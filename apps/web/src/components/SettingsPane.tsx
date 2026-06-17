import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Save, Server } from "lucide-react";
import { api, type AppSettings } from "../lib/api";
import { PERMISSION_MODES, type PermissionMode } from "@claude-ui/engine/driver";
import { cn } from "../lib/utils";
import { Spinner } from "./ui";

const MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
] as const;

const THEMES = ["dark", "light", "system"] as const;
const DENSITIES = ["comfortable", "compact"] as const;

/**
 * Client-only connection settings (API host + token), kept in localStorage as
 * groundwork for talking to a remote engine later. Deliberately NOT sent to the
 * server — they describe how the browser reaches a server, so they can't live
 * there. Mirrors the SSR-guarded storage style used across the app.
 */
const CONN_KEY = "claude-ui:conn";
interface ConnSettings {
  apiHost?: string;
  apiToken?: string;
}
function readConn(): ConnSettings {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(CONN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ConnSettings) : {};
  } catch {
    return {};
  }
}
function writeConn(c: ConnSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONN_KEY, JSON.stringify(c));
  } catch {
    /* non-fatal */
  }
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
}: {
  onSettingsSaved?: (s: AppSettings) => void;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const [conn, setConn] = useState<ConnSettings>(() => readConn());
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  // Local edit helper: patch a single key in the in-memory settings object.
  const patch = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const next = await api.putSettings({
        defaultModel: settings.defaultModel,
        defaultPermissionMode: settings.defaultPermissionMode,
        theme: settings.theme,
        density: settings.density,
        monthlyBudgetUsd: settings.monthlyBudgetUsd ?? null,
      });
      setSettings(next);
      writeConn(conn);
      onSettingsSaved?.(next);
      setSavedAt(Date.now());
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedAt(null), 2000);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loadError && !settings) {
    return (
      <div className="flex-1 overflow-y-auto bg-zinc-950 p-8">
        <div className="mx-auto max-w-2xl rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-[13px] text-red-300">
          Failed to load settings: {loadError}
        </div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="flex flex-1 items-center justify-center bg-zinc-950">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  const budgetStr =
    settings.monthlyBudgetUsd == null ? "" : String(settings.monthlyBudgetUsd);

  return (
    <div className="flex-1 overflow-y-auto bg-zinc-950">
      <div className="mx-auto max-w-2xl px-8 py-8">
        <header className="mb-6">
          <h1 className="text-lg font-semibold text-zinc-100">Settings</h1>
          <p className="mt-1 text-[12.5px] text-zinc-500">
            Defaults for new sessions and your spend budget. Saved on the server.
          </p>
        </header>

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
            <span className="inline-flex items-center gap-1.5 text-[12px] text-emerald-400">
              <Check className="h-3.5 w-3.5" />
              Saved
            </span>
          )}
          {loadError && settings && (
            <span className="text-[12px] text-red-400">{loadError}</span>
          )}
        </div>
      </div>
    </div>
  );
}
