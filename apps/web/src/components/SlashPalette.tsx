import { useEffect, useMemo, useRef } from "react";
import { Slash } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * Built-in slash commands that are always available, regardless of what the
 * CLI session advertises. These execute UI actions (clear, model picker, help)
 * rather than being forwarded to the agent as prompt text.
 */
export interface BuiltinCommand {
  name: string;
  description: string;
}

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: "clear", description: "Start a fresh conversation" },
  { name: "model", description: "Switch the active model" },
  { name: "help", description: "Show available commands" },
];

/** A row shown in the palette — either a built-in (with description) or a raw session command. */
interface PaletteRow {
  name: string;
  description?: string;
  isBuiltin: boolean;
}

/**
 * A dropdown of slash commands, shown above the ChatPane composer when the user
 * types "/" at the very start of the draft. Purely presentational:
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
  /** Insert (or execute) the chosen command. */
  onPick: (command: string) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  // Build a merged, deduplicated list: built-ins first, then session commands
  // that aren't already covered by a built-in.
  const builtinNames = new Set(BUILTIN_COMMANDS.map((b) => b.name));
  const rows = useMemo((): PaletteRow[] => {
    const builtinRows: PaletteRow[] = BUILTIN_COMMANDS.map((b) => ({
      name: b.name,
      description: b.description,
      isBuiltin: true,
    }));
    const sessionRows: PaletteRow[] = commands
      .filter((c) => !builtinNames.has(c))
      .map((c) => ({ name: c, isBuiltin: false }));
    return [...builtinRows, ...sessionRows];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commands]);

  // Rank: exact-prefix matches first (alphabetical), then substring matches.
  const filtered = useMemo(() => filterRows(rows, query), [rows, query]);

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
        <span className="ml-auto text-zinc-600">↑↓ to move · Enter to run · Esc to dismiss</span>
      </div>
      <ul ref={listRef} className="max-h-56 overflow-y-auto py-1">
        {filtered.map((row, i) => (
          <li key={row.name}>
            <button
              type="button"
              // Use onMouseDown (not onClick) so the textarea doesn't blur before
              // the pick registers, keeping focus in the composer.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(row.name);
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition",
                i === activeIndex
                  ? "bg-clay-500/15 text-clay-200"
                  : "text-zinc-300 hover:bg-zinc-800/70",
              )}
            >
              <span className="font-mono text-zinc-500">/</span>
              <span className="font-medium">{row.name}</span>
              {row.description ? (
                <span className={cn(
                  "ml-auto truncate text-[11px]",
                  i === activeIndex ? "text-clay-300/60" : "text-zinc-600",
                )}>
                  {row.description}
                </span>
              ) : null}
              {row.isBuiltin ? (
                <span className={cn(
                  "shrink-0 rounded px-1 py-px text-[9px] font-medium ring-1",
                  i === activeIndex
                    ? "text-clay-300/70 ring-clay-500/30"
                    : "text-zinc-600 ring-zinc-700/60",
                )}>
                  built-in
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Filter + rank palette rows for a query (the text after "/"). Empty query
 * returns all rows preserving their order. Otherwise prefix matches rank above
 * substring matches; both are sorted alphabetically within their group.
 */
function filterRows(rows: PaletteRow[], query: string): PaletteRow[] {
  const q = query.toLowerCase();
  if (!q) return rows;
  const prefix: PaletteRow[] = [];
  const substr: PaletteRow[] = [];
  for (const r of rows) {
    const lc = r.name.toLowerCase();
    if (lc.startsWith(q)) prefix.push(r);
    else if (lc.includes(q)) substr.push(r);
  }
  prefix.sort((a, b) => a.name.localeCompare(b.name));
  substr.sort((a, b) => a.name.localeCompare(b.name));
  return [...prefix, ...substr];
}

/**
 * Filter + rank slash command NAMES for a query (the text after "/"). Used by
 * ChatPane to compute the keyboard cursor against the same filtered list.
 * Merges built-in commands with session commands before filtering — so the
 * activeIndex the parent tracks always lines up with what SlashPalette renders.
 */
export function filterCommands(sessionCommands: string[], query: string): string[] {
  const builtinNames = new Set(BUILTIN_COMMANDS.map((b) => b.name));
  const allNames: string[] = [
    ...BUILTIN_COMMANDS.map((b) => b.name),
    ...sessionCommands.filter((c) => !builtinNames.has(c)),
  ];
  const q = query.toLowerCase();
  if (!q) return allNames;
  const prefix: string[] = [];
  const substr: string[] = [];
  for (const c of allNames) {
    const lc = c.toLowerCase();
    if (lc.startsWith(q)) prefix.push(c);
    else if (lc.includes(q)) substr.push(c);
  }
  prefix.sort((a, b) => a.localeCompare(b));
  substr.sort((a, b) => a.localeCompare(b));
  return [...prefix, ...substr];
}
