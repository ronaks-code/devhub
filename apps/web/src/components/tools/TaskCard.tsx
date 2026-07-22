import { createContext, useContext, useState } from "react";
import { Bot, ChevronRight, Loader2, Terminal } from "lucide-react";
import { api } from "../../lib/api";
import type { NormalizedMessage, SubagentRef } from "../../lib/types";
import { cn } from "../../lib/utils";
import { MessageView } from "../MessageView";
import { pairToolResults } from "../../lib/transcript";
import type { PairedToolUse, ToolResultBlock } from "../../lib/transcript";

/**
 * The subagent transcripts available for the CURRENTLY-viewed session, threaded
 * to TaskCard without prop-drilling through MessageView/ToolCard. TranscriptPane
 * (which holds the loaded SessionMessagesPage) provides it; the live ChatPane
 * leaves the default (no session id, no refs), so the Task card there shows the
 * description but the inline-transcript expander is simply unavailable.
 */
export interface SubagentSource {
  /** Session whose /subagent endpoint serves the transcript files. */
  sessionId: string | null;
  /** The subagent files discovered for this session (agentId + filePath). */
  refs: SubagentRef[];
}

const SubagentContext = createContext<SubagentSource>({ sessionId: null, refs: [] });

export const SubagentProvider = SubagentContext.Provider;

/** Pull the human-facing fields out of a Task tool_use input, tolerating shapes. */
function parseTask(input: unknown): {
  description: string | null;
  subagentType: string | null;
  prompt: string | null;
} {
  if (!input || typeof input !== "object") {
    return { description: null, subagentType: null, prompt: null };
  }
  const o = input as Record<string, unknown>;
  return {
    description: typeof o.description === "string" ? o.description : null,
    subagentType: typeof o.subagent_type === "string" ? o.subagent_type : null,
    prompt: typeof o.prompt === "string" ? o.prompt : null,
  };
}

/** A standalone (non-paired) tool_result body, scrolled + capped like elsewhere. */
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
 * Tool-specific renderer for the Task (subagent) tool_use. Shows the subagent's
 * description + type as a labeled card, the final result (the subagent's
 * report), and — when this session's subagent transcript files are available —
 * an expander that lazily loads and renders the FULL subagent transcript inline
 * via GET /api/sessions/:id/subagent. Dispatched from MessageView/ToolCard when a
 * tool_use's name is "Task".
 */
export function TaskCard({ block }: { block: PairedToolUse }) {
  const { sessionId, refs } = useContext(SubagentContext);
  const { description, subagentType, prompt } = parseTask(block.input);
  const result = block.result;
  const isError = result?.isError ?? false;

  // Lazy subagent-transcript load. We don't have a per-Task → file mapping from
  // the engine, so we offer the session's subagent files: with exactly one we
  // load it directly; with several we let the user pick which to view.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [sub, setSub] = useState<NormalizedMessage[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const canLoad = sessionId != null && refs.length > 0;

  const loadSubagent = (filePath: string) => {
    if (!sessionId || loading) return;
    setLoading(true);
    setLoadError(null);
    api
      .subagentMessages(sessionId, filePath)
      .then((msgs) => {
        setSub(pairToolResults(msgs));
        setLoadedFor(filePath);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  return (
    <details className="my-1.5 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40 open:bg-zinc-900/60">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-xs font-medium">
        <Bot className="h-3.5 w-3.5 shrink-0 text-[var(--dh-brand)]" />
        <span className="text-[var(--dh-brand)]">Task</span>
        {subagentType ? (
          <span className="rounded bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
            {subagentType}
          </span>
        ) : null}
        {description ? (
          <span className="truncate text-[11.5px] text-zinc-300" title={description}>
            {description}
          </span>
        ) : (
          <span className="text-[11px] italic text-zinc-600">subagent</span>
        )}
      </summary>

      <div className="border-t border-zinc-800">
        {/* The prompt the subagent was launched with (collapsed). */}
        {prompt ? (
          <details className="border-b border-zinc-800/60">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-500">
              <ChevronRight className="h-3 w-3" />
              instructions
            </summary>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words border-t border-zinc-800/60 px-3 py-2 font-mono text-[12px] leading-relaxed text-zinc-400">
              {prompt}
            </pre>
          </details>
        ) : null}

        {/* The subagent's returned report (the tool_result). */}
        {result ? (
          <details className="border-b border-zinc-800/60" open={!isError}>
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-500">
              <Terminal className="h-3 w-3" />
              {isError ? "error" : "report"}
            </summary>
            <ResultBody result={result} />
          </details>
        ) : null}

        {/* Inline subagent transcript loader. Only when this session's subagent
            files are available (Browse/transcript view). */}
        {canLoad ? (
          <div className="px-3 py-2">
            {sub ? (
              <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/60">
                <div className="flex items-center gap-2 border-b border-zinc-800 px-2.5 py-1.5 text-[11px] font-medium text-zinc-400">
                  <Bot className="h-3.5 w-3.5 text-[var(--dh-brand)]" />
                  subagent transcript
                  <span className="text-zinc-600">· {sub.length} messages</span>
                  {refs.length > 1 ? (
                    <select
                      value={loadedFor ?? ""}
                      onChange={(e) => loadSubagent(e.target.value)}
                      className="ml-auto rounded-md bg-zinc-900 px-1.5 py-0.5 text-[10.5px] text-zinc-300 ring-1 ring-zinc-800 focus:outline-none focus:ring-[var(--dh-focus)]/40"
                      title="Choose which subagent transcript to view"
                    >
                      {refs.map((r) => (
                        <option key={r.filePath} value={r.filePath}>
                          {r.label ?? r.agentId}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
                <div className="max-h-96 overflow-y-auto">
                  {sub.map((m) => (
                    <div key={m.seq} className="border-b border-zinc-900/70 last:border-b-0">
                      <MessageView m={m} />
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <button
                onClick={() => loadSubagent(refs[0]!.filePath)}
                disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800/70 px-2.5 py-1 text-[12px] font-medium text-zinc-300 ring-1 ring-zinc-700/60 transition hover:bg-zinc-800 hover:text-[var(--dh-link)] disabled:opacity-50"
              >
                {loading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                {loading
                  ? "Loading subagent transcript…"
                  : refs.length > 1
                    ? `View subagent transcript (${refs.length} available)`
                    : "View subagent transcript"}
              </button>
            )}
            {loadError ? (
              <p className="mt-1.5 text-[11px] text-red-400">Failed to load: {loadError}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}
