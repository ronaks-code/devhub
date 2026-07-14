import { createHash } from "node:crypto";
import type { NativeRevision } from "../types.js";
import type { CodexNativeItemMetadata, CodexNativeThreadMetadata } from "./native-shapes.js";

const REVISION_PREFIX = "codex:v1:";

function lastItem(thread: CodexNativeThreadMetadata): CodexNativeItemMetadata | null {
  for (let turnIndex = thread.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = thread.turns[turnIndex]?.items;
    const item = items?.[items.length - 1];
    if (item) return item;
  }
  return null;
}

/**
 * Builds a content-free native revision. The hash intentionally covers only
 * provider IDs, status, archive state, and timestamps; message text, reasoning,
 * commands, arguments, diffs, and tool output never enter the fingerprint.
 */
export function buildCodexNativeRevision(
  thread: CodexNativeThreadMetadata,
): Readonly<NativeRevision> {
  const finalTurn = thread.turns[thread.turns.length - 1] ?? null;
  const finalItem = lastItem(thread);
  const canonical = JSON.stringify({
    v: 1,
    id: thread.id,
    sessionId: thread.sessionId,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    recencyAt: thread.recencyAt,
    status: thread.status,
    activeFlags: thread.activeFlags,
    turns: thread.turns.map((turn) => ({
      id: turn.id,
      status: turn.status,
      itemsView: turn.itemsView,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
      items: turn.items.map((item) => ({
        id: item.id,
        type: item.type,
        status: item.status,
      })),
    })),
  });
  const digest = createHash("sha256").update(canonical, "utf8").digest("base64url");
  return Object.freeze({
    updatedAt: thread.updatedAt,
    status: thread.status,
    lastTurnId: finalTurn?.id ?? null,
    lastTurnStatus: finalTurn?.status ?? null,
    lastItemId: finalItem?.id ?? null,
    fingerprint: `${REVISION_PREFIX}${digest}`,
  });
}
