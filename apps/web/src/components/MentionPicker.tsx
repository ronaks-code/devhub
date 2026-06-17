import { useEffect, useRef } from "react";
import { File, Folder, AtSign } from "lucide-react";
import { cn } from "../lib/utils";
import type { FileEntry } from "../lib/api";

/**
 * A dropdown of project files, shown above the ChatPane composer when the user
 * types an "@" mention (e.g. "@src/comp"). Purely presentational, mirroring
 * SlashPalette:
 *
 *  - `entries` is the fuzzy-matched file list (from GET /api/files), already
 *    ranked server-side; this component just renders + highlights.
 *  - the composer's keydown handler stays authoritative for Arrow/Enter/Escape
 *    (it owns the cursor via `activeIndex` and inserts via `onPick`).
 *  - clicking a row also calls `onPick`. We use onMouseDown so the textarea
 *    doesn't blur before the pick registers, keeping focus in the composer.
 *
 * `loading` shows a subtle hint on the first keystroke before results arrive;
 * `error` surfaces a fetch failure (e.g. the route isn't available) without
 * breaking the composer.
 */
export function MentionPicker({
  query,
  entries,
  activeIndex,
  loading,
  error,
  onPick,
}: {
  /** Text after the "@" (for the header hint). */
  query: string;
  /** Ranked file matches to render. */
  entries: FileEntry[];
  /** Highlighted row index, owned by the parent composer. */
  activeIndex: number;
  /** True while a fetch is in flight (shows a loading hint). */
  loading?: boolean;
  /** Set when the lookup failed (shows an error hint instead of rows). */
  error?: string | null;
  /** Insert the chosen file path into the composer. */
  onPick: (entry: FileEntry) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the highlighted row scrolled into view as the parent moves the cursor.
  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Nothing to show and nothing to say → render nothing (composer stays clean).
  if (entries.length === 0 && !loading && !error) return null;

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl shadow-black/40 ring-1 ring-black/20">
      <div className="flex items-center gap-2 border-b border-zinc-800/80 px-3 py-1.5 text-[11px] text-zinc-500">
        <AtSign className="h-3 w-3" />
        <span>{query ? `Files matching “${query}”` : "Files"}</span>
        {loading ? <span className="text-zinc-600">· searching…</span> : null}
        <span className="ml-auto text-zinc-600">↑↓ to move · Enter to insert · Esc to dismiss</span>
      </div>

      {error ? (
        <div className="px-3 py-2 text-[12px] text-amber-400">{error}</div>
      ) : entries.length === 0 ? (
        <div className="px-3 py-2 text-[12px] text-zinc-500">
          {loading ? "Searching…" : "No matching files"}
        </div>
      ) : (
        <ul ref={listRef} className="max-h-56 overflow-y-auto py-1">
          {entries.map((entry, i) => (
            <li key={entry.path}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(entry);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition",
                  i === activeIndex
                    ? "bg-clay-500/15 text-clay-200"
                    : "text-zinc-300 hover:bg-zinc-800/70",
                )}
              >
                {entry.dir ? (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                ) : (
                  <File className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                )}
                <span className="truncate font-mono text-[12.5px]">
                  {entry.path}
                  {entry.dir ? "/" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Detect an active "@" mention at the caret. Returns the query (text after the
 * "@") plus the [start,end) range of the "@query" token to replace on insert, or
 * null when the caret isn't in a mention.
 *
 * A mention is the run from an "@" back to a word/path boundary up to the caret,
 * with NO whitespace inside it — so "@src/foo" is a mention but "a @ b" (just an
 * "@") or text past a space isn't. The "@" must start a token (preceded by start
 * of input or whitespace) so an email like "a@b" never triggers the picker.
 */
export function detectMention(
  text: string,
  caret: number,
): { query: string; start: number; end: number } | null {
  // Walk left from the caret to find the "@" that opens this token. Stop at any
  // whitespace (the mention can't contain spaces) — there's no mention then.
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i]!;
    if (ch === "@") {
      // The "@" must start a token: at input start or after whitespace.
      const before = i === 0 ? "" : text[i - 1]!;
      if (i === 0 || /\s/.test(before)) {
        return { query: text.slice(i + 1, caret), start: i, end: caret };
      }
      return null; // "@" mid-word (e.g. an email) — not a mention.
    }
    if (/\s/.test(ch)) return null; // hit whitespace before any "@".
    i--;
  }
  return null;
}
