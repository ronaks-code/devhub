import { useEffect, useMemo, useRef, useState } from "react";
import { Slash } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * A dropdown of the session's slash commands, shown above the ChatPane composer
 * when the user types "/" at the very start of the draft. Purely presentational:
 *
 *  - `query` is the text after the leading "/" (e.g. "comp" for "/comp").
 *  - commands are filtered + ranked here with {@link filterCommands} (prefix
 *    matches first, then substring) — the SAME function ChatPane uses to compute
 *    its keyboard cursor, so `activeIndex` lines up with the rendered rows.
 *  - the composer's keydown handler stays authoritative for Arrow/Enter/Escape
 *    (it already owns Enter-to-send + history recall); it drives `activeIndex` and
 *    inserts via `onPick`. Clicking a row also calls `onPick`.
 */
export function SlashPalette({
  query,
  commands,
  activeIndex,
  onPick,
}: {
  /** Text after the leading "/", lowercased matching is done internally. */
  query: string;
  /** The session's available slash command names (without the leading "/"). */
  commands: string[];
  /** Highlighted row index (into the FILTERED list), owned by the parent. */
  activeIndex: number;
  /** Insert the chosen command into the composer. */
  onPick: (command: string) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  // Rank: exact-prefix matches first (alphabetical), then substring matches.
  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);

  // Keep the highlighted row scrolled into view as the parent moves the cursor.
  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (filtered.length === 0) return null;

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl shadow-black/40 ring-1 ring-black/20">
      <div className="flex items-center gap-2 border-b border-zinc-800/80 px-3 py-1.5 text-[11px] text-zinc-500">
        <Slash className="h-3 w-3" />
        <span>Slash commands</span>
        <span className="ml-auto text-zinc-600">↑↓ to move · Enter to insert · Esc to dismiss</span>
      </div>
      <ul ref={listRef} className="max-h-56 overflow-y-auto py-1">
        {filtered.map((cmd, i) => (
          <li key={cmd}>
            <button
              type="button"
              // Use onMouseDown (not onClick) so the textarea doesn't blur before
              // the pick registers, keeping focus in the composer.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(cmd);
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition",
                i === activeIndex
                  ? "bg-clay-500/15 text-clay-200"
                  : "text-zinc-300 hover:bg-zinc-800/70",
              )}
            >
              <span className="font-mono text-zinc-500">/</span>
              <span className="font-medium">{cmd}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Filter + rank slash commands for a query (the text after "/"). Empty query
 * returns all commands (alphabetical). Otherwise prefix matches rank above
 * substring matches; both are sorted alphabetically within their group.
 * Exported so ChatPane can compute the same filtered list for keyboard nav.
 */
export function filterCommands(commands: string[], query: string): string[] {
  const q = query.toLowerCase();
  if (!q) return [...commands].sort((a, b) => a.localeCompare(b));
  const prefix: string[] = [];
  const substr: string[] = [];
  for (const c of commands) {
    const lc = c.toLowerCase();
    if (lc.startsWith(q)) prefix.push(c);
    else if (lc.includes(q)) substr.push(c);
  }
  prefix.sort((a, b) => a.localeCompare(b));
  substr.sort((a, b) => a.localeCompare(b));
  return [...prefix, ...substr];
}
