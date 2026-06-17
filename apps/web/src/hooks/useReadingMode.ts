import { useCallback, useMemo, useState } from "react";
import type { ContentBlock, NormalizedMessage } from "../lib/types";

/**
 * "Reading mode" strips a transcript down to the human-readable conversation:
 * just the user prompts and Claude's prose answers, with tool cards, thinking
 * blocks, and system/meta chatter hidden. It's for reading a session like an
 * article rather than auditing every tool call.
 *
 * What it keeps:
 *  - user + assistant messages only (system / hook / meta / attachment dropped).
 *  - within a kept message, only `text` blocks (tool_use / tool_result / thinking
 *    / image blocks dropped).
 *  - messages left with no text after filtering are removed entirely, so there
 *    are no empty bubbles.
 *
 * It returns a small toggle API plus a pure `apply` that the host runs over its
 * (already paired + filtered) message list. Pure + memo-friendly: when reading
 * mode is off, `apply` returns the input array unchanged (zero overhead).
 */

/** Roles whose prose we keep in reading mode. Everything else is hidden. */
const READABLE_ROLES = new Set(["user", "assistant"]);

/** Keep only the text blocks of a message (drops tools/thinking/images). */
function textOnly(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.filter((b) => b.type === "text");
}

/**
 * Reduce a message list to user/assistant prose only. Clones each kept message
 * with its non-text blocks removed; drops messages that end up empty. Exported
 * standalone so it can be unit-tested / reused without the hook.
 */
export function applyReadingMode(messages: NormalizedMessage[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const m of messages) {
    if (!READABLE_ROLES.has(m.role)) continue;
    const blocks = textOnly(m.blocks);
    // Keep a message only if it has real prose. A text block that's whitespace
    // (e.g. a bare newline between tool calls) shouldn't survive as an empty bubble.
    const hasProse = blocks.some(
      (b) => b.type === "text" && b.text.trim().length > 0,
    );
    if (!hasProse) continue;
    out.push(blocks.length === m.blocks.length ? m : { ...m, blocks });
  }
  return out;
}

export interface ReadingMode {
  /** Whether reading mode is on. */
  enabled: boolean;
  /** Flip reading mode on/off. */
  toggle: () => void;
  /** Set reading mode explicitly. */
  setEnabled: (on: boolean) => void;
  /**
   * Apply reading mode to a message list. Returns the input unchanged when
   * reading mode is off (referentially stable), or the prose-only subset when on.
   */
  apply: (messages: NormalizedMessage[]) => NormalizedMessage[];
}

export function useReadingMode(initial = false): ReadingMode {
  const [enabled, setEnabled] = useState(initial);
  const toggle = useCallback(() => setEnabled((v) => !v), []);
  const apply = useCallback(
    (messages: NormalizedMessage[]) => (enabled ? applyReadingMode(messages) : messages),
    [enabled],
  );
  return useMemo(
    () => ({ enabled, toggle, setEnabled, apply }),
    [enabled, toggle, apply],
  );
}
