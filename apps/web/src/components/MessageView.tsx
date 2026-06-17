import { createContext, memo, useContext, type ReactNode } from "react";
import { Wrench, Terminal, Webhook, ListPlus, Brain, FileDiff, Check, X, Pencil } from "lucide-react";
import type { ContentBlock, NormalizedMessage } from "../lib/types";
import { cn } from "../lib/utils";
import { Markdown } from "./Markdown";
import { DiffView, parseEditInput } from "./DiffView";
import { TodoWriteCard } from "./tools/TodoWriteCard";
import { BashCard } from "./tools/BashCard";
import type { PairedToolUse, ToolResultBlock } from "../lib/transcript";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * The active in-transcript find query, threaded to leaf blocks without prop
 * drilling. Empty string = no find active (the common, zero-overhead case).
 */
const HighlightContext = createContext<string>("");

/** Split `text` on case-insensitive occurrences of `query`, wrapping matches in <mark>. */
function HighlightText({ text }: { text: string }): ReactNode {
  const query = useContext(HighlightContext);
  if (!query) return text;
  const needle = query.toLowerCase();
  const hay = text.toLowerCase();
  if (!hay.includes(needle)) return text;
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const at = hay.indexOf(needle, i);
    if (at === -1) {
      out.push(text.slice(i));
      break;
    }
    if (at > i) out.push(text.slice(i, at));
    out.push(
      <mark key={key++} className="rounded bg-amber-400/30 px-0.5 text-amber-100">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    i = at + needle.length;
  }
  return <>{out}</>;
}

function prettyInput(input: unknown): string {
  try {
    return typeof input === "string" ? input : JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** Compact, scrollable rendering of a tool_result's body. */
function ResultBody({ result }: { result: ToolResultBlock }) {
  const content = result.content ?? "";
  const long = content.length > 600;
  const head = long ? content.slice(0, 600) : content;
  return (
    <pre
      className={cn(
        "overflow-x-auto whitespace-pre-wrap break-words border-t px-3 py-2 font-mono text-[12px] leading-relaxed",
        result.isError ? "border-red-900/60 text-red-300" : "border-zinc-800 text-zinc-400",
      )}
    >
      {long ? `${head}\n…` : head || "(empty)"}
    </pre>
  );
}

/**
 * A tool_use rendered as ONE named collapsible card. When a tool_result is
 * attached (via pairToolResults) we show its status; Edit/Write/MultiEdit/
 * NotebookEdit get a red/green diff with the file path as the header.
 */
function ToolCard({ block }: { block: PairedToolUse }) {
  const name = block.name || "tool";

  // TodoWrite gets a dedicated checklist renderer instead of raw JSON.
  if (name === "TodoWrite") return <TodoWriteCard block={block} />;

  // Bash gets a command/stdout renderer with exit styling; the generic card is
  // its fallback when the input doesn't carry a string command.
  if (name === "Bash") {
    return <BashCard block={block} fallback={() => <GenericToolCard block={block} />} />;
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
          {result ? <StatusChip isError={isError} /> : null}
        </summary>
        <div className="border-t border-zinc-800 px-3 py-2">
          <DiffView edit={edit} />
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
  return <GenericToolCard block={block} />;
}

/**
 * The default tool_use card: compact JSON input + a collapsed result body. Used
 * for every tool without a dedicated renderer, and as the BashCard fallback when
 * a Bash input can't be parsed.
 */
function GenericToolCard({ block }: { block: PairedToolUse }) {
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
        {result ? <StatusChip isError={isError} /> : null}
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

/** Standalone tool_result (its tool_use is outside this window). */
function ToolResult({ result }: { result: ToolResultBlock }) {
  const content = result.content ?? "";
  const long = content.length > 600;
  return (
    <details
      className={cn(
        "my-1.5 rounded-lg border bg-zinc-900/30",
        result.isError ? "border-red-900/60" : "border-zinc-800",
      )}
      open={!long}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-xs font-medium text-zinc-400">
        <Terminal className="h-3.5 w-3.5" />
        {result.isError ? "tool error" : "tool result"}
        {long ? <span className="text-zinc-600">· {content.length.toLocaleString()} chars</span> : null}
      </summary>
      <ResultBody result={result} />
    </details>
  );
}

/** A text block: rendered as markdown normally, or plain highlighted text while
 *  a find is active (so matches are visible without fighting the markdown AST). */
function TextBlock({ text }: { text: string }) {
  const query = useContext(HighlightContext);
  if (query && text.toLowerCase().includes(query.toLowerCase())) {
    return (
      <div className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-zinc-200">
        <HighlightText text={text} />
      </div>
    );
  }
  return <Markdown text={text} />;
}

function Block({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case "text":
      return <TextBlock text={block.text} />;
    case "thinking":
      return (
        <details className="my-1 rounded-lg border border-zinc-800/60 bg-zinc-900/20">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-xs text-zinc-500">
            <Brain className="h-3.5 w-3.5" /> thinking
          </summary>
          <div className="border-t border-zinc-800/60 px-3 py-2 text-[12.5px] italic leading-relaxed text-zinc-500">
            <Markdown text={block.text} className="text-zinc-500" />
          </div>
        </details>
      );
    case "tool_use":
      return <ToolCard block={block as PairedToolUse} />;
    case "tool_result":
      return <ToolResult result={block} />;
    case "image":
      return (
        <div className="my-1 text-xs text-zinc-500">
          🖼 image{block.mediaType ? ` (${block.mediaType})` : ""}
        </div>
      );
    default:
      return (
        <pre className="my-1 overflow-x-auto rounded bg-zinc-900/40 p-2 font-mono text-[11px] text-zinc-600">
          {JSON.stringify((block as { raw?: unknown }).raw ?? block, null, 2).slice(0, 400)}
        </pre>
      );
  }
}

const ROLE_META: Record<string, { label: string; bar: string; chip: string }> = {
  user: { label: "You", bar: "bg-clay-500", chip: "text-clay-300" },
  assistant: { label: "Claude", bar: "bg-zinc-600", chip: "text-zinc-300" },
  system: { label: "system", bar: "bg-zinc-800", chip: "text-zinc-500" },
  hook: { label: "hook", bar: "bg-sky-800", chip: "text-sky-400" },
  queue: { label: "queued", bar: "bg-amber-800", chip: "text-amber-400" },
  attachment: { label: "attachment", bar: "bg-zinc-800", chip: "text-zinc-500" },
  meta: { label: "meta", bar: "bg-zinc-800", chip: "text-zinc-600" },
};

export const MessageView = memo(function MessageView({
  m,
  streaming,
  highlight = "",
  onEdit,
}: {
  m: NormalizedMessage;
  /** Show a blinking cursor at the end (live-streaming assistant bubble). */
  streaming?: boolean;
  /** Active in-transcript find query; matches inside text blocks get marked. */
  highlight?: string;
  /**
   * When set on a user message (live Chat only), shows an "Edit & resend"
   * affordance. Invoked with the message's plain text so the composer can be
   * prefilled and the turn re-run, forking the conversation from that point.
   */
  onEdit?: (text: string) => void;
}) {
  const meta = ROLE_META[m.role] ?? ROLE_META.meta!;
  const dim = m.role === "system" || m.role === "attachment" || m.role === "meta" || m.role === "queue";
  // Plain text of a user message, for the edit-and-resend affordance.
  const editText =
    onEdit && m.role === "user"
      ? m.blocks
          .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim()
      : "";
  return (
    <HighlightContext.Provider value={highlight}>
    <div className="group flex gap-3 px-4 py-2.5">
      <div className={cn("mt-1 w-0.5 shrink-0 rounded-full", meta.bar)} />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className={cn("text-xs font-semibold", meta.chip)}>{meta.label}</span>
          {m.role === "hook" && <Webhook className="h-3 w-3 text-sky-500" />}
          {m.role === "queue" && <ListPlus className="h-3 w-3 text-amber-500" />}
          {m.model ? <span className="text-[10px] text-zinc-600">{m.model}</span> : null}
          {m.isSidechain ? <span className="text-[10px] text-zinc-600">· subagent</span> : null}
          {onEdit && m.role === "user" && editText ? (
            <button
              onClick={() => onEdit(editText)}
              className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-zinc-500 opacity-0 transition hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100"
              title="Edit this message and resend (forks the conversation from here)"
            >
              <Pencil className="h-3 w-3" />
              Edit &amp; resend
            </button>
          ) : null}
        </div>
        <div className={cn("space-y-0.5", dim && "opacity-70")}>
          {m.blocks.length === 0 ? (
            streaming ? (
              <span className="inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-clay-400 align-middle" />
            ) : (
              <div className="text-xs text-zinc-600">(no content)</div>
            )
          ) : (
            <>
              {m.blocks.map((b, i) => (
                <Block key={i} block={b} />
              ))}
              {streaming ? (
                <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-clay-400 align-middle" />
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
    </HighlightContext.Provider>
  );
});
