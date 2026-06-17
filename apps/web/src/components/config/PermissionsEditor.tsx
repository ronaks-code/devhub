import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CircleSlash,
  HelpCircle,
  Loader2,
  Plus,
  Shield,
  ShieldCheck,
  TestTube2,
  X,
} from "lucide-react";
import { api } from "../../lib/api";
import type { ConfigScope, PermissionsConfig, RuleAction } from "../../lib/types";
import { evaluate, specifierFor } from "../../lib/permissionMatch";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui";

/**
 * Built-in Claude Code tool names, for the rule-input autocomplete. Not
 * exhaustive (MCP tools have dynamic names like `mcp__server__tool`), so the
 * input stays free-form — these are just suggestions.
 */
const TOOL_NAMES = [
  "Bash",
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
] as const;

const inputCls =
  "w-full rounded-lg bg-zinc-900 px-2.5 py-1.5 font-mono text-[12.5px] text-zinc-200 ring-1 ring-zinc-800 placeholder:text-zinc-600 focus:outline-none focus:ring-clay-500/40";

/** Per-bucket visual treatment + icon. */
const ACTION_META: Record<RuleAction, { label: string; icon: React.ReactNode; tone: string; ring: string }> = {
  allow: {
    label: "Allow",
    icon: <ShieldCheck className="h-3.5 w-3.5" />,
    tone: "text-emerald-300",
    ring: "ring-emerald-500/20",
  },
  ask: {
    label: "Ask",
    icon: <HelpCircle className="h-3.5 w-3.5" />,
    tone: "text-amber-300",
    ring: "ring-amber-500/20",
  },
  deny: {
    label: "Deny",
    icon: <CircleSlash className="h-3.5 w-3.5" />,
    tone: "text-red-300",
    ring: "ring-red-500/20",
  },
};

/**
 * A single rule input with a tool-name autocomplete. As the user types the tool
 * portion (before any `(`), we offer matching built-in tool names; picking one
 * inserts `Name(` so the next keystroke begins the matcher. Free-form otherwise,
 * since MCP tools and custom patterns can't be enumerated.
 */
function RuleInput({
  value,
  onChange,
  onSubmit,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder?: string;
}) {
  const [focused, setFocused] = useState(false);
  // Suggest only while typing the tool name (no "(" yet) and there's a prefix.
  const toolPrefix = value.includes("(") ? "" : value.trim();
  const suggestions = useMemo(() => {
    if (!focused || !toolPrefix) return [];
    const lower = toolPrefix.toLowerCase();
    return TOOL_NAMES.filter(
      (t) => t.toLowerCase().startsWith(lower) && t.toLowerCase() !== lower,
    ).slice(0, 6);
  }, [focused, toolPrefix]);

  return (
    <div className="relative flex-1">
      <input
        className={inputCls}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        // Delay blur so a suggestion mousedown still registers.
        onBlur={() => window.setTimeout(() => setFocused(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      {suggestions.length > 0 ? (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 shadow-xl">
          {suggestions.map((t) => (
            <button
              key={t}
              type="button"
              // onMouseDown (not onClick) so it fires before the input's blur.
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(`${t}(`);
              }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[12px] text-zinc-300 hover:bg-clay-500/10 hover:text-clay-200"
            >
              {t}
              <span className="text-zinc-600">(…)</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One bucket (allow/ask/deny): its rules + an add box. */
function RuleBucket({
  action,
  rules,
  onAdd,
  onRemove,
  busy,
}: {
  action: RuleAction;
  rules: string[];
  onAdd: (rule: string) => void;
  onRemove: (rule: string) => void;
  busy: boolean;
}) {
  const meta = ACTION_META[action];
  const [draft, setDraft] = useState("");
  const submit = () => {
    const v = draft.trim();
    if (!v) return;
    onAdd(v);
    setDraft("");
  };
  return (
    <div className={cn("rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-4 ring-1", meta.ring)}>
      <div className={cn("mb-3 flex items-center gap-1.5 text-[12px] font-semibold", meta.tone)}>
        {meta.icon}
        {meta.label}
        <span className="rounded-md bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
          {rules.length}
        </span>
      </div>

      <div className="mb-3 flex flex-col gap-1.5">
        {rules.length === 0 ? (
          <div className="text-[11.5px] text-zinc-600">No {action} rules.</div>
        ) : (
          rules.map((r) => (
            <div
              key={r}
              className="group flex items-center gap-2 rounded-lg bg-zinc-900/60 px-2.5 py-1 ring-1 ring-zinc-800"
            >
              <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-300" title={r}>
                {r}
              </code>
              <button
                onClick={() => onRemove(r)}
                disabled={busy}
                className="shrink-0 rounded p-0.5 text-zinc-600 opacity-0 transition hover:bg-zinc-800 hover:text-red-300 group-hover:opacity-100 disabled:opacity-40"
                title="Remove rule"
                aria-label={`Remove ${action} rule ${r}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="flex items-center gap-2">
        <RuleInput
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          placeholder={action === "allow" ? "Bash(git status:*)" : action === "deny" ? "Read(./.env)" : "Edit(src/**)"}
        />
        <button
          onClick={submit}
          disabled={busy || !draft.trim()}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-zinc-800 px-2.5 py-1.5 text-[12px] font-medium text-zinc-200 transition hover:bg-zinc-700 disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </button>
      </div>
    </div>
  );
}

/**
 * The "tester": pick a tool + type an input, and see which bucket wins under the
 * CURRENT merged rules — using the client-side matcher (clearly approximate). Helps
 * sanity-check a rule before relying on it.
 */
function RuleTester({ perms }: { perms: PermissionsConfig }) {
  const [tool, setTool] = useState<string>("Bash");
  const [input, setInput] = useState<string>("git status");

  // The tester input is a raw string; for Bash it's the command, for file tools
  // it's the path. We wrap it as the right shape so specifierFor reads it the way
  // a real tool call would.
  const wrappedInput = useMemo<unknown>(() => {
    if (tool === "Bash") return { command: input };
    if (["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep"].includes(tool)) {
      return { file_path: input };
    }
    return input;
  }, [tool, input]);

  const outcome = useMemo(() => evaluate(perms, tool, wrappedInput), [perms, tool, wrappedInput]);
  const specifier = useMemo(() => specifierFor(tool, wrappedInput), [tool, wrappedInput]);

  const decisionMeta: Record<typeof outcome.decision, { label: string; cls: string }> = {
    deny: { label: "DENY", cls: "bg-red-500/15 text-red-300 ring-red-500/30" },
    ask: { label: "ASK", cls: "bg-amber-500/15 text-amber-300 ring-amber-500/30" },
    allow: { label: "ALLOW", cls: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30" },
    default: { label: "DEFAULT (no rule)", cls: "bg-zinc-800 text-zinc-400 ring-zinc-700" },
  };
  const dm = decisionMeta[outcome.decision];

  return (
    <section className="space-y-3 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-4">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-200">
        <TestTube2 className="h-4 w-4 text-zinc-500" />
        Rule tester
        <span className="rounded-md bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
          approximate
        </span>
      </div>
      <p className="-mt-1 text-[11.5px] text-zinc-600">
        See which bucket wins for a tool call under the current rules. Client-side estimate of
        Claude Code's matching (deny &gt; ask &gt; allow) — for a sanity check, not enforcement.
      </p>
      <div className="flex flex-wrap items-stretch gap-2">
        <input
          list="perm-tester-tools"
          className="w-32 rounded-lg bg-zinc-900 px-2.5 py-1.5 font-mono text-[12.5px] text-zinc-200 ring-1 ring-zinc-800 focus:outline-none focus:ring-clay-500/40"
          value={tool}
          onChange={(e) => setTool(e.target.value.trim())}
          placeholder="Tool"
          spellCheck={false}
        />
        <datalist id="perm-tester-tools">
          {TOOL_NAMES.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <input
          className={cn(inputCls, "flex-1")}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={tool === "Bash" ? "git status" : "src/index.ts"}
          spellCheck={false}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
        <span
          className={cn(
            "inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1",
            dm.cls,
          )}
        >
          {dm.label}
        </span>
        <span className="text-zinc-600">
          matched on <code className="rounded bg-zinc-800/70 px-1 text-zinc-400">{specifier || "(empty)"}</code>
        </span>
        {outcome.matched.deny ? (
          <span className="text-zinc-600">
            · deny: <code className="text-red-300/80">{outcome.matched.deny}</code>
          </span>
        ) : null}
        {outcome.matched.ask ? (
          <span className="text-zinc-600">
            · ask: <code className="text-amber-300/80">{outcome.matched.ask}</code>
          </span>
        ) : null}
        {outcome.matched.allow ? (
          <span className="text-zinc-600">
            · allow: <code className="text-emerald-300/80">{outcome.matched.allow}</code>
          </span>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Edit Claude Code's permission rules (allow / ask / deny) via GET/PUT
 * /api/permissions. Reads the MERGED view across the settings.json layers (global,
 * or global+project when a project cwd is given). Writes always go to the USER
 * settings.json server-side (the route only ever touches that one file), so adds
 * and removes here edit your global rules even when viewing the merged set.
 *
 * Includes a tool-name autocomplete on the rule inputs and a client-side "tester"
 * that shows which bucket wins for a sample tool call (approximate — the engine
 * owns the authoritative matcher).
 */
export function PermissionsEditor({ projectCwd }: { projectCwd?: string }) {
  const [scope, setScope] = useState<ConfigScope>("global");
  const [perms, setPerms] = useState<PermissionsConfig | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const effectiveScope: ConfigScope = scope === "project" && projectCwd ? "project" : "global";
  const cwdArg = effectiveScope === "project" ? projectCwd : undefined;

  const load = useCallback(
    (signal?: { cancelled: boolean }) => {
      setPerms(null);
      setLoadError(null);
      api
        .getPermissions(cwdArg)
        .then((res) => {
          if (signal?.cancelled) return;
          setPerms(res.permissions);
          setSources(res.sources);
        })
        .catch((e) => {
          if (signal?.cancelled) return;
          setLoadError(e instanceof Error ? e.message : String(e));
        });
    },
    [cwdArg],
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

  const flashSaved = () => {
    setSavedAt(Date.now());
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedAt(null), 1800);
  };

  // Optimistic add/remove: update the bucket locally, PUT to the server, and on
  // failure reload from disk so the UI never drifts from the persisted state.
  const mutate = useCallback(
    async (action: RuleAction, rule: string, op: "add" | "remove") => {
      setWriteError(null);
      setBusy(true);
      // Optimistic local update.
      setPerms((prev) => {
        if (!prev) return prev;
        const next: PermissionsConfig = {
          allow: [...prev.allow],
          ask: [...prev.ask],
          deny: [...prev.deny],
        };
        if (op === "add") {
          if (!next[action].includes(rule)) next[action] = [...next[action], rule];
        } else {
          next[action] = next[action].filter((r) => r !== rule);
        }
        return next;
      });
      try {
        await api.putPermissionRule(action, rule, op);
        flashSaved();
      } catch (e) {
        setWriteError(e instanceof Error ? e.message : String(e));
        load(); // resync from disk on failure
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  return (
    <div className="space-y-5">
      <section className="space-y-3 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Shield className="h-4 w-4 text-zinc-500" />
          <h2 className="text-[13px] font-semibold text-zinc-200">Permissions</h2>
          <select
            value={effectiveScope}
            onChange={(e) => setScope(e.target.value as ConfigScope)}
            className="ml-auto rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-200 ring-1 ring-zinc-800 focus:outline-none focus:ring-clay-500/40"
            title="Which layers to read"
          >
            <option value="global">global (~/.claude/settings.json)</option>
            <option value="project" disabled={!projectCwd}>
              project{projectCwd ? "" : " (open a project first)"}
            </option>
          </select>
        </div>
        <p className="-mt-1 text-[11.5px] text-zinc-600">
          Rules controlling which tool calls run automatically. Reads the merged view across
          settings.json layers; adds and removes here write to your global{" "}
          <code className="rounded bg-zinc-800/70 px-1 text-[10.5px] text-zinc-500">
            ~/.claude/settings.json
          </code>
          .
        </p>
      </section>

      {loadError ? (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{loadError}</span>
        </div>
      ) : null}

      {perms === null && !loadError ? (
        <div className="flex items-center gap-2 py-6 text-[12px] text-zinc-500">
          <Spinner className="h-4 w-4" />
          Loading permissions…
        </div>
      ) : null}

      {perms ? (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {(["allow", "ask", "deny"] as const).map((action) => (
              <RuleBucket
                key={action}
                action={action}
                rules={perms[action]}
                onAdd={(rule) => void mutate(action, rule, "add")}
                onRemove={(rule) => void mutate(action, rule, "remove")}
                busy={busy}
              />
            ))}
          </div>

          {writeError ? (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-300">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{writeError}</span>
            </div>
          ) : null}

          <div className="flex items-center gap-3 text-[11px] text-zinc-600">
            {busy ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
              </span>
            ) : savedAt ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-400">
                <Check className="h-3.5 w-3.5" /> Saved to ~/.claude/settings.json
              </span>
            ) : null}
            {sources.length > 0 ? (
              <span>
                Merged from:{" "}
                {sources.map((s, i) => (
                  <span key={s}>
                    {i > 0 ? " · " : ""}
                    <code className="rounded bg-zinc-800/70 px-1 text-[10.5px] text-zinc-500">{s}</code>
                  </span>
                ))}
              </span>
            ) : null}
          </div>

          <RuleTester perms={perms} />
        </>
      ) : null}
    </div>
  );
}
