import { useMemo } from "react";
import { MessageSquare, Wrench, FileDiff, Terminal, ListTree } from "lucide-react";
import type { NormalizedMessage } from "../lib/types";
import { cn } from "../lib/utils";

/** Tools worth surfacing in the outline as "major actions" (vs. noisy reads). */
const MAJOR_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "Task",
]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** One clickable entry: a user turn or a major tool action. */
interface OutlineEntry {
  /** Virtualizer index of the message this entry lives in. */
  index: number;
  kind: "user" | "tool";
  label: string;
  toolName?: string;
}

/** First non-empty line of text across a message's text blocks, trimmed short. */
function firstLine(m: NormalizedMessage): string {
  for (const b of m.blocks) {
    if (b.type === "text") {
      const line = b.text.split("\n").find((l) => l.trim().length > 0);
      if (line) return line.trim();
    }
  }
  return "(no text)";
}

/** A compact label for a tool_use block (file path for edits, else the input). */
function toolLabel(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (EDIT_TOOLS.has(name) && typeof o.file_path === "string") {
      // Show just the basename to keep the rail narrow.
      const parts = o.file_path.split("/");
      return parts[parts.length - 1] || o.file_path;
    }
    if (name === "Bash" && typeof o.command === "string") {
      return o.command;
    }
    if (name === "Task" && typeof o.description === "string") {
      return o.description;
    }
  }
  return name;
}

/**
 * Derive the table of contents from the (paired) transcript messages: every user
 * turn plus each major tool action, tagged with the message index so a click can
 * scroll the virtualizer there. Memoize at the call site — this walks all blocks.
 */
export function buildOutline(messages: NormalizedMessage[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  messages.forEach((m, index) => {
    if (m.role === "user") {
      // Skip user messages that are purely tool_result carriers (no real text).
      const hasText = m.blocks.some((b) => b.type === "text" && b.text.trim().length > 0);
      if (hasText) out.push({ index, kind: "user", label: firstLine(m) });
      return;
    }
    if (m.role === "assistant") {
      for (const b of m.blocks) {
        if (b.type === "tool_use" && MAJOR_TOOLS.has(b.name)) {
          out.push({
            index,
            kind: "tool",
            toolName: b.name,
            label: toolLabel(b.name, b.input),
          });
        }
      }
    }
  });
  return out;
}

function EntryIcon({ entry }: { entry: OutlineEntry }) {
  if (entry.kind === "user") return <MessageSquare className="h-3.5 w-3.5 text-clay-400" />;
  if (entry.toolName && EDIT_TOOLS.has(entry.toolName))
    return <FileDiff className="h-3.5 w-3.5 text-sky-400" />;
  if (entry.toolName === "Bash") return <Terminal className="h-3.5 w-3.5 text-emerald-400" />;
  return <Wrench className="h-3.5 w-3.5 text-zinc-500" />;
}

/**
 * A collapsible TOC side-rail for the open transcript. Lists user turns and major
 * tool actions; clicking an entry scrolls the transcript virtualizer to that
 * message (via `onJump`, wired to virtualizer.scrollToIndex in TranscriptPane).
 *
 * `activeIndex` highlights the entry whose message is currently in view (best
 * effort — the caller can pass the find/active match index).
 */
export function TranscriptOutline({
  messages,
  onJump,
  onClose,
  activeIndex,
}: {
  messages: NormalizedMessage[];
  onJump: (index: number) => void;
  onClose: () => void;
  activeIndex?: number | null;
}) {
  const entries = useMemo(() => buildOutline(messages), [messages]);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-zinc-800/80 bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-800/80 px-3 py-2.5">
        <ListTree className="h-3.5 w-3.5 text-zinc-500" />
        <span className="text-[12px] font-semibold text-zinc-300">Outline</span>
        <span className="rounded bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
          {entries.length}
        </span>
        <button
          onClick={onClose}
          className="ml-auto rounded-md px-1.5 py-0.5 text-[11px] text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
          title="Hide outline"
        >
          Hide
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {entries.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11.5px] text-zinc-600">
            No turns or actions to outline yet.
          </div>
        ) : (
          <ul>
            {entries.map((e, i) => (
              <li key={`${e.index}-${i}`}>
                <button
                  onClick={() => onJump(e.index)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition hover:bg-zinc-900",
                    e.kind === "tool" && "pl-6",
                    activeIndex === e.index ? "bg-clay-500/10 text-clay-200" : "text-zinc-400",
                  )}
                  title={e.label}
                >
                  <span className="shrink-0">
                    <EntryIcon entry={e} />
                  </span>
                  <span className="truncate">{e.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
