/**
 * M7 Task 1: cross-provider fork handoff.
 *
 * A "handoff" hands a task's REVIEWED, ALLOWLISTED conversational content from one
 * provider's native task to a brand-new native task on a DIFFERENT provider. It is
 * intentionally NOT a generic "copy everything" fork:
 *
 *  - The transferred context is built from an ALLOWLIST (only completed-turn
 *    `message` events from `user`/`assistant` roles), not a blocklist. Anything not
 *    explicitly allowlisted — approval/permission requests, diagnostics, usage,
 *    status, plan/activity chatter, in-flight (unreviewed) turn content, and any
 *    text carrying a hidden-reasoning marker — never reaches the payload.
 *  - Every surviving string is run through {@link redactSecrets}, so credential-
 *    shaped substrings (API keys, bearer tokens, connection strings, `.env`-style
 *    assignments) are masked even inside an otherwise-allowlisted message.
 *  - The source task is only ever READ (via {@link ProviderRegistry.readTask}) —
 *    this module never calls any mutating adapter method on the source. A content
 *    hash of the source is captured at preview time and re-checked at commit time;
 *    if the source changed in between (a "mutation attempt"), the commit is
 *    rejected and no target task is created.
 *  - The new target task is created through the existing
 *    {@link ProviderRegistry.startTask}, so it goes through the exact same
 *    ownership/ID/capability checks every other native task does. Cross-task
 *    references use {@link taskLocator} (provider + home FINGERPRINT + native task
 *    id) rather than the raw filesystem home path, so a handoff link never leaks a
 *    raw home directory across providers.
 *  - Linkage metadata is ADDITIVE: it never mutates either task's own fields, and
 *    it is produced in both directions (a source-side view and a target-side view)
 *    so either task can be shown "forked to/from" the other.
 *
 * Everything here is gated behind the default-off `crossProviderFork` feature
 * flag (see feature-flags.ts); every entry point throws
 * {@link CrossProviderForkDisabledError} when the flag is not explicitly `true`.
 */
import { createHash } from "node:crypto";
import { canonicalProviderIndexJson } from "../provider-index/identity.js";
import { taskLocator, type ProviderTaskLocator } from "../provider-index/identity.js";
import { redactSecrets } from "../redact.js";
import type { DevHubFeatureFlags } from "./feature-flags.js";
import type { ProviderEvent } from "./events.js";
import type { ProviderRegistry } from "./registry.js";
import type {
  NativeTask,
  NativeTaskKey,
  NativeTurn,
  ProviderId,
} from "./types.js";

/** Thrown by every entry point in this module when `crossProviderFork` is not `true`. */
export class CrossProviderForkDisabledError extends Error {
  readonly code = "CROSS_PROVIDER_FORK_DISABLED";
  constructor() {
    super("crossProviderFork feature flag is not enabled");
    this.name = "CrossProviderForkDisabledError";
  }
}

/** Thrown when the source task changed between preview and commit. */
export class SourceTaskMutatedError extends Error {
  readonly code = "SOURCE_TASK_MUTATED";
  constructor() {
    super("source task content changed since the handoff preview was built; the source is immutable for a handoff and the commit was rejected");
    this.name = "SourceTaskMutatedError";
  }
}

/** Thrown when the target provider did not create a distinct native task. */
export class HandoffTargetNotNativeError extends Error {
  readonly code = "HANDOFF_TARGET_NOT_NATIVE";
  constructor() {
    super("cross-provider handoff target must be a new native task on a different provider");
    this.name = "HandoffTargetNotNativeError";
  }
}

/** One allowlisted, redacted message carried across the handoff. */
export interface TransferredContextMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** The transferred-context slice of a handoff preview: allowlisted + redacted only. */
export interface TransferredContext {
  readonly messages: readonly TransferredContextMessage[];
}

export interface HandoffTargetDescriptor {
  readonly provider: ProviderId;
  readonly home: string;
  readonly cwd: string;
  readonly model?: string;
  readonly mode?: string;
}

/**
 * The preview a user reviews before committing a handoff: target provider/model/
 * mode/cwd plus the exact transferred context that will seed the new task, and the
 * source content hash the commit will re-verify against.
 */
export interface CrossProviderHandoffPreview {
  readonly sourceLocator: ProviderTaskLocator;
  readonly sourceContentHash: string;
  readonly targetProvider: ProviderId;
  readonly targetModel: string | null;
  readonly targetMode: string | null;
  readonly targetCwd: string;
  readonly transferredContext: TransferredContext;
}

/** One direction of the additive, bidirectional handoff link. */
export interface HandoffLinkView {
  readonly relation: "handoff-source" | "handoff-target";
  readonly self: ProviderTaskLocator;
  readonly counterpart: ProviderTaskLocator;
  readonly sourceContentHash: string;
  readonly createdAt: string;
}

/** The full bidirectional link produced once a handoff is committed. */
export interface CrossProviderHandoffLink {
  readonly sourceLocator: ProviderTaskLocator;
  readonly targetLocator: ProviderTaskLocator;
  readonly sourceContentHash: string;
  readonly createdAt: string;
  readonly forSource: HandoffLinkView;
  readonly forTarget: HandoffLinkView;
}

export interface CrossProviderHandoffResult {
  readonly preview: CrossProviderHandoffPreview;
  readonly targetTask: Readonly<NativeTask>;
  readonly link: CrossProviderHandoffLink;
}

function requireFlag(flags: Pick<DevHubFeatureFlags, "crossProviderFork">): void {
  if (flags.crossProviderFork !== true) throw new CrossProviderForkDisabledError();
}

const HIDDEN_REASONING_MARKER =
  /(?:hidden|private|internal)[-_ ]?(?:reasoning|thought)|chain[-_ ]?of[-_ ]?thought/iu;

/** A turn counts as "reviewed" (eligible for handoff) only once it has finished. */
const REVIEWED_TURN_STATUSES = new Set(["complete", "completed", "success", "succeeded"]);

function isReviewedTurn(turn: NativeTurn): boolean {
  return REVIEWED_TURN_STATUSES.has(turn.status.toLowerCase());
}

/**
 * The allowlist: only `message` events, only `user`/`assistant` roles, only from a
 * reviewed (completed) turn, with no hidden-reasoning marker anywhere in the text.
 * Approval/permission requests, diagnostics, usage/status/plan/activity chatter,
 * `system` role messages, and anything from an in-flight turn are excluded — never
 * blocklisted individually, simply never allowlisted in.
 */
function isAllowlistedMessageEvent(
  event: ProviderEvent,
): event is ProviderEvent & { type: "message"; role: "user" | "assistant" } {
  if (event.type !== "message") return false;
  if (event.role !== "user" && event.role !== "assistant") return false;
  if (HIDDEN_REASONING_MARKER.test(event.text)) return false;
  return true;
}

/** Build the redacted, allowlisted transferred context for a (fully read) source task. */
export function buildTransferredContext(task: Readonly<NativeTask>): TransferredContext {
  const messages: TransferredContextMessage[] = [];
  for (const turn of task.turns) {
    if (!isReviewedTurn(turn)) continue;
    for (const event of turn.events) {
      if (!isAllowlistedMessageEvent(event)) continue;
      const redacted = redactSecrets(event.text);
      if (HIDDEN_REASONING_MARKER.test(redacted)) continue;
      messages.push(Object.freeze({ role: event.role, text: redacted }));
    }
  }
  return Object.freeze({ messages: Object.freeze(messages) });
}

/**
 * A deterministic content hash of the FULL source task (not just the transferred
 * slice) — every turn/event, unredacted — used purely to detect mutation between
 * preview and commit. Never exposed outside this module in raw form beyond the hex
 * digest string.
 */
export function sourceTaskContentHash(task: Readonly<NativeTask>): string {
  const canonical = canonicalProviderIndexJson({
    key: task.key,
    turns: task.turns.map((turn) => ({
      id: turn.id,
      status: turn.status,
      events: turn.events,
    })),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Build the review preview for a handoff. Pure: takes an already-read source task
 * (the caller is expected to have gone through `registry.readTask` so ownership is
 * proven) and a target descriptor, and returns the preview the user reviews before
 * committing. Never touches the registry and never mutates `task`.
 */
export function buildCrossProviderHandoffPreview(
  flags: Pick<DevHubFeatureFlags, "crossProviderFork">,
  sourceTask: Readonly<NativeTask>,
  target: HandoffTargetDescriptor,
): CrossProviderHandoffPreview {
  requireFlag(flags);
  if (target.provider === sourceTask.key.provider) {
    throw new TypeError("cross-provider handoff target must be a different provider than the source");
  }
  return Object.freeze({
    sourceLocator: taskLocator(sourceTask.key),
    sourceContentHash: sourceTaskContentHash(sourceTask),
    targetProvider: target.provider,
    targetModel: target.model ?? null,
    targetMode: target.mode ?? null,
    targetCwd: target.cwd,
    transferredContext: buildTransferredContext(sourceTask),
  });
}

function renderTransferredContextText(context: TransferredContext): string {
  if (context.messages.length === 0) return "";
  return context.messages
    .map((message) => `[handoff:${message.role}] ${message.text}`)
    .join("\n\n");
}

function handoffLink(
  sourceLocator: ProviderTaskLocator,
  targetLocator: ProviderTaskLocator,
  sourceContentHash: string,
  createdAt: string,
): CrossProviderHandoffLink {
  const forSource: HandoffLinkView = Object.freeze({
    relation: "handoff-source",
    self: sourceLocator,
    counterpart: targetLocator,
    sourceContentHash,
    createdAt,
  });
  const forTarget: HandoffLinkView = Object.freeze({
    relation: "handoff-target",
    self: targetLocator,
    counterpart: sourceLocator,
    sourceContentHash,
    createdAt,
  });
  return Object.freeze({
    sourceLocator,
    targetLocator,
    sourceContentHash,
    createdAt,
    forSource,
    forTarget,
  });
}

/**
 * Commit a previously-built preview: re-reads the source task through the registry,
 * REJECTS the commit if its content hash has drifted from the preview's (source is
 * immutable for a handoff — see {@link SourceTaskMutatedError}), then creates a NEW
 * native task on the target provider via `registry.startTask` (the existing
 * provider-registry path, so ownership/id/capability checks apply exactly as for
 * any other task start) seeded with the preview's transferred context, and returns
 * the additive, bidirectional link metadata for the two tasks.
 */
export async function commitCrossProviderHandoff(
  registry: Pick<ProviderRegistry, "readTask" | "startTask">,
  flags: Pick<DevHubFeatureFlags, "crossProviderFork">,
  sourceKey: NativeTaskKey,
  preview: CrossProviderHandoffPreview,
  /**
   * The target provider's raw home root. This is DELIBERATELY not part of
   * `preview` (which only ever carries the fingerprinted, locator-only view of a
   * task) — the raw home is needed here purely to route the `startTask` call to
   * the right provider adapter, and it never appears in the returned link/preview.
   */
  targetHome: string,
): Promise<CrossProviderHandoffResult> {
  requireFlag(flags);

  const current = await registry.readTask(sourceKey, true);
  const currentHash = sourceTaskContentHash(current);
  if (currentHash !== preview.sourceContentHash) {
    throw new SourceTaskMutatedError();
  }

  const targetTask = await registry.startTask(preview.targetProvider, {
    home: targetHome,
    cwd: preview.targetCwd,
    ...(preview.targetModel !== null ? { model: preview.targetModel } : {}),
    ...(preview.targetMode !== null ? { mode: preview.targetMode } : {}),
    ...(preview.transferredContext.messages.length > 0
      ? { input: { text: renderTransferredContextText(preview.transferredContext) } }
      : {}),
  });

  if (
    targetTask.key.provider === preview.sourceLocator.provider &&
    targetTask.key.nativeTaskId === sourceKey.nativeTaskId
  ) {
    throw new HandoffTargetNotNativeError();
  }
  if (targetTask.key.provider !== preview.targetProvider) {
    throw new HandoffTargetNotNativeError();
  }

  const targetLocator = taskLocator(targetTask.key);
  const link = handoffLink(
    preview.sourceLocator,
    targetLocator,
    preview.sourceContentHash,
    new Date().toISOString(),
  );

  return Object.freeze({ preview, targetTask, link });
}
