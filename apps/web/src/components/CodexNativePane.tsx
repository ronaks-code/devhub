import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  isProviderActiveStatus,
  isProviderTerminalStatus,
  isRuntimeFailureUncertainStatus,
  isUserCancelledStatus,
} from "@devhub/engine/provider-status-contract";
import {
  Activity,
  AlertTriangle,
  Archive,
  ArrowDown,
  Bot,
  Check,
  Coins,
  FileDiff,
  GitFork,
  ListTodo,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Square,
  X,
} from "lucide-react";
import { cn } from "../lib/utils";
import { useDraft } from "../hooks/useDraft";
import { useStickToBottom } from "../hooks/useStickToBottom";
import {
  providerApi,
  ProviderStreamError,
  type NativeTask,
  type NativeTaskKey,
  type NativeTaskSummary,
  type NativeTurnRef,
  type ProviderApiClient,
  type ProviderCapabilities,
  type ProviderCreateOutcome,
  type ProviderDescriptorCensus,
  type ProviderEvent,
  type ProviderEventSubscription,
  type ProviderId,
  type ProviderRequest,
  type ProviderRequestIdentity,
  type ProviderRequestResponse,
  type StartTaskInput,
} from "../lib/provider-api.js";
import { isUnifiedTaskIndexApplied } from "../lib/provider-index-api.js";
import type { DevHubFeatureFlags } from "@devhub/engine/providers";
import { Markdown } from "./Markdown";
import { ProviderHomeSetup } from "./ProviderHomeSetup";
import { EmptyState, IconButton, Spinner } from "./ui";
import { CrossProviderForkPanel } from "./features/shell/CrossProviderForkPanel.js";

type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";
type PermissionMode = string;
type BusyOperation =
  | "archive"
  | "create"
  | "fork"
  | "interrupt"
  | "rename"
  | "respond"
  | "resume"
  | "send"
  | null;

type ReconciliationKind = "provider-home" | "task" | "task-policy";
type ReconciliationScope =
  | {
      readonly kind: "provider-home";
      readonly home: string;
      readonly reason: "mutation-uncertain" | "stale-list";
      readonly phase: "refresh-home" | "refresh-task" | "review";
      readonly operation: "create" | "fork" | "archive-refresh";
      readonly sourceKey?: NativeTaskKey;
      readonly requiresTaskAcknowledgement?: boolean;
    }
  | {
      readonly kind: "task";
      readonly key: NativeTaskKey;
      readonly phase: "refresh" | "review";
      readonly operation: Exclude<BusyOperation, "create" | null>;
      readonly afterReview?: "task-policy";
      readonly observedArchived?: boolean;
    }
  | { readonly kind: "task-policy"; readonly key: NativeTaskKey };

interface MessageEntry {
  kind: "message";
  key: string;
  role: "user" | "assistant" | "system";
  text: string;
  streaming: boolean;
  turnId: string | null;
  nativeId: string | null;
}

interface PlanEntry {
  kind: "plan";
  key: string;
  text: string;
  status: string;
  turnId: string | null;
  nativeId: string | null;
}

interface ActivityEntry {
  kind: "activity";
  key: string;
  activity: string;
  status: string;
  message: string | null;
  turnId: string | null;
  nativeId: string | null;
}

interface DiffEntry {
  kind: "diff";
  key: string;
  turnId: string | null;
  changedFiles: number;
  additions: number;
  deletions: number;
}

interface UsageEntry {
  kind: "usage";
  key: string;
  turnId: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
}

interface StatusEntry {
  kind: "status";
  key: string;
  scope: "task" | "turn" | "item";
  status: string;
  nativeId: string | null;
}

interface RequestEntry {
  kind: "request";
  key: string;
  request: ProviderRequest;
}

interface DiagnosticEntry {
  kind: "diagnostic";
  key: string;
  level: "warning" | "error";
  code: string;
  message: string;
}

export type CodexTimelineEntry =
  | MessageEntry
  | PlanEntry
  | ActivityEntry
  | DiffEntry
  | UsageEntry
  | StatusEntry
  | RequestEntry
  | DiagnosticEntry;

export interface CodexTimelineState {
  readonly order: readonly string[];
  readonly entries: Readonly<Record<string, CodexTimelineEntry>>;
}

const EMPTY_TIMELINE: CodexTimelineState = Object.freeze({
  order: Object.freeze([]),
  entries: Object.freeze({}),
});

export const CLAUDE_MODEL_DISCLOSURE =
  "Claude model selection unavailable until runtime support is verified.";
export const PROVIDER_LOCK_DISCLOSURE =
  "Provider is fixed after creation. Fork to another provider to continue there.";

export interface NativeProviderPresentation {
  readonly provider: ProviderId;
  readonly product: "Codex" | "Claude";
  readonly providerLabel: "OpenAI · Codex" | "Anthropic · Claude";
  readonly homeLabel: "Codex home" | "Claude home";
  readonly taskLabel: "Codex task" | "Claude task";
  readonly draftNamespace: "native-codex" | "native-claude";
  readonly permissionModes: readonly Readonly<{ value: string; label: string }>[];
}

const OPENAI_PRESENTATION: Readonly<NativeProviderPresentation> = Object.freeze({
  provider: "openai",
  product: "Codex",
  providerLabel: "OpenAI · Codex",
  homeLabel: "Codex home",
  taskLabel: "Codex task",
  draftNamespace: "native-codex",
  permissionModes: Object.freeze([
    Object.freeze({ value: "read-only", label: "Read only" }),
    Object.freeze({ value: "workspace-write", label: "Workspace write" }),
  ]),
});

const ANTHROPIC_PRESENTATION: Readonly<NativeProviderPresentation> = Object.freeze({
  provider: "anthropic",
  product: "Claude",
  providerLabel: "Anthropic · Claude",
  homeLabel: "Claude home",
  taskLabel: "Claude task",
  draftNamespace: "native-claude",
  permissionModes: Object.freeze([
    Object.freeze({ value: "manual", label: "Manual" }),
    Object.freeze({ value: "acceptEdits", label: "Accept edits" }),
    Object.freeze({ value: "plan", label: "Plan" }),
  ]),
});

export function nativeProviderPresentation(
  provider: ProviderId,
): Readonly<NativeProviderPresentation> {
  return provider === "anthropic" ? ANTHROPIC_PRESENTATION : OPENAI_PRESENTATION;
}

export function providerDefaultPermission(provider: ProviderId): PermissionMode {
  return provider === "anthropic" ? "plan" : "read-only";
}

export function providerRequiresFirstMessage(provider: ProviderId): boolean {
  return provider === "anthropic";
}

/** Resolve only controls visible for the selected provider at serialization time. */
export function providerCreateOverrides(
  provider: ProviderId,
  model: string,
  permissionMode: string,
): Readonly<{ model?: string; permissionMode: string }> {
  const presentation = nativeProviderPresentation(provider);
  const safePermission = presentation.permissionModes.some(
    (candidate) => candidate.value === permissionMode,
  )
    ? permissionMode
    : providerDefaultPermission(provider);
  const visibleModel = provider === "openai" ? model.trim() : "";
  return Object.freeze({
    ...(visibleModel ? { model: visibleModel } : {}),
    permissionMode: safePermission,
  });
}

/** Preserve server-attested Claude policy unless this is an explicit repair. */
export function providerResumeOverrides(
  provider: ProviderId,
  model: string | null,
  policyRepair: boolean,
): Readonly<{ model?: string; permissionMode?: string }> {
  if (provider === "anthropic") {
    return policyRepair
      ? Object.freeze({ permissionMode: providerDefaultPermission(provider) })
      : Object.freeze({});
  }
  const visibleModel = model?.trim() ?? "";
  return Object.freeze({
    ...(visibleModel ? { model: visibleModel } : {}),
    permissionMode: providerDefaultPermission(provider),
  });
}

/**
 * Fold a provider home (a raw filesystem path) into an opaque, path-free token
 * used to namespace browser-owned state (draft keys, in-memory task identities).
 * FNV-1a 32-bit → 8 hex chars: deterministic and stable, so the same home always
 * maps to the same scope, while the literal path never appears in a storage key,
 * URL, or DOM identity. NOT security-sensitive — it only scopes local UI state,
 * not the server's canonical home (which stays backend-only behind fingerprints).
 */
export function pathFreeHomeToken(home: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < home.length; i++) {
    hash ^= home.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Every browser-owned task identity includes the immutable provider dimension.
 * The identity is opaque, path-free (the home is hashed, never embedded), and
 * NUL-free (the native id is percent-encoded and the parts are dot-joined —
 * `provider` and the hex home token never contain a dot, so the split stays
 * unambiguous). Used only for in-memory de-dup and DOM keys.
 */
export function nativeTaskIdentity(key: NativeTaskKey): string {
  return `${key.provider}.${pathFreeHomeToken(key.home)}.${encodeURIComponent(key.nativeTaskId)}`;
}

export const MAX_CONNECT_BUFFER_EVENTS = 256;
const MAX_CONNECT_BUFFER_BYTES = 2 * 1024 * 1024;

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function eventBytes(event: ProviderEvent): number {
  try {
    return new TextEncoder().encode(JSON.stringify(event)).byteLength;
  } catch {
    return MAX_CONNECT_BUFFER_BYTES + 1;
  }
}

function normalizedStatus(status: string): string {
  return status.toLowerCase().replace(/[\s-]/g, "_");
}

function isActiveStatus(status: string): boolean {
  return isProviderActiveStatus(status);
}

function isTerminalStatus(status: string): boolean {
  return isProviderTerminalStatus(status);
}

export function nativeMutationsArePaused(
  connection: ConnectionState,
  listLoading: boolean,
  reconciliationScope: ReconciliationScope | null,
): boolean {
  return connection !== "connected" || listLoading || reconciliationScope !== null;
}

export function providerHomeReviewSource(
  scope: Extract<ReconciliationScope, { readonly kind: "provider-home" }>,
): NativeTaskKey | undefined {
  // Create reconciliation is home-scoped. Only fork supplies a concrete
  // source task whose post-mutation state must also be reviewed.
  return scope.sourceKey;
}

export function reconciliationReviewReady(scope: ReconciliationScope | null): boolean {
  return (scope?.kind === "task" || scope?.kind === "provider-home") && scope.phase === "review";
}

export function reconciliationForPartialTask(
  key: NativeTaskKey,
  operation: "send" | "fork",
): ReconciliationScope {
  return {
    kind: "task",
    key,
    phase: "refresh",
    operation,
    afterReview: "task-policy",
  };
}

export function shouldRetainArchivedSnapshotForReview(
  scope: ReconciliationScope | null,
  key: NativeTaskKey,
): boolean {
  return scope?.kind === "task" &&
    scope.operation === "archive" &&
    (scope.phase === "refresh" || scope.phase === "review") &&
    nativeTaskKeysEqual(scope.key, key);
}

export function projectReconciliationForTaskStatus(
  scope: ReconciliationScope | null,
  key: NativeTaskKey,
  status: string,
): ReconciliationScope | null {
  if (
    normalizedStatus(status) === "archived" &&
    shouldRetainArchivedSnapshotForReview(scope, key) &&
    scope?.kind === "task" && !scope.observedArchived
  ) {
    return { ...scope, observedArchived: true };
  }
  return scope;
}

export function projectReconciliationForTurnStatus(
  scope: ReconciliationScope | null,
  key: NativeTaskKey,
  status: string,
): ReconciliationScope | null {
  if (scope !== null || !isRuntimeFailureUncertainStatus(status)) return scope;
  return {
    kind: "task",
    key,
    phase: "refresh",
    operation: "send",
  };
}

export function projectBufferedTurnReconciliation(
  scope: ReconciliationScope | null,
  key: NativeTaskKey,
  buffered: readonly ProviderEvent[],
): Readonly<{ scope: ReconciliationScope | null; disconnect: boolean }> {
  let projected = scope;
  let disconnect = false;
  for (const event of buffered) {
    if (event.type !== "status" || event.scope !== "turn") continue;
    if (isRuntimeFailureUncertainStatus(event.status)) disconnect = true;
    projected = projectReconciliationForTurnStatus(projected, key, event.status);
  }
  return Object.freeze({ scope: projected, disconnect });
}

export function providerEventAnnouncement(
  event: ProviderEvent,
  product = "Codex",
): string | null {
  if (event.type === "status") {
    const status = event.status.replaceAll("_", " ").replaceAll("-", " ");
    return `${product} ${event.scope} status: ${status}.`;
  }
  if (event.type === "message" && event.role === "assistant") {
    return `${product} response completed.`;
  }
  if (event.type === "request") {
    const request = event.request.kind.replaceAll("-", " ");
    return `${product} is waiting for ${request}.`;
  }
  return null;
}

export function activeTurnAfterSendResponse(
  turnId: string,
  latestStatus: string | undefined,
): string | null {
  return latestStatus !== undefined && isTerminalStatus(latestStatus) ? null : turnId;
}

export function taskIndexForKey(
  key: string,
  currentIndex: number,
  length: number,
): number | null {
  if (length < 1 || currentIndex < 0 || currentIndex >= length) return null;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key === "ArrowDown" || key === "j") return (currentIndex + 1) % length;
  if (key === "ArrowUp" || key === "k") return (currentIndex - 1 + length) % length;
  return null;
}

export function taskMatchesSelection(
  task: NativeTask | null,
  home: string | null,
  nativeTaskId: string | null,
  provider: ProviderId = "openai",
): task is NativeTask {
  return task !== null && home !== null && nativeTaskId !== null &&
    task.key.provider === provider &&
    task.key.home === home &&
    task.key.nativeTaskId === nativeTaskId;
}

export function reviewedTaskFingerprint(
  task: NativeTask | null,
  key: NativeTaskKey,
): string | null {
  if (!task || !nativeTaskKeysEqual(task.key, key)) return null;
  const fingerprint = task.revision?.fingerprint;
  return typeof fingerprint === "string" && fingerprint.length > 0
    ? fingerprint
    : null;
}

export function nativeTaskKeysEqual(a: NativeTaskKey, b: NativeTaskKey): boolean {
  return a.provider === b.provider && a.home === b.home &&
    a.nativeTaskId === b.nativeTaskId;
}

function nativePart(value: string | null): string {
  return value ?? "none";
}

function typedRpcId(value: string | number | null): string {
  if (value === null) return "null";
  return `${typeof value}:${String(value)}`;
}

function identityKey(identity: Readonly<ProviderRequestIdentity>): string {
  // In-memory timeline de-dup key. Path-free (the home is hashed) and NUL-free
  // (every part is percent-encoded so no separator or filesystem path leaks, and
  // the "|" join is unambiguous because encodeURIComponent never emits "|").
  return [
    identity.key.provider,
    pathFreeHomeToken(identity.key.home),
    identity.key.nativeTaskId,
    String(identity.generation ?? "none"),
    nativePart(identity.turnId),
    typedRpcId(identity.requestId),
    nativePart(identity.itemId),
    typedRpcId(identity.approvalId),
  ].map(encodeURIComponent).join("|");
}

function upsertTimeline(
  state: CodexTimelineState,
  entry: CodexTimelineEntry,
): CodexTimelineState {
  const exists = Object.prototype.hasOwnProperty.call(state.entries, entry.key);
  return {
    order: exists ? state.order : [...state.order, entry.key],
    entries: { ...state.entries, [entry.key]: entry },
  };
}

function removeTimeline(state: CodexTimelineState, key: string): CodexTimelineState {
  if (!Object.prototype.hasOwnProperty.call(state.entries, key)) return state;
  const entries = { ...state.entries };
  delete entries[key];
  return { order: state.order.filter((candidate) => candidate !== key), entries };
}

/** Apply one validated provider event while preserving provider-native identity. */
export function appendCodexTimelineEvent(
  state: CodexTimelineState,
  event: ProviderEvent,
): CodexTimelineState {
  switch (event.type) {
    case "message-delta": {
      const key = `message:${nativePart(event.turnId)}:${nativePart(event.itemId)}:${event.role}`;
      const previous = state.entries[key];
      // A completed item is authoritative. A late/replayed delta must not
      // corrupt it during reconnect reconciliation.
      if (previous?.kind === "message" && !previous.streaming) return state;
      const previousText = previous?.kind === "message" ? previous.text : "";
      return upsertTimeline(state, {
        kind: "message",
        key,
        role: event.role,
        text: `${previousText}${event.delta}`,
        streaming: true,
        turnId: event.turnId,
        nativeId: event.itemId,
      });
    }
    case "message": {
      const key = `message:${nativePart(event.turnId)}:${nativePart(event.itemId)}:${event.role}`;
      return upsertTimeline(state, {
        kind: "message",
        key,
        role: event.role,
        text: event.text,
        streaming: false,
        turnId: event.turnId,
        nativeId: event.itemId,
      });
    }
    case "plan": {
      const key = event.itemId === null && event.stepIndex !== null
        ? `plan:${nativePart(event.turnId)}:step:${event.stepIndex}`
        : `plan:${nativePart(event.turnId)}:${nativePart(event.itemId)}`;
      const previous = state.entries[key];
      if (
        event.status === "streaming" &&
        previous?.kind === "plan" &&
        previous.status !== "streaming"
      ) return state;
      const planText = event.status === "streaming" && previous?.kind === "plan"
        ? `${previous.text}${event.text}`
        : event.text;
      return upsertTimeline(state, {
        kind: "plan",
        key,
        text: planText,
        status: event.status,
        turnId: event.turnId,
        nativeId: event.itemId,
      });
    }
    case "activity": {
      const key = `activity:${nativePart(event.turnId)}:${nativePart(event.itemId)}`;
      return upsertTimeline(state, {
        kind: "activity",
        key,
        activity: event.activity,
        status: event.status,
        message: event.message,
        turnId: event.turnId,
        nativeId: event.itemId,
      });
    }
    case "diff-summary": {
      const key = `diff:${nativePart(event.turnId)}`;
      return upsertTimeline(state, {
        kind: "diff",
        key,
        turnId: event.turnId,
        changedFiles: event.changedFiles,
        additions: event.additions,
        deletions: event.deletions,
      });
    }
    case "usage": {
      const key = `usage:${nativePart(event.turnId)}`;
      return upsertTimeline(state, {
        kind: "usage",
        key,
        turnId: event.turnId,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cachedInputTokens: event.cachedInputTokens,
        totalTokens: event.totalTokens,
      });
    }
    case "status": {
      const key = `status:${event.scope}:${nativePart(event.nativeId)}`;
      return upsertTimeline(state, {
        kind: "status",
        key,
        scope: event.scope,
        status: event.status,
        nativeId: event.nativeId,
      });
    }
    case "request": {
      const key = `request:${identityKey(event.request.identity)}`;
      return upsertTimeline(state, { kind: "request", key, request: event.request });
    }
    case "request-resolved":
      return removeTimeline(state, `request:${identityKey(event.identity)}`);
    case "diagnostic": {
      const prefix = `diagnostic:${event.occurredAt}:${event.code}:`;
      let index = state.order.length;
      while (Object.prototype.hasOwnProperty.call(state.entries, `${prefix}${index}`)) index += 1;
      const key = `${prefix}${index}`;
      return upsertTimeline(state, {
        kind: "diagnostic",
        key,
        level: event.level,
        code: event.code,
        message: event.message,
      });
    }
  }
}

export function buildCodexTimeline(events: readonly ProviderEvent[]): CodexTimelineState {
  return events.reduce(appendCodexTimelineEvent, EMPTY_TIMELINE);
}

function timelineForTask(task: NativeTask): CodexTimelineState {
  return buildCodexTimeline(task.turns.flatMap((turn) => turn.events));
}

export function projectTaskStatus<T extends NativeTaskSummary>(
  task: T,
  event: ProviderEvent,
): T {
  return event.type === "status" && event.scope === "task"
    ? {
        ...task,
        status: event.status,
        ...(normalizedStatus(event.status) === "archived" ? { archived: true } : {}),
      }
    : task;
}

/** Keep task-row activity derived from the complete set of observed live turns. */
export function projectTaskStatusFromTurnEvent<T extends NativeTaskSummary>(
  task: T,
  event: ProviderEvent,
  hasActiveTurn: boolean,
): T {
  return event.type === "status" && event.scope === "turn" &&
      isTerminalStatus(event.status) && !hasActiveTurn && isActiveStatus(task.status)
    ? { ...task, status: "idle" }
    : task;
}

export function capabilityAllowsRequest(
  capabilities: Readonly<ProviderCapabilities>,
  kind: ProviderRequest["kind"],
): boolean {
  switch (kind) {
    case "command-approval": return capabilities.approveCommand;
    case "file-change-approval": return capabilities.approveFileChange;
    case "permission": return capabilities.approvePermissions;
    case "user-input": return capabilities.requestUserInput;
    case "mcp-elicitation": return capabilities.mcpElicitation;
  }
}

export function connectionMessage(state: ConnectionState): string | null {
  if (state === "reconnecting") return "Reconnecting… task mutations remain paused.";
  if (state === "disconnected") {
    return "Connection lost — task status must be checked before continuing.";
  }
  return null;
}

export function codexComposerPlaceholder(
  mutationsPaused: boolean,
  activeTurn: boolean,
  canSteer: boolean,
): string {
  if (mutationsPaused) return "Reconnect to send. Your draft is saved.";
  if (activeTurn && !canSteer) return "Wait for this turn or interrupt it";
  if (activeTurn) return "Add guidance to the active turn";
  return "Ask for follow-up changes";
}

export function connectionAfterSnapshot(
  streamFailed: boolean,
  requiresReconciliation: boolean,
): "connected" | "disconnected" {
  return streamFailed || requiresReconciliation ? "disconnected" : "connected";
}

/** Mutations with an unknown outcome or a rejected safety policy require an authoritative read. */
export function reconciliationKindForError(
  error: unknown,
  operationScope: ReconciliationKind,
): ReconciliationKind | null {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const declaredScope = error && typeof error === "object" && "scope" in error
    ? (error as { scope?: unknown }).scope
    : undefined;
  if (
    code === "RECONCILIATION_REQUIRED" &&
    (declaredScope === "provider-home" || declaredScope === "task" || declaredScope === "task-policy")
  ) return declaredScope;
  if (code === "POLICY_MISMATCH") return "task-policy";
  return code === "MUTATION_UNCERTAIN" ||
    code === "RECONCILIATION_REQUIRED"
    ? operationScope
    : null;
}

export interface NativeCreateResult {
  readonly task: NativeTask;
  readonly partial: boolean;
  readonly retry: false;
  readonly notice: string;
  readonly reconciliationOperation: "send" | "fork" | null;
}

/** Execute native creation exactly once and preserve a partial native outcome. */
export async function runNativeCreate(
  client: Pick<ProviderApiClient, "start">,
  provider: ProviderId,
  input: StartTaskInput,
): Promise<NativeCreateResult> {
  const outcome = await client.start(provider, input);
  if (outcome.outcome === "partial") {
    return {
      task: outcome.task,
      partial: true,
      retry: false,
      reconciliationOperation: "send",
      notice: `Task ${outcome.task.key.nativeTaskId} was created, but its first-turn status is unknown and its effective safety policy is unverified. The native task was recovered and was not retried. Verify a safe policy before continuing.`,
    };
  }
  return {
    task: outcome.task,
    partial: false,
    retry: false,
    reconciliationOperation: null,
    notice: `Task created with ${nativeProviderPresentation(provider).providerLabel}.`,
  };
}

function forkOutcome(outcome: ProviderCreateOutcome): NativeCreateResult {
  if (outcome.outcome === "partial") {
    return {
      task: outcome.task,
      partial: true,
      retry: false,
      reconciliationOperation: "fork",
      notice: `Fork ${outcome.task.key.nativeTaskId} was created, but its setup status is unknown and its effective safety policy is unverified. The native fork was recovered and was not retried. Verify a safe policy before continuing.`,
    };
  }
  return {
    task: outcome.task,
    partial: false,
    retry: false,
    reconciliationOperation: null,
    notice: "Native task fork created.",
  };
}

function requestTitle(kind: ProviderRequest["kind"]): string {
  switch (kind) {
    case "command-approval": return "Command approval requested";
    case "file-change-approval": return "File-change approval requested";
    case "permission": return "Permission requested";
    case "user-input": return "Input requested";
    case "mcp-elicitation": return "MCP approval requested";
  }
}

function decisionResponse(
  request: Extract<ProviderRequest, { kind: "command-approval" | "file-change-approval" | "mcp-elicitation" }>,
  decision: "allow" | "deny" | "cancel",
): ProviderRequestResponse {
  return { kind: request.kind, identity: request.identity, decision };
}

function Intervention({
  request,
  capabilities,
  onRespond,
  disabled,
}: {
  request: ProviderRequest;
  capabilities: Readonly<ProviderCapabilities>;
  onRespond: (response: ProviderRequestResponse) => void;
  disabled: boolean;
}) {
  const allowed = capabilityAllowsRequest(capabilities, request.kind);
  const label = requestTitle(request.kind);
  return (
    <section
      role="status"
      aria-live="polite"
      aria-label={label}
      className="mx-4 my-2 rounded-xl border border-amber-800/50 bg-amber-500/5 px-3 py-2.5"
    >
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-amber-200">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{label}</span>
      </div>
      {!allowed ? (
        <p className="mt-1.5 text-[11.5px] text-zinc-500">
          This provider interaction is not enabled for this task.
        </p>
      ) : request.kind === "command-approval" ||
        request.kind === "file-change-approval" ||
        request.kind === "mcp-elicitation" ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            aria-label={
              request.kind === "command-approval"
                ? "Approve command"
                : request.kind === "file-change-approval"
                  ? "Approve file change"
                  : "Approve MCP request"
            }
            onClick={() => onRespond(decisionResponse(request, "allow"))}
            disabled={disabled}
            className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50 disabled:pointer-events-none disabled:opacity-40"
          >
            Allow
          </button>
          <button
            type="button"
            aria-label={
              request.kind === "command-approval"
                ? "Deny command"
                : request.kind === "file-change-approval"
                  ? "Deny file change"
                  : "Deny MCP request"
            }
            onClick={() => onRespond(decisionResponse(request, "deny"))}
            disabled={disabled}
            className="rounded-md bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-200 transition hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50 disabled:pointer-events-none disabled:opacity-40"
          >
            Deny
          </button>
          <button
            type="button"
            aria-label={`Cancel ${label.toLowerCase()}`}
            onClick={() => onRespond(decisionResponse(request, "cancel"))}
            disabled={disabled}
            className="rounded-md px-2.5 py-1 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50 disabled:pointer-events-none disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      ) : request.kind === "permission" ? (
        <div className="mt-2">
          <p className="text-[11.5px] text-zinc-500">
            Native permission grants are not exposed without a verified permission profile.
          </p>
          <button
            type="button"
            aria-label="Deny permission request"
            onClick={() => onRespond({ kind: "permission", identity: request.identity, permissions: [] })}
            disabled={disabled}
            className="mt-2 rounded-md bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-200 transition hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50 disabled:pointer-events-none disabled:opacity-40"
          >
            Deny
          </button>
        </div>
      ) : (
        <p className="mt-1.5 text-[11.5px] text-zinc-500">
          The provider did not expose bounded question metadata, so DevHub cannot submit an answer safely.
        </p>
      )}
    </section>
  );
}

export function CodexNativeTimeline({
  timeline,
  capabilities,
  onRespond,
  disabled = false,
  keys = timeline.order,
  compact = false,
  product = "Codex",
}: {
  timeline: CodexTimelineState;
  capabilities: Readonly<ProviderCapabilities>;
  onRespond: (response: ProviderRequestResponse) => void;
  disabled?: boolean;
  keys?: readonly string[];
  compact?: boolean;
  product?: "Codex" | "Claude";
}) {
  if (keys.length === 0) {
    return compact
      ? <div className="w-full" />
      : <div role="region" aria-label={`${product} task transcript`} className="mx-auto h-full w-full max-w-3xl" />;
  }

  return (
    <div
      aria-label={compact ? undefined : `${product} task transcript`}
      className={compact ? "w-full" : "mx-auto w-full max-w-3xl py-5"}
    >
      {keys.map((key) => {
        const entry = timeline.entries[key];
        if (!entry) return null;
        switch (entry.kind) {
          case "message":
            if (entry.role === "user") {
              return (
                <article
                  key={entry.key}
                  data-turn-id={entry.turnId ?? undefined}
                  data-item-id={entry.nativeId ?? undefined}
                  className="flex justify-end px-4 py-2.5"
                >
                  <p className="max-w-[78%] whitespace-pre-wrap break-words rounded-xl bg-zinc-900 px-3.5 py-2.5 text-[13.5px] leading-relaxed text-zinc-100">
                    {entry.text}
                  </p>
                </article>
              );
            }
            return (
              <article
                key={entry.key}
                data-turn-id={entry.turnId ?? undefined}
                data-item-id={entry.nativeId ?? undefined}
                className="px-4 py-2.5"
              >
                <div className="flex items-start gap-2.5">
                  <Bot className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <Markdown text={entry.text} className="text-[13.5px] leading-relaxed text-zinc-200" />
                    {entry.streaming ? (
                      <span className="text-[10.5px] text-zinc-600">Streaming…</span>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          case "plan":
            return (
              <section
                key={entry.key}
                aria-label="Plan"
                data-turn-id={entry.turnId ?? undefined}
                data-item-id={entry.nativeId ?? undefined}
                className="mx-4 my-2 border-l-2 border-zinc-700 px-3 py-1.5"
              >
                <div className="flex items-center gap-2 text-xs font-medium text-zinc-300">
                  <ListTodo className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Plan</span>
                  <span className="text-[10.5px] font-normal text-zinc-600">{entry.status}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-zinc-400">
                  {entry.text}
                </p>
              </section>
            );
          case "activity":
            return (
              <div
                key={entry.key}
                data-turn-id={entry.turnId ?? undefined}
                data-item-id={entry.nativeId ?? undefined}
                className="mx-4 my-1.5 flex items-start gap-2 px-1 py-1 text-[12px] text-zinc-400"
              >
                <Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-600" aria-hidden="true" />
                <span className="font-medium text-zinc-300">{entry.activity}</span>
                <span className="text-zinc-600">{entry.status}</span>
                {entry.message ? <span className="min-w-0 flex-1 break-words">{entry.message}</span> : null}
              </div>
            );
          case "diff":
            return (
              <div key={entry.key} className="mx-4 my-2 flex justify-center">
                <div className="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-3 py-1.5 text-[11.5px] text-zinc-400 ring-1 ring-zinc-800">
                  <FileDiff className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{entry.changedFiles} {entry.changedFiles === 1 ? "file" : "files"}</span>
                  <span className="text-emerald-400">+{entry.additions}</span>
                  <span className="text-red-400">-{entry.deletions}</span>
                </div>
              </div>
            );
          case "usage":
            return (
              <div key={entry.key} className="mx-4 my-1 flex items-center justify-center gap-1.5 text-[10.5px] text-zinc-600">
                <Coins className="h-3 w-3" aria-hidden="true" />
                <span>{entry.totalTokens.toLocaleString()} tokens</span>
                {entry.cachedInputTokens > 0 ? <span>· {entry.cachedInputTokens.toLocaleString()} cached</span> : null}
              </div>
            );
          case "status":
            return (
              <div key={entry.key} className="mx-4 my-1 text-[10.5px] text-zinc-600">
                {isUserCancelledStatus(entry.status) ? (
                  <span>Cancelled by you</span>
                ) : (
                  <><span className="capitalize">{entry.scope}</span> · {entry.status}</>
                )}
              </div>
            );
          case "request":
            return (
              <Intervention
                key={entry.key}
                request={entry.request}
                capabilities={capabilities}
                onRespond={onRespond}
                disabled={disabled}
              />
            );
          case "diagnostic":
            return (
              <div
                key={entry.key}
                role={entry.level === "error" ? "alert" : "status"}
                className={cn(
                  "mx-4 my-2 rounded-lg border px-3 py-2 text-[11.5px]",
                  entry.level === "error"
                    ? "border-red-900/50 bg-red-500/5 text-red-300"
                    : "border-amber-900/50 bg-amber-500/5 text-amber-300",
                )}
              >
                {entry.message} <span className="text-zinc-600">({entry.code})</span>
              </div>
            );
        }
      })}
    </div>
  );
}

function VirtualizedCodexNativeTimeline({
  timeline,
  capabilities,
  onRespond,
  disabled,
  scrollRef,
  product,
}: {
  timeline: CodexTimelineState;
  capabilities: Readonly<ProviderCapabilities>;
  onRespond: (response: ProviderRequestResponse) => void;
  disabled: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  product: "Codex" | "Claude";
}) {
  const virtualizer = useVirtualizer({
    count: timeline.order.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => timeline.order[index] ?? index,
    estimateSize: () => 96,
    overscan: 10,
  });

  if (timeline.order.length === 0) {
    return (
      <div
        role="region"
        aria-label={`${product} task transcript`}
        className="mx-auto h-full w-full max-w-3xl"
      />
    );
  }

  return (
    <div
      role="region"
      aria-label={`${product} task transcript`}
      className="relative mx-auto w-full max-w-3xl"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((row) => {
        const key = timeline.order[row.index];
        if (!key) return null;
        return (
          <div
            key={row.key}
            ref={virtualizer.measureElement}
            data-index={row.index}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${row.start}px)` }}
          >
            <CodexNativeTimeline
              timeline={timeline}
              capabilities={capabilities}
              onRespond={onRespond}
              disabled={disabled}
              keys={[key]}
              compact
              product={product}
            />
          </div>
        );
      })}
    </div>
  );
}

function safeOperationMessage(error: unknown, product = "Codex"): string {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  switch (code) {
    case "MUTATION_UNCERTAIN":
      return "The provider mutation outcome is uncertain. DevHub will not retry it automatically; refresh native state first.";
    case "RECONCILIATION_REQUIRED":
      return "Native state must be refreshed and explicitly reviewed before another mutation.";
    case "POLICY_MISMATCH":
      return `${product} could not verify the requested safety policy. Mutations remain paused until a safe policy is verified.`;
    case "UNSAFE_OVERRIDE":
      return "That runtime override is not allowed.";
    case "DISABLED":
      return `Native ${product} is disabled. Enable it only after the runtime gate passes.`;
    case "SUBSCRIPTION_CAPACITY":
      return "The native event connection limit was reached. Close another task stream and reconnect.";
    case "UNSUPPORTED_INTERACTION":
      return `This interaction has not been verified for the current ${product} runtime.`;
    default:
      return `The native ${product} operation failed. Your task and draft were preserved.`;
  }
}

function taskUpdatedMs(task: NativeTaskSummary): number {
  const parsed = task.updatedAt ? Date.parse(task.updatedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortedTasks(tasks: readonly NativeTaskSummary[]): NativeTaskSummary[] {
  const byIdentity = new Map<string, NativeTaskSummary>();
  for (const task of tasks) {
    const identity = nativeTaskIdentity(task.key);
    const previous = byIdentity.get(identity);
    if (!previous || taskUpdatedMs(task) >= taskUpdatedMs(previous)) byIdentity.set(identity, task);
  }
  return [...byIdentity.values()].sort((a, b) => taskUpdatedMs(b) - taskUpdatedMs(a));
}

export function taskSelectionAfterList(
  current: string | null,
  tasks: readonly NativeTaskSummary[],
  mode: "first" | "preserve" = "first",
  preferredTaskId?: string,
): string | null {
  if (current && tasks.some((task) => task.key.nativeTaskId === current)) return current;
  if (preferredTaskId) return preferredTaskId;
  return mode === "first" ? tasks[0]?.key.nativeTaskId ?? null : null;
}

function replaceTask(
  tasks: readonly NativeTaskSummary[],
  task: NativeTaskSummary,
): NativeTaskSummary[] {
  const next = tasks.filter((candidate) =>
    candidate.key.provider !== task.key.provider ||
    candidate.key.home !== task.key.home ||
    candidate.key.nativeTaskId !== task.key.nativeTaskId);
  next.push(task);
  return sortedTasks(next);
}

export function latestActiveTurn(task: NativeTask | null): string | null {
  if (!task) return null;
  for (let index = task.turns.length - 1; index >= 0; index -= 1) {
    const turn = task.turns[index]!;
    if (isActiveStatus(turn.status)) return turn.id;
  }
  return null;
}

export interface CreatedTaskHandoff {
  readonly identity: string;
  readonly selectedTask: NativeTask;
  readonly timeline: CodexTimelineState;
  readonly activeTurnId: string | null;
  readonly turnStatuses: Map<string, string>;
}

/** Seed the connected view from the authoritative create response before rereading. */
export function createdTaskHandoff(task: NativeTask): Readonly<CreatedTaskHandoff> {
  return Object.freeze({
    identity: nativeTaskIdentity(task.key),
    selectedTask: task,
    timeline: timelineForTask(task),
    activeTurnId: latestActiveTurn(task),
    turnStatuses: new Map(task.turns.map((turn) => [turn.id, turn.status])),
  });
}

function descriptorHomes(
  descriptors: readonly ProviderDescriptorCensus[],
  provider: ProviderId = "openai",
): string[] {
  return descriptors
    .filter((descriptor) => descriptorSupportsNativeHistory(descriptor, provider))
    .map((descriptor) => descriptor.home)
    .sort((a, b) => a.localeCompare(b));
}

export function descriptorSupportsNativeHistory(
  descriptor: ProviderDescriptorCensus,
  provider: ProviderId = "openai",
): descriptor is Extract<ProviderDescriptorCensus, { status: "available" }> {
  return descriptor.provider === provider && descriptor.status === "available" &&
    descriptor.capabilities.list && descriptor.capabilities.read;
}

/**
 * Attach the live sink before taking the authoritative snapshot. Events emitted
 * during the snapshot read stay buffered and are replayed atomically with it,
 * closing the read-then-subscribe loss window without duplicating late deltas.
 */
export async function connectNativeTask(
  client: Pick<ProviderApiClient, "read" | "subscribe">,
  key: NativeTaskKey,
  signal: AbortSignal,
  onLiveEvent: (event: ProviderEvent) => void,
  onStreamError: () => void,
  onSnapshot: (task: NativeTask, buffered: readonly ProviderEvent[]) => void,
): Promise<ProviderEventSubscription> {
  const buffered: ProviderEvent[] = [];
  let bufferedBytes = 0;
  let buffering = true;
  let subscription: ProviderEventSubscription | null = null;
  let bufferFailure: ProviderStreamError | null = null;
  let streamErrorReported = false;
  let stopPromise: Promise<void> | null = null;
  const readAbort = new AbortController();
  const stopSubscription = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    if (!subscription) return Promise.resolve();
    stopPromise = subscription.unsubscribe();
    return stopPromise;
  };
  const onAbort = () => {
    readAbort.abort(signal.reason);
    void stopSubscription();
  };
  const reportStreamError = () => {
    if (streamErrorReported) return;
    streamErrorReported = true;
    onStreamError();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    subscription = await client.subscribe(
      key,
      (event) => {
        if (signal.aborted) return;
        if (!buffering) {
          onLiveEvent(event);
          return;
        }
        const bytes = eventBytes(event);
        if (
          bufferFailure !== null ||
          buffered.length >= MAX_CONNECT_BUFFER_EVENTS ||
          bufferedBytes + bytes > MAX_CONNECT_BUFFER_BYTES
        ) {
          if (bufferFailure === null) {
            bufferFailure = new ProviderStreamError(
              "SSE_BUFFER_LIMIT",
              "Provider events exceeded the pre-snapshot buffer",
            );
            readAbort.abort(bufferFailure);
            reportStreamError();
            void stopSubscription();
          }
          return;
        }
        buffered.push(event);
        bufferedBytes += bytes;
      },
      { signal, onError: reportStreamError },
    );
    if (signal.aborted) {
      await stopSubscription();
      throw abortError();
    }
    if (bufferFailure !== null) {
      await stopSubscription();
      throw bufferFailure;
    }
    const closedBeforeSnapshot = subscription.closed.then<never>(
      () => {
        reportStreamError();
        throw new ProviderStreamError(
          "SSE_READ_FAILED",
          "Provider stream closed before the task snapshot completed",
        );
      },
      (reason: unknown) => {
        reportStreamError();
        throw reason;
      },
    );
    const task = await Promise.race([
      client.read(key, true, { signal: readAbort.signal }),
      closedBeforeSnapshot,
      new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => reject(
          signal.aborted ? abortError() : bufferFailure ?? abortError(),
        );
        if (readAbort.signal.aborted) rejectAbort();
        else readAbort.signal.addEventListener("abort", rejectAbort, { once: true });
      }),
    ]);
    if (bufferFailure !== null) {
      await stopSubscription();
      throw bufferFailure;
    }
    if (signal.aborted) {
      await stopSubscription();
      throw abortError();
    }
    onSnapshot(task, Object.freeze([...buffered]));
    buffering = false;
    return subscription;
  } catch (error) {
    buffering = false;
    await stopSubscription().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Reread before fork so the chosen native turn cannot lag live task state. */
export async function runNativeFork(
  client: Pick<ProviderApiClient, "read" | "fork">,
  key: NativeTaskKey,
): Promise<NativeCreateResult> {
  const current = await client.read(key, true);
  const outcome = await client.fork(key, current.turns.at(-1)?.id);
  return forkOutcome(outcome);
}

export interface CodexNativePaneProps {
  client?: ProviderApiClient;
  preferredHome?: string;
  preferredTaskId?: string;
  fallback?: ReactNode;
  provider?: ProviderId;
  /** Resolved DevHub feature flags. When `unifiedTaskIndex` is applied true the setup
   *  runs through the path-free provider-index facade; otherwise the direct key-based
   *  pane below renders unchanged (the preserved rollback surface). */
  features?: Partial<DevHubFeatureFlags>;
  /** Preferred home fingerprint used only by the flag-on locator setup (opaque, never a path). */
  preferredHomeFingerprint?: string;
}

/**
 * Provider task pane entry point. Consumes the `unifiedTaskIndex` locator transport seam:
 * when the flag is applied true the setup is a PublicProviderHome-only view over the
 * path-free facade; when it is off the direct key-based pane renders byte-for-byte as
 * before (instant rollback). The branch is a component swap so each side owns its own
 * hooks and neither leaks state across a flag flip.
 */
export function CodexNativePane(props: CodexNativePaneProps) {
  if (isUnifiedTaskIndexApplied(props.features)) {
    return (
      <ProviderHomeSetup
        features={props.features}
        provider={props.provider ?? "openai"}
        {...(props.preferredHomeFingerprint !== undefined
          ? { preferredHomeFingerprint: props.preferredHomeFingerprint }
          : {})}
        fallback={props.fallback}
      />
    );
  }
  return <CodexNativeDirectPane {...props} />;
}

/** Feature-flagged native Codex vertical slice inside the preserved DevHub shell. */
export function CodexNativeDirectPane({
  client = providerApi,
  preferredHome,
  preferredTaskId,
  fallback,
  provider = "openai",
  features,
}: CodexNativePaneProps) {
  const presentation = nativeProviderPresentation(provider);
  // M7: cross-provider fork always targets the OTHER shipping native runtime.
  const otherProvider: ProviderId = provider === "openai" ? "anthropic" : "openai";
  const crossProviderForkEnabled = features?.crossProviderFork === true;
  const [descriptors, setDescriptors] = useState<readonly ProviderDescriptorCensus[] | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<Readonly<ProviderCapabilities> | null>(null);
  const [tasks, setTasks] = useState<readonly NativeTaskSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<NativeTask | null>(null);
  const [timeline, setTimeline] = useState<CodexTimelineState>(EMPTY_TIMELINE);
  const [listLoading, setListLoading] = useState(true);
  const [taskLoading, setTaskLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [reconciliationScope, setReconciliationScope] = useState<ReconciliationScope | null>(null);
  const [acknowledgingReconciliation, setAcknowledgingReconciliation] = useState(false);
  const [busy, setBusy] = useState<BusyOperation>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createCwd, setCreateCwd] = useState("");
  const [createModel, setCreateModel] = useState("");
  const [createPermission, setCreatePermission] = useState<PermissionMode>(
    () => providerDefaultPermission(provider),
  );
  const [renameValue, setRenameValue] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [pendingInterruptTurnId, setPendingInterruptTurnId] = useState<string | null>(null);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [discoveryNonce, setDiscoveryNonce] = useState(0);
  const [liveAnnouncement, setLiveAnnouncement] = useState<{ readonly id: number; readonly text: string } | null>(null);
  // Draft scopes are path-free: the raw home is folded into an opaque token so no
  // filesystem path ever lands in a localStorage key. The create-draft is scoped
  // by that same token (a per-home scratch draft) rather than the raw home.
  const homeToken = home ? pathFreeHomeToken(home) : null;
  const { draft, setDraft, clearDraft } = useDraft(
    homeToken ? `${presentation.draftNamespace}:${homeToken}` : presentation.draftNamespace,
    selectedId,
  );
  const {
    draft: createPrompt,
    setDraft: setCreatePrompt,
    clearDraft: clearCreatePrompt,
  } = useDraft(`${presentation.draftNamespace}:create`, homeToken);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const loadedIdentityRef = useRef<string | null>(null);
  const listRequestRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const selectedIdentityRef = useRef<string | null>(null);
  const connectionAbortRef = useRef<AbortController | null>(null);
  const reconciliationScopeRef = useRef<ReconciliationScope | null>(null);
  const taskOptionRefs = useRef(new Map<string, HTMLButtonElement>());
  const archiveDialogRef = useRef<HTMLDivElement>(null);
  const archiveTriggerRef = useRef<HTMLButtonElement>(null);
  const archiveCompletedRef = useRef(false);
  const acknowledgementPendingRef = useRef(false);
  const taskListRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef<BusyOperation>(null);
  const turnStatusRef = useRef(new Map<string, string>());
  const preferredTaskIdRef = useRef<string | null>(preferredTaskId ?? null);
  selectedIdentityRef.current = home && selectedId
    ? nativeTaskIdentity({ provider, home, nativeTaskId: selectedId })
    : null;
  selectedIdRef.current = selectedId;
  busyRef.current = busy;

  useEffect(() => {
    preferredTaskIdRef.current = preferredTaskId ?? null;
  }, [preferredTaskId, provider]);

  useEffect(() => {
    setCreateModel("");
    setCreatePermission(providerDefaultPermission(provider));
  }, [provider]);

  const updateReconciliationScope = useCallback((scope: ReconciliationScope | null) => {
    reconciliationScopeRef.current = scope;
    setReconciliationScope(scope);
  }, []);

  const transitionSelectedTask = useCallback((nextId: string | null) => {
    connectionAbortRef.current?.abort();
    selectedIdRef.current = nextId;
    loadedIdentityRef.current = null;
    setSelectedId(nextId);
    setSelectedTask(null);
    setTimeline(EMPTY_TIMELINE);
    setActiveTurnId(null);
    setPendingInterruptTurnId(null);
    setLiveAnnouncement(null);
    setRenameValue(null);
    setConfirmArchive(false);
    turnStatusRef.current.clear();
    setConnection(nextId ? "connecting" : "connected");
  }, []);

  const descriptor = useMemo(
    () => descriptors?.find(
      (candidate) => descriptorSupportsNativeHistory(candidate, provider) && candidate.home === home,
    ) ?? null,
    [descriptors, home, provider],
  );
  const mutationsPaused = nativeMutationsArePaused(connection, listLoading, reconciliationScope);
  const selectedIsNative = selectedTask?.source === "native";
  const selectedCanMutate = selectedIsNative && selectedTask.archived !== true;
  const selectedNeedsPolicyRepair = reconciliationScope?.kind === "task-policy" &&
    selectedTask !== null &&
    reconciliationScope.key.provider === selectedTask.key.provider &&
    reconciliationScope.key.home === selectedTask.key.home &&
    reconciliationScope.key.nativeTaskId === selectedTask.key.nativeTaskId;
  const policyRepairReady = selectedNeedsPolicyRepair && connection === "connected";
  const timelineStick = useStickToBottom(timelineScrollRef);
  useEffect(() => {
    if (timeline.order.length === 0) return;
    return timelineStick.followToIndex(() => {
      const element = timelineScrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
  }, [timeline, timelineStick.followToIndex]);

  useEffect(() => {
    timelineStick.pin();
  }, [home, selectedId, timelineStick.pin]);

  const loadList = useCallback(async (
    selectedHome: string,
    options: {
      append?: boolean;
      cursor?: string;
      selection?: "first" | "preserve";
      preferredTaskId?: string;
    } = {},
  ): Promise<boolean> => {
    const requestId = ++listRequestRef.current;
    setListLoading(true);
    setError(null);
    try {
      const page = await client.list({
        provider,
        home: selectedHome,
        limit: 50,
        includeArchived,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      });
      if (listRequestRef.current !== requestId) return false;
      setTasks((current) => sortedTasks(options.append ? [...current, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
      if (!options.append) {
        const current = selectedIdRef.current;
        const next = taskSelectionAfterList(
          current,
          page.items,
          options.selection,
          options.preferredTaskId,
        );
        if (next !== current) transitionSelectedTask(next);
        setFocusedTaskId((current) => {
          if (current && page.items.some((task) => task.key.nativeTaskId === current)) return current;
          return page.items[0]?.key.nativeTaskId ?? null;
        });
      }
      return true;
    } catch (reason) {
      if (listRequestRef.current !== requestId) return false;
      setError(safeOperationMessage(reason, presentation.product));
      return false;
    } finally {
      if (listRequestRef.current === requestId) setListLoading(false);
    }
  }, [client, includeArchived, presentation.product, provider, transitionSelectedTask, updateReconciliationScope]);

  useEffect(() => () => {
    listRequestRef.current += 1;
  }, []);

  useEffect(() => {
    let active = true;
    setDescriptors(null);
    setListLoading(true);
    client.providers()
      .then((result) => {
        if (!active) return;
        setDescriptors(result);
        const homes = descriptorHomes(result, provider);
        const selectedHome = preferredHome && homes.includes(preferredHome) ? preferredHome : homes[0] ?? null;
        setHome(selectedHome);
        const selectedDescriptor = result.find(
          (candidate) => candidate.provider === provider && candidate.status === "available" && candidate.home === selectedHome,
        );
        setCapabilities(
          selectedDescriptor && descriptorSupportsNativeHistory(selectedDescriptor, provider)
            ? selectedDescriptor.capabilities
            : null,
        );
        if (!selectedHome) setListLoading(false);
      })
      .catch((reason) => {
        if (!active) return;
        setError(safeOperationMessage(reason, presentation.product));
        setDescriptors([]);
        setListLoading(false);
      });
    return () => { active = false; };
  }, [client, discoveryNonce, preferredHome, presentation.product, provider]);

  useEffect(() => {
    if (!home || !descriptor || descriptor.status !== "available") return;
    let active = true;
    setCapabilities(descriptor.capabilities);
    setTasks([]);
    setNextCursor(null);
    transitionSelectedTask(null);
    setFocusedTaskId(null);
    setSelectedTask(null);
    setTimeline(EMPTY_TIMELINE);
    setConnection("connecting");
    void loadList(home, (preferredTaskIdRef.current
        ? { preferredTaskId: preferredTaskIdRef.current }
        : {})).then((loaded) => {
      if (!active) return;
      if (!loaded) setConnection("disconnected");
      else if (!selectedIdRef.current) {
        setConnection(reconciliationScopeRef.current ? "disconnected" : "connected");
      }
    });
    return () => { active = false; };
  }, [descriptor, home, loadList, transitionSelectedTask]);

  useEffect(() => {
    if (!home || !selectedId || !capabilities?.read) {
      loadedIdentityRef.current = null;
      setSelectedTask(null);
      setTimeline(EMPTY_TIMELINE);
      setActiveTurnId(null);
      setPendingInterruptTurnId(null);
      if (!selectedId) {
        setConnection(reconciliationScopeRef.current
          ? "disconnected"
          : listLoading
            ? "connecting"
            : "connected");
      }
      return;
    }

    const abort = new AbortController();
    connectionAbortRef.current = abort;
    let subscription: Awaited<ReturnType<ProviderApiClient["subscribe"]>> | null = null;
    let streamFailed = false;
    const key: NativeTaskKey = { provider, home, nativeTaskId: selectedId };
    const selectedIdentity = nativeTaskIdentity(key);
    if (loadedIdentityRef.current !== selectedIdentity) {
      loadedIdentityRef.current = selectedIdentity;
      setSelectedTask(null);
      setTimeline(EMPTY_TIMELINE);
      setActiveTurnId(null);
      setRenameValue(null);
      setConfirmArchive(false);
      turnStatusRef.current.clear();
    }
    setTaskLoading(true);
    setError(null);
    setConnection(reconnectNonce > 0 ? "reconnecting" : "connecting");

    const applyLiveEvent = (event: ProviderEvent) => {
      if (abort.signal.aborted) return;
      setTimeline((current) => appendCodexTimelineEvent(current, event));
      const announcement = providerEventAnnouncement(event, presentation.product);
      if (announcement) {
        setLiveAnnouncement((current) => ({ id: (current?.id ?? 0) + 1, text: announcement }));
      }
      if (event.type === "status" && event.scope === "task") {
        const projectedScope = projectReconciliationForTaskStatus(
          reconciliationScopeRef.current,
          key,
          event.status,
        );
        if (projectedScope !== reconciliationScopeRef.current) {
          updateReconciliationScope(projectedScope);
        }
        if (
          normalizedStatus(event.status) === "archived" && !includeArchived &&
          !shouldRetainArchivedSnapshotForReview(reconciliationScopeRef.current, key)
        ) {
          setTasks((current) => current.filter((task) =>
            task.key.provider !== key.provider ||
            task.key.home !== key.home ||
            task.key.nativeTaskId !== key.nativeTaskId));
          transitionSelectedTask(null);
          void loadList(key.home);
          return;
        }
        setTasks((current) => current.map((task) =>
          task.key.provider === key.provider &&
          task.key.home === key.home &&
          task.key.nativeTaskId === key.nativeTaskId
            ? projectTaskStatus(task, event)
            : task));
        setSelectedTask((current) => current ? projectTaskStatus(current, event) : current);
      }
      if (event.type === "status" && event.scope === "turn" && event.nativeId) {
        const projectedScope = projectReconciliationForTurnStatus(
          reconciliationScopeRef.current,
          key,
          event.status,
        );
        if (projectedScope !== reconciliationScopeRef.current) {
          updateReconciliationScope(projectedScope);
        }
        if (isRuntimeFailureUncertainStatus(event.status)) setConnection("disconnected");
        if (isUserCancelledStatus(event.status)) setNotice("Cancelled by you");
        turnStatusRef.current.set(event.nativeId, event.status);
        const hasActiveTurn = [...turnStatusRef.current.values()].some(isActiveStatus);
        if (isTerminalStatus(event.status) && !hasActiveTurn) {
          setTasks((current) => current.map((task) =>
            task.key.provider === key.provider &&
            task.key.home === key.home &&
            task.key.nativeTaskId === key.nativeTaskId
              ? projectTaskStatusFromTurnEvent(task, event, false)
              : task));
          setSelectedTask((current) => current
            ? projectTaskStatusFromTurnEvent(current, event, false)
            : current);
        }
        if (isActiveStatus(event.status)) setActiveTurnId(event.nativeId);
        else if (isTerminalStatus(event.status)) {
          setPendingInterruptTurnId((current) => current === event.nativeId ? null : current);
          setActiveTurnId((current) => current === event.nativeId ? null : current);
        }
      }
    };

    const applySnapshot = (task: NativeTask, buffered: readonly ProviderEvent[]) => {
      if (preferredTaskIdRef.current === task.key.nativeTaskId) {
        preferredTaskIdRef.current = null;
      }
      const projectedTask = buffered.reduce(projectTaskStatus, task);
      setSelectedTask(projectedTask);
      setTasks((current) => replaceTask(current, projectedTask));
      setTimeline(buffered.reduce(appendCodexTimelineEvent, timelineForTask(task)));
      let activeTurn = latestActiveTurn(task);
      turnStatusRef.current = new Map(task.turns.map((turn) => [turn.id, turn.status]));
      for (const event of buffered) {
        if (event.type !== "status" || event.scope !== "turn" || !event.nativeId) continue;
        turnStatusRef.current.set(event.nativeId, event.status);
        if (isActiveStatus(event.status)) activeTurn = event.nativeId;
        else if (isTerminalStatus(event.status) && activeTurn === event.nativeId) activeTurn = null;
      }
      setActiveTurnId(activeTurn);
      setPendingInterruptTurnId((current) => current && current === activeTurn ? current : null);
      const bufferedReconciliation = projectBufferedTurnReconciliation(
        reconciliationScopeRef.current,
        task.key,
        buffered,
      );
      if (bufferedReconciliation.scope !== reconciliationScopeRef.current) {
        updateReconciliationScope(bufferedReconciliation.scope);
      }
      if (bufferedReconciliation.disconnect) streamFailed = true;
      const pending = reconciliationScopeRef.current;
      const retainArchivedForReview = shouldRetainArchivedSnapshotForReview(pending, task.key);
      if (
        pending?.kind === "task" &&
        pending.phase === "refresh" &&
        pending.key.provider === task.key.provider &&
        pending.key.home === task.key.home &&
        pending.key.nativeTaskId === task.key.nativeTaskId
      ) {
        updateReconciliationScope({
          ...pending,
          phase: "review",
          ...(projectedTask.archived ? { observedArchived: true } : {}),
        });
      } else if (
        pending?.kind === "provider-home" &&
        pending.phase === "refresh-task" &&
        pending.sourceKey?.provider === task.key.provider &&
        pending.sourceKey.home === task.key.home &&
        pending.sourceKey.nativeTaskId === task.key.nativeTaskId
      ) {
        updateReconciliationScope({ ...pending, phase: "review" });
      }
      if (projectedTask.archived && !includeArchived && !retainArchivedForReview) {
        setTasks((current) => current.filter((candidate) =>
          !nativeTaskKeysEqual(candidate.key, projectedTask.key)));
        transitionSelectedTask(null);
        void loadList(projectedTask.key.home);
      }
    };

    const connect = async () => {
      try {
        if (capabilities.subscribe) {
          subscription = await connectNativeTask(
            client,
            key,
            abort.signal,
            applyLiveEvent,
            () => {
              streamFailed = true;
              if (!abort.signal.aborted) setConnection("disconnected");
            },
            applySnapshot,
          );
          void subscription.closed.then(
            () => {
              streamFailed = true;
              if (!abort.signal.aborted) setConnection("disconnected");
            },
            () => {
              streamFailed = true;
              if (!abort.signal.aborted) setConnection("disconnected");
            },
          );
        } else {
          const task = await client.read(key, true);
          if (abort.signal.aborted) return;
          applySnapshot(task, []);
        }
        if (!abort.signal.aborted) {
          setConnection(connectionAfterSnapshot(
            streamFailed,
            reconciliationScopeRef.current?.kind === "task"
              ? reconciliationScopeRef.current.phase === "refresh"
              : reconciliationScopeRef.current?.kind === "provider-home"
                ? reconciliationScopeRef.current.phase !== "review"
                : false,
          ));
        }
      } catch (reason) {
        if (abort.signal.aborted) return;
        setConnection("disconnected");
        setError(safeOperationMessage(reason, presentation.product));
      } finally {
        if (!abort.signal.aborted) setTaskLoading(false);
      }
    };
    void connect();

    return () => {
      abort.abort();
      if (connectionAbortRef.current === abort) connectionAbortRef.current = null;
      if (subscription) void subscription.unsubscribe();
    };
  }, [capabilities?.read, capabilities?.subscribe, client, home, includeArchived, loadList, presentation.product, provider, reconnectNonce, selectedId, transitionSelectedTask, updateReconciliationScope]);

  useEffect(() => {
    if (selectedId !== null) return;
    setConnection(reconciliationScopeRef.current
      ? "disconnected"
      : listLoading
        ? "connecting"
        : "connected");
  }, [listLoading, reconciliationScope, selectedId]);

  const selectCreatedTask = useCallback((
    task: NativeTask,
    resultNotice: string,
    reconciliationOperation: "send" | "fork" | null = null,
  ) => {
    const handoff = createdTaskHandoff(task);
    if (reconciliationOperation !== null) {
      updateReconciliationScope(reconciliationForPartialTask(
        task.key,
        reconciliationOperation,
      ));
    }
    setConnection("reconnecting");
    setHome(task.key.home);
    preferredTaskIdRef.current = null;
    loadedIdentityRef.current = handoff.identity;
    setTasks((current) => replaceTask(current, task));
    selectedIdRef.current = task.key.nativeTaskId;
    setSelectedId(task.key.nativeTaskId);
    setFocusedTaskId(task.key.nativeTaskId);
    setSelectedTask(handoff.selectedTask);
    setTimeline(handoff.timeline);
    setNotice(resultNotice);
    setShowCreate(false);
    setRenameValue(null);
    setConfirmArchive(false);
    setActiveTurnId(handoff.activeTurnId);
    setPendingInterruptTurnId(null);
    turnStatusRef.current = handoff.turnStatuses;
  }, [updateReconciliationScope]);

  const createTask = async (event: FormEvent) => {
    event.preventDefault();
    const firstMessageRequired = providerRequiresFirstMessage(provider);
    if (
      !home || descriptor?.home !== home || !capabilities?.start ||
      !createCwd.trim() || busy || mutationsPaused ||
      (firstMessageRequired && !createPrompt.trim()) ||
      (createPrompt.trim().length > 0 && !capabilities.subscribe)
    ) return;
    setBusy("create");
    setError(null);
    try {
      const result = await runNativeCreate(client, provider, {
        home,
        cwd: createCwd.trim(),
        ...providerCreateOverrides(provider, createModel, createPermission),
        ...(createPrompt.trim() && capabilities.subscribe
          ? { input: { text: createPrompt.trim() } }
          : {}),
      });
      selectCreatedTask(result.task, result.notice, result.reconciliationOperation);
      if (!result.partial) {
        clearCreatePrompt();
      }
    } catch (reason) {
      if (reconciliationKindForError(reason, "provider-home")) {
        updateReconciliationScope({
          kind: "provider-home",
          home,
          reason: "mutation-uncertain",
          phase: "refresh-home",
          operation: "create",
        });
        setConnection("disconnected");
      }
      setError(safeOperationMessage(reason, presentation.product));
    } finally {
      setBusy(null);
    }
  };

  const runSelected = useCallback(async (
    operation: Exclude<BusyOperation, "create" | null>,
    action: (task: NativeTask, stillSelected: () => boolean) => Promise<void>,
  ) => {
    const policyRepair = operation === "resume" &&
      reconciliationScope?.kind === "task-policy" &&
      selectedTask !== null &&
      reconciliationScope.key.provider === selectedTask.key.provider &&
      reconciliationScope.key.home === selectedTask.key.home &&
      reconciliationScope.key.nativeTaskId === selectedTask.key.nativeTaskId &&
      connection === "connected";
    if (
      !taskMatchesSelection(selectedTask, home, selectedId, provider) ||
      selectedTask.source !== "native" || selectedTask.archived || busy ||
      (mutationsPaused && !policyRepair)
    ) return;
    const operationIdentity = nativeTaskIdentity(selectedTask.key);
    const stillSelected = () => selectedIdentityRef.current === operationIdentity;
    setBusy(operation);
    setError(null);
    try {
      await action(selectedTask, stillSelected);
    } catch (reason) {
      const errorCode = reason && typeof reason === "object" && "code" in reason
        ? String((reason as { code?: unknown }).code)
        : "";
      const reconciliationKind = policyRepair && errorCode === "MUTATION_UNCERTAIN"
        ? "task"
        : reconciliationKindForError(
            reason,
            operation === "fork"
              ? "provider-home"
              : policyRepair
                ? "task-policy"
                : "task",
          );
      if (reconciliationKind) {
        updateReconciliationScope(reconciliationKind === "provider-home"
          ? {
              kind: "provider-home",
              home: selectedTask.key.home,
              reason: "mutation-uncertain",
              phase: "refresh-home",
              operation: "fork",
              sourceKey: selectedTask.key,
              requiresTaskAcknowledgement: true,
            }
          : reconciliationKind === "task-policy"
            ? { kind: "task-policy", key: selectedTask.key }
            : {
                kind: "task",
                key: selectedTask.key,
                phase: "refresh",
                operation,
                ...(operation === "resume" ? { afterReview: "task-policy" as const } : {}),
              });
        setConnection("disconnected");
        setError(safeOperationMessage(reason, presentation.product));
      } else if (stillSelected()) {
        setError(safeOperationMessage(reason, presentation.product));
      }
    } finally {
      setBusy(null);
    }
  }, [busy, connection, home, mutationsPaused, presentation.product, provider, reconciliationScope, selectedId, selectedTask, updateReconciliationScope]);

  const resume = () => runSelected("resume", async (task, stillSelected) => {
    const policyRepair = selectedNeedsPolicyRepair;
    const resumed = await client.resume(
      task.key,
      providerResumeOverrides(provider, task.model, policyRepair),
    );
    setTasks((current) => replaceTask(current, resumed));
    if (stillSelected()) {
      updateReconciliationScope(null);
      setConnection("reconnecting");
      setReconnectNonce((current) => current + 1);
      setNotice(policyRepair
        ? "Native task resumed with an explicit safe provider policy."
        : "Native task resumed.");
      composerRef.current?.focus();
    }
  });

  const fork = () => runSelected("fork", async (task, stillSelected) => {
    const result = await runNativeFork(client, task.key);
    setTasks((current) => replaceTask(current, result.task));
    setNotice(result.notice);
    if (stillSelected()) {
      selectCreatedTask(result.task, result.notice, result.reconciliationOperation);
    }
  });

  const sendOrSteer = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !selectedTask || busy || mutationsPaused || !capabilities?.subscribe) return;
    if (activeTurnId) {
      if (!capabilities?.steer) return;
      void runSelected("send", async (task, stillSelected) => {
        await client.steer(task.key, activeTurnId, { text });
        if (stillSelected()) {
          clearDraft();
          setNotice("Input added to the active turn.");
        }
      });
      return;
    }
    if (!capabilities?.send) return;
    void runSelected("send", async (task, stillSelected) => {
      const ref: NativeTurnRef = await client.send(task.key, { text });
      if (stillSelected()) {
        clearDraft();
        setActiveTurnId(activeTurnAfterSendResponse(
          ref.turnId,
          turnStatusRef.current.get(ref.turnId),
        ));
        setNotice(`Turn started with ${presentation.providerLabel}.`);
      }
    });
  };

  const interrupt = () => runSelected("interrupt", async (task, stillSelected) => {
    if (!activeTurnId) return;
    const turnId = activeTurnId;
    await client.interrupt(task.key, turnId);
    if (stillSelected()) {
      const latestStatus = turnStatusRef.current.get(turnId);
      if (!latestStatus || !isTerminalStatus(latestStatus)) {
        setPendingInterruptTurnId(turnId);
        setNotice("Interrupt requested. Waiting for native task status.");
      } else if (isUserCancelledStatus(latestStatus)) {
        setNotice("Cancelled by you");
      } else {
        setNotice("The native turn finished while the interrupt was being acknowledged.");
      }
    }
  });

  const respond = (response: ProviderRequestResponse) => {
    if (!selectedTask || !nativeTaskKeysEqual(selectedTask.key, response.identity.key)) return;
    void runSelected("respond", async (task, stillSelected) => {
      if (!nativeTaskKeysEqual(task.key, response.identity.key)) return;
      const status = await client.respond(response);
      if (stillSelected()) {
        setTimeline((current) => appendCodexTimelineEvent(current, {
          type: "request-resolved",
          provider: response.identity.key.provider,
          key: response.identity.key,
          occurredAt: new Date().toISOString(),
          identity: response.identity,
        }));
        setNotice(status === "stale" ? "That provider request was already resolved." : `Response sent to ${presentation.providerLabel}.`);
      }
    });
  };

  const rename = (event: FormEvent) => {
    event.preventDefault();
    const name = renameValue?.trim();
    if (!name) return;
    void runSelected("rename", async (task, stillSelected) => {
      await client.rename(task.key, name);
      setTasks((current) => current.map((candidate) =>
        candidate.key.provider === task.key.provider &&
        candidate.key.home === task.key.home &&
        candidate.key.nativeTaskId === task.key.nativeTaskId
          ? { ...candidate, title: name }
          : candidate));
      if (stillSelected()) {
        setSelectedTask((current) => current ? { ...current, title: name } : current);
        setRenameValue(null);
        setNotice("Task renamed in the native provider.");
      }
    });
  };

  const archive = () => runSelected("archive", async (task, stillSelected) => {
    await client.archive(task.key);
    archiveCompletedRef.current = true;
    const archivedTask = { ...task, archived: true };
    setTasks((current) => includeArchived
      ? replaceTask(current, archivedTask)
      : current.filter((candidate) =>
          candidate.key.provider !== task.key.provider ||
          candidate.key.home !== task.key.home ||
          candidate.key.nativeTaskId !== task.key.nativeTaskId));
    if (stillSelected()) {
      setConfirmArchive(false);
      if (includeArchived) setSelectedTask((current) => current ? { ...current, archived: true } : current);
      else {
        transitionSelectedTask(null);
      }
      setNotice(`Task archived in ${presentation.providerLabel}.`);
    }
    const refreshed = await loadList(task.key.home);
    if (!refreshed) {
      updateReconciliationScope({
        kind: "provider-home",
        home: task.key.home,
        reason: "stale-list",
        phase: "refresh-home",
        operation: "archive-refresh",
      });
      setConnection("disconnected");
      setError("The task was archived, but native history could not be refreshed. Refresh provider state before another mutation.");
    }
  });

  const checkNativeState = useCallback(async () => {
    if (!home) return;
    setConnection("reconnecting");
    setError(null);
    if (reconciliationScope?.kind === "provider-home") {
      const reconciled = await loadList(reconciliationScope.home, {
        selection: reconciliationScope.operation === "create" ? "preserve" : "first",
      });
      if (!reconciled) {
        setConnection("disconnected");
        return;
      }
      if (reconciliationScope.reason === "stale-list") {
        updateReconciliationScope(null);
        if (selectedIdRef.current) {
          setConnection("reconnecting");
          setReconnectNonce((current) => current + 1);
        } else {
          setConnection("connected");
        }
        return;
      }
      const sourceKey = providerHomeReviewSource(reconciliationScope);
      const reviewed = sourceKey
        ? { ...reconciliationScope, phase: "refresh-task" as const, sourceKey }
        : { ...reconciliationScope, phase: "review" as const };
      updateReconciliationScope(reviewed);
      if (sourceKey) {
        setHome(sourceKey.home);
        transitionSelectedTask(sourceKey.nativeTaskId);
        setReconnectNonce((current) => current + 1);
      } else if (selectedIdRef.current) {
        setReconnectNonce((current) => current + 1);
      } else setConnection("connected");
      return;
    }
    if (reconciliationScope?.kind === "task") {
      setHome(reconciliationScope.key.home);
      transitionSelectedTask(reconciliationScope.key.nativeTaskId);
      setReconnectNonce((current) => current + 1);
      return;
    }
    if (selectedId) {
      setReconnectNonce((current) => current + 1);
      return;
    }
    const reconciled = await loadList(home);
    setConnection(reconciled ? "connected" : "disconnected");
  }, [home, loadList, reconciliationScope, selectedId, transitionSelectedTask]);

  const acknowledgeReviewedState = useCallback(async () => {
    const pending = reconciliationScopeRef.current;
    if (!pending || acknowledgementPendingRef.current) return;
    acknowledgementPendingRef.current = true;
    setAcknowledgingReconciliation(true);
    let retryScope = pending;
    try {
      if (pending.kind === "task" && pending.phase === "review") {
        const fingerprint = reviewedTaskFingerprint(selectedTask, pending.key);
        if (fingerprint === null) {
          throw new Error("The reviewed native task has no authoritative revision fingerprint");
        }
        await client.acknowledgeReconciliation({
          scope: "task",
          key: pending.key,
          fingerprint,
        });
      } else if (pending.kind === "provider-home" && pending.phase === "review") {
        if (pending.requiresTaskAcknowledgement && pending.sourceKey) {
          const fingerprint = reviewedTaskFingerprint(selectedTask, pending.sourceKey);
          if (fingerprint === null) {
            throw new Error("The reviewed native task has no authoritative revision fingerprint");
          }
          await client.acknowledgeReconciliation({
            scope: "task",
            key: pending.sourceKey,
            fingerprint,
          });
          retryScope = { ...pending, requiresTaskAcknowledgement: false };
          updateReconciliationScope(retryScope);
        }
        await client.acknowledgeReconciliation({
          scope: "provider-home",
          provider,
          home: pending.home,
        });
      } else {
        return;
      }
      if (pending.kind === "task" && pending.afterReview === "task-policy") {
        updateReconciliationScope({ kind: "task-policy", key: pending.key });
        setNotice("Native task state was reviewed. Its safety policy still requires a verified safe Resume.");
      } else {
        updateReconciliationScope(null);
        setNotice("Reviewed native state acknowledged. Mutations remain governed by the selected task connection.");
        if (
          pending.kind === "task" && pending.operation === "archive" &&
          pending.observedArchived && !includeArchived
        ) {
          setTasks((current) => current.filter((candidate) =>
            !nativeTaskKeysEqual(candidate.key, pending.key)));
          transitionSelectedTask(null);
          void loadList(pending.key.home);
        }
      }
    } catch (reason) {
      if (retryScope.kind === "task") {
        updateReconciliationScope({ ...retryScope, phase: "refresh" });
      } else if (retryScope.kind === "provider-home") {
        updateReconciliationScope({ ...retryScope, phase: "refresh-home" });
      }
      setError(safeOperationMessage(reason, presentation.product));
      setConnection("disconnected");
    } finally {
      acknowledgementPendingRef.current = false;
      setAcknowledgingReconciliation(false);
    }
  }, [client, includeArchived, loadList, presentation.product, provider, selectedTask, transitionSelectedTask, updateReconciliationScope]);

  const cancelStateCheck = useCallback(() => {
    connectionAbortRef.current?.abort();
    listRequestRef.current += 1;
    setListLoading(false);
    setTaskLoading(false);
    setConnection("disconnected");
  }, []);

  useEffect(() => {
    if (!confirmArchive) return;
    const appRoot = document.getElementById("root");
    const priorInert = appRoot?.inert ?? false;
    const priorOverflow = document.body.style.overflow;
    if (appRoot) appRoot.inert = true;
    document.body.style.overflow = "hidden";
    const trigger = archiveTriggerRef.current;
    const dialog = archiveDialogRef.current;
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [])];
    const frame = requestAnimationFrame(() => focusable()[0]?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && busyRef.current !== "archive") {
        event.preventDefault();
        setConfirmArchive(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      if (appRoot) appRoot.inert = priorInert;
      document.body.style.overflow = priorOverflow;
      const completed = archiveCompletedRef.current;
      archiveCompletedRef.current = false;
      requestAnimationFrame(() => {
        if (completed) {
          const focusedId = selectedIdRef.current;
          const option = focusedId && home
            ? taskOptionRefs.current.get(nativeTaskIdentity({
                provider,
                home,
                nativeTaskId: focusedId,
              }))
            : undefined;
          (option && !option.disabled ? option : taskListRef.current)?.focus();
        } else {
          (trigger?.isConnected ? trigger : taskListRef.current)?.focus();
        }
      });
    };
  }, [confirmArchive, home, provider]);

  useEffect(() => {
    if (confirmArchive && busy === "archive") archiveDialogRef.current?.focus();
  }, [busy, confirmArchive]);

  if (descriptors === null) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-busy="true"
        className="flex min-h-0 flex-1 items-center justify-center bg-zinc-950"
      >
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Spinner className="h-4 w-4" />
          Checking native {presentation.product} runtime…
        </div>
      </div>
    );
  }

  const homes = descriptorHomes(descriptors, provider);
  // M7: the fork target needs a discovered, enabled home for the OTHER provider —
  // when there is none, the entry point stays hidden (nothing to fork into yet).
  const crossProviderForkTargetHome = descriptorHomes(descriptors, otherProvider)[0] ?? null;
  if (!home || !capabilities) {
    const unavailable = descriptors.find(
      (candidate) => candidate.provider === provider && candidate.status === "unavailable",
    );
    const unsupportedHistory = descriptors.some(
      (candidate) => candidate.provider === provider && candidate.status === "available" &&
        (!candidate.capabilities.list || !candidate.capabilities.read),
    );
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-zinc-950">
        <div role="status" className="border-b border-amber-900/40 bg-amber-500/5 px-4 py-3 text-amber-200">
          <div className="flex items-center gap-2 text-xs font-medium">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> Native {presentation.product} is unavailable
          </div>
          <p className="mt-1 text-[11px] text-zinc-500">
            {unavailable
              ? `The configured ${presentation.product} runtime could not be verified. Showing the preserved fallback below.`
              : unsupportedHistory
                ? `This ${presentation.product} runtime does not expose verified native list/read capabilities. Showing the preserved fallback below.`
              : `No enabled ${presentation.providerLabel} home was discovered. Native controls stay hidden; the preserved fallback remains available.`}
          </p>
        </div>
        {fallback ?? (
          <EmptyState
            icon={<AlertTriangle className="h-11 w-11" />}
            title="Read-only history is not connected"
            hint="Return to the legacy History view while the native runtime is unavailable."
          />
        )}
        <div className="border-t border-zinc-900 px-4 py-3 text-center">
          {error ? <p role="alert" className="mb-2 text-[11px] text-red-300">{error}</p> : null}
          <button
            type="button"
            onClick={() => {
              setError(null);
              setDescriptors(null);
              setDiscoveryNonce((current) => current + 1);
            }}
            className="rounded-md px-2.5 py-1 text-xs text-zinc-400 ring-1 ring-zinc-800 hover:bg-zinc-900 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
          >
            Retry native runtime
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 bg-zinc-950 text-zinc-200">
      <aside aria-label={`${presentation.providerLabel} tasks`} className="flex w-72 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950">
        <div className="border-b border-zinc-800/80 p-3">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium text-zinc-300">{presentation.providerLabel}</div>
              {homes.length > 1 ? (
                <label className="mt-1 block">
                  <span className="sr-only">{presentation.homeLabel}</span>
                  <select
                    value={home}
                    onChange={(event) => {
                      preferredTaskIdRef.current = null;
                      listRequestRef.current += 1;
                      setTasks([]);
                      setNextCursor(null);
                      transitionSelectedTask(null);
                      setFocusedTaskId(null);
                      setShowCreate(false);
                      setConnection("connecting");
                      setHome(event.target.value);
                    }}
                    disabled={Boolean(busy) || reconciliationScope !== null}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[10.5px] text-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
                  >
                    {homes.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
                  </select>
                </label>
              ) : (
                <div className="truncate text-[10.5px] text-zinc-600" title={home}>{home}</div>
              )}
            </div>
            {capabilities.start ? (
              <IconButton
                type="button"
                aria-label={`New native ${presentation.taskLabel}`}
                title={`New native ${presentation.taskLabel}`}
                onClick={() => setShowCreate((current) => !current)}
                disabled={Boolean(busy) || mutationsPaused}
              >
                <Plus className="h-4 w-4" />
              </IconButton>
            ) : null}
          </div>
        </div>

        {showCreate ? (
          <form aria-label={`New native ${presentation.taskLabel} setup`} onSubmit={createTask} className="space-y-2 border-b border-zinc-800/80 p-3">
            <label className="block text-[10.5px] text-zinc-500">
              Working folder
              <input
                autoFocus
                required
                disabled={busy === "create"}
                value={createCwd}
                onChange={(event) => setCreateCwd(event.target.value)}
                placeholder="/absolute/project/path"
                className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
              />
            </label>
            {provider === "openai" ? (
              <label className="block text-[10.5px] text-zinc-500">
                Model (optional)
                <input
                  disabled={busy === "create"}
                  value={createModel}
                  onChange={(event) => setCreateModel(event.target.value)}
                  placeholder="Provider default"
                  className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
                />
              </label>
            ) : (
              <p className="text-[10.5px] leading-relaxed text-zinc-600">
                {CLAUDE_MODEL_DISCLOSURE}
              </p>
            )}
            <label className="block text-[10.5px] text-zinc-500">
              Permission mode
              <select
                disabled={busy === "create"}
                value={createPermission}
                onChange={(event) => setCreatePermission(event.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
              >
                {presentation.permissionModes.map((mode) => (
                  <option key={mode.value} value={mode.value}>{mode.label}</option>
                ))}
              </select>
            </label>
            <label className="block text-[10.5px] text-zinc-500">
              First message ({providerRequiresFirstMessage(provider) ? "required" : "optional"})
              <textarea
                required={providerRequiresFirstMessage(provider)}
                disabled={busy === "create" || !capabilities.subscribe}
                rows={2}
                value={createPrompt}
                onChange={(event) => setCreatePrompt(event.target.value)}
                placeholder={capabilities.subscribe ? undefined : "Live event subscription is unavailable"}
                className="mt-1 w-full resize-y rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
              />
            </label>
            <p className="text-[10px] text-zinc-600">
              {PROVIDER_LOCK_DISCLOSURE}
              {!capabilities.subscribe ? " First-message turns require verified live events." : ""}
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowCreate(false)} disabled={busy === "create"} className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50 disabled:opacity-40">
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  !createCwd.trim() || busy === "create" || mutationsPaused ||
                  (providerRequiresFirstMessage(provider) && !createPrompt.trim()) ||
                  (createPrompt.trim().length > 0 && !capabilities.subscribe)
                }
                className="rounded-md bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-950 transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50 disabled:opacity-40"
              >
                {busy === "create" ? "Creating task…" : "Create task"}
              </button>
            </div>
          </form>
        ) : null}

        <div className="flex items-center justify-between border-b border-zinc-800/50 px-3 py-2">
          <span className="text-[10.5px] font-medium uppercase tracking-wide text-zinc-600">Native history</span>
          {capabilities.archive ? <label className="flex items-center gap-1.5 text-[10.5px] text-zinc-600">
            <input
              type="checkbox"
              disabled={Boolean(busy) || reconciliationScope !== null}
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
              className="accent-zinc-500"
            />
            Archived
          </label> : null}
        </div>

        <div ref={taskListRef} tabIndex={-1} role="listbox" aria-label={`Native ${presentation.product} task history`} aria-busy={listLoading} className="min-h-0 flex-1 overflow-y-auto p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-clay-500/50">
          {tasks.map((task, taskIndex) => (
            <button
              key={nativeTaskIdentity(task.key)}
              ref={(node) => {
                const identity = nativeTaskIdentity(task.key);
                if (node) taskOptionRefs.current.set(identity, node);
                else taskOptionRefs.current.delete(identity);
              }}
              data-native-task-option="true"
              type="button"
              role="option"
              aria-selected={selectedId === task.key.nativeTaskId}
              aria-label={`${task.title}, ${presentation.providerLabel}, ${task.status}`}
              title={task.title}
              tabIndex={(focusedTaskId ?? selectedId ?? tasks[0]?.key.nativeTaskId) === task.key.nativeTaskId ? 0 : -1}
              onFocus={() => setFocusedTaskId(task.key.nativeTaskId)}
              onClick={() => {
                preferredTaskIdRef.current = null;
                setFocusedTaskId(task.key.nativeTaskId);
                transitionSelectedTask(task.key.nativeTaskId);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  preferredTaskIdRef.current = null;
                  transitionSelectedTask(task.key.nativeTaskId);
                  return;
                }
                const nextIndex = taskIndexForKey(event.key, taskIndex, tasks.length);
                if (nextIndex === null) return;
                event.preventDefault();
                const next = tasks[nextIndex]!;
                setFocusedTaskId(next.key.nativeTaskId);
                taskOptionRefs.current
                  .get(nativeTaskIdentity(next.key))
                  ?.focus();
              }}
              disabled={listLoading || Boolean(busy) || reconciliationScope !== null}
              className={cn(
                "mb-0.5 w-full rounded-lg px-2.5 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50",
                selectedId === task.key.nativeTaskId ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
              )}
            >
              <div className="truncate text-[12.5px] font-medium">{task.title}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-zinc-600">
                <span className="truncate">{task.cwd ?? "No working folder"}</span>
                <span aria-hidden="true">·</span>
                <span className="shrink-0">
                  {task.source === "degraded-fallback" ? "Read-only fallback" : task.status}
                </span>
              </div>
            </button>
          ))}
          {listLoading && tasks.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-zinc-600">
              <Spinner className="h-3.5 w-3.5" /> Loading native history…
            </div>
          ) : null}
          {!listLoading && tasks.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-zinc-600">
              {connection === "disconnected" && error
                ? "Native history is unavailable until the provider check succeeds."
                : `No native ${presentation.product} tasks yet.`}
            </p>
          ) : null}
          {nextCursor ? (
            <button
              type="button"
              onClick={() => void loadList(home, { append: true, cursor: nextCursor })}
              disabled={listLoading || Boolean(busy) || reconciliationScope !== null}
              className="mt-2 w-full rounded-md px-2 py-1.5 text-xs text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50 disabled:opacity-40"
            >
              Load older tasks
            </button>
          ) : null}
        </div>
      </aside>

      <section aria-label={`Selected native ${presentation.taskLabel}`} aria-busy={taskLoading} className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-800/80 px-4">
          {selectedTask ? (
            <>
              {renameValue !== null ? (
                <form onSubmit={rename} className="flex min-w-0 flex-1 items-center gap-1.5">
                  <label className="sr-only" htmlFor="codex-native-rename">Native task name</label>
                  <input
                    id="codex-native-rename"
                    autoFocus
                    readOnly={busy === "rename"}
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
                  />
                  <IconButton type="submit" aria-label="Save task name" title="Save task name" disabled={!renameValue.trim() || busy === "rename"}>
                    <Check className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton type="button" aria-label="Cancel rename" title="Cancel rename" onClick={() => setRenameValue(null)} disabled={busy === "rename"}>
                    <X className="h-3.5 w-3.5" />
                  </IconButton>
                </form>
              ) : (
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-sm font-medium text-zinc-200">{selectedTask.title}</h2>
                  <p className="truncate text-[10.5px] text-zinc-600">
                    {presentation.providerLabel}{selectedTask.source === "degraded-fallback" ? " · Read-only fallback" : ""}{selectedTask.model ? ` · ${selectedTask.model}` : ""}{selectedTask.cwd ? ` · ${selectedTask.cwd}` : ""}
                  </p>
                </div>
              )}
              {renameValue === null ? (
                <div className="flex shrink-0 items-center gap-0.5">
                  {selectedCanMutate && capabilities.resume ? (
                    <button
                      type="button"
                      onClick={resume}
                      disabled={Boolean(busy) || (mutationsPaused && !policyRepairReady)}
                      className="rounded-md px-2 py-1 text-[11px] text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50 disabled:opacity-40"
                    >
                      {selectedNeedsPolicyRepair ? "Verify safe policy" : "Resume"}
                    </button>
                  ) : null}
                  {selectedCanMutate && capabilities.rename ? (
                    <IconButton type="button" aria-label="Rename native task" title="Rename native task" onClick={() => setRenameValue(selectedTask.title)} disabled={Boolean(busy) || mutationsPaused}>
                      <Pencil className="h-3.5 w-3.5" />
                    </IconButton>
                  ) : null}
                  {selectedCanMutate && capabilities.fork ? (
                    <IconButton type="button" aria-label="Fork native task" title="Fork native task" onClick={fork} disabled={Boolean(busy) || mutationsPaused}>
                      <GitFork className="h-3.5 w-3.5" />
                    </IconButton>
                  ) : null}
                  {/* M7: cross-provider fork is a SEPARATE entry point from the same-
                      provider `Fork native task` above — it hands off REVIEWED,
                      redacted context to a NEW native task on the other provider,
                      never a same-provider fork. Flag-off (or no discovered home for
                      the other provider) hides this entirely; there is no other way
                      to reach it. */}
                  {selectedCanMutate && crossProviderForkEnabled && crossProviderForkTargetHome ? (
                    <CrossProviderForkPanel
                      enabled={crossProviderForkEnabled}
                      source={{
                        provider: selectedTask.key.provider,
                        title: selectedTask.title,
                        nativeTaskId: selectedTask.key.nativeTaskId,
                      }}
                      target={{
                        provider: otherProvider,
                        home: crossProviderForkTargetHome,
                        cwd: selectedTask.cwd ?? crossProviderForkTargetHome,
                      }}
                      fetchPreview={() =>
                        client.forkPreviewCrossProvider(selectedTask.key, {
                          provider: otherProvider,
                          home: crossProviderForkTargetHome,
                          cwd: selectedTask.cwd ?? crossProviderForkTargetHome,
                        })
                      }
                      commitPreview={(previewId) =>
                        client.forkCommitCrossProvider(
                          selectedTask.key,
                          { provider: otherProvider, home: crossProviderForkTargetHome },
                          previewId,
                        )
                      }
                      className="rounded-md px-2 py-1 text-[11px] text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50 disabled:opacity-40"
                    />
                  ) : null}
                  {selectedCanMutate && capabilities.archive ? (
                    <IconButton type="button" aria-label="Archive native task" title="Archive native task" onClick={(event) => {
                      archiveTriggerRef.current = event.currentTarget;
                      archiveCompletedRef.current = false;
                      setConfirmArchive(true);
                    }} disabled={Boolean(busy) || mutationsPaused}>
                      <Archive className="h-3.5 w-3.5" />
                    </IconButton>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <div className="text-sm text-zinc-600">{presentation.providerLabel}</div>
          )}
        </div>

        {reconciliationScope || connectionMessage(connection) ? (
          <div role="status" aria-live="polite" className="flex items-center gap-2 border-b border-amber-900/40 bg-amber-500/5 px-4 py-2 text-[11.5px] text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            <span>
              {reconciliationScope?.kind === "provider-home"
                ? reconciliationScope.phase === "review"
                  ? `Native provider state was refreshed after the uncertain ${reconciliationScope.operation}. Review it before enabling another mutation.`
                  : "A provider mutation outcome is uncertain. Refresh native state before continuing."
                : reconciliationScope?.kind === "task"
                  ? reconciliationScope.phase === "review"
                    ? reconciliationScope.operation === "archive" && reconciliationScope.observedArchived
                      ? "Native task state confirms the uncertain archive succeeded. Review the archived read-only task before enabling another mutation."
                      : `Native task state was refreshed after the uncertain ${reconciliationScope.operation}. Review it before enabling another mutation.`
                    : "This task must be checked against native state before another mutation."
                  : reconciliationScope?.kind === "task-policy"
                    ? "This task's effective safety policy is unverified. Only a verified safe Resume can unlock mutations."
                  : !selectedId && connection === "disconnected"
                    ? "Native task history could not be refreshed. Retry the provider history check."
                    : connectionMessage(connection)}
            </span>
            {reconciliationReviewReady(reconciliationScope) ? (
              <button
                type="button"
                onClick={acknowledgeReviewedState}
                disabled={acknowledgingReconciliation}
                className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-amber-200 transition hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50 disabled:opacity-40"
              >
                I reviewed native state
              </button>
            ) : reconciliationScope?.kind === "task-policy" && connection === "connected" && capabilities.resume ? (
              <button
                type="button"
                onClick={resume}
                disabled={Boolean(busy)}
                className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-amber-200 transition hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50 disabled:opacity-40"
              >
                Verify safe policy
              </button>
            ) : connection === "disconnected" ? (
              <button
                type="button"
                onClick={() => void checkNativeState()}
                className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-amber-200 transition hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
              >
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                {reconciliationScope?.kind === "provider-home"
                  ? "Check provider state"
                  : selectedId
                    ? "Check task status"
                    : "Retry native history"}
              </button>
            ) : connection === "reconnecting" ? (
              <button
                type="button"
                onClick={cancelStateCheck}
                className="ml-auto rounded-md px-2 py-1 text-[11px] text-amber-200 transition hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
              >
                Cancel check
              </button>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <div role="alert" className="flex items-start gap-2 border-b border-red-900/40 bg-red-500/5 px-4 py-2 text-[11.5px] text-red-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss error" className="rounded p-0.5 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        {notice ? (
          <div role="status" aria-live="polite" className="flex items-start gap-2 border-b border-sky-900/40 bg-sky-500/5 px-4 py-2 text-[11.5px] text-sky-200">
            <span className="min-w-0 flex-1">{notice}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss status" className="rounded p-0.5 hover:bg-sky-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}

        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-announcement-id={liveAnnouncement?.id ?? 0}
          className="sr-only"
        >
          {liveAnnouncement?.text ?? ""}
        </div>

        {confirmArchive && selectedTask && typeof document !== "undefined" ? createPortal((
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && busy !== "archive") setConfirmArchive(false);
            }}
          >
            <div
              ref={archiveDialogRef}
              tabIndex={-1}
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="codex-archive-title"
              aria-describedby="codex-archive-description"
              className="w-full max-w-md rounded-xl border border-amber-900/50 bg-zinc-950 p-5 shadow-2xl"
            >
              <div id="codex-archive-title" className="text-sm font-medium text-amber-200">Archive “{selectedTask.title}” in {presentation.providerLabel}?</div>
              <p id="codex-archive-description" className="mt-2 text-xs leading-relaxed text-zinc-500">This changes the provider-native record. The task content remains readable when archived history is shown.</p>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setConfirmArchive(false)} disabled={busy === "archive"} className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50 disabled:opacity-40">Cancel</button>
                <button type="button" onClick={archive} disabled={busy === "archive"} className="rounded-md bg-amber-700 px-3 py-1.5 text-xs font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50 disabled:opacity-40">{busy === "archive" ? "Archiving…" : "Archive native task"}</button>
              </div>
            </div>
          </div>
        ), document.body) : null}

        <div className="relative min-h-0 flex-1">
          <div
            ref={timelineScrollRef}
            onScroll={timelineStick.onScroll}
            className="h-full overflow-y-auto"
          >
          {taskLoading && !selectedTask ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-600">
              <Spinner className="h-4 w-4" /> Loading native task…
            </div>
          ) : selectedTask && capabilities ? (
            <VirtualizedCodexNativeTimeline
              timeline={timeline}
              capabilities={capabilities}
              onRespond={respond}
              disabled={Boolean(busy) || mutationsPaused || !selectedCanMutate || !capabilities.subscribe}
              scrollRef={timelineScrollRef}
              product={presentation.product}
            />
          ) : (
            <EmptyState icon={<Bot className="h-11 w-11" />} title={`Select a native ${presentation.taskLabel}`} hint="Choose history on the left or create a new task." />
          )}
          </div>
          {timelineStick.showJumpToLatest && selectedTask ? (
            <button
              type="button"
              onClick={() => timelineStick.scrollToLatest(() => {
                const element = timelineScrollRef.current;
                if (element) element.scrollTop = element.scrollHeight;
              })}
              className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-zinc-800 px-3 py-1.5 text-[11px] font-medium text-zinc-200 shadow-lg ring-1 ring-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
            >
              <ArrowDown className="h-3 w-3" aria-hidden="true" /> Jump to latest
            </button>
          ) : null}
        </div>

        {selectedTask && selectedCanMutate && capabilities.subscribe && (
          activeTurnId
            ? capabilities.steer || capabilities.interrupt
            : capabilities.send
        ) ? (
          <form onSubmit={sendOrSteer} className="shrink-0 border-t border-zinc-800/80 p-3">
            <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-zinc-800 bg-zinc-900 p-2 shadow-lg shadow-black/10 focus-within:border-zinc-700">
              <label className="sr-only" htmlFor="codex-native-composer">
                {activeTurnId && capabilities.steer ? `Steer active ${presentation.product} turn` : `Continue native ${presentation.taskLabel}`}
              </label>
              <textarea
                id="codex-native-composer"
                ref={composerRef}
                rows={2}
                readOnly={Boolean(busy)}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={codexComposerPlaceholder(
                  mutationsPaused,
                  Boolean(activeTurnId),
                  capabilities.steer,
                )}
                className="max-h-40 min-h-12 min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600 disabled:cursor-not-allowed"
              />
              {activeTurnId && capabilities.interrupt ? (
                <IconButton type="button" aria-label={pendingInterruptTurnId ? "Interrupt requested" : `Interrupt active ${presentation.product} turn`} title={pendingInterruptTurnId ? "Interrupt requested" : `Interrupt active ${presentation.product} turn`} onClick={interrupt} disabled={Boolean(busy) || mutationsPaused || pendingInterruptTurnId === activeTurnId} className="mb-0.5 bg-zinc-100 text-zinc-950 hover:bg-white hover:text-zinc-950">
                  <Square className="h-3.5 w-3.5 fill-current" />
                </IconButton>
              ) : null}
              {!activeTurnId || capabilities.steer ? (
                <IconButton
                  type="submit"
                  aria-label={activeTurnId ? `Steer active ${presentation.product} turn` : `Send to native ${presentation.taskLabel}`}
                  title={activeTurnId ? `Steer active ${presentation.product} turn` : `Send to native ${presentation.taskLabel}`}
                  disabled={!draft.trim() || Boolean(busy) || mutationsPaused || Boolean(activeTurnId && !capabilities.steer)}
                  className="mb-0.5 bg-zinc-100 text-zinc-950 hover:bg-white hover:text-zinc-950"
                >
                  <Send className="h-3.5 w-3.5" />
                </IconButton>
              ) : null}
            </div>
          </form>
        ) : selectedTask ? (
          <div className="border-t border-zinc-800/80 px-4 py-3 text-center text-xs text-zinc-600">
            {selectedTask.source === "degraded-fallback"
              ? "Read-only fallback. Native mutations are unavailable for this task."
              : selectedTask.archived
                ? "Archived native task. History remains readable; mutations are unavailable."
              : capabilities.send && !capabilities.subscribe
                ? "Live task mutations require a verified native event subscription. History remains read-only."
              : "This task is read-only for the verified provider capability set."}
          </div>
        ) : null}
      </section>
    </div>
  );
}

export default CodexNativePane;
