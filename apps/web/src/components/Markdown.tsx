import { Suspense, lazy } from "react";
import { cn } from "../lib/utils";

// The heavy markdown stack — react-markdown + remark/rehype + katex +
// highlight.js — is the single biggest dependency in the app. It's only needed
// once a transcript (or a markdown preview) actually renders, so we split it
// into its own chunk and load it on demand. This keeps the initial Browse load
// lean; the chunk is fetched the first time any Markdown mounts, then cached.
const MarkdownImpl = lazy(() =>
  import("./MarkdownImpl").then((m) => ({ default: m.MarkdownImpl })),
);

/**
 * Plain-text fallback shown for the brief moment the markdown chunk is loading
 * (only the very first time, then it's cached). Renders the source verbatim with
 * preserved whitespace so the content is readable immediately — a short
 * unhighlighted/un-typeset flash, no blank gap or layout jump.
 */
function MarkdownFallback({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn(
        "md-body whitespace-pre-wrap text-[13.5px] leading-relaxed text-zinc-200",
        className,
      )}
    >
      {text}
    </div>
  );
}

/**
 * Real GitHub-flavored markdown with syntax highlighting + math, tuned for the
 * dark theme. A thin lazy wrapper: the actual renderer (and its heavy deps) lives
 * in {@link "./MarkdownImpl"} and loads on first use. The public API is unchanged
 * — same props, same output once the chunk lands — so every existing caller works
 * as before; the only difference is faster initial load.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <Suspense fallback={<MarkdownFallback text={text} className={className} />}>
      <MarkdownImpl text={text} className={className} />
    </Suspense>
  );
}
