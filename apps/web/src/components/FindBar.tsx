import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronUp, ChevronDown, X, Search } from "lucide-react";
import type { ContentBlock, NormalizedMessage } from "../lib/types";

/** Concatenate the searchable plain text of a message (text + thinking blocks). */
function messageText(m: NormalizedMessage): string {
  let out = "";
  for (const b of m.blocks) out += blockText(b) + "\n";
  return out;
}

function blockText(b: ContentBlock): string {
  switch (b.type) {
    case "text":
    case "thinking":
      return b.text;
    case "tool_use":
      try {
        return typeof b.input === "string" ? b.input : JSON.stringify(b.input);
      } catch {
        return "";
      }
    case "tool_result":
      return b.content ?? "";
    default:
      return "";
  }
}

/** Count case-insensitive, non-overlapping occurrences of `q` in `hay`. */
function countOccurrences(hay: string, q: string): number {
  if (!q) return 0;
  const h = hay.toLowerCase();
  const needle = q.toLowerCase();
  let n = 0;
  let i = h.indexOf(needle);
  while (i !== -1) {
    n++;
    i = h.indexOf(needle, i + needle.length);
  }
  return n;
}

/** One match: which message index it lives in, plus its ordinal within that message. */
export interface FindMatch {
  messageIndex: number;
  /** 0-based occurrence within the message (for future per-occurrence scroll). */
  occurrence: number;
}

/**
 * Build the flat, ordered match list for `query` across `messages`. Empty query
 * yields no matches. Exposed so the host can scroll the virtualizer to a match.
 */
export function buildMatches(messages: NormalizedMessage[], query: string): FindMatch[] {
  const q = query.trim();
  if (!q) return [];
  const matches: FindMatch[] = [];
  for (let i = 0; i < messages.length; i++) {
    const n = countOccurrences(messageText(messages[i]!), q);
    for (let k = 0; k < n; k++) matches.push({ messageIndex: i, occurrence: k });
  }
  return matches;
}

/**
 * A Cmd/Ctrl-F in-transcript find bar. Owns the query input and current-match
 * cursor; reports the active match's message index to the host so it can scroll
 * the virtualizer there. Highlighting itself is handled by passing the active
 * query down to MessageView (the host wires that), matching the Highlighted
 * pattern used elsewhere.
 *
 * Controlled by the host: `open` toggles visibility; closing clears the query.
 */
export function FindBar({
  open,
  messages,
  onClose,
  onQueryChange,
  onActiveMatchChange,
}: {
  open: boolean;
  messages: NormalizedMessage[];
  onClose: () => void;
  /** The trimmed live query (for highlight). Empty string when nothing to find. */
  onQueryChange: (query: string) => void;
  /** The message index of the active match (or null), so the host can scroll to it. */
  onActiveMatchChange: (messageIndex: number | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => buildMatches(messages, query), [messages, query]);
  const total = matches.length;

  // Focus the field whenever the bar opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Reset the cursor when the result set changes (new query / new transcript).
  useEffect(() => {
    setActive(0);
  }, [query, messages]);

  // Push the live query up for highlighting.
  useEffect(() => {
    onQueryChange(open ? query.trim() : "");
  }, [open, query, onQueryChange]);

  // Report the active match's message index so the host scrolls to it.
  useEffect(() => {
    if (!open || total === 0) {
      onActiveMatchChange(null);
      return;
    }
    const idx = Math.min(active, total - 1);
    onActiveMatchChange(matches[idx]?.messageIndex ?? null);
  }, [open, active, total, matches, onActiveMatchChange]);

  if (!open) return null;

  const go = (delta: number) => {
    if (total === 0) return;
    setActive((a) => (a + delta + total) % total);
  };

  return (
    <div className="absolute right-4 top-3 z-20 flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 shadow-lg shadow-black/40">
      <Search className="h-3.5 w-3.5 text-zinc-500" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="Find in transcript"
        className="w-44 bg-transparent text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
      />
      <span className="min-w-[3.5rem] text-right text-[11px] tabular-nums text-zinc-500">
        {total === 0 ? (query.trim() ? "0/0" : "") : `${Math.min(active + 1, total)}/${total}`}
      </span>
      <button
        onClick={() => go(-1)}
        disabled={total === 0}
        className="rounded p-1 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
        title="Previous match (Shift+Enter)"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => go(1)}
        disabled={total === 0}
        className="rounded p-1 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
        title="Next match (Enter)"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={onClose}
        className="rounded p-1 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
        title="Close (Esc)"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
