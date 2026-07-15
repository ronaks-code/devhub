import { useCallback, useEffect, useRef, useState } from "react";
import { Blocks, Bot, Check, FileText, Loader2, PiggyBank, Save, Send, Server, Shield, SlidersHorizontal, Sparkles, Webhook } from "lucide-react";
import { api, type AppSettings } from "../lib/api";
import { PERMISSION_MODES, type PermissionMode } from "@devhub/engine/driver";
import type { DevHubFeatureFlags } from "@devhub/engine/providers";
import { cn } from "../lib/utils";
import { readCompat, writeCompat } from "../lib/compat-storage";
import { Spinner } from "./ui";
import { McpManager } from "./config/McpManager";
import { HooksEditor } from "./config/HooksEditor";
import { PermissionsEditor } from "./config/PermissionsEditor";
import { AgentsLibrary } from "./config/AgentsLibrary";
import { SkillsManager } from "./config/SkillsManager";
import { ClaudeMdEditor } from "./config/ClaudeMdEditor";
import { PluginsView } from "./config/PluginsView";
import { WebhooksManager } from "./config/WebhooksManager";
import { RebuildIndex } from "./config/RebuildIndex";
import { IntegrityPanel } from "./config/IntegrityPanel";
import { ArchiveTransfer } from "./config/ArchiveTransfer";
import { BudgetSettings } from "./BudgetSettings";

/** Sub-tabs within the Settings view. */
type SettingsSection =
  | "preferences"
  | "budget"
  | "memory"
  | "mcp"
  | "hooks"
  | "webhooks"
  | "permissions"
  | "agents"
  | "skills"
  | "plugins";

const MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
] as const;

const THEMES = ["dark", "light", "system"] as const;
const DENSITIES = ["comfortable", "compact"] as const;

/** Complete the settings route's exact six-field feature contract without importing Node runtime code. */
export function completeDevHubFeatures(
  value: Partial<DevHubFeatureFlags> | undefined,
): DevHubFeatureFlags {
  return {
    nativeCodex: value?.nativeCodex === true,
    persistentClaude: value?.persistentClaude === true,
    unifiedTaskIndex: value?.unifiedTaskIndex === true,
    shellChrome: value?.shellChrome === true,
    taskRail: value?.taskRail === true,
    taskHeaderSetup: value?.taskHeaderSetup === true,
    threadWorkspace: value?.threadWorkspace === true,
    composerSurface: value?.composerSurface === true,
    inspectorDock: value?.inspectorDock === true,
    searchCommands: value?.searchCommands === true,
    settingsSecondary: value?.settingsSecondary === true,
    codexStyleShell: value?.codexStyleShell === true,
    crossProviderFork: value?.crossProviderFork === true,
    workMode: value?.workMode === true,
  };
}

/** Apply the local checkbox intent while preserving every other feature request. */
export function withNativeCodexPreference(
  settings: AppSettings,
  enabled: boolean,
): AppSettings {
  const resolved = completeDevHubFeatures(settings.devHubFeatures);
  const requested = completeDevHubFeatures(
    settings.requestedDevHubFeatures ?? settings.devHubFeatures,
  );
  return {
    ...settings,
    devHubFeatures: {
      ...resolved,
      nativeCodex: settings.requestedDevHubFeatures === undefined
        ? enabled
        : resolved.nativeCodex,
    },
    requestedDevHubFeatures: {
      ...requested,
      nativeCodex: enabled,
    },
  };
}

/** Apply the Claude runtime request without presenting a server-clamped flag as enabled. */
export function withPersistentClaudePreference(
  settings: AppSettings,
  enabled: boolean,
): AppSettings {
  const resolved = completeDevHubFeatures(settings.devHubFeatures);
  const requested = completeDevHubFeatures(
    settings.requestedDevHubFeatures ?? settings.devHubFeatures,
  );
  return {
    ...settings,
    devHubFeatures: {
      ...resolved,
      persistentClaude: settings.requestedDevHubFeatures === undefined
        ? enabled
        : resolved.persistentClaude,
    },
    requestedDevHubFeatures: {
      ...requested,
      persistentClaude: enabled,
    },
  };
}

/** Build the persisted Preferences payload, including every required feature boolean. */
export function settingsUpdatePayload(settings: AppSettings): Partial<AppSettings> {
  return {
    defaultModel: settings.defaultModel,
    defaultPermissionMode: settings.defaultPermissionMode,
    theme: settings.theme,
    density: settings.density,
    monthlyBudgetUsd: settings.monthlyBudgetUsd ?? null,
    devHubFeatures: completeDevHubFeatures(
      settings.requestedDevHubFeatures ?? settings.devHubFeatures,
    ),
  };
}

const EDITABLE_SETTING_KEYS = [
  "defaultModel",
  "defaultPermissionMode",
  "theme",
  "density",
  "monthlyBudgetUsd",
] as const satisfies readonly (keyof AppSettings)[];

/** Build a merge-safe patch containing only fields the Preferences form changed. */
export function dirtySettingsUpdatePayload(
  settings: AppSettings,
  dirty: ReadonlySet<keyof AppSettings>,
): Partial<AppSettings> {
  const full = settingsUpdatePayload(settings);
  const patch: Partial<AppSettings> = {};
  for (const key of EDITABLE_SETTING_KEYS) {
    if (dirty.has(key)) (patch as Record<string, unknown>)[key] = full[key];
  }
  if (dirty.has("devHubFeatures") || dirty.has("requestedDevHubFeatures")) {
    patch.devHubFeatures = full.devHubFeatures;
  }
  return patch;
}

/** Rebase an authoritative snapshot underneath unsaved local fields. */
export function mergeAuthoritativeSettings(
  current: AppSettings | null,
  authoritative: AppSettings,
  dirty: Set<keyof AppSettings>,
): AppSettings {
  if (!current || dirty.size === 0) return authoritative;
  const merged: AppSettings = { ...authoritative };
  for (const key of [...dirty]) {
    const authoritativeValue = authoritative[key];
    const localValue = current[key];
    if (JSON.stringify(authoritativeValue) === JSON.stringify(localValue)) {
      dirty.delete(key);
    } else {
      (merged as Record<string, unknown>)[key] = localValue;
    }
  }
  return merged;
}

/** Publish to the shell before deciding whether this pane still owns local UI state. */
export function deliverSettingsResponse(
  settings: AppSettings,
  requestVersion: number | undefined,
  onSettingsSaved: ((settings: AppSettings, requestVersion?: number) => boolean | void) | undefined,
  localRequestIsCurrent: boolean,
): boolean {
  const shellAccepted = onSettingsSaved?.(settings, requestVersion) !== false;
  return shellAccepted && localRequestIsCurrent;
}

/** A dropped PUT response may still have committed, so recovery must outlive this pane. */
export function requestSettingsReconciliation(
  onSettingsReconcile: (() => void | Promise<void>) | undefined,
): void {
  try {
    void onSettingsReconcile?.();
  } catch {
    // The App-level bounded reconciliation keeps the last known-safe snapshot.
  }
}

/**
 * Client-only connection settings (API host + token), kept in localStorage as
 * groundwork for talking to a remote engine later. Deliberately NOT sent to the
 * server — they describe how the browser reaches a server, so they can't live
 * there. Mirrors the SSR-guarded storage style used across the app.
 */
const CONN_KEY = "devhub:conn";
interface ConnSettings {
  apiHost?: string;
  apiToken?: string;
}
function readConn(): ConnSettings {
  try {
    const raw = readCompat(CONN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ConnSettings) : {};
  } catch {
    return {};
  }
}
function writeConn(c: ConnSettings): void {
  writeCompat(CONN_KEY, JSON.stringify(c));
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-zinc-300">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-zinc-600">{hint}</span> : null}
    </label>
  );
}

const selectCls =
  "rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[13px] text-zinc-200 ring-1 ring-zinc-800 focus:outline-none focus:ring-clay-500/40";
const inputCls =
  "rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[13px] text-zinc-200 ring-1 ring-zinc-800 placeholder:text-zinc-600 focus:outline-none focus:ring-clay-500/40";

/**
 * Settings tab. Server-backed fields (model, permission mode, theme, density,
 * monthly budget) load from GET /api/settings and save via PUT /api/settings.
 * Connection fields (host/token) are client-only and persist to localStorage.
 *
 * onSettingsSaved lets the app react immediately (e.g. apply a new theme or
 * default model) without waiting for a reload.
 */
export function SettingsPane({
  onSettingsSaved,
  onSettingsRequestStart,
  onSettingsReconcile,
  authoritativeSettings,
  projectCwd,
}: {
  onSettingsSaved?: (s: AppSettings, requestVersion?: number) => boolean | void;
  /** Share request ordering with the shell so stale responses cannot re-enable a clamped runtime. */
  onSettingsRequestStart?: () => number;
  /** App-owned reread that remains valid after this pane unmounts. */
  onSettingsReconcile?: () => void | Promise<void>;
  /** App-level latest-wins snapshot; keeps this editor from adopting stale concurrent responses. */
  authoritativeSettings?: AppSettings | null;
  /** Active project's working dir; enables project-scoped MCP server edits. */
  projectCwd?: string;
}) {
  const [section, setSection] = useState<SettingsSection>("preferences");
  const [settings, setSettings] = useState<AppSettings | null>(authoritativeSettings ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const [conn, setConn] = useState<ConnSettings>(() => readConn());
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestVersion = useRef(0);
  const dirtySettings = useRef(new Set<keyof AppSettings>());

  const loadSettings = useCallback(async (preserveNotice = false) => {
    const localVersion = ++requestVersion.current;
    const shellVersion = onSettingsRequestStart?.();
    if (!preserveNotice) setLoadError(null);
    try {
      const next = await api.getSettings();
      if (!deliverSettingsResponse(
        next,
        shellVersion,
        onSettingsSaved,
        requestVersion.current === localVersion,
      )) return;
      setSettings((current) => mergeAuthoritativeSettings(
        current,
        next,
        dirtySettings.current,
      ));
    } catch (reason) {
      if (requestVersion.current !== localVersion) return;
      setLoadError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [onSettingsRequestStart, onSettingsSaved]);

  useEffect(() => {
    if (authoritativeSettings) {
      requestVersion.current += 1;
      setSettings((current) => mergeAuthoritativeSettings(
        current,
        authoritativeSettings,
        dirtySettings.current,
      ));
      setLoadError((current) => current?.startsWith("Save response was not confirmed")
        ? current
        : null);
      return;
    }
    void loadSettings();
  }, [authoritativeSettings, loadSettings]);

  useEffect(() => {
    return () => {
      requestVersion.current += 1;
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  // Local edit helper: patch a single key in the in-memory settings object.
  const patch = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    dirtySettings.current.add(key);
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const save = async () => {
    if (!settings) return;
    const payload = dirtySettingsUpdatePayload(settings, dirtySettings.current);
    const savedKeys = [...dirtySettings.current];
    if (Object.keys(payload).length === 0) {
      writeConn(conn);
      setSavedAt(Date.now());
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedAt(null), 2000);
      return;
    }
    const localVersion = ++requestVersion.current;
    const shellVersion = onSettingsRequestStart?.();
    setSaving(true);
    setLoadError(null);
    try {
      const next = await api.putSettings(payload);
      const keepLocalState = deliverSettingsResponse(
        next,
        shellVersion,
        onSettingsSaved,
        requestVersion.current === localVersion,
      );
      writeConn(conn);
      if (!keepLocalState) return;
      for (const key of savedKeys) dirtySettings.current.delete(key);
      // The response is authoritative: runtime-unavailable features are clamped
      // false by the server, so neither this form nor the shell advertises them.
      setSettings(next);
      setSavedAt(Date.now());
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedAt(null), 2000);
    } catch (e) {
      requestSettingsReconciliation(onSettingsReconcile);
      if (requestVersion.current !== localVersion) return;
      setLoadError(`Save response was not confirmed; reconciling settings. ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (requestVersion.current === localVersion) setSaving(false);
    }
  };

  const budgetStr =
    settings?.monthlyBudgetUsd == null ? "" : String(settings.monthlyBudgetUsd);

  // The server-backed Preferences body owns its own loading/error states so the
  // sub-tab chrome (and the MCP tab) stays usable even if settings fail to load.
  const preferencesBody =
    loadError && !settings ? (
      <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-[13px] text-red-300">
        <p>Failed to load settings: {loadError}</p>
        <button
          type="button"
          onClick={() => void loadSettings()}
          className="mt-3 rounded-md bg-red-500/15 px-2.5 py-1 text-[12px] font-medium text-red-200 ring-1 ring-red-500/30 hover:bg-red-500/25"
        >
          Retry settings
        </button>
      </div>
    ) : !settings ? (
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="flex items-center justify-center gap-2 py-16"
      >
        <Spinner aria-hidden="true" className="h-5 w-5" />
        <span className="sr-only">Loading settings…</span>
      </div>
    ) : (
      <>
        <fieldset disabled={saving} className="contents">
        <section className="space-y-5 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-5">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field label="Default model" hint="Used when starting a new chat.">
              <select
                className={selectCls}
                value={settings.defaultModel ?? MODELS[0]}
                onChange={(e) => patch("defaultModel", e.target.value)}
              >
                {MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Default permission mode" hint="How edits/commands are approved.">
              <select
                className={selectCls}
                value={settings.defaultPermissionMode ?? PERMISSION_MODES[0]}
                onChange={(e) => patch("defaultPermissionMode", e.target.value as PermissionMode)}
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Theme" hint="Stored for now; full theming lands later.">
              <select
                className={selectCls}
                value={settings.theme ?? "system"}
                onChange={(e) => patch("theme", e.target.value as AppSettings["theme"])}
              >
                {THEMES.map((t) => (
                  <option key={t} value={t} className="capitalize">
                    {t}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Density">
              <select
                className={selectCls}
                value={settings.density ?? "comfortable"}
                onChange={(e) => patch("density", e.target.value)}
              >
                {DENSITIES.map((d) => (
                  <option key={d} value={d} className="capitalize">
                    {d}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Monthly budget (USD)" hint="Soft cap for spend tracking. Blank = no budget.">
              <input
                type="number"
                min="0"
                step="1"
                inputMode="decimal"
                placeholder="No budget"
                className={inputCls}
                value={budgetStr}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  if (v === "") return patch("monthlyBudgetUsd", null);
                  const n = Number(v);
                  patch("monthlyBudgetUsd", Number.isFinite(n) ? n : null);
                }}
              />
            </Field>
          </div>

          <div className="border-t border-zinc-800/80 pt-4">
            <label className="flex cursor-pointer items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-[12px] font-medium text-zinc-300">
                  Native Codex
                </span>
                <span id="native-codex-hint" className="mt-1 block text-[11px] text-zinc-600">
                  {completeDevHubFeatures(settings.requestedDevHubFeatures ?? settings.devHubFeatures).nativeCodex &&
                  !completeDevHubFeatures(settings.devHubFeatures).nativeCodex
                    ? "Requested, but the verified Codex runtime is unavailable. Turn this off to clear the saved request."
                    : "Use the verified Codex app-server task surface. The server keeps the effective feature off when the runtime gate is unavailable."}
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-label="Enable native Codex"
                aria-describedby="native-codex-hint"
                checked={completeDevHubFeatures(
                  settings.requestedDevHubFeatures ?? settings.devHubFeatures,
                ).nativeCodex}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  dirtySettings.current.add("requestedDevHubFeatures");
                  setSettings((current) => current
                    ? withNativeCodexPreference(current, enabled)
                    : current);
                }}
                className="mt-0.5 h-4 w-4 shrink-0 accent-clay-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
              />
            </label>
          </div>

          <div className="border-t border-zinc-800/80 pt-4">
            <label className="flex cursor-pointer items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-[12px] font-medium text-zinc-300">
                  Persistent Claude
                </span>
                <span id="persistent-claude-hint" className="mt-1 block text-[11px] text-zinc-600">
                  {completeDevHubFeatures(settings.requestedDevHubFeatures ?? settings.devHubFeatures).persistentClaude &&
                  !completeDevHubFeatures(settings.devHubFeatures).persistentClaude
                    ? "Requested, but the verified Claude CLI runtime or programmatic API/cloud authentication is unavailable. Turn this off to clear the saved request."
                    : "Use the provider-native persistent Claude CLI task surface. The server keeps it off unless its runtime, authentication, and lifecycle gates are available."}
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-label="Enable persistent Claude"
                aria-describedby="persistent-claude-hint"
                checked={completeDevHubFeatures(
                  settings.requestedDevHubFeatures ?? settings.devHubFeatures,
                ).persistentClaude}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  dirtySettings.current.add("requestedDevHubFeatures");
                  setSettings((current) => current
                    ? withPersistentClaudePreference(current, enabled)
                    : current);
                }}
                className="mt-0.5 h-4 w-4 shrink-0 accent-clay-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
              />
            </label>
          </div>
        </section>

        <section className="mt-6 space-y-5 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-5">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-zinc-500" />
            <h2 className="text-[13px] font-semibold text-zinc-200">Connection</h2>
            <span className="rounded-md bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
              local only
            </span>
          </div>
          <p className="-mt-2 text-[11.5px] text-zinc-600">
            Groundwork for connecting to a remote engine. Stored only in this browser.
          </p>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field label="API host" hint="e.g. https://my-machine:5179">
              <input
                type="text"
                placeholder="(same origin)"
                className={inputCls}
                value={conn.apiHost ?? ""}
                onChange={(e) => setConn((c) => ({ ...c, apiHost: e.target.value }))}
              />
            </Field>
            <Field label="API token" hint="Sent as a bearer token to a remote host.">
              <input
                type="password"
                placeholder="(none)"
                autoComplete="off"
                className={inputCls}
                value={conn.apiToken ?? ""}
                onChange={(e) => setConn((c) => ({ ...c, apiToken: e.target.value }))}
              />
            </Field>
          </div>
        </section>
        </fieldset>

        {/* Forced full re-index control. Self-contained: hides itself on a server
            without the /api/reindex route, and reflects live progress over the
            existing index-progress/ready SSE. */}
        <RebuildIndex />

        {/* Index-health audit + safe repair. Self-contained: hides itself on a
            server without the /api/maintenance/* routes, and operates only on our
            own index DB (re-derivation over deletes — never the transcripts). */}
        <IntegrityPanel />

        {/* Export/import the portable archive — a permanent, shareable backup of our
            indexed history + organization that survives Claude Code's ~30-day
            transcript auto-delete. Self-contained: probes the /api/export|import
            routes and hides itself on an older server; import only writes our own
            index DB and never touches ~/.claude. */}
        <ArchiveTransfer />

        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg bg-clay-500 px-3.5 py-1.5 text-[13px] font-medium text-white transition hover:bg-clay-600 disabled:opacity-50",
            )}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save settings
          </button>
          {savedAt && (
            <span role="status" className="inline-flex items-center gap-1.5 text-[12px] text-emerald-400">
              <Check className="h-3.5 w-3.5" />
              Saved
            </span>
          )}
          {loadError && settings && (
            <span role="alert" className="text-[12px] text-red-400">Save failed: {loadError}. Review the current values, then retry.</span>
          )}
        </div>
      </>
    );

  const TABS: { id: SettingsSection; label: string; icon: React.ReactNode }[] = [
    { id: "preferences", label: "Preferences", icon: <SlidersHorizontal className="h-3.5 w-3.5" /> },
    { id: "budget", label: "Budget", icon: <PiggyBank className="h-3.5 w-3.5" /> },
    { id: "memory", label: "Memory", icon: <FileText className="h-3.5 w-3.5" /> },
    { id: "mcp", label: "MCP servers", icon: <Server className="h-3.5 w-3.5" /> },
    { id: "hooks", label: "Hooks", icon: <Webhook className="h-3.5 w-3.5" /> },
    { id: "webhooks", label: "Webhooks", icon: <Send className="h-3.5 w-3.5" /> },
    { id: "permissions", label: "Permissions", icon: <Shield className="h-3.5 w-3.5" /> },
    { id: "agents", label: "Agents", icon: <Bot className="h-3.5 w-3.5" /> },
    { id: "skills", label: "Skills", icon: <Sparkles className="h-3.5 w-3.5" /> },
    { id: "plugins", label: "Plugins", icon: <Blocks className="h-3.5 w-3.5" /> },
  ];

  // Permissions uses a 3-column bucket grid, so it gets a wider container than the
  // form-style sections (which read best narrow).
  const wide = section === "permissions";

  return (
    <div className="flex-1 overflow-y-auto bg-zinc-950">
      <div className={cn("mx-auto px-8 py-8", wide ? "max-w-5xl" : "max-w-2xl")}>
        <header className="mb-5">
          <h1 className="text-lg font-semibold text-zinc-100">Settings</h1>
          <p className="mt-1 text-[12.5px] text-zinc-500">
            {section === "budget"
              ? "Set a monthly spend cap, when to warn, and whether to enforce it."
              : section === "mcp"
              ? "Manage the Model Context Protocol servers Claude Code can use."
              : section === "hooks"
                ? "Commands Claude Code runs on lifecycle events, edited as JSON."
                : section === "webhooks"
                ? "POST a payload to Slack, Discord, or your own tools when sessions finish/stall or budgets hit."
                : section === "permissions"
                  ? "Allow / ask / deny rules that decide which tool calls run automatically."
                  : section === "agents"
                    ? "Subagents installed globally and in this project (read-only)."
                    : section === "skills"
                      ? "Skills installed globally and in this project (read-only)."
                      : section === "plugins"
                        ? "Plugins installed via the Claude Code CLI and your configured marketplaces (read-only)."
                        : section === "memory"
                        ? "Your CLAUDE.md memory file — instructions prepended to every session."
                        : "Defaults for new sessions and your spend budget. Saved on the server."}
          </p>
        </header>

        <div className="mb-6 inline-flex items-center rounded-lg bg-zinc-900 p-0.5 ring-1 ring-zinc-800">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setSection(t.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-[12px] font-medium transition",
                section === t.id
                  ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/30"
                  : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        {section === "preferences" ? (
          preferencesBody
        ) : section === "budget" ? (
          <BudgetSettings />
        ) : section === "memory" ? (
          <ClaudeMdEditor projectCwd={projectCwd} />
        ) : section === "mcp" ? (
          <McpManager projectCwd={projectCwd} />
        ) : section === "hooks" ? (
          <HooksEditor projectCwd={projectCwd} />
        ) : section === "webhooks" ? (
          <WebhooksManager />
        ) : section === "permissions" ? (
          <PermissionsEditor projectCwd={projectCwd} />
        ) : section === "agents" ? (
          <AgentsLibrary projectCwd={projectCwd} />
        ) : section === "skills" ? (
          <SkillsManager projectCwd={projectCwd} />
        ) : (
          <PluginsView />
        )}
      </div>
    </div>
  );
}
