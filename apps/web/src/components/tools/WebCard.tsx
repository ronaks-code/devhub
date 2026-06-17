import { useMemo, type ReactNode } from "react";
import { Globe, Link as LinkIcon, Search } from "lucide-react";
import type { PairedToolUse } from "../../lib/transcript";
import { cn } from "../../lib/utils";
import { Markdown } from "../Markdown";

/** Parsed view of a WebFetch tool_use: a URL plus the analysis prompt. */
interface ParsedFetch {
  kind: "fetch";
  /** The URL being fetched (WebFetch `url`). */
  url: string;
  /** The instruction applied to the fetched page (WebFetch `prompt`), if given. */
  prompt?: string;
}

/** Parsed view of a WebSearch tool_use: the query plus any domain filters. */
interface ParsedSearch {
  kind: "search";
  /** The search query (WebSearch `query`). */
  query: string;
  /** Domains the search was restricted to (WebSearch `allowed_domains`). */
  allowed?: string[];
  /** Domains excluded from the search (WebSearch `blocked_domains`). */
  blocked?: string[];
}

type Parsed = ParsedFetch | ParsedSearch;

/** Coerce an unknown value to a string array of non-empty entries (or undefined). */
function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return out.length > 0 ? out : undefined;
}

/**
 * Pull the relevant fields out of a WebFetch or WebSearch tool_use input.
 * WebFetch carries `url` (+ optional `prompt`); WebSearch carries `query` (+
 * optional allowed/blocked domain lists). Returns null when the expected key is
 * missing, so the caller can fall back to the generic tool card.
 */
function parseWeb(name: string, input: unknown): Parsed | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (name === "WebFetch") {
    if (typeof o.url !== "string") return null;
    return {
      kind: "fetch",
      url: o.url,
      prompt: typeof o.prompt === "string" ? o.prompt : undefined,
    };
  }
  // WebSearch
  if (typeof o.query !== "string") return null;
  return {
    kind: "search",
    query: o.query,
    allowed: strArray(o.allowed_domains),
    blocked: strArray(o.blocked_domains),
  };
}

/** Best-effort short hostname for a URL, for the summary chip. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A small labeled domain chip (allowed / blocked) for the WebSearch subheader. */
function DomainChip({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-zinc-800/70 px-1.5 py-0.5 text-[10px] text-zinc-400">
      <span className={tone}>{label}</span>
      <span className="font-mono text-zinc-300">{value}</span>
    </span>
  );
}

/**
 * Tool-specific renderer for the WebFetch AND WebSearch tool_use. For WebFetch it
 * shows the URL (as a clickable link) + the analysis prompt; for WebSearch the
 * query + any allowed/blocked domain filters. Below either, the tool_result is
 * rendered as a clean markdown summary rather than a raw JSON dump. Dispatched
 * from ToolCard when a tool_use's name is "WebFetch" or "WebSearch"; falls back to
 * the generic card when the input lacks the expected url/query field.
 *
 * Plain words: instead of a wall of raw text, this says "Claude looked at this
 * page / searched the web for this — here's what it found," with the link/query
 * up top and the findings formatted underneath.
 */
export function WebCard({
  block,
  fallback,
}: {
  block: PairedToolUse;
  /** Generic renderer used when the input lacks url/query. */
  fallback: () => ReactNode;
}) {
  const name = block.name || "";
  const parsed = useMemo(() => parseWeb(name, block.input), [name, block.input]);

  const result = block.result;
  const isError = result?.isError ?? false;
  const content = (result?.content ?? "").trim();

  if (!parsed) return <>{fallback()}</>;

  const isFetch = parsed.kind === "fetch";
  const Icon = isFetch ? Globe : Search;
  const tone = isFetch ? "text-sky-400" : "text-cyan-400";
  const label = isFetch ? "WebFetch" : "WebSearch";
  // The header's one-line summary: the host (fetch) or the query (search).
  const headline = isFetch ? hostOf(parsed.url) : parsed.query;

  const long = content.length > 4000;
  const shown = long ? content.slice(0, 4000) : content;

  return (
    <details
      className={cn(
        "my-1.5 overflow-hidden rounded-lg border bg-zinc-900/40 open:bg-zinc-900/60",
        isError ? "border-red-900/60" : "border-zinc-800",
      )}
      open
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-xs font-medium">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", tone)} />
        <span className={cn("shrink-0", tone)}>{label}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-zinc-300" title={headline}>
          {headline}
        </span>
        {result ? (
          isError ? (
            <span className="shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
              error
            </span>
          ) : (
            <span className="shrink-0 rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-zinc-400">
              {content ? `${content.length.toLocaleString()} chars` : "no result"}
            </span>
          )
        ) : null}
      </summary>

      {/* Query/URL + filters subheader. */}
      <div className="flex flex-col gap-1.5 border-t border-zinc-800 px-3 py-2">
        {isFetch ? (
          <a
            href={parsed.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex max-w-full items-center gap-1.5 text-[12px] text-sky-400 hover:text-sky-300 hover:underline"
            title={parsed.url}
          >
            <LinkIcon className="h-3 w-3 shrink-0" />
            <span className="truncate font-mono">{parsed.url}</span>
          </a>
        ) : (
          <div className="font-mono text-[12px] text-zinc-200">{parsed.query}</div>
        )}
        {isFetch && parsed.prompt ? (
          <div className="text-[11.5px] text-zinc-500">
            <span className="text-zinc-600">asked: </span>
            {parsed.prompt}
          </div>
        ) : null}
        {!isFetch && (parsed.allowed || parsed.blocked) ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {parsed.allowed?.map((d) => (
              <DomainChip key={`a:${d}`} label="only" value={d} tone="text-emerald-500/80" />
            ))}
            {parsed.blocked?.map((d) => (
              <DomainChip key={`b:${d}`} label="not" value={d} tone="text-red-500/80" />
            ))}
          </div>
        ) : null}
      </div>

      {/* Result summary — markdown-rendered, or an error/empty state. */}
      {result ? (
        isError ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words border-t border-red-900/60 px-3 py-2 font-mono text-[12px] leading-relaxed text-red-300">
            {content || "(error)"}
          </pre>
        ) : content ? (
          <div className="border-t border-zinc-800 px-3 py-2">
            <Markdown text={shown} />
            {long ? (
              <div className="mt-1 text-[11px] text-zinc-600">
                … truncated (showing first {shown.length.toLocaleString()} of{" "}
                {content.length.toLocaleString()} chars)
              </div>
            ) : null}
          </div>
        ) : (
          <div className="border-t border-zinc-800 px-3 py-2 text-[11.5px] text-zinc-600">
            No results.
          </div>
        )
      ) : null}
    </details>
  );
}
