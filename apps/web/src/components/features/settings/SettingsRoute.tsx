import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type AppSettings } from "../../../lib/api.js";
import { PERMISSION_MODES, type PermissionMode } from "@devhub/engine/driver";
import type { DevHubFeatureFlags } from "@devhub/engine/providers";
import { readCompat, writeCompat } from "../../../lib/compat-storage.js";
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
  completeDevHubFeatures,
  deliverSettingsResponse,
  dirtySettingsUpdatePayload,
  mergeAuthoritativeSettings,
  requestSettingsReconciliation,
  withNativeCodexPreference,
  withPersistentClaudePreference,
} from "../../SettingsPane.js";
import { SecondaryNav } from "../shell/SecondaryNav.js";
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

const MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
] as const;
const THEMES = ["dark", "light", "system"] as const;
const DENSITIES = ["comfortable", "compact"] as const;

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
  return settings?.devHubFeatures?.settingsSecondary === true ? "devhub" : "legacy";
}

/** True only when the settings-secondary slice flag is applied. */
export function isSettingsSecondaryApplied(
  features: Partial<DevHubFeatureFlags> | undefined,
): boolean {
  return features?.settingsSecondary === true;
}

export function SettingsRoute({
  onSettingsSaved,
  onSettingsRequestStart,
  onSettingsReconcile,
  authoritativeSettings,
  projectCwd,
}: {
  onSettingsSaved?: (s: AppSettings, requestVersion?: number) => boolean | void;
  onSettingsRequestStart?: () => number;
  onSettingsReconcile?: () => void | Promise<void>;
  authoritativeSettings?: AppSettings | null;
  projectCwd?: string;
}): ReactNode {
  const [section, setSection] = useState<SettingsSection>("preferences");
  const [settings, setSettings] = useState<AppSettings | null>(authoritativeSettings ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [conn, setConn] = useState<ConnSettings>(() => readConn());
  const [connSavedAt, setConnSavedAt] = useState<number | null>(null);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);

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
      setSettings((current) => mergeAuthoritativeSettings(current, next, dirtySettings.current));
    } catch (reason) {
      if (requestVersion.current !== localVersion) return;
      setLoadError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [onSettingsRequestStart, onSettingsSaved]);

  useEffect(() => {
    if (authoritativeSettings) {
      requestVersion.current += 1;
      setSettings((current) => mergeAuthoritativeSettings(current, authoritativeSettings, dirtySettings.current));
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
      setConnSavedAt(Date.now());
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
      setConnSavedAt(Date.now());
      if (!keepLocalState) return;
      for (const key of savedKeys) dirtySettings.current.delete(key);
      setSettings(next);
      setSavedAt(Date.now());
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedAt(null), 2000);
    } catch (e) {
      requestSettingsReconciliation(onSettingsReconcile);
      if (requestVersion.current !== localVersion) return;
      setLoadError(
        `Save response was not confirmed; reconciling settings. ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      if (requestVersion.current === localVersion) setSaving(false);
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
          <Field id="dh-settings-theme" label="Theme" hint="Stored for now; full theming lands later.">
            <Select
              id="dh-settings-theme"
              value={settings.theme ?? "system"}
              describedBy="dh-settings-theme-hint"
              options={THEMES.map((t) => ({ value: t, label: t }))}
              onChange={(v) => patch("theme", v as AppSettings["theme"])}
            />
          </Field>
          <Field id="dh-settings-density" label="Density">
            <Select
              id="dh-settings-density"
              value={settings.density ?? "comfortable"}
              options={DENSITIES.map((d) => ({ value: d, label: d }))}
              onChange={(v) => patch("density", v)}
            />
          </Field>
        </FieldGroup>

        <FieldGroup
          id="dh-settings-providers"
          heading="Providers"
          description="Default model for new chats, which native provider runtimes are requested, and this browser's connection to a remote engine."
        >
          <Field id="dh-settings-default-model" label="Default model" hint="Used when starting a new chat.">
            <Select
              id="dh-settings-default-model"
              value={settings.defaultModel ?? MODELS[0]}
              describedBy="dh-settings-default-model-hint"
              options={MODELS.map((m) => ({ value: m, label: m }))}
              onChange={(v) => patch("defaultModel", v)}
            />
          </Field>

          <div className="dh-settings-switch-row" data-dh-settings-switch="nativeCodex">
            <Switch
              id="dh-settings-native-codex"
              label="Enable native Codex"
              describedBy="dh-settings-native-codex-hint"
              checked={
                completeDevHubFeatures(settings.requestedDevHubFeatures ?? settings.devHubFeatures).nativeCodex
              }
              onChange={(enabled) => {
                dirtySettings.current.add("requestedDevHubFeatures");
                setSettings((current) => (current ? withNativeCodexPreference(current, enabled) : current));
              }}
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

          <div className="dh-settings-switch-row" data-dh-settings-switch="persistentClaude">
            <Switch
              id="dh-settings-persistent-claude"
              label="Enable persistent Claude"
              describedBy="dh-settings-persistent-claude-hint"
              checked={
                completeDevHubFeatures(settings.requestedDevHubFeatures ?? settings.devHubFeatures).persistentClaude
              }
              onChange={(enabled) => {
                dirtySettings.current.add("requestedDevHubFeatures");
                setSettings((current) => (current ? withPersistentClaudePreference(current, enabled) : current));
              }}
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

          <Table
            caption="Provider runtime status"
            columns={["Feature", "Status", "Note"]}
            rows={providerCapabilityRows(settings).map((r) => ({
              key: r.key,
              cells: [r.feature, r.status, r.note],
            }))}
          />

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
                onChange={(v) => setConn((c) => ({ ...c, apiHost: v }))}
              />
            </Field>
            <Field id="dh-settings-api-token" label="API token" hint="Sent as a bearer token to a remote host.">
              <Input
                id="dh-settings-api-token"
                type="password"
                value={conn.apiToken ?? ""}
                placeholder="(none)"
                describedBy="dh-settings-api-token-hint"
                onChange={(v) => setConn((c) => ({ ...c, apiToken: v }))}
              />
            </Field>
            <Button variant="danger" onClick={() => setClearDialogOpen(true)}>
              Clear local connection data
            </Button>
          </FieldSet>
        </FieldGroup>

        <FieldGroup
          id="dh-settings-budget"
          heading="Budget"
          description="A soft monthly spend cap for quick reference. Warn thresholds and enforcement live under the Budget tab."
        >
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
        </FieldGroup>

        <FieldGroup
          id="dh-settings-permissions"
          heading="Permissions"
          description="Default for new sessions. Per-project allow/ask/deny rules live under the Permissions tab."
        >
          <Field id="dh-settings-permission-mode" label="Default permission mode" hint="How edits/commands are approved.">
            <Select
              id="dh-settings-permission-mode"
              value={settings.defaultPermissionMode ?? PERMISSION_MODES[0] ?? "default"}
              describedBy="dh-settings-permission-mode-hint"
              options={PERMISSION_MODES.map((m) => ({ value: m, label: m }))}
              onChange={(v) => patch("defaultPermissionMode", v as PermissionMode)}
            />
          </Field>
        </FieldGroup>

        {/* Preserved maintenance workflows, mounted unchanged. */}
        <RebuildIndex />
        <IntegrityPanel />
        <ArchiveTransfer />

        <div className="dh-settings-save-row">
          <Button type="button" variant="default" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save settings"}
          </Button>
          {saving ? <Progress label="Saving settings" /> : null}
          {savedAt ? (
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

  return (
    <SecondaryNav active="settings">
      <div className="dh-settings-route" data-dh-settings-route="">
        <header className="dh-settings-header">
          <h1 className="dh-settings-title">Settings</h1>
        </header>

        <Tabs id={SETTINGS_TABLIST_ID} label="Settings sections" tabs={SETTINGS_TABS} active={section} onSelect={setSection} />

        {section === "preferences" ? (
          <TabPanel id={SETTINGS_TABLIST_ID} tabId="preferences">
            {preferencesBody}
          </TabPanel>
        ) : section === "budget" ? (
          <TabPanel id={SETTINGS_TABLIST_ID} tabId="budget">
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
    </SecondaryNav>
  );
}

