import { Children, Fragment, memo, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import hljs from "highlight.js/lib/core";
import jsonLang from "highlight.js/lib/languages/json";
import { Check, Copy, Hash, List } from "lucide-react";
import { cn } from "../lib/utils";
import { linkifyText } from "../lib/linkify";
import { OpenInEditor, useCwd } from "./OpenInEditor";

// A minimal highlight.js instance registered with only the JSON grammar — used
// to re-highlight a fenced ```json block AFTER we pretty-print it (rehype-highlight
// already ran on the original, un-indented source, so we redo this one ourselves).
hljs.registerLanguage("json", jsonLang);

/**
 * Pretty-print a JSON string with 2-space indentation. Returns `null` when the
 * input does NOT parse as JSON (so the caller leaves the original block alone —
 * a malformed/partial JSON fence still renders verbatim instead of erroring).
 * Cheap parse → only attempted on blocks already tagged `language-json`.
 */
function prettyJson(src: string): string | null {
  const trimmed = src.trim();
  if (!trimmed) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

/** Extract plain text from React children (for the copy-to-clipboard payload). */
function childText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(childText).join("");
  if (typeof node === "object" && "props" in node) {
    const props = (node as { props?: { "data-copy-text"?: string; children?: ReactNode } }).props;
    // A pretty-printed JSON block renders its highlighted markup via
    // dangerouslySetInnerHTML (so it has no React children to walk); it stashes
    // the reformatted source on data-copy-text so Copy yields the indented JSON.
    if (props && typeof props["data-copy-text"] === "string") return props["data-copy-text"];
    return childText(props?.children);
  }
  return "";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="inline-flex items-center gap-1 rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 ring-1 ring-zinc-700/70 transition hover:bg-zinc-700 hover:text-zinc-100"
      title="Copy code"
    >
      {copied ? <Check className="h-3 w-3 text-clay-300" /> : <Copy className="h-3 w-3" />}
      {copied ? "copied" : "copy"}
    </button>
  );
}

/** Pull the language- class off a fenced block's inner <code> child. */
function langOf(children: ReactNode): string | null {
  if (children && typeof children === "object" && "props" in children) {
    const cls = (children as { props?: { className?: string } }).props?.className ?? "";
    const m = /language-([\w-]+)/.exec(cls);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * A bare file path rendered as a styled, clickable token. When the active pane
 * exposes a project cwd (via {@link useCwd}), an inline {@link OpenInEditor} button
 * sits beside it so the path opens in the user's editor. Without a cwd it degrades
 * to a plain styled span (OpenInEditor renders nothing), so cwd-less transcripts
 * still read fine. Never rendered inside code — the linkify pass only touches the
 * text children of block elements (see {@link Linkify}).
 */
function FilePathToken({ path }: { path: string }) {
  const cwd = useCwd();
  return (
    <span className="inline-flex items-baseline gap-0.5 align-baseline">
      <code className="rounded bg-zinc-800/70 px-1 py-0.5 font-mono text-[12px] text-clay-200">
        {path}
      </code>
      {cwd ? <OpenInEditor file={path} className="px-0.5 py-0" /> : null}
    </span>
  );
}

/**
 * Walk a block element's rendered children and promote URLs / file paths found in
 * its plain-text runs into clickable affordances. STRING children are linkified;
 * any already-rendered element child (an inline `<code>`, `<a>`, `<strong>`, …) is
 * passed through untouched — so code is never linkified (react-markdown renders
 * code via its own `code` component before this ever sees it).
 */
function Linkify({ children }: { children: ReactNode }): ReactNode {
  return Children.map(children, (child, i) => {
    if (typeof child !== "string") return child;
    const tokens = linkifyText(child);
    // Fast path: nothing linkable, return the original string unchanged.
    if (tokens.length === 1 && tokens[0]!.kind === "text") return child;
    return (
      <Fragment key={i}>
        {tokens.map((tok, j) => {
          if (tok.kind === "url") {
            return (
              <a
                key={j}
                href={tok.href}
                target="_blank"
                rel="noreferrer noopener"
                className="text-clay-300 underline decoration-clay-500/40 underline-offset-2 transition hover:text-clay-400 hover:decoration-clay-400"
              >
                {tok.value}
              </a>
            );
          }
          if (tok.kind === "path") return <FilePathToken key={j} path={tok.value} />;
          return <Fragment key={j}>{tok.value}</Fragment>;
        })}
      </Fragment>
    );
  });
}

/** True for a `li` react-markdown hands us that GFM tagged as a task-list item. */
function isTaskListItem(props: { className?: string }): boolean {
  return /\btask-list-item\b/.test(props.className ?? "");
}

/**
 * A fenced code block with a language label + hover copy button. Renders in
 * place of <pre>, so it only ever wraps real block code (never inline `code`).
 */
function CodeBlock({ children }: { children: ReactNode }) {
  const text = childText(children);
  const language = langOf(children);
  return (
    <div className="group/code relative my-2">
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1.5 opacity-0 transition group-hover/code:opacity-100">
        {language ? (
          <span className="rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 ring-1 ring-zinc-700/70">
            {language}
          </span>
        ) : null}
        <CopyButton text={text} />
      </div>
      <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-3 font-mono text-[12.5px] leading-relaxed text-zinc-200 ring-1 ring-zinc-800">
        {children}
      </pre>
    </div>
  );
}

/**
 * Slugify heading text into a stable, URL-hash-safe id: lower-cased, non-word runs
 * collapsed to single hyphens, trimmed. Deterministic for the same text, so a
 * pre-scan of the source and the rendered heading agree on the id (then a
 * de-duplicating counter keeps repeats unique — "setup", "setup-1", …). Mirrors the
 * common GitHub-style slug so a `#heading` anchor lands where you'd expect.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** One heading entry for the in-transcript table of contents. */
interface TocEntry {
  /** 2 or 3 — only h2/h3 get anchors + a TOC row. */
  depth: 2 | 3;
  text: string;
  id: string;
}

/**
 * Scan the raw markdown for ATX h2/h3 headings (`## …` / `### …`) and assign each a
 * unique slug id (de-duplicating with a numeric suffix). Returns the ordered list +
 * a slug-resolver the heading renderers reuse so the rendered id matches the TOC
 * link exactly. Fenced code blocks are skipped so a `## ` inside a ``` block isn't
 * mistaken for a heading.
 *
 * Done as a source scan (not in the heading component) because the TOC needs ALL
 * the headings up front and react-markdown renders each heading in isolation.
 */
function scanHeadings(src: string): { toc: TocEntry[]; nextSlug: (text: string) => string } {
  const toc: TocEntry[] = [];
  const counts = new Map<string, number>();
  // Assign the next unique slug for a heading's text (deterministic per render).
  const nextSlug = (text: string): string => {
    const base = slugify(text) || "section";
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };

  let inFence = false;
  for (const line of src.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length as 2 | 3;
    const text = m[2]!.trim();
    toc.push({ depth, text, id: nextSlug(text), });
  }
  return { toc, nextSlug };
}

/** Pull the plain text of a heading's children (to slugify it the same way). */
function headingText(children: ReactNode): string {
  return childText(children).trim();
}

/**
 * A collapsible "On this page" table of contents for a long assistant answer.
 * Anchor links smooth-scroll to the heading and set the URL hash so the spot is
 * shareable. Rendered above the body only when there are enough headings to be
 * worth it (see {@link TOC_MIN_HEADINGS}).
 */
function TableOfContents({ entries }: { entries: TocEntry[] }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="not-prose my-2 rounded-lg border border-zinc-800/70 bg-zinc-900/40"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-[12px] font-medium text-zinc-400 transition hover:text-zinc-200">
        <List className="h-3.5 w-3.5" />
        On this page
        <span className="text-zinc-600">· {entries.length}</span>
      </summary>
      <nav className="border-t border-zinc-800/70 px-3 py-2" aria-label="Table of contents">
        <ul className="space-y-0.5">
          {entries.map((e) => (
            <li key={e.id} className={e.depth === 3 ? "pl-3" : undefined}>
              <a
                href={`#${e.id}`}
                onClick={(ev) => {
                  // Smooth-scroll to the heading and set the hash without the
                  // default jump, so the scroll animates and the URL stays shareable.
                  const target = document.getElementById(e.id);
                  if (target) {
                    ev.preventDefault();
                    target.scrollIntoView({ behavior: "smooth", block: "start" });
                    if (typeof history !== "undefined") history.replaceState(null, "", `#${e.id}`);
                  }
                }}
                className="block truncate text-[12px] text-zinc-500 transition hover:text-clay-300"
              >
                {e.text}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </details>
  );
}

/**
 * Render a heading (h2/h3) with a stable slug id (so it's a hash target) plus a `#`
 * link that appears on hover and updates the URL hash. The heading element keeps its
 * semantic tag + id; a relatively-positioned wrapper hangs the anchor in the gutter.
 * The slug comes from {@link scanHeadings}'s resolver so it matches the TOC link.
 */
function AnchoredHeading({
  tag: Tag,
  id,
  className,
  children,
}: {
  tag: "h2" | "h3";
  id: string;
  className: string;
  children: ReactNode;
}) {
  // `scroll-mt` so a smooth-scroll/hash jump doesn't tuck the heading under the
  // sticky transcript chrome. The id lives on the heading itself for correct
  // semantics + a real hash target.
  return (
    <Tag id={id} className={cn("group/h relative scroll-mt-16", className)}>
      <a
        href={`#${id}`}
        aria-label="Link to this section"
        onClick={(ev) => {
          ev.preventDefault();
          document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
          if (typeof history !== "undefined") history.replaceState(null, "", `#${id}`);
        }}
        className="absolute -left-4 top-1/2 -translate-y-1/2 text-zinc-600 opacity-0 transition hover:text-clay-300 group-hover/h:opacity-100"
      >
        <Hash className="h-3.5 w-3.5" />
      </a>
      {children}
    </Tag>
  );
}

/** A long answer earns a table of contents at (and above) this many h2/h3 headings. */
const TOC_MIN_HEADINGS = 3;

/**
 * Real GitHub-flavored markdown with syntax highlighting, tuned for the dark
 * theme. Kept light because the message list is virtualized.
 *
 * The heavy markdown stack (react-markdown + remark/rehype + katex + highlight.js)
 * lives here so the public {@link "./Markdown".Markdown} wrapper can lazy-load it —
 * keeping those deps out of the initial JS chunk until a transcript first renders.
 */
export const MarkdownImpl = memo(function MarkdownImpl({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  // Pre-scan for h2/h3 headings: the result feeds the optional TOC and gives the
  // heading renderers a slug resolver so their ids match the TOC links. Recomputed
  // only when the source text changes. A fresh resolver is created per render of the
  // tree below so the de-dupe counter restarts in sync with the rendered headings.
  const toc = useMemo(() => scanHeadings(text).toc, [text]);
  const showToc = toc.length >= TOC_MIN_HEADINGS;
  // Per-render slug resolver, restarted each render so the counter tracks the
  // rendered heading order 1:1 (matching the pre-scan that built `toc`).
  const slug = scanHeadings(text).nextSlug;
  return (
    <div className={cn("md-body text-[13.5px] leading-relaxed text-zinc-200", className)}>
      {showToc ? <TableOfContents entries={toc} /> : null}
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-2 mt-3 text-[17px] font-semibold text-zinc-100 first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <AnchoredHeading
              tag="h2"
              id={slug(headingText(children))}
              className="mb-2 mt-3 text-[15.5px] font-semibold text-zinc-100 first:mt-0"
            >
              {children}
            </AnchoredHeading>
          ),
          h3: ({ children }) => (
            <AnchoredHeading
              tag="h3"
              id={slug(headingText(children))}
              className="mb-1.5 mt-2.5 text-[14px] font-semibold text-zinc-100 first:mt-0"
            >
              {children}
            </AnchoredHeading>
          ),
          h4: ({ children }) => (
            <h4 className="mb-1.5 mt-2 text-[13px] font-semibold text-zinc-200 first:mt-0">
              {children}
            </h4>
          ),
          p: ({ children }) => (
            <p className="my-1.5 first:mt-0 last:mb-0">
              <Linkify>{children}</Linkify>
            </p>
          ),
          ul: ({ children, className }) => (
            // A GFM task list (`- [ ]`) drops the disc bullet — the checkbox is the
            // marker — and tightens the indent; ordinary lists keep the disc.
            <ul
              className={cn(
                "my-1.5 space-y-0.5 marker:text-zinc-600",
                /\bcontains-task-list\b/.test(className ?? "")
                  ? "list-none pl-1"
                  : "list-disc pl-5",
              )}
            >
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1.5 list-decimal space-y-0.5 pl-5 marker:text-zinc-600">{children}</ol>
          ),
          li: ({ children, className }) =>
            isTaskListItem({ className }) ? (
              // Task-list item: the checkbox renders inline (see the `input`
              // renderer); flex-align it with the text and linkify the rest.
              <li className="flex items-baseline gap-1.5 leading-relaxed">
                <Linkify>{children}</Linkify>
              </li>
            ) : (
              <li className="leading-relaxed">
                <Linkify>{children}</Linkify>
              </li>
            ),
          // GFM task-list checkboxes (`- [ ]` / `- [x]`) render as real, disabled
          // checkboxes tinted to the theme. remark-gfm already marks them disabled;
          // we keep that (read-only — a transcript checkbox isn't interactive) and
          // pass `checked` straight through so open/closed state is faithful.
          input: ({ type, checked, disabled }) =>
            type === "checkbox" ? (
              <input
                type="checkbox"
                checked={!!checked}
                disabled={disabled ?? true}
                readOnly
                aria-hidden
                className="mt-0.5 h-3 w-3 shrink-0 translate-y-px cursor-default rounded-sm border-zinc-700 bg-zinc-800 accent-clay-500"
              />
            ) : null,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-clay-300 underline decoration-clay-500/40 underline-offset-2 transition hover:text-clay-400 hover:decoration-clay-400"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-zinc-700 pl-3 text-zinc-400">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-zinc-800" />,
          strong: ({ children }) => (
            <strong className="font-semibold text-zinc-100">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto rounded-lg ring-1 ring-zinc-800">
              <table className="w-full border-collapse text-[12.5px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-zinc-900/70">{children}</thead>,
          th: ({ children }) => (
            <th className="border-b border-zinc-800 px-3 py-1.5 text-left font-semibold text-zinc-300">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-zinc-800/60 px-3 py-1.5 text-zinc-300">
              <Linkify>{children}</Linkify>
            </td>
          ),
          // <pre> only wraps block code, so it owns the chrome (copy + label).
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          code: ({ className: codeClass, children, ...props }) => {
            // Block code is highlighted (has a language- class from rehype) and
            // sits inside <pre>; everything else is inline.
            const isBlock = /\blanguage-/.test(codeClass ?? "") || /\bhljs\b/.test(codeClass ?? "");
            if (isBlock) {
              // Pretty-print fenced ```json blocks: reformat the source with a
              // 2-space indent, then RE-highlight it ourselves. rehype-highlight
              // already ran (in the rehype pass) on the original, un-indented
              // text and replaced `children` with colored spans — so we flatten
              // those back to source via childText(), reformat, and re-run hljs
              // on the result. If the text isn't valid JSON, prettyJson() returns
              // null and we fall through to the already-highlighted children.
              if (/\blanguage-json\b/.test(codeClass ?? "")) {
                const pretty = prettyJson(childText(children));
                if (pretty != null) {
                  const html = hljs.highlight(pretty, { language: "json" }).value;
                  return (
                    <code
                      className={cn("hljs language-json")}
                      data-copy-text={pretty}
                      dangerouslySetInnerHTML={{ __html: html }}
                      {...props}
                    />
                  );
                }
              }
              return (
                <code className={cn("hljs", codeClass)} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className="rounded bg-zinc-800/70 px-1 py-0.5 font-mono text-[12px] text-clay-200"
                {...props}
              >
                {children}
              </code>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
