import type { InspectorChangedFile } from "../components/features/inspectors/InspectorDock.js";
import type {
  ProviderId,
  SearchNavigationTarget,
  SearchResult,
} from "../components/features/search/TaskSearchDialog.js";
import type { TaskRailSection, TaskRailTask } from "../components/features/shell/TaskRail.js";
import { boundRawDiagnostic, type ThreadItem } from "../components/features/shell/ThreadWorkspace.js";
import { pairToolResults, type PairedToolUse } from "./transcript.js";
import { displaySearchHitTitle, displaySessionTitle } from "./session-title.js";
import type {
  GitStatus,
  NormalizedMessage,
  RunningSession,
  SearchHitWithSeq,
  SessionSummary,
} from "./types.js";

/**
 * Pure App.tsx→M6-shell data adapters (M6 Task 9, the non-cutover composition pass).
 *
 * Every M6 slice component (Tasks 1-8) is pure presentation over an explicit model;
 * none of them read App state directly. These functions are the SEAM that maps real
 * live App state (sessions, git status, search hits, file changes) onto those models,
 * so `App.tsx` stays composition/routing and the mapping itself stays unit-testable
 * without mounting React. Every mapping here is HONEST: it derives provider identity
 * from the composite key / the known-Claude legacy code path only, never guesses one
 * from text, and never fabricates a capability the underlying data doesn't back.
 */

/** Legacy Claude sessions are the ONLY provider this composite-key encoding names. */
export const LEGACY_SESSION_PROVIDER: ProviderId = "anthropic";
const KEY_SEPARATOR = "\u0000";

/**
 * Build the TaskRail's task rows for the currently active project's session list.
 * Every row is real session data — never a placeholder — and provider is always
 * `anthropic` because these are legacy Claude sessions (the ONLY provider this list
 * can honestly carry; a native Codex/Claude task lives in `CodexNativePane`, not this
 * list, and its rows are a separate, still-gated data-wire). Sorted by most-recent
 * activity, capped so the rail never renders an unbounded list.
 */
export function buildTaskRailSections(
  sessions: readonly SessionSummary[],
  sectionLabel: string,
  maxRows = 50,
): TaskRailSection[] {
  if (sessions.length === 0) return [];
  const tasks: TaskRailTask[] = [...sessions]
    .sort((a, b) => (b.lastTimestamp ?? "").localeCompare(a.lastTimestamp ?? ""))
    .slice(0, maxRows)
    .map((s) => ({
      id: s.sessionId,
      title: displaySessionTitle(s, sectionLabel),
      provider: LEGACY_SESSION_PROVIDER,
    }));
  return [{ id: "sessions", label: sectionLabel, tasks }];
}

/**
 * Sidebar/topbar run-status derivation (Aurora Cockpit §3.1/§3.2).
 *
 * The ONLY honest source of a session's live run state is a `RunningSession` from
 * `api.running()` (see hooks/useStatsPolling) joined to the session by `sessionId` —
 * `SessionSummary` itself carries NO status/provider (spec §3.1's inventory was
 * wrong; this is the corrected contract). A session with no running entry has no
 * live state, so it groups as idle/recent and renders no status dot.
 *
 * Mapping (matches the shared `StatusDot` variants in components/ui/StatusDot.tsx):
 *   needsYou            → "waiting"  (waiting on you — the "Needs review" signal)
 *   stale/dead/!alive   → "failed"   (busy-but-silent / exited)
 *   busy/alive          → "running"
 *   status "waiting"    → "waiting"  (agent parked on a tool, not yet needsYou)
 *   otherwise           → "idle"
 */
export type RailRunStatus = "running" | "waiting" | "idle" | "failed";

export function deriveRunStatus(r: RunningSession | null | undefined): RailRunStatus | undefined {
  if (!r) return undefined;
  if (r.needsYou) return "waiting";
  if (r.stale || r.alive === false || r.status === "dead") return "failed";
  if (r.status === "busy" || r.alive === true) return "running";
  if (r.status === "waiting") return "waiting";
  return "idle";
}

/**
 * One-line human reason a session sits in the sidebar's "Needs you" tier (§3.1v2
 * inbox cards). Composed ONLY from real `RunningSession` fields — `waitingFor` is
 * the permission-prompt/tool string Claude Code itself reported; the fallbacks
 * describe the real `alive`/`stale` flags. Returns undefined when the run carries
 * no explainable signal (the card then simply renders no reason line).
 */
export function describeRunReason(
  r: RunningSession,
  status: RailRunStatus | undefined,
): string | undefined {
  if (r.waitingFor) return `Asked: "${r.waitingFor}"`;
  if (r.needsYou) return "Needs your approval";
  if (status === "waiting") return "Waiting";
  if (status === "failed") return r.alive === false ? "Process exited" : "Stalled — no recent progress";
  return undefined;
}

/** Index the running list by sessionId for O(1) joins against the session list. */
export function indexRunningBySession(
  running: readonly RunningSession[] | null | undefined,
): Map<string, RunningSession> {
  const map = new Map<string, RunningSession>();
  for (const r of running ?? []) map.set(r.sessionId, r);
  return map;
}

/** The four sidebar session groups (§3.1), derived from the running join. */
export interface SessionGroups {
  /** Actively working now. */
  running: SessionSummary[];
  /** Waiting on you — needsYou / `deriveRunStatus === "waiting"` ONLY. This is the
   * one honest "needs you" definition, shared with the StatusBar count and the
   * Ops Grid/Board's `needsYou` bucket (see `opsHelpers.attentionBucket`) — a
   * session either waits on you or it doesn't, and that can't disagree with
   * itself depending which surface you're looking at (W3-COUNTS). */
  needsReview: SessionSummary[];
  /** Busy-but-silent / exited — its OWN bucket, never folded into `needsReview`. */
  stale: SessionSummary[];
  /** No live run entry — recent/idle history. */
  idle: SessionSummary[];
}

/**
 * Group real sessions into Running / Needs review / Stale / Idle by joining
 * `api.running()` on `sessionId`. Never fabricates status: a session absent from
 * `running` is idle. Sessions stay sorted most-recent-first within each group.
 */
export function groupSessionsByRunStatus(
  sessions: readonly SessionSummary[],
  running: readonly RunningSession[] | null | undefined,
): SessionGroups {
  const byId = indexRunningBySession(running);
  const sorted = [...sessions].sort((a, b) =>
    (b.lastTimestamp ?? "").localeCompare(a.lastTimestamp ?? ""),
  );
  const groups: SessionGroups = { running: [], needsReview: [], stale: [], idle: [] };
  for (const s of sorted) {
    const status = deriveRunStatus(byId.get(s.sessionId));
    if (status === "running") groups.running.push(s);
    else if (status === "waiting") groups.needsReview.push(s);
    else if (status === "failed") groups.stale.push(s);
    else groups.idle.push(s);
  }
  return groups;
}

/**
 * Map a legacy `/api/search` hit onto the M6 `SearchResult` contract. The composite
 * task key names `anthropic` because a legacy session search hit IS Claude data —
 * this is never a guess from message text, just the honest encoding of a fact the
 * legacy index already knows (the hit came from the Claude session index).
 */
export function searchHitToResult(hit: SearchHitWithSeq): SearchResult {
  return {
    taskKey: [LEGACY_SESSION_PROVIDER, hit.projectId, hit.sessionId].join(KEY_SEPARATOR),
    title: displaySearchHitTitle(hit),
    projectName: hit.projectName,
    snippet: hit.snippet,
    seq: hit.seq,
    degraded: false,
  };
}

/** The legacy (projectId, sessionId) pair a search navigation target resolves to. */
export interface LegacySearchDestination {
  projectId: string;
  sessionId: string;
  seq?: number;
}

/** Invert a provider-locked navigation target back to the legacy Browse route. */
export function legacyDestinationForTarget(target: SearchNavigationTarget): LegacySearchDestination {
  return {
    projectId: target.home,
    sessionId: target.nativeTaskId,
    seq: target.seq > 0 ? target.seq : undefined,
  };
}

/** One aggregated file change, as produced by `FileChangeSummary`'s `buildFileChanges`. */
export interface FileChangeLike {
  filePath: string;
  added: number;
  removed: number;
}

/**
 * The InspectorDock's WORKTREE summary, derived from REAL repository status + the
 * transcript's aggregated file changes. Local shape (branch + changes) — the dock's
 * `InspectorWorktree` prop is built from this at the call site. Every field is
 * backed: a `null`/absent `gitStatus` (no cwd, or the git read hasn't landed yet)
 * means `branch` is omitted; no file changes means `changes` is omitted — never a
 * placeholder value.
 */
export interface EnvironmentSummary {
  branch?: string;
  changes?: string;
}

/** Aurora Cockpit §3.3: build the WORKTREE section's branch + change summary. */
export function buildEnvironmentSummary(
  gitStatus: GitStatus | null,
  fileChanges: readonly FileChangeLike[],
): EnvironmentSummary {
  const totals = fileChanges.reduce(
    (acc, c) => ({ added: acc.added + c.added, removed: acc.removed + c.removed }),
    { added: 0, removed: 0 },
  );
  const env: EnvironmentSummary = {};
  if (fileChanges.length > 0) {
    env.changes = `${fileChanges.length} ${fileChanges.length === 1 ? "file" : "files"} · +${totals.added} -${totals.removed}`;
  }
  if (gitStatus?.branch) env.branch = gitStatus.branch;
  return env;
}

/**
 * Build the InspectorDock CHANGED-FILES section (§3.3): file path + line deltas only,
 * NO diff hunks (owner: no diff-forward UI in chat). Derived from the transcript's
 * aggregated file changes; empty in → empty out (the dock shows `No changes`).
 */
export function buildChangedFiles(fileChanges: readonly FileChangeLike[]): InspectorChangedFile[] {
  return fileChanges.map((c) => ({ path: c.filePath, added: c.added, removed: c.removed }));
}

/**
 * Harness-internal text that arrives on a `user`-role message — Claude Code
 * itself appends these, never something the human actually typed — so role
 * alone can't route them: a subagent-completion `<task-notification>…
 * </task-notification>` XML block, or the `[Image: original …Multiply
 * coordinates by N.NN…]` scaling note it prepends when a pasted screenshot
 * gets downscaled. Matched by real, observed prefixes (not a guess) so this
 * collapses to the same one-line raw diagnostic as [hook]/[queue]/[attachment]
 * below, instead of rendering as a fabricated "You" bubble (W3-TX, M8 remainder).
 */
function isHarnessInternalUserText(text: string): boolean {
  return harnessInternalUserLabel(text) !== null;
}

/**
 * A human label for harness-internal text that arrives on a `user`-role message,
 * or null when it's genuine typed conversation. These are markers Claude Code
 * appends itself (never the human): a subagent `<task-notification>` block, the
 * `[Image: original … Multiply coordinates …]` downscale note, and the bare
 * `[image]`/`[attachment]` placeholders the parser emits for non-text content.
 * Matched by observed prefixes so a real message is never misrouted. Used both to
 * ROUTE these to a collapsed raw row (not a fabricated "You" bubble) and to LABEL
 * that row so the raw token never surfaces as conversation text (QA MAJOR).
 */
function harnessInternalUserLabel(text: string): string | null {
  const t = text.trimStart();
  if (t.startsWith("<task-notification")) return "Task update";
  if (t.startsWith("[Image: original ")) return "Image (scaled for display)";
  if (/^\[image\]$/i.test(t)) return "Image";
  if (/^\[attachment\]/i.test(t)) return "Attachment";
  if (/^\[system[:\]]/i.test(t)) return "System event";
  return null;
}

/** Human label for a non-user/assistant plumbing role (system/hook/queue/…). */
function roleLabel(role: string): string {
  switch (role) {
    case "hook":
      return "Hook";
    case "queue":
      return "Queued message";
    case "attachment":
      return "Attachment";
    case "system":
      return "System event";
    default:
      return "System event";
  }
}

/**
 * Map real transcript messages onto `ThreadWorkspace`'s `ThreadItem` union. Plain
 * text renders as `user`/`assistant` prose; a `tool_use` block (with its paired
 * `tool_result` attached — see `pairToolResults`) renders as ONE compact tool card
 * (Aurora Cockpit §3.3); every OTHER block (image, unknown, or an orphan tool_result
 * whose tool_use scrolled out of the window) still becomes a bounded `raw`
 * diagnostic rather than a fabricated card — the honest fallback the model reserves
 * for real data we don't render richly (`design-lock.md` §4's "unknown native event
 * → bounded raw diagnostic, never a fabricated tool"). Never drops a message
 * silently: an empty-text message with no other blocks contributes nothing, which is
 * honest (there was nothing to show), not a bug.
 *
 * Internal plumbing — a non-user/assistant role's text (system/hook/queue/
 * attachment/meta), a `user`-role message whose TEXT is actually harness-internal
 * (see `isHarnessInternalUserText`), and `thinking` blocks — is real data too, so it
 * still becomes a `raw` item, but `collapsed: true` (M8: these used to render as
 * always-open JSON dumps that read as chat content, e.g. `[queue] [queued: enqueue]
 * {...}`). The full bounded text stays one click away; only the default visual
 * weight changes.
 */
export function mapMessagesToThreadItems(messages: readonly NormalizedMessage[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  // Attach each tool_result to its tool_use so a call is ONE card, not two entries;
  // consumed standalone results are dropped. Orphan results (tool_use out of window)
  // are left in place and fall through to the raw diagnostic below.
  const paired = pairToolResults([...messages]);
  for (const m of paired) {
    const key = m.uuid ?? `seq-${m.seq}`;
    const text = m.blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n\n")
      .trim();
    if (text) {
      const internalUserLabel = m.role === "user" ? harnessInternalUserLabel(text) : null;
      if (m.role === "user" && !internalUserLabel) {
        items.push({ kind: "user", id: `${key}-text`, content: text });
      } else if (m.role === "assistant") {
        items.push({ kind: "assistant", id: `${key}-text`, content: text });
      } else {
        // Internal plumbing (system/hook/queue/attachment/meta), OR a `user`-role
        // message that's actually harness-internal: collapsed + labelled with a
        // human summary so the raw marker never reads as conversation text, not
        // dropped (QA MAJOR: `[assistant:thinking]`, `[system: …]`, `[Image: …]`).
        items.push({
          kind: "raw",
          id: `${key}-text`,
          raw: boundRawDiagnostic(`[${m.role}] ${text}`),
          collapsed: true,
          summary: internalUserLabel ?? roleLabel(m.role),
        });
      }
    }
    let i = 0;
    for (const b of m.blocks) {
      if (b.type === "text") continue;
      if (b.type === "tool_use") {
        // A real tool call → one compact card. `pairToolResults` may have attached
        // a `.result`; ToolCard renders the collapsed one-line result from it.
        items.push({ kind: "tool", id: `${key}-${i}`, block: b as PairedToolUse });
        i++;
        continue;
      }
      if (b.type === "thinking") {
        // Reasoning text, collapsed under a human "Reasoning" label — not a
        // fabricated JSON blob and not the raw `[assistant:thinking]` token, which
        // used to surface as conversation text (QA MAJOR).
        items.push({
          kind: "raw",
          id: `${key}-${i}`,
          raw: boundRawDiagnostic(`[${m.role}:thinking] ${(b as { text?: string }).text ?? ""}`),
          collapsed: true,
          summary: "Reasoning",
        });
        i++;
        continue;
      }
      if (b.type === "image") {
        // A real image block: collapse to a clean "Image" row instead of dumping
        // `[role:image] {json}` inline (QA MAJOR — raw protocol token as chat text).
        items.push({
          kind: "raw",
          id: `${key}-${i}`,
          raw: boundRawDiagnostic(`[${m.role}:image] ${JSON.stringify(b)}`),
          collapsed: true,
          summary: "Image",
        });
        i++;
        continue;
      }
      items.push({
        kind: "raw",
        id: `${key}-${i}`,
        raw: boundRawDiagnostic(`[${m.role}:${b.type}] ${JSON.stringify(b)}`),
      });
      i++;
    }
  }
  return items;
}
