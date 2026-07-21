import type { StatusKind } from "../../ui/StatusDot";
import type { ChipProvider } from "../../ui/ProviderChip";
import type { RunningSession, SessionSummary } from "../../../lib/types";
import { deriveRunStatus } from "../../../lib/m6-compose";
import { displaySessionTitle } from "../../../lib/session-title";

/**
 * Shared Live Ops derivations (Aurora Cockpit §3.7). The Glass Grid
 * (`MultiSessionGrid`), the Attention Board (`LiveOpsBoard`), and the Drive panel
 * (`MultiSessionDrive`) all render the SAME running-session model, so the honest
 * joins + status buckets live here once.
 *
 * Every value is backed by real data: a session's run state comes only from its
 * `RunningSession` (from `api.running()`), and cost/title/branch come from the
 * indexed `SessionSummary` joined on `sessionId`. Nothing is invented — a field
 * we don't have simply doesn't render at the call site.
 *
 * The bucket classification below DELEGATES to `deriveRunStatus` (m6-compose) —
 * the same function the sidebar tiers and StatusBar use. It used to reimplement
 * its own, subtly different rules here, which is exactly how the app ended up
 * showing contradictory counts from the SAME poll snapshot (D3/M7): a session
 * parked waiting on a tool read as "waiting" in the sidebar but "running" in Ops,
 * so "2 running" and "1 running" and "0 running" could all be true at once,
 * depending which component you looked at. One classification function, fed the
 * same data, can't disagree with itself.
 */

/** Last path segment of a working directory (the "project" name). */
export function lastSegment(cwd: string | null): string {
  if (!cwd) return "unknown";
  const parts = cwd.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || cwd;
}

/**
 * Provider identity from a model id — Claude vs Codex/OpenAI. Pure name
 * inspection (never guessed from behavior); anything unrecognized returns null so
 * the caller renders NO chip rather than a wrong one.
 */
export function providerFromModel(model: string | null | undefined): ChipProvider | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (/claude|opus|sonnet|haiku|fable/.test(m)) return "anthropic";
  if (/gpt|codex|openai|^o1|^o3|^o4/.test(m)) return "openai";
  return null;
}

/** Compact "elapsed since" for an epoch-ms timestamp (5s / 3m / 2h / 4d). */
export function agoMs(sinceMs: number | null | undefined, nowMs: number): string {
  if (!sinceMs) return "—";
  const sec = Math.max(0, Math.round((nowMs - sinceMs) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

/**
 * The four Attention-Board buckets (§3.7), in priority order. Also drives the
 * Glass Grid's status treatment. Mapped 1:1 from the shared `RailRunStatus`
 * (m6-compose's `deriveRunStatus` — see the module doc above for why):
 *   needsYou  ← "waiting"  (blocked on the user OR parked on a tool, loudest)
 *   stale     ← "failed"   (busy-but-silent / dead PID — crashed mid-turn)
 *   running   ← "running"  (actively working)
 *   finished  ← "idle" (or no live entry) — ran, now awaiting review
 */
export type OpsBucket = "needsYou" | "running" | "stale" | "finished";

export function attentionBucket(s: RunningSession): OpsBucket {
  switch (deriveRunStatus(s)) {
    case "waiting":
      return "needsYou";
    case "failed":
      return "stale";
    case "running":
      return "running";
    default:
      return "finished";
  }
}

/** Map a bucket to the shared `StatusDot` variant (§1.1E). */
export function bucketStatusKind(bucket: OpsBucket): StatusKind {
  switch (bucket) {
    case "needsYou":
      return "waiting";
    case "stale":
      return "failed";
    case "finished":
      return "idle";
    case "running":
      return "running";
  }
}

/** Human label for a bucket (paired with the dot so color is never the only cue). */
export function bucketLabel(bucket: OpsBucket): string {
  switch (bucket) {
    case "needsYou":
      return "needs you";
    case "stale":
      return "stale";
    case "finished":
      return "finished";
    case "running":
      return "running";
  }
}

/** Index the running list by sessionId (defensive: first entry per id wins). */
export function indexRunning(running: readonly RunningSession[] | null | undefined): Map<string, RunningSession> {
  const map = new Map<string, RunningSession>();
  for (const s of running ?? []) {
    if (!map.has(s.sessionId)) map.set(s.sessionId, s);
  }
  return map;
}

/** Index sessions by sessionId for the cost/title/branch join. */
export function indexSessions(sessions: readonly SessionSummary[] | null | undefined): Map<string, SessionSummary> {
  const map = new Map<string, SessionSummary>();
  for (const s of sessions ?? []) map.set(s.sessionId, s);
  return map;
}

/**
 * A title that's really just a bare integer masquerading as a name — the root
 * cause of D2 (a `<pid>.json`'s `name` field can carry a raw turn/message counter
 * instead of a real title, which rendered as literal `"1"` cards in Ops/Drive/the
 * add-panel picker). A genuine session or project name is never a bare digit
 * string, so this is a narrow rejection of an obviously-wrong value — never a
 * guess about which name IS right.
 */
function looksLikeBareIndex(name: string): boolean {
  return /^\d+$/.test(name.trim());
}

/**
 * The ops-surface title for a running session (D2, single source for Grid/Board/
 * Drive/the add-panel picker). Prefers the REAL, derived title from the joined
 * `SessionSummary` — the SAME `displaySessionTitle` the sidebar/rail use — over
 * the process's raw self-reported `name`, since that field isn't always a title
 * (see `looksLikeBareIndex`). Falls back to `r.name` only when it looks like a
 * real name and there's no indexed session, then the cwd's basename, then an
 * honest "Untitled session {shortId}" — never a raw counter.
 */
export function resolveOpsTitle(r: RunningSession, s: SessionSummary | undefined): string {
  const cwdName = lastSegment(r.cwd);
  const knownProjectName = cwdName === "unknown" ? undefined : cwdName;
  if (s) return displaySessionTitle(s, knownProjectName);
  if (r.name && !looksLikeBareIndex(r.name)) return r.name;
  if (knownProjectName) return knownProjectName;
  return r.sessionId ? `Untitled session ${r.sessionId.slice(0, 8)}` : "Untitled session";
}

/**
 * A running session enriched with its indexed `SessionSummary` (when the session
 * is indexed). `title`/`cost`/`branch`/`provider` are ALL nullable — the join may
 * miss (a brand-new session isn't indexed yet), and the card omits what's absent.
 */
export interface OpsEntry {
  running: RunningSession;
  bucket: OpsBucket;
  /** Best display name, via `resolveOpsTitle`: the indexed session's real title, else the process's own name (if not a bare index), else the cwd basename. */
  title: string;
  /** Joined session cost (USD), when the session is indexed. */
  costUsd: number | null;
  /** Branch from the indexed session, when known. */
  branch: string | null;
  /** Provider derived from the model id, when recognized. */
  provider: ChipProvider | null;
}

/**
 * Build the ordered, joined ops model from the live running list + the session
 * index. Sorted needs-you first (oldest waiting leads), then running, stale,
 * finished; newest activity breaks ties within a bucket.
 */
export function buildOpsEntries(
  running: readonly RunningSession[] | null | undefined,
  sessionsById: Map<string, SessionSummary>,
): OpsEntry[] {
  const seen = new Set<string>();
  const entries: OpsEntry[] = [];
  for (const r of running ?? []) {
    if (r.sessionId && seen.has(r.sessionId)) continue;
    if (r.sessionId) seen.add(r.sessionId);
    const s = r.sessionId ? sessionsById.get(r.sessionId) : undefined;
    const bucket = attentionBucket(r);
    entries.push({
      running: r,
      bucket,
      title: resolveOpsTitle(r, s),
      costUsd: typeof s?.costUsd === "number" ? s.costUsd : null,
      branch: s?.gitBranch ?? null,
      provider: providerFromModel(r.model ?? s?.model ?? null),
    });
  }
  const rank: Record<OpsBucket, number> = { needsYou: 0, running: 1, stale: 2, finished: 3 };
  return entries.sort((a, b) => {
    const ra = rank[a.bucket];
    const rb = rank[b.bucket];
    if (ra !== rb) return ra - rb;
    // Needs-you: oldest waiting first (so the most-stuck floats up). Else newest first.
    if (a.bucket === "needsYou") {
      return (a.running.statusUpdatedAt ?? a.running.startedAt ?? 0) - (b.running.statusUpdatedAt ?? b.running.startedAt ?? 0);
    }
    return (b.running.startedAt ?? 0) - (a.running.startedAt ?? 0);
  });
}
