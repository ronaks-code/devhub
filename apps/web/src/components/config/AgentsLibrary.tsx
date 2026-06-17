import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Bot, Check, Copy, FileCode } from "lucide-react";
import { api } from "../../lib/api";
import type { AgentDef, ConfigScope } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui";

/** A scope chip used in the list rows (matches McpManager's styling). */
function ScopeChip({ scope }: { scope: ConfigScope }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1",
        scope === "global"
          ? "bg-clay-500/10 text-clay-300 ring-clay-500/25"
          : "bg-sky-500/10 text-sky-300 ring-sky-500/25",
      )}
    >
      {scope}
    </span>
  );
}

/**
 * The "open file" affordance. There is no server endpoint to open an editor, so
 * this offers the two things a browser CAN do for an on-disk path: copy it to the
 * clipboard, and a `vscode://file/...` deep link that opens it in VS Code when
 * that handler is registered. Both are best-effort and never throw.
 */
function OpenFile({ filePath }: { filePath: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(filePath)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  // VS Code expects an absolute, leading-slash path after `vscode://file`.
  const vscodeHref = `vscode://file${filePath.startsWith("/") ? "" : "/"}${filePath}`;
  return (
    <div className="flex items-center gap-1">
      <a
        href={vscodeHref}
        title="Open in VS Code (if installed)"
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
      >
        <FileCode className="h-3 w-3" />
        Open
      </a>
      <button
        onClick={copy}
        title="Copy file path"
        className={cn(
          "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium transition",
          copied
            ? "text-emerald-400"
            : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200",
        )}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? "Copied" : "Copy path"}
      </button>
    </div>
  );
}

function AgentRow({ agent }: { agent: AgentDef }) {
  return (
    <li className="flex flex-col gap-1.5 rounded-xl border border-zinc-800/80 bg-zinc-900/30 px-3.5 py-3">
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 shrink-0 text-clay-400" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-100">
          {agent.name}
        </span>
        {agent.model ? (
          <span
            className="rounded-md bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400"
            title="Preferred model (from frontmatter)"
          >
            {agent.model}
          </span>
        ) : null}
        <ScopeChip scope={agent.scope} />
      </div>
      {agent.description ? (
        <p className="text-[12px] leading-relaxed text-zinc-400">{agent.description}</p>
      ) : (
        <p className="text-[12px] italic text-zinc-600">No description.</p>
      )}
      <div className="flex items-center justify-between gap-2">
        <span
          className="min-w-0 truncate font-mono text-[10.5px] text-zinc-600"
          title={agent.filePath}
          dir="rtl"
        >
          {agent.filePath}
        </span>
        <OpenFile filePath={agent.filePath} />
      </div>
    </li>
  );
}

/**
 * Read-only library of subagents — the global set plus, when a project cwd is
 * available, that project's. Fetched from GET /api/config/agents (engine
 * `listAgents`). Shows each agent's name, description, preferred model, and
 * scope, with copy-path / open-in-VS-Code affordances. No writes: agents are
 * authored as `agents/*.md` files; this view surfaces what's installed.
 */
export function AgentsLibrary({ projectCwd }: { projectCwd?: string }) {
  const [agents, setAgents] = useState<AgentDef[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAgents(null);
    setError(null);
    api
      .config.agents(projectCwd)
      .then((a) => {
        if (!cancelled) setAgents(a);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectCwd]);

  // Global first, then project; alphabetical within each scope so the list is stable.
  const sorted = useMemo(() => {
    if (!agents) return [];
    const rank = (s: ConfigScope) => (s === "global" ? 0 : 1);
    return [...agents].sort(
      (a, b) => rank(a.scope) - rank(b.scope) || a.name.localeCompare(b.name),
    );
  }, [agents]);

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-[13px] text-red-300">
        <AlertCircle className="h-4 w-4 shrink-0" />
        Failed to load agents: {error}
      </div>
    );
  }
  if (!agents) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }
  if (sorted.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 px-4 py-10 text-center">
        <Bot className="mx-auto mb-2 h-8 w-8 text-zinc-700" />
        <div className="text-[13px] font-medium text-zinc-400">No subagents found</div>
        <p className="mx-auto mt-1 max-w-sm text-[11.5px] text-zinc-600">
          Add agents under <code className="text-zinc-500">~/.claude/agents/</code>
          {projectCwd ? (
            <>
              {" "}or <code className="text-zinc-500">.claude/agents/</code> in this project
            </>
          ) : null}{" "}
          and they'll appear here.
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2.5">
      {sorted.map((a) => (
        <AgentRow key={`${a.scope}:${a.filePath}`} agent={a} />
      ))}
    </ul>
  );
}
