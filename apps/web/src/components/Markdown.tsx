import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import { cn } from "../lib/utils";

/** Extract plain text from React children (for the copy-to-clipboard payload). */
function childText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(childText).join("");
  if (typeof node === "object" && "props" in node) {
    return childText((node as { props?: { children?: ReactNode } }).props?.children);
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
 * Real GitHub-flavored markdown with syntax highlighting, tuned for the dark
 * theme. Kept light because the message list is virtualized.
 */
export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={cn("md-body text-[13.5px] leading-relaxed text-zinc-200", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-2 mt-3 text-[17px] font-semibold text-zinc-100 first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-3 text-[15.5px] font-semibold text-zinc-100 first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1.5 mt-2.5 text-[14px] font-semibold text-zinc-100 first:mt-0">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-1.5 mt-2 text-[13px] font-semibold text-zinc-200 first:mt-0">
              {children}
            </h4>
          ),
          p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => (
            <ul className="my-1.5 list-disc space-y-0.5 pl-5 marker:text-zinc-600">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1.5 list-decimal space-y-0.5 pl-5 marker:text-zinc-600">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
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
            <td className="border-b border-zinc-800/60 px-3 py-1.5 text-zinc-300">{children}</td>
          ),
          // <pre> only wraps block code, so it owns the chrome (copy + label).
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          code: ({ className: codeClass, children, ...props }) => {
            // Block code is highlighted (has a language- class from rehype) and
            // sits inside <pre>; everything else is inline.
            const isBlock = /\blanguage-/.test(codeClass ?? "") || /\bhljs\b/.test(codeClass ?? "");
            if (isBlock) {
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
