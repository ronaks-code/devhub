import { useState, type ReactNode } from "react";
import { Check, Copy, Terminal } from "lucide-react";
import type { PairedToolUse } from "../../lib/transcript";
import { cn } from "../../lib/utils";

/** Pull the command (+ optional description) out of a Bash tool_use input. */
function parseBash(input: unknown): { command: string; description?: string } | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (typeof o.command !== "string") return null;
  return {
    command: o.command,
    description: typeof o.description === "string" ? o.description : undefined,
  };
}

/** A compact copy-to-clipboard button matching the Markdown code-block style. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        // Inside a <summary>: don't toggle the disclosure when copying.
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 ring-1 ring-zinc-700/70 transition hover:bg-zinc-700 hover:text-zinc-100"
      title="Copy command"
    >
      {copied ? <Check className="h-3 w-3 text-[var(--dh-link)]" /> : <Copy className="h-3 w-3" />}
      {copied ? "copied" : "copy"}
    </button>
  );
}

/**
 * Tool-specific renderer for the Bash tool_use. Shows the command in a monospace,
 * copyable header line and the paired stdout/result below with success/error
 * styling driven by the tool_result's `isError`. Dispatched from MessageView when
 * a tool_use's name is "Bash"; falls back to the generic ToolCard when the input
 * doesn't carry a string command.
 */
export function BashCard({
  block,
  fallback,
}: {
  block: PairedToolUse;
  /** Generic renderer used when the Bash input is unparseable. */
  fallback: () => ReactNode;
}) {
  const parsed = parseBash(block.input);
  if (!parsed) return <>{fallback()}</>;

  const result = block.result;
  const isError = result?.isError ?? false;
  const stdout = result?.content ?? "";
  const long = stdout.length > 800;
  const head = long ? stdout.slice(0, 800) : stdout;

  return (
    <details
      className={cn(
        "my-1.5 overflow-hidden rounded-lg border bg-zinc-900/40 open:bg-zinc-900/60",
        isError ? "border-red-900/60" : "border-zinc-800",
      )}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-xs font-medium">
        <Terminal className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
        <span className="shrink-0 text-emerald-400">Bash</span>
        <code
          className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-zinc-300"
          title={parsed.command}
        >
          {parsed.command}
        </code>
        {result ? (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
              isError ? "bg-red-500/10 text-red-300" : "bg-emerald-500/10 text-emerald-300",
            )}
          >
            {isError ? "exit ≠ 0" : "exit 0"}
          </span>
        ) : null}
        <CopyButton text={parsed.command} />
      </summary>

      {/* Full command (monospace, wrapped) — the summary truncates it. */}
      <div className="border-t border-zinc-800 px-3 py-2">
        {parsed.description ? (
          <div className="mb-1 text-[11px] text-zinc-500">{parsed.description}</div>
        ) : null}
        <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-zinc-200">
          <span className="select-none text-zinc-600">$ </span>
          {parsed.command}
        </pre>
      </div>

      {/* Paired stdout / result, with exit styling. */}
      {result ? (
        <div
          className={cn(
            "border-t",
            isError ? "border-red-900/60" : "border-zinc-800/60",
          )}
        >
          <div className="flex items-center gap-2 px-3 pt-1.5 text-[10.5px] font-medium text-zinc-500">
            <span>{isError ? "stderr / output" : "stdout"}</span>
            {long ? (
              <span className="text-zinc-600">· {stdout.length.toLocaleString()} chars</span>
            ) : null}
          </div>
          <pre
            className={cn(
              "overflow-x-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-relaxed",
              isError ? "text-red-300" : "text-zinc-400",
            )}
          >
            {long ? `${head}\n…` : head || "(no output)"}
          </pre>
        </div>
      ) : null}
    </details>
  );
}
