import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Eye, FileText, Loader2, Pencil, Save } from "lucide-react";
import { api } from "../../lib/api";
import type { ClaudeMdDoc, ConfigScope } from "../../lib/types";
import { approxTokens, compactNumber } from "../../lib/format";
import { cn } from "../../lib/utils";
import { Markdown } from "../Markdown";
import { Spinner } from "../ui";

const textareaCls =
  "min-h-[20rem] w-full resize-y rounded-lg bg-zinc-900 px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-zinc-200 ring-1 ring-zinc-800 placeholder:text-zinc-600 focus:outline-none focus:ring-clay-500/40";

/** Edit / Preview toggle for the body. */
type ViewMode = "edit" | "preview";

/**
 * Edit the project's memory file — CLAUDE.md — across scopes. Reads the file via
 * GET /api/config/claudemd (global → ~/.claude/CLAUDE.md, or project →
 * <cwd>/CLAUDE.md when a project is open) and saves it via PUT, which does a
 * safe (.bak backup -> atomic) write server-side.
 *
 * Plain words: this is the file that tells Claude how YOU like things done. The
 * editor shows a live markdown preview of what you typed and an approximate token
 * count, because everything here gets prepended to context — so a smaller file
 * leaves more room for the actual conversation.
 *
 * Note: writing CLAUDE.md via this config route is explicitly allowed (it's not a
 * user transcript). The token count uses a ~4-chars/token heuristic — labeled
 * "approx" because there's no real tokenizer in the browser bundle.
 */
export function ClaudeMdEditor({ projectCwd }: { projectCwd?: string }) {
  const [scope, setScope] = useState<ConfigScope>("global");
  const [doc, setDoc] = useState<ClaudeMdDoc | null>(null);
  const [text, setText] = useState("");
  const [view, setView] = useState<ViewMode>("edit");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Project scope only makes sense when a project is open; otherwise force global.
  const effectiveScope: ConfigScope = scope === "project" && projectCwd ? "project" : "global";
  const cwdArg = effectiveScope === "project" ? projectCwd : undefined;

  const load = useCallback(
    (signal?: { cancelled: boolean }) => {
      setDoc(null);
      setLoadError(null);
      setSaveError(null);
      setSavedAt(null);
      api.config
        .getClaudeMd(effectiveScope, cwdArg)
        .then((d) => {
          if (signal?.cancelled) return;
          setDoc(d);
          setText(d.content);
        })
        .catch((e) => {
          if (signal?.cancelled) return;
          setLoadError(e instanceof Error ? e.message : String(e));
        });
    },
    [effectiveScope, cwdArg],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  const save = useCallback(async () => {
    setSaveError(null);
    setSaving(true);
    try {
      const res = await api.config.putClaudeMd(effectiveScope, text, cwdArg);
      // Reflect the written path immediately (handy when the file was new).
      setDoc((prev) =>
        prev ? { ...prev, filePath: res.filePath, content: text } : { scope: res.scope, filePath: res.filePath, content: text },
      );
      setSavedAt(Date.now());
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedAt(null), 2000);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [effectiveScope, text, cwdArg]);

  const tokens = approxTokens(text);
  const dirty = doc !== null && text !== doc.content;

  return (
    <section className="space-y-4 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <FileText className="h-4 w-4 text-zinc-500" />
        <h2 className="text-[13px] font-semibold text-zinc-200">CLAUDE.md</h2>
        <span
          className="rounded-md bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500"
          title="Approximate token count (~4 chars/token). All of this is prepended to context."
        >
          ~{compactNumber(tokens)} tokens
        </span>
        {dirty ? (
          <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
            unsaved
          </span>
        ) : null}
        <select
          value={effectiveScope}
          onChange={(e) => setScope(e.target.value as ConfigScope)}
          className="ml-auto rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-200 ring-1 ring-zinc-800 focus:outline-none focus:ring-clay-500/40"
          title="Scope"
        >
          <option value="global">global (~/.claude/CLAUDE.md)</option>
          <option value="project" disabled={!projectCwd}>
            project{projectCwd ? "" : " (open a project first)"}
          </option>
        </select>
      </div>
      <p className="-mt-2 text-[11.5px] text-zinc-600">
        Your memory/instructions file — prepended to every session so Claude knows how you like
        things done. Edited as markdown; saving backs up the target file before writing.
      </p>

      {loadError ? (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{loadError}</span>
        </div>
      ) : null}

      {doc === null && !loadError ? (
        <div className="flex items-center gap-2 py-4 text-[12px] text-zinc-500">
          <Spinner className="h-4 w-4" />
          Loading CLAUDE.md…
        </div>
      ) : null}

      {doc ? (
        <>
          {/* Edit / Preview segmented toggle. */}
          <div className="inline-flex items-center rounded-lg bg-zinc-900 p-0.5 ring-1 ring-zinc-800">
            {(
              [
                { id: "edit", label: "Edit", icon: <Pencil className="h-3.5 w-3.5" /> },
                { id: "preview", label: "Preview", icon: <Eye className="h-3.5 w-3.5" /> },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setView(t.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-[12px] font-medium transition",
                  view === t.id
                    ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/30"
                    : "text-zinc-500 hover:text-zinc-300",
                )}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>

          {view === "edit" ? (
            <textarea
              className={textareaCls}
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              placeholder="# Project memory&#10;&#10;Describe conventions, commands, and preferences Claude should always follow…"
            />
          ) : (
            <div className="min-h-[20rem] rounded-lg bg-zinc-900/60 px-4 py-3 ring-1 ring-zinc-800">
              {text.trim() ? (
                <Markdown text={text} />
              ) : (
                <div className="py-8 text-center text-[12px] text-zinc-600">
                  Nothing to preview yet — switch to Edit and start typing.
                </div>
              )}
            </div>
          )}

          {doc.filePath ? (
            <div className="text-[11px] text-zinc-600">
              File:{" "}
              <code className="rounded bg-zinc-800/70 px-1 text-[10.5px] text-zinc-500">
                {doc.filePath}
              </code>
            </div>
          ) : (
            <div className="text-[11px] text-zinc-600">
              No CLAUDE.md exists at this scope yet — saving will create it.
            </div>
          )}

          {saveError ? (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-300">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{saveError}</span>
            </div>
          ) : null}

          <div className="flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving || !dirty}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg bg-clay-500 px-3.5 py-1.5 text-[13px] font-medium text-white transition hover:bg-clay-600 disabled:opacity-50",
              )}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save CLAUDE.md
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
