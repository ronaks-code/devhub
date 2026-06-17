import { createContext, memo, useContext, useState, type ReactNode } from "react";
import { Terminal, Webhook, ListPlus, Brain, Pencil, Link2, Link2Off } from "lucide-react";
import type { ContentBlock, NormalizedMessage } from "../lib/types";
import { cn } from "../lib/utils";
import { messageAnchorProps } from "../hooks/useMessagePermalink";
import { Markdown } from "./Markdown";
import { TurnMeta } from "./TurnMeta";
import { ToolCard } from "./ToolCard";
import { ResultBody } from "./ResultBody";
import { ImageBlock, type ImageBlockData } from "./ImageBlock";
import type { PairedToolUse, ToolResultBlock } from "../lib/transcript";

/**
 * The active in-transcript find query, threaded to leaf blocks without prop
 * drilling. Empty string = no find active (the common, zero-overhead case).
 */
const HighlightContext = createContext<string>("");

/**
 * Whether this transcript is the LIVE chat (vs. a historical read). Threaded to
 * the tool cards so an unresolved tool_use can show a running…/spinner state
 * only while live — history rendering stays identical. Defaults to false.
 */
const LiveContext = createContext<boolean>(false);

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

/** A tool_use block: renders the extracted ToolCard, passing the live flag from
 *  context so an unresolved tool shows a running…/spinner state only while live. */
function ToolUseBlock({ block }: { block: PairedToolUse }) {
  const live = useContext(LiveContext);
  return <ToolCard block={block} live={live} />;
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
      return <ToolUseBlock block={block as PairedToolUse} />;
    case "tool_result":
      return <ToolResult result={block} />;
    case "image":
      // The engine ContentBlock image type is {type:"image",mediaType?} with no
      // bytes/path; the runtime block may carry data/assetPath/url, which
      // ImageBlock reads defensively off this widened view (no engine edit).
      return <ImageBlock block={block as ImageBlockData} />;
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
  live = false,
  highlight = "",
  prevTimestamp,
  onEdit,
  onCopyLink,
}: {
  m: NormalizedMessage;
  /** Show a blinking cursor at the end (live-streaming assistant bubble). */
  streaming?: boolean;
  /**
   * True in the live Chat transcript. Lets an unresolved tool_use show a
   * running…/spinner state (with elapsed seconds) until its result lands; in
   * history rendering this stays false and unresolved tools render as before.
   */
  live?: boolean;
  /** Active in-transcript find query; matches inside text blocks get marked. */
  highlight?: string;
  /**
   * The immediately-preceding message's ISO timestamp. Used by {@link TurnMeta}
   * to show the per-turn duration (gap → this message) on an assistant reply that
   * followed a user prompt. Omit it to show only this message's wall-clock time.
   */
  prevTimestamp?: string | null;
  /**
   * When set on a user message (live Chat only), shows an "Edit & resend"
   * affordance. Invoked with the message's plain text so the composer can be
   * prefilled and the turn re-run, forking the conversation from that point.
   */
  onEdit?: (text: string) => void;
  /**
   * When set, shows a "copy link" affordance on hover that deep-links this
   * message via the URL hash. Invoked with the message's uuid + seq; returns
   * whether the clipboard write succeeded (so we can show a brief confirmation).
   * Backed by useMessagePermalink in the host.
   */
  onCopyLink?: (uuid: string | null, seq: number) => Promise<boolean>;
}) {
  const meta = ROLE_META[m.role] ?? ROLE_META.meta!;
  const dim = m.role === "system" || m.role === "attachment" || m.role === "meta" || m.role === "queue";
  // Brief "copied" / "copy failed" confirmation on the copy-link button.
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const handleCopyLink = async () => {
    if (!onCopyLink) return;
    const ok = await onCopyLink(m.uuid, m.seq);
    setCopied(ok ? "ok" : "fail");
    window.setTimeout(() => setCopied(null), 1500);
  };
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
    <LiveContext.Provider value={live}>
    <div className="group flex gap-3 px-4 py-2.5" {...messageAnchorProps(m.uuid, m.seq)}>
      <div className={cn("mt-1 w-0.5 shrink-0 rounded-full", meta.bar)} />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className={cn("text-xs font-semibold", meta.chip)}>{meta.label}</span>
          {m.role === "hook" && <Webhook className="h-3 w-3 text-sky-500" />}
          {m.role === "queue" && <ListPlus className="h-3 w-3 text-amber-500" />}
          {m.model ? <span className="text-[10px] text-zinc-600">{m.model}</span> : null}
          {m.isSidechain ? <span className="text-[10px] text-zinc-600">· subagent</span> : null}
          {/* Per-turn timestamp + duration (subtle). Latency (prev → this) shows
              only on an assistant reply, where prevTimestamp is the user prompt. */}
          <TurnMeta
            timestamp={m.timestamp}
            prevTimestamp={prevTimestamp}
            showDuration={m.role === "assistant"}
          />
          {/* Right-aligned hover affordances: edit-and-resend (user/live only)
              and the message permalink "copy link". */}
          {(onEdit && m.role === "user" && editText) || onCopyLink ? (
            <div className="ml-auto flex items-center gap-1">
              {onEdit && m.role === "user" && editText ? (
                <button
                  onClick={() => onEdit(editText)}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-zinc-500 opacity-0 transition hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100"
                  title="Edit this message and resend (forks the conversation from here)"
                >
                  <Pencil className="h-3 w-3" />
                  Edit &amp; resend
                </button>
              ) : null}
              {onCopyLink ? (
                <button
                  onClick={handleCopyLink}
                  className={cn(
                    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium opacity-0 transition group-hover:opacity-100",
                    copied === "ok"
                      ? "text-emerald-400 opacity-100"
                      : copied === "fail"
                        ? "text-red-400 opacity-100"
                        : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200",
                  )}
                  title="Copy a link to this message"
                >
                  {copied === "fail" ? <Link2Off className="h-3 w-3" /> : <Link2 className="h-3 w-3" />}
                  {copied === "ok" ? "Copied" : copied === "fail" ? "Failed" : "Copy link"}
                </button>
              ) : null}
            </div>
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
    </LiveContext.Provider>
    </HighlightContext.Provider>
  );
});
