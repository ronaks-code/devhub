import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type AppSettings } from "../../../lib/api.js";
import type { Stats } from "../../../lib/types.js";
import { PERMISSION_MODES, type PermissionMode } from "@devhub/engine/driver";
import type { DevHubFeatureFlags } from "@devhub/engine/providers";
import { readCompat, writeCompat } from "../../../lib/compat-storage.js";
import { formatUsd } from "../../../lib/format.js";
import { providerFromModel } from "../ops/opsHelpers.js";
import { Spinner } from "../../ui.js";
import { McpManager } from "../../config/McpManager.js";
import { HooksEditor } from "../../config/HooksEditor.js";
import { PermissionsEditor } from "../../config/PermissionsEditor.js";
import { AgentsLibrary } from "../../config/AgentsLibrary.js";
import { SkillsManager } from "../../config/SkillsManager.js";
import { ClaudeMdEditor } from "../../config/ClaudeMdEditor.js";
import { PluginsView } from "../../config/PluginsView.js";
import { WebhooksManager } from "../../config/WebhooksManager.js";
import { RebuildIndex } from "../../config/RebuildIndex.js";
import { IntegrityPanel } from "../../config/IntegrityPanel.js";
import { ArchiveTransfer } from "../../config/ArchiveTransfer.js";
import { BudgetSettings } from "../../BudgetSettings.js";
import {
  applySettingsEdits,
  completeDevHubFeatures,
  deliverSettingsResponse,
  dirtySettingsUpdatePayload,
  requestSettingsReconciliation,
  retainUnsavedEdits,
  settingsEditsDirtySet,
  withNativeCodexPreference,
  withPersistentClaudePreference,
} from "../../SettingsPane.js";
import {
  Alert,
  Button,
  Dialog,
  Field,
  FieldGroup,
  FieldSet,
  Input,
  Progress,
  Select,
  Switch,
  Table,
  TabPanel,
  Tabs,
  type SettingsTabGroup,
  type SettingsTabItem,
} from "./settings-ui.js";

/**
 * SettingsRoute — the canonical provider-aware Settings surface (M6 Task 8, the
 * eighth and final strangler slice, behind `settingsSecondary`).
 *
 * `design-lock.md` §8 / `component-state-matrix.md` §13 / `surface-inventory.md`
 * `RT-07`: accessible field groups (`Appearance`, `Providers`, `Permissions`) using
 * the audited `Tabs`/`FieldGroup`/`Field`/`FieldSet`/`Select`/`Input`/`Switch`/
 * `Button`/`Alert`/`Progress`/`Table`/`Dialog` primitive set — never a generic form
 * card. Every preserved workflow (Budget/Memory/MCP servers/Hooks/Webhooks/
 * Permissions/Agents/Skills/Plugins, plus the search-index/integrity/archive
 * maintenance utilities) stays reachable via the SAME preserved components, mounted
 * unchanged. Reuses the SettingsPane's pure state-machine helpers
 * (`completeDevHubFeatures`, `withNativeCodexPreference`, `withPersistentClaudePreference`,
 * `settingsUpdatePayload`, `dirtySettingsUpdatePayload`, `mergeAuthoritativeSettings`,
 * `deliverSettingsResponse`, `requestSettingsReconciliation`) instead of re-deriving
 * the same save/reconcile/dirty-field logic a second time.
 */

export type SettingsSection =
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

export const SETTINGS_TABLIST_ID = "dh-settings-tabs";

export const SETTINGS_TABS: ReadonlyArray<SettingsTabItem<SettingsSection>> = Object.freeze([
  { id: "preferences", label: "Preferences" },
  { id: "budget", label: "Budget" },
  { id: "memory", label: "Memory" },
  { id: "mcp", label: "MCP servers" },
  { id: "hooks", label: "Hooks" },
  { id: "webhooks", label: "Webhooks" },
  { id: "permissions", label: "Permissions" },
  { id: "agents", label: "Agents" },
  { id: "skills", label: "Skills" },
  { id: "plugins", label: "Plugins" },
]);

/**
 * §3.4 IDE-Rail groupings: the ten preserved sections organized under three mono
 * headers. Only EXISTING sections are reorganized — no new routes are invented.
 * `AGENTS` = the agent-behaviour prefs (Preferences bundles Appearance/Providers,
 * plus session Permissions); `CONFIG` = the editable config surfaces; `DATA` = the
 * spend/budget surface. The concatenation of `tabIds` defines the rail's visual +
 * keyboard order (see `SETTINGS_TABS_DISPLAY`).
 */
export const SETTINGS_TAB_GROUPS: ReadonlyArray<SettingsTabGroup<SettingsSection>> = Object.freeze([
  { label: "Agents", tabIds: ["preferences", "permissions"] },
  { label: "Config", tabIds: ["memory", "mcp", "hooks", "webhooks", "agents", "skills", "plugins"] },
  { label: "Data", tabIds: ["budget"] },
]);

/**
 * The tab list in rail (grouped) order — the SAME set as `SETTINGS_TABS`, only
 * reordered so keyboard roving (which walks this array) matches the grouped visual
 * order. `SETTINGS_TABS` itself stays in the legacy order for any consumer that
 * relies on it.
 */
export const SETTINGS_TABS_DISPLAY: ReadonlyArray<SettingsTabItem<SettingsSection>> = Object.freeze(
  SETTINGS_TAB_GROUPS.flatMap((group) =>
    group.tabIds.map((id) => SETTINGS_TABS.find((t) => t.id === id)!),
  ),
);

/**
 * §3.4 Query-Deck search — ROW granularity. The live search filters INDIVIDUAL
 * setting rows (not whole sections), and the hits render grouped under their
 * section header. Each row is pure, unit-testable metadata; `kind: "control"` rows
 * render their real live control inline (via `renderSettingControl`), while
 * `kind: "section"` rows are a jump into a preserved editor surface we can't
 * decompose into individual rows here.
 */
export type SettingRowKind = "control" | "section";

export interface SettingRowDef {
  /** For a control row: the id passed to `renderSettingControl`. For a section row: unused. */
  id: string;
  /** Section-header label the hit groups under. */
  group: string;
  /** Human row label shown in the hit list. */
  label: string;
  /** Extra search text (synonyms) matched alongside the label + group. */
  keywords: string;
  kind: SettingRowKind;
  /** Which tab a `section` row jumps to when opened. */
  section?: SettingsSection;
}

/** Group order for grouped search hits (headers only render when they have a hit). */
export const SETTINGS_SEARCH_GROUP_ORDER: ReadonlyArray<string> = Object.freeze([
  "Appearance",
  "Providers & models",
  "Connection",
  "Budget",
  "Permissions",
  "Data & maintenance",
  "Memory",
  "MCP servers",
  "Hooks",
  "Webhooks",
  "Agents",
  "Skills",
  "Plugins",
]);

/** The flat row registry the Query-Deck search filters over. */
export const SETTINGS_ROWS: ReadonlyArray<SettingRowDef> = Object.freeze([
  // Preferences — live controls, individually searchable.
  { id: "theme", group: "Appearance", label: "Theme", keywords: "appearance theme dark light system os palette", kind: "control" },
  { id: "density", group: "Appearance", label: "Density", keywords: "density comfortable compact spacing layout", kind: "control" },
  { id: "default-model", group: "Providers & models", label: "Default model", keywords: "default model claude codex opus sonnet haiku fable new chat", kind: "control" },
  { id: "default-mechanics", group: "Providers & models", label: "Default agent mechanics", keywords: "mechanics runtime claude code codex default agent new task", kind: "control" },
  { id: "native-codex", group: "Providers & models", label: "Native Codex", keywords: "native codex openai runtime app-server enable provider", kind: "control" },
  { id: "persistent-claude", group: "Providers & models", label: "Persistent Claude", keywords: "persistent claude cli runtime authentication provider enable", kind: "control" },
  { id: "provider-table", group: "Providers & models", label: "Provider runtime status", keywords: "provider runtime status enabled requested disabled capability", kind: "control" },
  { id: "connection", group: "Connection", label: "Connection (API host / token)", keywords: "connection api host token bearer remote engine device browser url endpoint clear local", kind: "control" },
  { id: "monthly-budget", group: "Budget", label: "Monthly budget (USD)", keywords: "budget spend cap cost money monthly usd soft", kind: "control" },
  { id: "permission-mode", group: "Permissions", label: "Default permission mode", keywords: "permission mode allow ask deny approve edits commands default acceptedits", kind: "control" },
  { id: "rebuild-index", group: "Data & maintenance", label: "Rebuild search index", keywords: "rebuild search index reindex maintenance", kind: "control" },
  { id: "integrity", group: "Data & maintenance", label: "Integrity", keywords: "integrity health repair drift audit maintenance", kind: "control" },
  { id: "archive", group: "Data & maintenance", label: "Archive & transfer", keywords: "backup archive transfer export import download restore portable maintenance data", kind: "control" },
  // Preserved editor surfaces — a jump row per section (they aren't decomposed here).
  { id: "budget", group: "Budget", label: "Budget thresholds & enforcement", keywords: "budget spend cap forecast pacing warn threshold enforce meter", kind: "section", section: "budget" },
  { id: "memory", group: "Memory", label: "Memory / CLAUDE.md", keywords: "memory claude.md context instructions project global", kind: "section", section: "memory" },
  { id: "mcp", group: "MCP servers", label: "MCP servers", keywords: "mcp servers model context protocol tools", kind: "section", section: "mcp" },
  { id: "hooks", group: "Hooks", label: "Hooks", keywords: "hooks automation events lifecycle", kind: "section", section: "hooks" },
  { id: "webhooks", group: "Webhooks", label: "Webhooks", keywords: "webhooks notifications http endpoint slack", kind: "section", section: "webhooks" },
  { id: "agents", group: "Agents", label: "Agents", keywords: "agents subagents library roles", kind: "section", section: "agents" },
  { id: "skills", group: "Skills", label: "Skills", keywords: "skills slash commands", kind: "section", section: "skills" },
  { id: "plugins", group: "Plugins", label: "Plugins", keywords: "plugins extensions marketplace", kind: "section", section: "plugins" },
]);

/** One header-grouped block of search hits. */
export interface SettingSearchGroup {
  group: string;
  rows: SettingRowDef[];
}

/**
 * Row-granularity filter for the Query-Deck. Matches a row when the trimmed query
 * appears in its label, group, or keywords (all lowercased). Hits are returned
 * grouped by section header, in `SETTINGS_SEARCH_GROUP_ORDER`. An empty query
 * returns no groups (the caller shows the normal tabbed surface instead).
 */
export function matchSettingRows(
  rows: ReadonlyArray<SettingRowDef>,
  query: string,
): SettingSearchGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matched = rows.filter(
    (r) =>
      r.label.toLowerCase().includes(q) ||
      r.group.toLowerCase().includes(q) ||
      r.keywords.includes(q),
  );
  const byGroup = new Map<string, SettingRowDef[]>();
  for (const row of matched) {
    const bucket = byGroup.get(row.group);
    if (bucket) bucket.push(row);
    else byGroup.set(row.group, [row]);
  }
  const ordered: SettingSearchGroup[] = [];
  for (const group of SETTINGS_SEARCH_GROUP_ORDER) {
    const groupRows = byGroup.get(group);
    if (groupRows && groupRows.length > 0) ordered.push({ group, rows: groupRows });
  }
  return ordered;
}

const MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
] as const;
const THEMES = ["dark", "light", "system"] as const;
const DENSITIES = ["comfortable", "compact"] as const;

/** The two-option mechanics choice, shown as a segmented control (not a bare checkbox). */
const MECHANICS_OPTIONS = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
] as const;

/** Client-only connection settings, kept out of the server payload — see `SettingsPane`. */
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
function clearConn(): void {
  writeCompat(CONN_KEY, JSON.stringify({}));
}

/**
 * `component-state-matrix.md` §13 disconnected rule: "Clearly distinguish
 * `Saved in this browser` from `Not synced`." A browser-local save is never
 * confused with a server-persisted one.
 */
export function connectionSyncLabel(saved: boolean): { label: string; note: string } {
  return {
    label: saved ? "Saved in this browser" : "Not saved",
    note: "Not synced — stored only on this device, never sent to the server.",
  };
}

export interface ProviderCapabilityRow {
  key: string;
  feature: string;
  status: "Enabled" | "Requested" | "Disabled";
  note: string;
}

/**
 * Pure provider-capability status rows for the `Providers` field group's `Table`.
 * Distinguishes resolved-true (`Enabled`) from requested-but-clamped (`Requested`,
 * with the exact unavailability reason) from neither (`Disabled`) — never implies a
 * runtime-unavailable feature is on.
 */
export function providerCapabilityRows(settings: AppSettings | null): ProviderCapabilityRow[] {
  if (!settings) return [];
  const resolved = completeDevHubFeatures(settings.devHubFeatures);
  const requested = completeDevHubFeatures(settings.requestedDevHubFeatures ?? settings.devHubFeatures);
  const row = (
    key: string,
    feature: string,
    resolvedOn: boolean,
    requestedOn: boolean,
    unavailableNote: string,
  ): ProviderCapabilityRow => ({
    key,
    feature,
    status: resolvedOn ? "Enabled" : requestedOn ? "Requested" : "Disabled",
    note: resolvedOn ? "Active" : requestedOn ? unavailableNote : "Off",
  });
  return [
    row(
      "nativeCodex",
      "Native Codex",
      resolved.nativeCodex,
      requested.nativeCodex,
      "Requested, but the verified Codex runtime is unavailable.",
    ),
    row(
      "persistentClaude",
      "Persistent Claude",
      resolved.persistentClaude,
      requested.persistentClaude,
      "Requested, but the verified Claude runtime or authentication is unavailable.",
    ),
    row(
      "unifiedTaskIndex",
      "Unified task index",
      resolved.unifiedTaskIndex,
      requested.unifiedTaskIndex,
      "Requested, but the shared index is unavailable.",
    ),
  ];
}

export interface ClearLocalDataConfirmation {
  title: string;
  body: string;
  affectedStore: string;
  confirmLabel: string;
  cancelLabel: string;
  reversible: boolean;
  callsProviderDelete: boolean;
  initialFocus: "cancel";
}

/**
 * `component-state-matrix.md` §13 destructive rule: "Cache/database deletion never
 * calls provider delete... Confirm high-impact operations; focus Cancel; no
 * credentials in summaries." This clears ONLY the browser-local connection prefs
 * (never a provider account, never server settings) and never echoes the token.
 */
export function describeClearLocalDataConfirmation(): ClearLocalDataConfirmation {
  return {
    title: "Clear local connection data?",
    body:
      "This clears the API host and token stored on this device. It does not delete " +
      "anything from Codex, Claude, or your provider account, and it does not change " +
      "the server's saved settings.",
    affectedStore: "This browser only (devhub:conn)",
    confirmLabel: "Clear local data",
    cancelLabel: "Cancel",
    reversible: true,
    callsProviderDelete: false,
    initialFocus: "cancel",
  };
}

export type SettingsSecondaryMode = "devhub" | "legacy";

/**
 * Slice-flag gate. Mirrors `resolveSearchCommandsMode`: the new `SettingsRoute`/
 * `OpsRoute`/`InboxRoute`/`DashboardRoute` mount only for a server-resolved true
 * `settingsSecondary`; anything else (false/undefined/missing) keeps the legacy
 * `SettingsPane`/`LiveOpsBoard`/`InboxPane`/`DashboardPane` — the immediate,
 * non-destructive rollback. Flag-off NEVER instantiates the new tree.
 */
export function resolveSettingsSecondaryMode(
  settings: { devHubFeatures?: Partial<DevHubFeatureFlags> } | null | undefined,
): SettingsSecondaryMode {
  return settings?.devHubFeatures?.settingsSecondary === false ? "legacy" : "devhub";
}

/** True only when the settings-secondary slice flag is applied. */
export function isSettingsSecondaryApplied(
  features: Partial<DevHubFeatureFlags> | undefined,
): boolean {
  return features?.settingsSecondary === true;
}

/**
 * §3.4/§3.6 spend-meter SPLIT BAR — real per-provider spend from `Stats.byModel`,
 * classified into Claude (violet) / Codex (mint) via the canonical
 * `providerFromModel` name inspection (the SAME classifier Live Ops + the Dashboard
 * use — one source of truth, never a re-guessed rule). Models the classifier can't
 * place fall into a muted "Other" segment rather than being silently attributed to
 * a provider.
 *
 * DATA HONESTY: `Stats.byModel` is APPROXIMATE, all-time cost (priced from token
 * usage, never billed truth). It is NOT a month-to-date figure and carries no
 * monthly cap, so this bar is a spend *composition* (share by provider), not a
 * budget-vs-cap meter — the monthly cap meter lives in `BudgetSettings` below it.
 */
export interface ProviderSpendSegment {
  key: "anthropic" | "openai" | "other";
  label: string;
  usd: number;
  /** Share of the total, 0–100. */
  pct: number;
}

export function providerSpendSegments(
  byModel: ReadonlyArray<{ model: string; costUsd: number }> | null | undefined,
): { segments: ProviderSpendSegment[]; totalUsd: number } {
  const totals: Record<ProviderSpendSegment["key"], number> = { anthropic: 0, openai: 0, other: 0 };
  for (const row of byModel ?? []) {
    const cost = Number.isFinite(row.costUsd) ? Math.max(0, row.costUsd) : 0;
    const provider = providerFromModel(row.model);
    if (provider === "anthropic") totals.anthropic += cost;
    else if (provider === "openai") totals.openai += cost;
    else totals.other += cost;
  }
  const totalUsd = totals.anthropic + totals.openai + totals.other;
  const seg = (key: ProviderSpendSegment["key"], label: string): ProviderSpendSegment => ({
    key,
    label,
    usd: totals[key],
    pct: totalUsd > 0 ? (totals[key] / totalUsd) * 100 : 0,
  });
  const segments = [seg("anthropic", "Claude"), seg("openai", "Codex"), seg("other", "Other")].filter(
    (s) => s.usd > 0,
  );
  return { segments, totalUsd };
}

const SEGMENT_COLOR: Record<ProviderSpendSegment["key"], string> = {
  anthropic: "var(--dh-brand)", // violet — Claude
  openai: "var(--dh-provider-openai)", // mint — Codex
  other: "var(--dh-text-dim)",
};

/**
 * The Budget-section spend-meter split bar. Self-contained: fetches `api.stats()`
 * once on mount (a single GET, NOT a competing poll — leaf routes must not double
 * the app-root stats poll per the spec's Phase-1 correction), then renders the
 * violet/mint provider split. When no spend is recorded yet, or the stats route is
 * unavailable, it renders an honest note instead of a fake bar.
 */
export function SpendSplitBar(): ReactNode {
  const [byModel, setByModel] = useState<Stats["byModel"] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    api
      .stats()
      .then((s) => {
        if (cancelled) return;
        setByModel(s.byModel ?? []);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { segments, totalUsd } = providerSpendSegments(byModel);

  return (
    <section
      aria-labelledby="dh-settings-spend-split-heading"
      className="dh-settings-fieldgroup"
      data-dh-settings-spend-split=""
      style={{ gap: 12 }}
    >
      <h2 id="dh-settings-spend-split-heading" className="dh-settings-fieldgroup-heading">
        Spend by provider
      </h2>
      {state === "loading" ? (
        <div role="status" aria-live="polite" className="dh-settings-loading">
          <Spinner aria-hidden="true" className="h-4 w-4" />
          <span className="dh-sr-only">Loading spend…</span>
        </div>
      ) : state === "error" ? (
        <p className="dh-settings-fieldgroup-description" style={{ marginTop: 0 }}>
          Spend breakdown isn&apos;t available on this server. —
        </p>
      ) : totalUsd <= 0 ? (
        <p className="dh-settings-fieldgroup-description" style={{ marginTop: 0 }}>
          No spend recorded yet. —
        </p>
      ) : (
        <>
          <div
            role="img"
            aria-label={`Spend by provider: ${segments
              .map((s) => `${s.label} ${formatUsd(s.usd)} (${Math.round(s.pct)}%)`)
              .join(", ")}. Total ${formatUsd(totalUsd)}.`}
            data-dh-settings-split-bar=""
            style={{
              display: "flex",
              width: "100%",
              height: 10,
              borderRadius: 999,
              overflow: "hidden",
              background: "var(--dh-control)",
              border: "1px solid var(--dh-border-subtle)",
            }}
          >
            {segments.map((s) => (
              <span
                key={s.key}
                data-dh-settings-split-segment={s.key}
                style={{ width: `${s.pct}%`, background: SEGMENT_COLOR[s.key], height: "100%" }}
              />
            ))}
          </div>
          <ul
            className="dh-settings-fieldgroup-description"
            style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", listStyle: "none", margin: 0, padding: 0 }}
          >
            {segments.map((s) => (
              <li key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span
                  aria-hidden="true"
                  style={{ width: 9, height: 9, borderRadius: 3, background: SEGMENT_COLOR[s.key], display: "inline-block" }}
                />
                <span>
                  {s.label} {formatUsd(s.usd)} · {Math.round(s.pct)}%
                </span>
              </li>
            ))}
          </ul>
          <p className="dh-settings-fieldgroup-description" style={{ marginTop: 0 }}>
            APPROXIMATE — all-time, priced from token usage, never billed truth. The monthly cap meter
            is below.
          </p>
        </>
      )}
    </section>
  );
}

export function SettingsRoute({
  onSettingsSaved,
  onSettingsRequestStart,
  onSettingsReconcile,
  authoritativeSettings,
  projectCwd,
  themePreference,
  onThemeChange,
}: {
  onSettingsSaved?: (s: AppSettings, requestVersion?: number) => boolean | void;
  onSettingsRequestStart?: () => number;
  onSettingsReconcile?: () => void | Promise<void>;
  authoritativeSettings?: AppSettings | null;
  projectCwd?: string;
  /**
   * The client `useTheme` preference — the ONE source of truth for the rendered
   * palette (W3-SHELL). When provided, the Theme select shows THIS value (not the
   * possibly-stale server `settings.theme`) and changes route through
   * `onThemeChange`, which applies instantly and mirrors to the server — so the
   * select, the header toggle, and the rendered app can never disagree.
   */
  themePreference?: "dark" | "light" | "system";
  onThemeChange?: (t: "dark" | "light" | "system") => void;
}): ReactNode {
  const [section, setSection] = useState<SettingsSection>("preferences");
  // §3.4 Query-Deck: a live ROW-granularity filter over the settings rows.
  const [settingsQuery, setSettingsQuery] = useState("");
  // Latest authoritative server snapshot. Unsaved user edits live in the separate
  // `edits` overlay, so a background refetch (App shell reconciliation, another
  // surface's save) can replace this base at any time without dropping an edit —
  // and the next PUT always carries every still-dirty field.
  const [serverSettings, setServerSettings] = useState<AppSettings | null>(authoritativeSettings ?? null);
  const [edits, setEdits] = useState<Partial<AppSettings>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [conn, setConn] = useState<ConnSettings>(() => readConn());
  const [connDirty, setConnDirty] = useState(false);
  const [connSavedAt, setConnSavedAt] = useState<number | null>(null);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);

  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestVersion = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

  // §3.4 Query-Deck: a plain "/" focuses the settings search — the near-universal
  // "focus search" shortcut. Ignored while the user is typing in a field (so "/"
  // still types literally, and Shift+/ "?" still reaches the global shortcut
  // cheat-sheet), and it never steals a "/" from an input the user is already in.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
      const input = searchRef.current;
      if (!input) return;
      e.preventDefault();
      input.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const settings = applySettingsEdits(serverSettings, edits);
  const hasUnsavedEdits = serverSettings != null && (Object.keys(edits).length > 0 || connDirty);

  const flashSaved = () => {
    setSavedAt(Date.now());
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedAt(null), 2000);
  };

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
      setServerSettings(next);
    } catch (reason) {
      if (requestVersion.current !== localVersion) return;
      setLoadError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [onSettingsRequestStart, onSettingsSaved]);

  useEffect(() => {
    if (authoritativeSettings) {
      requestVersion.current += 1;
      setServerSettings(authoritativeSettings);
      setLoadError((current) => (current?.startsWith("Save response was not confirmed") ? current : null));
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

  // Record the user's intent in the edits overlay. The key stays dirty until a
  // save sends it — a concurrent authoritative refetch can never clear it.
  const patch = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setEdits((current) => ({ ...current, [key]: value }));
  };

  // Feature-request toggles rewrite both feature maps together (see the
  // withNativeCodexPreference/withPersistentClaudePreference contracts).
  const patchFeatures = (transform: (current: AppSettings) => AppSettings) => {
    setEdits((current) => {
      const base = applySettingsEdits(serverSettings, current);
      if (!base) return current;
      const updated = transform(base);
      return {
        ...current,
        devHubFeatures: updated.devHubFeatures,
        requestedDevHubFeatures: updated.requestedDevHubFeatures,
      };
    });
  };

  const save = async () => {
    if (!settings) return;
    const sent = edits;
    const payload = dirtySettingsUpdatePayload(settings, settingsEditsDirtySet(sent));
    if (Object.keys(payload).length === 0) {
      writeConn(conn);
      setConnDirty(false);
      setConnSavedAt(Date.now());
      flashSaved();
      return;
    }
    const localVersion = ++requestVersion.current;
    const shellVersion = onSettingsRequestStart?.();
    setSaving(true);
    setLoadError(null);
    try {
      const next = await api.putSettings(payload);
      const adoptResponse = deliverSettingsResponse(
        next,
        shellVersion,
        onSettingsSaved,
        requestVersion.current === localVersion,
      );
      writeConn(conn);
      setConnDirty(false);
      setConnSavedAt(Date.now());
      // The PUT committed on the server: clear exactly what was sent, keeping any
      // edits made while the request was in flight.
      setEdits((current) => retainUnsavedEdits(current, sent));
      if (adoptResponse) {
        setServerSettings(next);
      } else {
        // Response ordering went stale (a newer request started meanwhile) —
        // re-read a fresh snapshot instead of adopting a superseded one.
        requestSettingsReconciliation(onSettingsReconcile);
      }
      flashSaved();
    } catch (e) {
      requestSettingsReconciliation(onSettingsReconcile);
      if (requestVersion.current !== localVersion) return;
      setLoadError(
        `Save response was not confirmed; reconciling settings. ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setSaving(false);
    }
  };

  const confirmClearLocalData = () => {
    clearConn();
    setConn({});
    setConnSavedAt(null);
    setClearDialogOpen(false);
  };

  const budgetStr = settings?.monthlyBudgetUsd == null ? "" : String(settings.monthlyBudgetUsd);
  const connSync = connectionSyncLabel(connSavedAt != null);
  const confirmation = describeClearLocalDataConfirmation();

  // Jump from a search hit into its full section, clearing the query so the tabbed
  // surface (not the hit list) shows.
  const openSection = (target: SettingsSection) => {
    setSettingsQuery("");
    setSection(target);
  };

  /**
   * ONE definition per live control, rendered by BOTH the normal Preferences panel
   * and the grouped search-hit list — so a control is never duplicated (no drift,
   * one source of truth). `settings` is guaranteed present at every call site.
   */
  const renderSettingControl = (id: string): ReactNode => {
    if (!settings) return null;
    switch (id) {
      case "theme":
        return (
          <Field id="dh-settings-theme" label="Theme" hint="Dark, light, or follow your OS. Applies immediately.">
            <Select
              id="dh-settings-theme"
              value={themePreference ?? settings.theme ?? "system"}
              describedBy="dh-settings-theme-hint"
              options={THEMES.map((t) => ({ value: t, label: t }))}
              onChange={(v) => {
                const next = v as "dark" | "light" | "system";
                // Route through the client theme owner when wired (instant apply +
                // server mirror in one step); the edits-overlay path stays only as
                // a standalone-mount fallback.
                if (onThemeChange) onThemeChange(next);
                else patch("theme", next);
              }}
            />
          </Field>
        );
      case "density":
        return (
          <Field id="dh-settings-density" label="Density">
            <Select
              id="dh-settings-density"
              value={settings.density ?? "comfortable"}
              options={DENSITIES.map((d) => ({ value: d, label: d }))}
              onChange={(v) => patch("density", v)}
            />
          </Field>
        );
      case "default-model":
        return (
          <Field id="dh-settings-default-model" label="Default model" hint="Used when starting a new chat.">
            <Select
              id="dh-settings-default-model"
              value={settings.defaultModel ?? MODELS[0]}
              describedBy="dh-settings-default-model-hint"
              options={MODELS.map((m) => ({ value: m, label: m }))}
              onChange={(v) => patch("defaultModel", v)}
            />
          </Field>
        );
      case "default-mechanics":
        return (
          <div className="dh-settings-switch-row" data-dh-settings-switch="defaultMechanics">
            {/* Segmented control: both options visible, the current value explicit —
                a bare checkbox hid which runtime "checked" meant. */}
            <div
              role="radiogroup"
              aria-label="Default agent mechanics"
              aria-describedby="dh-settings-default-mechanics-hint"
              className="dh-settings-segmented"
            >
              {MECHANICS_OPTIONS.map((option) => {
                const active = (settings.defaultMechanics ?? "claude") === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    data-dh-segment-active={active ? "true" : "false"}
                    className="dh-settings-segment"
                    onClick={() => patch("defaultMechanics", option.value)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <span className="dh-settings-switch-copy">
              <span className="dh-settings-switch-label">Default agent mechanics</span>
              <span id="dh-settings-default-mechanics-hint" className="dh-settings-field-hint">
                Selects the runtime for new tasks. Explicit task-level provider choices still take precedence.
              </span>
            </span>
          </div>
        );
      case "native-codex":
        return (
          <div className="dh-settings-switch-row" data-dh-settings-switch="nativeCodex">
            <Switch
              id="dh-settings-native-codex"
              label="Enable native Codex"
              describedBy="dh-settings-native-codex-hint"
              checked={
                completeDevHubFeatures(settings.requestedDevHubFeatures ?? settings.devHubFeatures).nativeCodex
              }
              onChange={(enabled) => patchFeatures((current) => withNativeCodexPreference(current, enabled))}
            />
            <span className="dh-settings-switch-copy">
              <span className="dh-settings-switch-label">Native Codex</span>
              <span id="dh-settings-native-codex-hint" className="dh-settings-field-hint">
                {completeDevHubFeatures(settings.requestedDevHubFeatures ?? settings.devHubFeatures).nativeCodex &&
                !completeDevHubFeatures(settings.devHubFeatures).nativeCodex
                  ? "Requested, but the verified Codex runtime is unavailable. Turn this off to clear the saved request."
                  : "Use the verified Codex app-server task surface. The server keeps the effective feature off when the runtime gate is unavailable."}
              </span>
            </span>
          </div>
        );
      case "persistent-claude":
        return (
          <div className="dh-settings-switch-row" data-dh-settings-switch="persistentClaude">
            <Switch
              id="dh-settings-persistent-claude"
              label="Enable persistent Claude"
              describedBy="dh-settings-persistent-claude-hint"
              checked={
                completeDevHubFeatures(settings.requestedDevHubFeatures ?? settings.devHubFeatures).persistentClaude
              }
              onChange={(enabled) => patchFeatures((current) => withPersistentClaudePreference(current, enabled))}
            />
            <span className="dh-settings-switch-copy">
              <span className="dh-settings-switch-label">Persistent Claude</span>
              <span id="dh-settings-persistent-claude-hint" className="dh-settings-field-hint">
                {completeDevHubFeatures(settings.requestedDevHubFeatures ?? settings.devHubFeatures).persistentClaude &&
                !completeDevHubFeatures(settings.devHubFeatures).persistentClaude
                  ? "Requested, but the verified Claude CLI runtime or programmatic API/cloud authentication is unavailable. Turn this off to clear the saved request."
                  : "Use the provider-native persistent Claude CLI task surface. The server keeps it off unless its runtime, authentication, and lifecycle gates are available."}
              </span>
            </span>
          </div>
        );
      case "provider-table":
        return (
          <Table
            caption="Provider runtime status"
            columns={["Feature", "Status", "Note"]}
            rows={providerCapabilityRows(settings).map((r) => ({
              key: r.key,
              cells: [r.feature, r.status, r.note],
            }))}
          />
        );
      case "connection":
        return (
          <FieldSet legend="Connection">
            <p className="dh-settings-connection-status" data-dh-settings-connection-status="">
              <span className="dh-settings-connection-label">{connSync.label}</span>
              <span className="dh-settings-connection-note">{connSync.note}</span>
            </p>
            <Field id="dh-settings-api-host" label="API host" hint="e.g. https://my-machine:5179">
              <Input
                id="dh-settings-api-host"
                value={conn.apiHost ?? ""}
                placeholder="(same origin)"
                describedBy="dh-settings-api-host-hint"
                onChange={(v) => {
                  setConnDirty(true);
                  setConn((c) => ({ ...c, apiHost: v }));
                }}
              />
            </Field>
            <Field id="dh-settings-api-token" label="API token" hint="Sent as a bearer token to a remote host.">
              <Input
                id="dh-settings-api-token"
                type="password"
                value={conn.apiToken ?? ""}
                placeholder="(none)"
                describedBy="dh-settings-api-token-hint"
                onChange={(v) => {
                  setConnDirty(true);
                  setConn((c) => ({ ...c, apiToken: v }));
                }}
              />
            </Field>
            <Button variant="danger" onClick={() => setClearDialogOpen(true)}>
              Clear local connection data
            </Button>
          </FieldSet>
        );
      case "monthly-budget":
        return (
          <Field id="dh-settings-monthly-budget" label="Monthly budget (USD)" hint="Soft cap for spend tracking. Blank = no budget.">
            <Input
              id="dh-settings-monthly-budget"
              type="number"
              value={budgetStr}
              placeholder="No budget"
              describedBy="dh-settings-monthly-budget-hint"
              onChange={(v) => {
                const trimmed = v.trim();
                if (trimmed === "") return patch("monthlyBudgetUsd", null);
                const n = Number(trimmed);
                patch("monthlyBudgetUsd", Number.isFinite(n) ? n : null);
              }}
            />
          </Field>
        );
      case "permission-mode":
        return (
          <Field id="dh-settings-permission-mode" label="Default permission mode" hint="How edits/commands are approved.">
            <Select
              id="dh-settings-permission-mode"
              value={settings.defaultPermissionMode ?? PERMISSION_MODES[0] ?? "default"}
              describedBy="dh-settings-permission-mode-hint"
              options={PERMISSION_MODES.map((m) => ({ value: m, label: m }))}
              onChange={(v) => patch("defaultPermissionMode", v as PermissionMode)}
            />
          </Field>
        );
      case "rebuild-index":
        return <RebuildIndex />;
      case "integrity":
        return <IntegrityPanel />;
      case "archive":
        return <ArchiveTransfer />;
      default:
        return null;
    }
  };

  const saveRow: ReactNode = (
    <>
      {/* Sticky save bar: stays visible however far the form scrolls, and shows a
          real dirty state — never a static "saved" that reads as success on failure. */}
      <div className="dh-settings-save-row" data-dh-settings-unsaved={hasUnsavedEdits ? "true" : "false"}>
        <Button type="button" variant="default" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save settings"}
        </Button>
        {saving ? <Progress label="Saving settings" /> : null}
        {!saving && hasUnsavedEdits ? (
          <span role="status" className="dh-settings-unsaved">
            Unsaved changes
          </span>
        ) : null}
        {!saving && !hasUnsavedEdits && savedAt ? (
          <span role="status" className="dh-settings-saved">
            Saved
          </span>
        ) : null}
        {loadError && settings ? (
          <Alert tone="error">
            Save failed: {loadError}. Review the current values, then retry.
          </Alert>
        ) : null}
      </div>

      {clearDialogOpen ? (
        <Dialog
          titleId="dh-settings-clear-local-data-title"
          title={confirmation.title}
          footer={
            <>
              <Button variant="ghost" autoFocus onClick={() => setClearDialogOpen(false)}>
                {confirmation.cancelLabel}
              </Button>
              <Button variant="danger" onClick={confirmClearLocalData}>
                {confirmation.confirmLabel}
              </Button>
            </>
          }
        >
          <p>{confirmation.body}</p>
          <p className="dh-settings-dialog-meta" data-dh-settings-dialog-affected="">
            Affects: {confirmation.affectedStore}
          </p>
        </Dialog>
      ) : null}
    </>
  );

  const preferencesBody: ReactNode =
    loadError && !settings ? (
      <Alert tone="error">
        <p>Failed to load settings: {loadError}</p>
        <Button variant="default" onClick={() => void loadSettings()}>
          Retry settings
        </Button>
      </Alert>
    ) : !settings ? (
      <div role="status" aria-live="polite" aria-atomic="true" className="dh-settings-loading">
        <Spinner aria-hidden="true" className="h-5 w-5" />
        <span className="dh-sr-only">Loading settings…</span>
      </div>
    ) : (
      <>
        <FieldGroup id="dh-settings-appearance" heading="Appearance">
          {renderSettingControl("theme")}
          {renderSettingControl("density")}
        </FieldGroup>

        <FieldGroup
          id="dh-settings-providers"
          heading="Providers"
          description="Default model for new chats, which native provider runtimes are requested, and this browser's connection to a remote engine."
        >
          {renderSettingControl("default-model")}
          {renderSettingControl("default-mechanics")}
          {renderSettingControl("native-codex")}
          {renderSettingControl("persistent-claude")}
          {renderSettingControl("provider-table")}
          {renderSettingControl("connection")}
        </FieldGroup>

        <FieldGroup
          id="dh-settings-budget"
          heading="Budget"
          description="A soft monthly spend cap for quick reference. Warn thresholds and enforcement live under the Budget tab."
        >
          {renderSettingControl("monthly-budget")}
        </FieldGroup>

        <FieldGroup
          id="dh-settings-permissions"
          heading="Permissions"
          description="Default for new sessions. Per-project allow/ask/deny rules live under the Permissions tab."
        >
          {renderSettingControl("permission-mode")}
        </FieldGroup>

        {/* Preserved maintenance workflows, mounted unchanged. */}
        {renderSettingControl("rebuild-index")}
        {renderSettingControl("integrity")}
        {renderSettingControl("archive")}

        {saveRow}
      </>
    );

  // §3.4 Query-Deck: the grouped, row-granularity hit list. Only matching rows
  // render, each under its section header + a hairline — never a whole section in
  // full with unrelated rows.
  const searchActive = settingsQuery.trim().length > 0;
  const matchedGroups = searchActive ? matchSettingRows(SETTINGS_ROWS, settingsQuery) : [];

  const searchResults: ReactNode =
    loadError && !settings ? (
      <Alert tone="error">
        <p>Failed to load settings: {loadError}</p>
        <Button variant="default" onClick={() => void loadSettings()}>
          Retry settings
        </Button>
      </Alert>
    ) : !settings ? (
      <div role="status" aria-live="polite" aria-atomic="true" className="dh-settings-loading">
        <Spinner aria-hidden="true" className="h-5 w-5" />
        <span className="dh-sr-only">Loading settings…</span>
      </div>
    ) : matchedGroups.length === 0 ? (
      <p className="dh-settings-nav-empty" data-dh-settings-search-empty="">
        No settings match “{settingsQuery.trim()}”. Clear the search to see every section.
      </p>
    ) : (
      <>
        {matchedGroups.map((group) => (
          <section
            key={group.group}
            className="dh-settings-fieldgroup"
            aria-label={group.group}
            data-dh-settings-search-group={group.group}
          >
            <h2 className="dh-settings-fieldgroup-heading">{group.group}</h2>
            <hr
              aria-hidden="true"
              className="dh-settings-hairline"
              style={{ border: 0, borderTop: "1px solid var(--dh-border-subtle)", margin: 0 }}
            />
            <div className="dh-settings-fieldgroup-body">
              {group.rows.map((row) =>
                row.kind === "control" ? (
                  <div key={row.id} data-dh-settings-search-row={row.id}>
                    {renderSettingControl(row.id)}
                  </div>
                ) : (
                  <div
                    key={row.id}
                    className="dh-settings-field"
                    data-dh-settings-search-row={row.id}
                    style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}
                  >
                    <span className="dh-settings-field-label">{row.label}</span>
                    <Button variant="ghost" onClick={() => row.section && openSection(row.section)}>
                      Open
                    </Button>
                  </div>
                ),
              )}
            </div>
          </section>
        ))}
        {saveRow}
      </>
    );

  // The SecondaryNav text strip that used to wrap this route is GONE (Aurora
  // shell QA F2/M9): it duplicated icon-rail destinations with unwired links.
  return (
      <div className="dh-aurora-bg--soft dh-settings-route" data-dh-settings-route="">
        <header className="dh-settings-header">
          <h1 className="dh-settings-title">Settings</h1>
          <input
            ref={searchRef}
            type="search"
            className="dh-settings-search"
            placeholder="Search settings… (press /)"
            aria-label="Search settings"
            aria-keyshortcuts="/"
            value={settingsQuery}
            onChange={(e) => setSettingsQuery(e.target.value)}
          />
        </header>

        {/* §3.4 IDE-Rail: the ten preserved sections grouped under AGENTS/CONFIG/
            DATA. Selecting a tab clears any active search so the tabbed surface
            shows. (Footer omitted: neither app version nor config path is exposed
            to the web client — rendering either would be a fabricated value.) */}
        <Tabs
          id={SETTINGS_TABLIST_ID}
          label="Settings sections"
          tabs={SETTINGS_TABS_DISPLAY}
          groups={SETTINGS_TAB_GROUPS}
          active={section}
          onSelect={openSection}
        />

        {searchActive ? (
          <div
            className="dh-settings-panel"
            role="region"
            aria-label={`Settings matching ${settingsQuery.trim()}`}
            data-dh-settings-panel="search"
            data-dh-settings-search-results=""
          >
            {searchResults}
          </div>
        ) : section === "preferences" ? (
          <TabPanel id={SETTINGS_TABLIST_ID} tabId="preferences">
            {preferencesBody}
          </TabPanel>
        ) : section === "budget" ? (
          <TabPanel id={SETTINGS_TABLIST_ID} tabId="budget">
            <SpendSplitBar />
            <BudgetSettings />
          </TabPanel>
        ) : section === "memory" ? (
          <TabPanel id={SETTINGS_TABLIST_ID} tabId="memory">
            <ClaudeMdEditor projectCwd={projectCwd} />
          </TabPanel>
        ) : section === "mcp" ? (
          <TabPanel id={SETTINGS_TABLIST_ID} tabId="mcp">
            <McpManager projectCwd={projectCwd} />
          </TabPanel>
        ) : section === "hooks" ? (
          <TabPanel id={SETTINGS_TABLIST_ID} tabId="hooks">
            <HooksEditor projectCwd={projectCwd} />
          </TabPanel>
        ) : section === "webhooks" ? (
          <TabPanel id={SETTINGS_TABLIST_ID} tabId="webhooks">
            <WebhooksManager />
          </TabPanel>
        ) : section === "permissions" ? (
          <TabPanel id={SETTINGS_TABLIST_ID} tabId="permissions">
            <PermissionsEditor projectCwd={projectCwd} />
          </TabPanel>
        ) : section === "agents" ? (
          <TabPanel id={SETTINGS_TABLIST_ID} tabId="agents">
            <AgentsLibrary projectCwd={projectCwd} />
          </TabPanel>
        ) : section === "skills" ? (
          <TabPanel id={SETTINGS_TABLIST_ID} tabId="skills">
            <SkillsManager projectCwd={projectCwd} />
          </TabPanel>
        ) : (
          <TabPanel id={SETTINGS_TABLIST_ID} tabId="plugins">
            <PluginsView />
          </TabPanel>
        )}
      </div>
  );
}
