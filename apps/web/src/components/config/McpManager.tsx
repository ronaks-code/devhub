import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  Loader2,
  Pencil,
  Plus,
  Server,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../../lib/api";
import type { ConfigScope, McpServerDef, McpServerInput } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui";

const inputCls =
  "rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[13px] text-zinc-200 ring-1 ring-zinc-800 placeholder:text-zinc-600 focus:outline-none focus:ring-clay-500/40";

/** A scope chip used in the list rows. */
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
 * The editor form. Drives the whole entry through a JSON textarea so any valid
 * MCP shape (stdio command/args/env, sse/http url) can be entered, with a small
 * validation pass that mirrors the engine's accept rules before we send.
 */
function McpEditor({
  initialName,
  initialJson,
  initialScope,
  scopeLocked,
  projectCwd,
  busy,
  onCancel,
  onSubmit,
}: {
  initialName: string;
  initialJson: string;
  initialScope: ConfigScope;
  /** When editing an existing server, the scope can't change (name+scope is the key). */
  scopeLocked: boolean;
  /** Whether a project cwd is available (enables the "project" scope option). */
  projectCwd?: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string, entry: McpServerInput, scope: ConfigScope) => void;
}) {
  const [name, setName] = useState(initialName);
  const [scope, setScope] = useState<ConfigScope>(initialScope);
  const [json, setJson] = useState(initialJson);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Server name is required.");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      setError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setError("Config must be a JSON object.");
      return;
    }
    const entry = parsed as McpServerInput;
    const type = entry.type ?? "stdio";
    if (type === "stdio") {
      if (!entry.command || typeof entry.command !== "string" || !entry.command.trim()) {
        setError('A "stdio" server needs a non-empty "command".');
        return;
      }
    } else if (!entry.url || typeof entry.url !== "string" || !entry.url.trim()) {
      setError(`A "${type}" server needs a "url".`);
      return;
    }
    if (scope === "project" && !projectCwd) {
      setError("Pick a project (open one in Browse/Chat) to use project scope.");
      return;
    }
    onSubmit(trimmed, entry, scope);
  };

  return (
    <div className="rounded-xl border border-clay-500/30 bg-zinc-900/50 p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-zinc-300">Server name</span>
          <input
            className={cn(inputCls, scopeLocked && "opacity-60")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. filesystem"
            disabled={scopeLocked}
            autoFocus={!scopeLocked}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-zinc-300">Scope</span>
          <select
            className={cn(inputCls, scopeLocked && "opacity-60")}
            value={scope}
            onChange={(e) => setScope(e.target.value as ConfigScope)}
            disabled={scopeLocked}
          >
            <option value="global">global (~/.claude.json)</option>
            <option value="project" disabled={!projectCwd}>
              project{projectCwd ? "" : " (open a project first)"}
            </option>
          </select>
        </label>
      </div>

      <label className="mt-3 flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-zinc-300">Config (JSON)</span>
        <textarea
          className={cn(inputCls, "min-h-[8rem] resize-y font-mono text-[12px] leading-relaxed")}
          value={json}
          onChange={(e) => setJson(e.target.value)}
          spellCheck={false}
        />
        <span className="text-[11px] text-zinc-600">
          stdio: {"{"} "command": "npx", "args": ["-y", "pkg"], "env": {"{}"} {"}"} · http/sse:{" "}
          {"{"} "type": "http", "url": "https://…" {"}"}
        </span>
      </label>

      {error ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={submit}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg bg-clay-500 px-3 py-1.5 text-[13px] font-medium text-white transition hover:bg-clay-600 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Save server
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-[13px] font-medium text-zinc-300 transition hover:bg-zinc-700 disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Pretty-print an existing server's `raw` entry for the JSON editor. */
function rawToJson(def: McpServerDef): string {
  try {
    return JSON.stringify(def.raw, null, 2);
  } catch {
    return "{}";
  }
}

const NEW_TEMPLATE = JSON.stringify(
  { type: "stdio", command: "", args: [] },
  null,
  2,
);

/** An editing target: "new" for the add form, or an existing server def. */
type EditTarget = { mode: "new" } | { mode: "edit"; def: McpServerDef } | null;

/**
 * Manage MCP servers across scopes. Lists every configured server (global +
 * project when a cwd is given), and supports add / edit / remove through a
 * JSON-validated form. All writes go through the engine config module via the
 * server, which validates + backs up ~/.claude.json before writing.
 */
export function McpManager({ projectCwd }: { projectCwd?: string }) {
  const [servers, setServers] = useState<McpServerDef[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await api.config.mcpList(projectCwd);
      setServers(list);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [projectCwd]);

  useEffect(() => {
    let cancelled = false;
    setServers(null);
    api.config
      .mcpList(projectCwd)
      .then((list) => {
        if (!cancelled) setServers(list);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectCwd]);

  const handleSubmit = useCallback(
    async (name: string, entry: McpServerInput, scope: ConfigScope) => {
      setBusy(true);
      setLoadError(null);
      try {
        // Scope is implied by cwd: project scope passes the project cwd; global
        // passes none. The write echoes the target (not the list), so re-fetch.
        await api.config.mcpSet(name, entry, scope === "project" ? projectCwd : undefined);
        await reload();
        setEditing(null);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [projectCwd, reload],
  );

  const handleDelete = useCallback(
    async (def: McpServerDef) => {
      setBusy(true);
      setLoadError(null);
      try {
        // Match the server's existing scope: project servers need the cwd.
        await api.config.mcpDelete(def.name, def.scope === "project" ? projectCwd : undefined);
        await reload();
        setPendingDelete(null);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
        // Re-sync in case the delete partially applied.
        void reload();
      } finally {
        setBusy(false);
      }
    },
    [projectCwd, reload],
  );

  // A stable key per server (name is unique within a scope).
  const keyed = useMemo(
    () => (servers ?? []).map((s) => ({ k: `${s.scope}:${s.name}`, s })),
    [servers],
  );

  return (
    <section className="space-y-4 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-5">
      <div className="flex items-center gap-2">
        <Server className="h-4 w-4 text-zinc-500" />
        <h2 className="text-[13px] font-semibold text-zinc-200">MCP servers</h2>
        <span className="rounded-md bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
          {servers ? servers.length : "…"}
        </span>
        {!editing ? (
          <button
            onClick={() => setEditing({ mode: "new" })}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-clay-500/15 px-2.5 py-1 text-[12px] font-medium text-clay-300 ring-1 ring-clay-500/30 transition hover:bg-clay-500/25 hover:text-clay-200"
          >
            <Plus className="h-3.5 w-3.5" />
            Add server
          </button>
        ) : null}
      </div>
      <p className="-mt-2 text-[11.5px] text-zinc-600">
        Model Context Protocol servers Claude Code can connect to. Writes back up{" "}
        <code className="rounded bg-zinc-800/70 px-1 text-[11px]">~/.claude.json</code> before saving.
      </p>

      {loadError ? (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{loadError}</span>
        </div>
      ) : null}

      {editing?.mode === "new" ? (
        <McpEditor
          initialName=""
          initialJson={NEW_TEMPLATE}
          initialScope="global"
          scopeLocked={false}
          projectCwd={projectCwd}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSubmit={handleSubmit}
        />
      ) : null}

      {servers === null && !loadError ? (
        <div className="flex items-center gap-2 py-4 text-[12px] text-zinc-500">
          <Spinner className="h-4 w-4" />
          Loading servers…
        </div>
      ) : null}

      {servers && servers.length === 0 && !editing ? (
        <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-6 text-center text-[12px] text-zinc-600">
          No MCP servers configured yet. Add one to get started.
        </div>
      ) : null}

      <ul className="space-y-2">
        {keyed.map(({ k, s }) =>
          editing?.mode === "edit" && editing.def.scope === s.scope && editing.def.name === s.name ? (
            <li key={k}>
              <McpEditor
                initialName={s.name}
                initialJson={rawToJson(s)}
                initialScope={s.scope}
                scopeLocked
                projectCwd={projectCwd}
                busy={busy}
                onCancel={() => setEditing(null)}
                onSubmit={handleSubmit}
              />
            </li>
          ) : (
            <li
              key={k}
              className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-zinc-100">{s.name}</span>
                  <ScopeChip scope={s.scope} />
                  <span className="rounded bg-zinc-800/70 px-1.5 py-0.5 text-[10px] text-zinc-500">
                    {s.type ?? "stdio"}
                  </span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">
                  {s.command
                    ? [s.command, ...s.args].join(" ")
                    : typeof s.raw.url === "string"
                      ? s.raw.url
                      : "(no command)"}
                </div>
              </div>

              {pendingDelete === k ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="text-[11px] text-zinc-500">Remove?</span>
                  <button
                    onClick={() => handleDelete(s)}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded-md bg-red-500/15 px-2 py-1 text-[11px] font-medium text-red-300 ring-1 ring-red-500/30 transition hover:bg-red-500/25 disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    Yes
                  </button>
                  <button
                    onClick={() => setPendingDelete(null)}
                    disabled={busy}
                    className="rounded-md bg-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-300 transition hover:bg-zinc-700 disabled:opacity-50"
                  >
                    No
                  </button>
                </div>
              ) : (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => {
                      setPendingDelete(null);
                      setEditing({ mode: "edit", def: s });
                    }}
                    className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
                    title="Edit server"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => setPendingDelete(k)}
                    className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-red-300"
                    title="Remove server"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
