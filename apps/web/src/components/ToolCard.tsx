import { useEffect, useRef, useState } from "react";
import { Check, FileDiff, Loader2, Terminal, Wrench, X } from "lucide-react";
import { cn } from "../lib/utils";
import { DiffView, parseEditInput } from "./DiffView";
import { ResultBody } from "./ResultBody";
import { TodoWriteCard } from "./tools/TodoWriteCard";
import { BashCard } from "./tools/BashCard";
import { ReadCard } from "./tools/ReadCard";
import { TaskCard } from "./tools/TaskCard";
import type { PairedToolUse, ToolResultBlock } from "../lib/transcript";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function prettyInput(input: unknown): string {
  try {
    return typeof input === "string" ? input : JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function StatusChip({ isError }: { isError: boolean }) {
  return (
    <span
      className={cn(
        "ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
        isError ? "bg-red-500/10 text-red-300" : "bg-emerald-500/10 text-emerald-300",
      )}
    >
      {isError ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" />}
      {isError ? "error" : "ok"}
    </span>
  );
}

/**
 * The "running…" chip for an unresolved tool_use in live chat. Shows a spinner
 * and the elapsed seconds since the tool first appeared. The start time is
 * captured ONCE on mount (the card mounts when the tool_use first renders), so
 * the elapsed reading is stable across the 1s ticks and survives re-renders.
 */
function RunningChip() {
  const startRef = useRef<number>(Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const tick = () => setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className="ml-auto inline-flex items-center gap-1 rounded bg-clay-500/10 px-1.5 py-0.5 text-[10px] font-medium text-clay-300">
      <Loader2 className="h-3 w-3 animate-spin" />
      running… {elapsed}s
    </span>
  );
}

/**
 * Status affordance on a tool card: while LIVE and unresolved (no paired result),
 * show the {@link RunningChip}; once the result lands, show the ok/error chip.
 * In history rendering (`live` falsy) an unresolved tool simply shows nothing —
 * matching the previous behavior exactly so historical transcripts are unchanged.
 */
function ToolStatus({ result, live }: { result?: ToolResultBlock; live: boolean }) {
  if (result) return <StatusChip isError={result.isError ?? false} />;
  if (live) return <RunningChip />;
  return null;
}

/**
 * A tool_use rendered as ONE named collapsible card. When a tool_result is
 * attached (via pairToolResults) we show its status; while LIVE and still
 * unresolved we show a running…/spinner state instead. Edit/Write/MultiEdit/
 * NotebookEdit get a red/green diff with the file path as the header.
 *
 * `live` is set only by the live Chat transcript (where a tool can still be
 * in-flight). History rendering leaves it falsy, so an unresolved tool renders
 * identically to before — no running chip, no spinner.
 */
export function ToolCard({ block, live = false }: { block: PairedToolUse; live?: boolean }) {
  const name = block.name || "tool";

  // TodoWrite gets a dedicated checklist renderer instead of raw JSON.
  if (name === "TodoWrite") return <TodoWriteCard block={block} />;

  // Task (subagent) gets a renderer that shows the subagent description + an
  // inline expander that loads the subagent transcript (when available).
  if (name === "Task") return <TaskCard block={block} />;

  // Bash gets a command/stdout renderer with exit styling; the generic card is
  // its fallback when the input doesn't carry a string command.
  if (name === "Bash") {
    return <BashCard block={block} fallback={() => <GenericToolCard block={block} live={live} />} />;
  }

  // Read gets a file viewer: path header + syntax-highlighted, line-numbered
  // content. Falls back to the generic card when the input has no file_path.
  if (name === "Read") {
    return <ReadCard block={block} fallback={() => <GenericToolCard block={block} live={live} />} />;
  }

  const result = block.result;
  const isError = result?.isError ?? false;
  const edit = EDIT_TOOLS.has(name) ? parseEditInput(name, block.input) : null;

  if (edit) {
    return (
      <details className="my-1.5 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40 open:bg-zinc-900/60" open>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-xs font-medium">
          <FileDiff className="h-3.5 w-3.5 text-clay-400" />
          <span className="text-clay-400">{name}</span>
          {edit.filePath ? (
            <span className="truncate font-mono text-[11px] text-zinc-400" title={edit.filePath}>
              {edit.filePath}
            </span>
          ) : null}
          <ToolStatus result={result} live={live} />
        </summary>
        <div className="border-t border-zinc-800 px-3 py-2">
          <DiffView edit={edit} collapseContext />
        </div>
        {result && (isError || (result.content ?? "").length > 0) ? (
          <details className="border-t border-zinc-800/60">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-500">
              <Terminal className="h-3 w-3" />
              {isError ? "error" : "result"}
            </summary>
            <ResultBody result={result} />
          </details>
        ) : null}
      </details>
    );
  }

  // Non-edit tools: the generic compact input + (collapsed) result card.
  return <GenericToolCard block={block} live={live} />;
}

/**
 * The default tool_use card: compact JSON input + a collapsed result body. Used
 * for every tool without a dedicated renderer, and as the BashCard fallback when
 * a Bash input can't be parsed.
 */
function GenericToolCard({ block, live }: { block: PairedToolUse; live: boolean }) {
  const name = block.name || "tool";
  const result = block.result;
  const isError = result?.isError ?? false;
  const resultLong = (result?.content ?? "").length > 600;
  return (
    <details
      className={cn(
        "my-1.5 rounded-lg border bg-zinc-900/40 open:bg-zinc-900/60",
        isError ? "border-red-900/60" : "border-zinc-800",
      )}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-xs font-medium text-clay-400">
        <Wrench className="h-3.5 w-3.5" />
        <span>{name}</span>
        <ToolStatus result={result} live={live} />
      </summary>
      <pre className="overflow-x-auto border-t border-zinc-800 px-3 py-2 font-mono text-[12px] leading-relaxed text-zinc-300">
        {prettyInput(block.input)}
      </pre>
      {result ? (
        <details className="border-t border-zinc-800/60" open={!resultLong && !isError}>
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-500">
            <Terminal className="h-3 w-3" />
            {isError ? "error" : "result"}
            {resultLong ? (
              <span className="text-zinc-600">
                · {(result.content ?? "").length.toLocaleString()} chars
              </span>
            ) : null}
          </summary>
          <ResultBody result={result} />
        </details>
      ) : null}
    </details>
  );
}
