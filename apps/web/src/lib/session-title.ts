import type { CodexSession, SearchHit, SessionSummary } from "./types.js";

/** Return the final directory name without assuming a POSIX-only path. */
export function projectNameFromCwd(cwd: string | null | undefined): string | null {
  const normalized = cwd?.trim().replace(/[/\\]+$/, "");
  if (!normalized) return null;
  return normalized.split(/[/\\]/).filter(Boolean).at(-1) ?? null;
}

/** Prefer authored/derived titles, then the real project cwd, then raw identity. */
export function displaySessionTitle(
  session: Pick<SessionSummary, "title" | "titleSource" | "cwd" | "sessionId">,
  knownProjectName?: string | null,
): string {
  const title = session.title.trim();
  if (title && session.titleSource !== "session-id") return title;
  const projectName = knownProjectName?.trim();
  return projectName || projectNameFromCwd(session.cwd) || title || session.sessionId;
}

/** Codex history has no prompt/title in the web contract, so use cwd then id. */
export function displayCodexSessionTitle(
  session: Pick<CodexSession, "cwd" | "id">,
): string {
  return projectNameFromCwd(session.cwd) ?? session.id;
}

/**
 * Search hits do not carry titleSource, so only replace titles proven to be the
 * native session identity: the full id or the engine's shortened id prefix.
 */
export function displaySearchHitTitle(
  hit: Pick<SearchHit, "title" | "sessionId" | "projectName" | "cwd">,
): string {
  const title = hit.title.trim();
  const sessionId = hit.sessionId.trim();
  const identityFallback =
    !title ||
    title === sessionId ||
    (title.length === 8 && title === sessionId.slice(0, 8));
  if (!identityFallback) return title;

  const projectName = hit.projectName.trim();
  return projectName || projectNameFromCwd(hit.cwd) || title || sessionId;
}
