import type { ContentBlock, NormalizedMessage } from "./types";

/** A tool_result block, narrowed from the ContentBlock union. */
export type ToolResultBlock = Extract<ContentBlock, { type: "tool_result" }>;

/**
 * A tool_use block with its matching tool_result attached. Rendered as one
 * collapsible card instead of two separate messages.
 */
export type PairedToolUse = Extract<ContentBlock, { type: "tool_use" }> & {
  result?: ToolResultBlock;
};

function isToolUse(b: ContentBlock): b is Extract<ContentBlock, { type: "tool_use" }> {
  return b.type === "tool_use";
}
function isToolResult(b: ContentBlock): b is ToolResultBlock {
  return b.type === "tool_result";
}

/**
 * In Claude Code transcripts a `tool_use` (assistant message) and its
 * `tool_result` (the FOLLOWING user message) are SEPARATE NormalizedMessages
 * joined by toolUseId. This transform:
 *   1. attaches each tool_result to its matching tool_use (by id ↔ toolUseId), and
 *   2. drops the now-consumed standalone tool_result blocks, removing user
 *      messages that became empty as a result.
 *
 * A tool_result whose tool_use is NOT in the current window (e.g. tail mode cut
 * the head off) is left as a standalone block so it still renders.
 *
 * Order is preserved. Messages that change are shallow-cloned; the originals
 * (and their block arrays) are never mutated.
 */
export function pairToolResults(messages: NormalizedMessage[]): NormalizedMessage[] {
  const resultById = indexToolResults(messages);
  if (resultById.size === 0) return messages;

  const out: NormalizedMessage[] = [];
  for (const m of messages) {
    const paired = pairMessage(m, resultById);
    if (paired) out.push(paired);
  }
  return out;
}

/**
 * Pair a single message: attach matching results to its tool_use blocks and
 * drop consumed standalone tool_result blocks. Returns the (possibly cloned)
 * message, or `null` when the message should be removed entirely (a user
 * message that became empty after its results were absorbed).
 *
 * Useful for callers (e.g. live chat) that keep their own stable keys: pair
 * each item individually and drop the ones that return null.
 */
export function pairMessage(
  m: NormalizedMessage,
  resultById: Map<string, ToolResultBlock>,
): NormalizedMessage | null {
  let changed = false;
  const blocks: ContentBlock[] = [];

  for (const b of m.blocks) {
    if (isToolUse(b)) {
      const match = b.id ? resultById.get(b.id) : undefined;
      if (match) {
        blocks.push({ ...b, result: match } as PairedToolUse);
        changed = true;
        continue;
      }
      blocks.push(b);
      continue;
    }
    // Drop a tool_result whose tool_use exists somewhere in the window (it gets
    // rendered inside that tool_use card instead).
    if (isToolResult(b) && b.toolUseId && resultById.has(b.toolUseId)) {
      changed = true;
      continue;
    }
    blocks.push(b);
  }

  if (!changed) return m;
  // Skip user messages that became empty once their results were absorbed.
  if (blocks.length === 0 && m.role === "user") return null;
  return { ...m, blocks };
}

/**
 * Build the toolUseId → tool_result index used by pairMessage. ONLY indexes
 * results whose tool_use is present in this window — so an orphan result (its
 * tool_use scrolled out of the tail) is left to render standalone.
 */
export function indexToolResults(messages: NormalizedMessage[]): Map<string, ToolResultBlock> {
  const toolUseIds = new Set<string>();
  for (const m of messages) {
    for (const b of m.blocks) {
      if (isToolUse(b) && b.id) toolUseIds.add(b.id);
    }
  }
  const resultById = new Map<string, ToolResultBlock>();
  for (const m of messages) {
    for (const b of m.blocks) {
      if (isToolResult(b) && b.toolUseId && toolUseIds.has(b.toolUseId)) {
        resultById.set(b.toolUseId, b);
      }
    }
  }
  return resultById;
}
