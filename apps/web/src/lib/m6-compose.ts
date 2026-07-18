import type { FileEntry } from "../components/features/inspectors/InspectorDock.js";
import type { DiffContent, EnvironmentSummary } from "../components/features/inspectors/InspectorDock.js";
import type {
  ProviderId,
  SearchNavigationTarget,
  SearchResult,
} from "../components/features/search/TaskSearchDialog.js";
import type { TaskRailSection, TaskRailTask } from "../components/features/shell/TaskRail.js";
import { boundRawDiagnostic, type ThreadItem } from "../components/features/shell/ThreadWorkspace.js";
import { displaySearchHitTitle, displaySessionTitle } from "./session-title.js";
import type { GitStatus, NormalizedMessage, SearchHitWithSeq, SessionSummary } from "./types.js";

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
 * Build the InspectorDock's persistent Environment summary from REAL repository
 * status + the transcript's own aggregated file changes. Every row is backed: a
 * `null`/absent `gitStatus` (no cwd, or the git read hasn't landed yet) means the
 * branch/changes rows are simply omitted — never a placeholder value.
 */
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

/** Build the Diff destination's content from the transcript's aggregated file changes. */
export function buildDiffContent(fileChanges: readonly FileChangeLike[]): DiffContent {
  const totals = fileChanges.reduce(
    (acc, c) => ({ added: acc.added + c.added, removed: acc.removed + c.removed }),
    { added: 0, removed: 0 },
  );
  return {
    files: fileChanges.map((c) => c.filePath),
    summary:
      fileChanges.length > 0
        ? `${fileChanges.length} ${fileChanges.length === 1 ? "file" : "files"} · +${totals.added} -${totals.removed}`
        : undefined,
  };
}

/** Build the Files destination's content from the transcript's aggregated file changes. */
export function buildFilesContent(fileChanges: readonly FileChangeLike[]): FileEntry[] {
  return fileChanges.map((c) => ({ path: c.filePath }));
}

/**
 * Map real transcript messages onto `ThreadWorkspace`'s `ThreadItem` union. Plain
 * text is the ONLY thing rendered as `user`/`assistant` prose; every other block
 * (tool_use, tool_result, image, thinking, unknown) becomes a bounded `raw`
 * diagnostic instead of a fabricated tool card — the exact honest fallback
 * `ThreadWorkspace`'s own model reserves for real data this mapper doesn't (yet)
 * render richly (`design-lock.md` §4's "unknown native event → bounded raw
 * diagnostic, never a fabricated tool"). Never drops a message silently: an
 * empty-text message with no other blocks contributes nothing, which is honest
 * (there was nothing to show), not a bug.
 */
export function mapMessagesToThreadItems(messages: readonly NormalizedMessage[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const m of messages) {
    const key = m.uuid ?? `seq-${m.seq}`;
    const text = m.blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n\n")
      .trim();
    if (text) {
      if (m.role === "user") items.push({ kind: "user", id: `${key}-text`, content: text });
      else if (m.role === "assistant") items.push({ kind: "assistant", id: `${key}-text`, content: text });
      // Other roles (system/hook/queue/attachment/meta) fall through to the raw
      // diagnostic below along with any non-text block, so nothing real is lost.
      else items.push({ kind: "raw", id: `${key}-text`, raw: boundRawDiagnostic(`[${m.role}] ${text}`) });
    }
    let i = 0;
    for (const b of m.blocks) {
      if (b.type === "text") continue;
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
