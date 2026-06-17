import { useState } from "react";
import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react";
import { cn } from "../lib/utils";
import type { ToolResultBlock } from "../lib/transcript";

/**
 * Length at which the body is collapsed to a preview by default. Below this the
 * whole thing renders inline (the common case — most tool results are short).
 */
const PREVIEW_CHARS = 600;

/**
 * Hard cap on what we ever paint into the DOM, even fully expanded. A pathological
 * multi-megabyte result would otherwise jank the transcript; we show the first
 * slice and note how much was withheld (the full text is still one Copy away).
 */
const MAX_EXPANDED_CHARS = 50_000;

/**
 * Compact, scrollable rendering of a tool_result's body with a "show more / show
 * less" expander and a copy button. Replaces the old hard 600-char truncation:
 *
 *  - short results (≤ {@link PREVIEW_CHARS}) render whole, no controls;
 *  - longer results collapse to a preview with a "Show more" toggle;
 *  - very long results cap the painted text at {@link MAX_EXPANDED_CHARS} even when
 *    expanded, with a note — Copy still yields the FULL content.
 *
 * Extracted from MessageView/ToolCard (which both had an identical inline copy)
 * so the result-body rendering lives in one place.
 */
export function ResultBody({ result }: { result: ToolResultBlock }) {
  const content = result.content ?? "";
  const len = content.length;
  const collapsible = len > PREVIEW_CHARS;
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  // What we actually paint: the preview slice when collapsed; the expanded slice
  // (capped at MAX_EXPANDED_CHARS) when open. Copy always uses the full content.
  const expandedCapped = len > MAX_EXPANDED_CHARS;
  const shown = !collapsible
    ? content
    : expanded
      ? content.slice(0, MAX_EXPANDED_CHARS)
      : content.slice(0, PREVIEW_CHARS);

  const copy = () => {
    void navigator.clipboard?.writeText(content).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => {
        /* clipboard denied — silently ignore */
      },
    );
  };

  return (
    <div
      className={cn(
        "border-t",
        result.isError ? "border-red-900/60" : "border-zinc-800",
      )}
    >
      <pre
        className={cn(
          "overflow-x-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-relaxed",
          result.isError ? "text-red-300" : "text-zinc-400",
          // Cap the painted height when expanded so a long blob scrolls in place
          // rather than blowing out the transcript.
          expanded ? "max-h-[28rem] overflow-y-auto" : "",
        )}
      >
        {shown || "(empty)"}
        {/* Collapsed-preview ellipsis hint (only when there's more to see). */}
        {collapsible && !expanded ? <span className="text-zinc-600">…</span> : null}
      </pre>

      {/* Controls: show more/less + a note for the capped case + copy. Always
          render the copy affordance; the expander only when there's overflow. */}
      <div className="flex items-center gap-3 px-3 pb-2 text-[11px] text-zinc-500">
        {collapsible ? (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 font-medium text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
          >
            {expanded ? (
              <>
                <ChevronUp className="h-3 w-3" /> Show less
              </>
            ) : (
              <>
                <ChevronDown className="h-3 w-3" /> Show more
                <span className="text-zinc-600">· {len.toLocaleString()} chars</span>
              </>
            )}
          </button>
        ) : null}

        {/* When expanded but still capped, say how much was withheld. */}
        {expanded && expandedCapped ? (
          <span className="text-zinc-600">
            showing first {MAX_EXPANDED_CHARS.toLocaleString()} of {len.toLocaleString()} chars —
            copy for the full output
          </span>
        ) : null}

        <button
          onClick={copy}
          className={cn(
            "ml-auto inline-flex items-center gap-1 rounded px-1 py-0.5 font-medium transition",
            copied
              ? "text-emerald-400"
              : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200",
          )}
          title="Copy result to clipboard"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
