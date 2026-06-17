import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, Loader2, Save, Webhook } from "lucide-react";
import { api } from "../../lib/api";
import type { ConfigScope, HooksConfig } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui";

const textareaCls =
  "min-h-[14rem] w-full resize-y rounded-lg bg-zinc-900 px-2.5 py-2 font-mono text-[12px] leading-relaxed text-zinc-200 ring-1 ring-zinc-800 placeholder:text-zinc-600 focus:outline-none focus:ring-clay-500/40";

/** Pretty-print the hooks map for the editor. Empty map shows a usable skeleton. */
function hooksToJson(hooks: Record<string, unknown[]>): string {
  const keys = Object.keys(hooks);
  if (keys.length === 0) {
    return JSON.stringify(
      { PreToolUse: [], PostToolUse: [], Stop: [] },
      null,
      2,
    );
  }
  try {
    return JSON.stringify(hooks, null, 2);
  } catch {
    return "{}";
  }
}

/**
 * Validate the edited JSON into a hooks map: must be a JSON object whose every
 * value is an array (each event maps to a list of matcher entries). Throws a
 * human-readable message on the first problem. Entry shapes are passed through
 * untouched — Claude Code owns that grammar.
 */
function parseHooks(json: string): Record<string, unknown[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Hooks must be a JSON object (event name -> array of entries).");
  }
  const out: Record<string, unknown[]> = {};
  for (const [event, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      throw new Error(`"${event}" must map to an array of hook entries.`);
    }
    out[event] = value;
  }
  return out;
}

/**
 * Edit the Claude Code hooks map across scopes. Reads the merged view from
 * GET /api/config/hooks (global, or global+project when a project cwd is given)
 * and saves the edited map via PUT /api/config/hooks.
 *
 * Hooks are passed through as a JSON-validated form: we enforce the top-level
 * shape (object of event -> array) but leave each entry's structure to Claude
 * Code, so any current/future matcher syntax round-trips unchanged. The server
 * does its own validate -> .bak backup -> atomic write to the scoped settings.json
 * (global → ~/.claude/settings.json, project → <cwd>/.claude/settings.json).
 */
export function HooksEditor({ projectCwd }: { projectCwd?: string }) {
  const [scope, setScope] = useState<ConfigScope>("global");
  const [config, setConfig] = useState<HooksConfig | null>(null);
  const [json, setJson] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Project scope only makes sense when a project is open; otherwise force global.
  const effectiveScope: ConfigScope = scope === "project" && projectCwd ? "project" : "global";
  const cwdArg = effectiveScope === "project" ? projectCwd : undefined;

  const load = useCallback(() => {
    setConfig(null);
    setLoadError(null);
    setSaveError(null);
    setSavedAt(null);
    api.config
      .getHooks(cwdArg)
      .then((cfg) => {
        setConfig(cfg);
        setJson(hooksToJson(cfg.hooks));
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [cwdArg]);

  useEffect(() => {
    let cancelled = false;
    setConfig(null);
    setLoadError(null);
    setSaveError(null);
    setSavedAt(null);
    api.config
      .getHooks(cwdArg)
      .then((cfg) => {
        if (cancelled) return;
        setConfig(cfg);
        setJson(hooksToJson(cfg.hooks));
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [cwdArg]);

  const save = useCallback(async () => {
    setSaveError(null);
    let hooks: Record<string, unknown[]>;
    try {
      hooks = parseHooks(json);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      return;
    }
    setSaving(true);
    try {
      await api.config.putHooks(effectiveScope, { hooks }, cwdArg);
      setSavedAt(Date.now());
      // Re-sync from disk so the source paths / merged view reflect the write.
      load();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [json, effectiveScope, cwdArg, load]);

  const sources = useMemo(() => config?.sources ?? [], [config]);

  return (
    <section className="space-y-4 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Webhook className="h-4 w-4 text-zinc-500" />
        <h2 className="text-[13px] font-semibold text-zinc-200">Hooks</h2>
        <span className="rounded-md bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
          {config ? Object.keys(config.hooks).length : "…"} events
        </span>
        <select
          value={effectiveScope}
          onChange={(e) => setScope(e.target.value as ConfigScope)}
          className="ml-auto rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-200 ring-1 ring-zinc-800 focus:outline-none focus:ring-clay-500/40"
          title="Scope"
        >
          <option value="global">global (~/.claude/settings.json)</option>
          <option value="project" disabled={!projectCwd}>
            project{projectCwd ? "" : " (open a project first)"}
          </option>
        </select>
      </div>
      <p className="-mt-2 text-[11.5px] text-zinc-600">
        Commands Claude Code runs on lifecycle events (PreToolUse, PostToolUse, Stop, …).
        Edited as a JSON map of event -&gt; entries. Writes back up the target settings.json
        before saving.
      </p>

      {loadError ? (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{loadError}</span>
        </div>
      ) : null}

      {config === null && !loadError ? (
        <div className="flex items-center gap-2 py-4 text-[12px] text-zinc-500">
          <Spinner className="h-4 w-4" />
          Loading hooks…
        </div>
      ) : null}

      {config ? (
        <>
          <textarea
            className={textareaCls}
            value={json}
            onChange={(e) => setJson(e.target.value)}
            spellCheck={false}
          />

          {sources.length > 0 ? (
            <div className="text-[11px] text-zinc-600">
              Merged from:{" "}
              {sources.map((s, i) => (
                <span key={s}>
                  {i > 0 ? " · " : ""}
                  <code className="rounded bg-zinc-800/70 px-1 text-[10.5px] text-zinc-500">{s}</code>
                </span>
              ))}
            </div>
          ) : null}

          {saveError ? (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-300">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{saveError}</span>
            </div>
          ) : null}

          <div className="flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg bg-clay-500 px-3.5 py-1.5 text-[13px] font-medium text-white transition hover:bg-clay-600 disabled:opacity-50",
              )}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save hooks
            </button>
            {savedAt ? (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                Saved
              </span>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
