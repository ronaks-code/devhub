import { useCallback, useRef, useState } from "react";
import { Copy, Check, X } from "lucide-react";
import type { ContentBlock, NormalizedMessage } from "../lib/types";
import { cn } from "../lib/utils";

/**
 * A small hover "copy" action that grabs a message's RAW text/markdown (not the
 * rendered HTML) and writes it to the clipboard, flashing a brief "Copied".
 *
 * Plain words: hover any message, click the little clipboard, and the exact
 * markdown Claude wrote (or you typed) lands on your clipboard — ready to paste
 * into an issue, a doc, wherever. It copies the source text, so code fences and
 * formatting survive the round-trip.
 *
 * We pull the prose out of the message's content blocks ourselves rather than
 * reading the DOM, so what gets copied is the original source — code stays in
 * fences, thinking is labelled, and tool calls are summarized compactly.
 */

/** Fenced-code language hint by tool name, so a copied tool call reads cleanly. */
function fenceLangFor(name: string): string {
  const n = name.toLowerCase();
  if (n === "bash") return "bash";
  if (n === "read" || n === "edit" || n === "write" || n === "grep") return "";
  return "json";
}

/** Render a tool_use block's input as a compact, readable code fence. */
function toolUseText(block: Extract<ContentBlock, { type: "tool_use" }>): string {
  let body: string;
  try {
    body =
      typeof block.input === "string"
        ? block.input
        : JSON.stringify(block.input, null, 2);
  } catch {
    body = String(block.input);
  }
  const lang = fenceLangFor(block.name);
  return `\`\`\`${lang}\n# ${block.name}\n${body}\n\`\`\``;
}

/**
 * Flatten a message's blocks into copy-ready markdown. Mirrors what the reader
 * sees, in source form:
 *   - text  → verbatim (it's already markdown).
 *   - thinking → blockquoted under a "_thinking_" label.
 *   - tool_use → a fenced code block of the tool name + input.
 *   - tool_result → a fenced block of the output (truncated marker preserved).
 *   - image → a `[image]` placeholder (binary can't go on the text clipboard).
 * Exported standalone so it's unit-testable without the component.
 */
export function messageToMarkdown(m: NormalizedMessage): string {
  const parts: string[] = [];
  for (const b of m.blocks) {
    switch (b.type) {
      case "text":
        if (b.text.trim()) parts.push(b.text);
        break;
      case "thinking":
        if (b.text.trim()) {
          parts.push(
            `> _thinking_\n` +
              b.text
                .split("\n")
                .map((l) => `> ${l}`)
                .join("\n"),
          );
        }
        break;
      case "tool_use":
        parts.push(toolUseText(b));
        break;
      case "tool_result":
        if (b.content?.trim()) {
          parts.push(`\`\`\`\n${b.content}\n\`\`\``);
        }
        break;
      case "image":
        parts.push("[image]");
        break;
      default:
        break;
    }
  }
  return parts.join("\n\n").trim();
}

/**
 * The hover copy affordance. Sits in a message's header row (it inherits the
 * row's `group` so it fades in on hover, matching the edit / copy-link buttons).
 * `getText` is computed lazily on click so a render never serializes a whole
 * message it isn't copying.
 */
export function CopyMessage({
  message,
  className,
}: {
  message: NormalizedMessage;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback(async () => {
    const text = messageToMarkdown(message);
    let ok = false;
    try {
      // Prefer the async Clipboard API; it's the only path in modern browsers.
      await navigator.clipboard?.writeText(text);
      ok = text.length > 0;
    } catch {
      ok = false;
    }
    setState(ok ? "ok" : "fail");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1500);
  }, [message]);

  return (
    <button
      type="button"
      onClick={copy}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium opacity-0 transition group-hover:opacity-100",
        state === "ok"
          ? "text-emerald-400 opacity-100"
          : state === "fail"
            ? "text-red-400 opacity-100"
            : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200",
        className,
      )}
      title="Copy this message as markdown"
      aria-label="Copy message"
    >
      {state === "fail" ? (
        <X className="h-3 w-3" />
      ) : state === "ok" ? (
        <Check className="h-3 w-3" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
      {state === "ok" ? "Copied" : state === "fail" ? "Failed" : "Copy"}
    </button>
  );
}
