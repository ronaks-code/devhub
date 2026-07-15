import type { DevHubFeatureFlags } from "@devhub/engine/providers";

/**
 * Provider capability model for the M6 Task 3 TaskHeader + provider-aware task
 * setup (design-lock §3 and §5).
 *
 * This module is the SINGLE source of truth for two locked invariants:
 *
 *   1. Provider is immutable after native task creation. There is no in-task
 *      provider picker anywhere; the only way to change provider is a cross-provider
 *      fork, which leaves the source task unchanged (`providerFixedDisclosure`).
 *
 *   2. Capability-gated controls are NEVER faked by CSS. A control with a proven
 *      provider/version runtime contract renders as an active field; a control the
 *      schema mentions but the runtime does not prove renders as an explicitly
 *      `disabled` field carrying a required capability `reason`; a control with no
 *      proven contract at all is ABSENT. A greyed style may never stand in for a
 *      missing runtime contract, so `decideSetupFields` only ever emits `disabled`
 *      together with a non-empty reason.
 *
 * It is pure data + pure functions so the presentational components and the tests
 * assert one contract.
 */

/** The two shipping native runtimes. Provider identity is a closed set. */
export type ProviderId = "openai" | "anthropic";

export interface ProviderIdentity {
  provider: ProviderId;
  /** Organization label, e.g. `OpenAI`. */
  org: string;
  /** Product label, e.g. `Codex`. */
  product: string;
  /** The quiet full identity shown as read-only text (`OpenAI · Codex`). */
  label: string;
}

/**
 * Map a provider to its quiet-text identity. This is the ONLY source of the
 * user-facing identity string; identity is quiet but never absent and never a logo
 * (design-lock §3, invariant 9). No provider wordmark ever becomes the brand.
 */
export function providerIdentity(provider: ProviderId): ProviderIdentity {
  return provider === "openai"
    ? { provider, org: "OpenAI", product: "Codex", label: "OpenAI · Codex" }
    : { provider, org: "Anthropic", product: "Claude", label: "Anthropic · Claude" };
}

/**
 * Provider-native permission field labels. These are NOT interchangeable: Codex uses
 * `Permissions`, Claude uses `Permission mode`. Claude must never render `Workspace`
 * and Codex `Workspace` is not the same control as Claude `Permission mode / Default`
 * (design-lock §5). The label is derived from the provider here — never taken from an
 * untrusted inventory string — so the invariant cannot be violated by bad data.
 */
export const PERMISSION_FIELD_LABEL: Readonly<Record<ProviderId, string>> = Object.freeze({
  openai: "Permissions",
  anthropic: "Permission mode",
});

/** Copy for the new-task setup surface. One source for the `T-setup` visible-copy diff. */
export const TASK_SETUP_COPY = Object.freeze({
  title: "New task setup",
  /** The fixed-provider disclosure required by design-lock §5. */
  providerFixedDisclosure:
    "Provider is fixed after creation. Fork to another provider to continue there.",
  createTask: "Create task",
  fieldProvider: "Provider",
  fieldModel: "Model",
  fieldReasoning: "Reasoning",
  fieldMode: "Mode",
  fieldProject: "Project",
  fieldFolder: "Folder",
});

/** Copy for the existing-task header. One source for the `T-header` visible-copy diff. */
export const TASK_HEADER_COPY = Object.freeze({
  /** Cross-provider fork is the ONLY provider change; it never mutates the source. */
  forkAction: "Create cross-provider fork",
  providerFixedNote:
    "Provider is fixed after creation. Fork to another provider to continue there.",
  /** Claude-only divergence copy. Never claims the requested model actually ran. */
  modelDiffersFromRequest: "Model differs from request",
  requestedLabel: "Requested",
  sessionReportedLabel: "Session reported",
  responseUsedLabel: "Response used",
});

/**
 * What the selected provider/version actually reports it supports. Empty/omitted
 * fields mean "no proven contract" and the corresponding control is ABSENT — the
 * runtime, not CSS, decides. `unproven` carries controls the schema names but the
 * runtime does not prove; each renders disabled WITH its exact reason.
 */
export interface ProviderCapabilityInventory {
  provider: ProviderId;
  /** Models the runtime reports it can start. Empty/omitted => Model control absent. */
  models?: readonly string[];
  /** Codex reasoning levels. Claude reports none (reasoning is Codex-only). */
  reasoningLevels?: readonly string[];
  /** Modes the runtime supports. Omitted/empty => Mode control absent. */
  modes?: readonly string[];
  /** Provider-native permission VALUES (the label is derived from the provider). */
  permissionValues?: readonly string[];
  /**
   * Controls the schema names but the runtime does not prove for this
   * provider/version. Each is rendered as an explicitly disabled field with its
   * exact reason (never CSS-faked, never advertised as working).
   */
  unproven?: readonly { key: SetupFieldKey; label: string; reason: string }[];
}

export type SetupFieldKey =
  | "provider"
  | "model"
  | "reasoning"
  | "mode"
  | "project"
  | "folder"
  | "permission";

export type FieldPresentation = "shown" | "disabled" | "absent";

export interface SetupFieldDecision {
  key: SetupFieldKey;
  label: string;
  presentation: FieldPresentation;
  /** Selectable values for a `shown` field. */
  values?: readonly string[];
  /** REQUIRED whenever presentation is `disabled`; the exact capability reason. */
  reason?: string;
}

/**
 * Decide the presentation of every setup field for one provider/version inventory.
 *
 * - `Provider`, `Project`, `Folder` are always shown (project/folder are not
 *   capability-gated; provider is the setup-time picker — an EXISTING task never
 *   renders this, see `TaskHeader`).
 * - `Model` / `Reasoning` / `Mode` / permission are shown only when the runtime
 *   reports a non-empty inventory; otherwise ABSENT (no proven contract).
 * - Reasoning is Codex-only; it is never shown for Claude even if data leaks in.
 * - `unproven` controls are appended as `disabled` with their exact reason.
 *
 * The returned list preserves the design-lock §5 field order.
 */
export function decideSetupFields(
  inv: ProviderCapabilityInventory,
): SetupFieldDecision[] {
  const has = (v?: readonly string[]): v is readonly string[] => Array.isArray(v) && v.length > 0;
  const fields: SetupFieldDecision[] = [];

  fields.push({ key: "provider", label: TASK_SETUP_COPY.fieldProvider, presentation: "shown" });

  fields.push(
    has(inv.models)
      ? { key: "model", label: TASK_SETUP_COPY.fieldModel, presentation: "shown", values: inv.models }
      : { key: "model", label: TASK_SETUP_COPY.fieldModel, presentation: "absent" },
  );

  // Reasoning is Codex-only. For Claude it is always absent, never a faked control.
  if (inv.provider === "openai" && has(inv.reasoningLevels)) {
    fields.push({
      key: "reasoning",
      label: TASK_SETUP_COPY.fieldReasoning,
      presentation: "shown",
      values: inv.reasoningLevels,
    });
  } else {
    fields.push({ key: "reasoning", label: TASK_SETUP_COPY.fieldReasoning, presentation: "absent" });
  }

  fields.push(
    has(inv.modes)
      ? { key: "mode", label: TASK_SETUP_COPY.fieldMode, presentation: "shown", values: inv.modes }
      : { key: "mode", label: TASK_SETUP_COPY.fieldMode, presentation: "absent" },
  );

  fields.push({ key: "project", label: TASK_SETUP_COPY.fieldProject, presentation: "shown" });
  fields.push({ key: "folder", label: TASK_SETUP_COPY.fieldFolder, presentation: "shown" });

  const permissionLabel = PERMISSION_FIELD_LABEL[inv.provider];
  fields.push(
    has(inv.permissionValues)
      ? { key: "permission", label: permissionLabel, presentation: "shown", values: inv.permissionValues }
      : { key: "permission", label: permissionLabel, presentation: "absent" },
  );

  // Schema-named but unproven controls: disabled WITH a reason (never absent-silent,
  // never CSS-faked-as-working). A reason is mandatory here by construction.
  for (const u of inv.unproven ?? []) {
    fields.push({
      key: u.key,
      label: u.label,
      presentation: "disabled",
      reason: u.reason && u.reason.length > 0 ? u.reason : "Not supported by this provider version.",
    });
  }

  return fields;
}

/** Inputs that gate whether `Create task` may be enabled. */
export interface CreateTaskGate {
  /** Provider auth is present/valid. */
  authValid: boolean;
  projectSelected: boolean;
  folderSelected: boolean;
  /** The permission/mode policy resolves to a valid provider-native value. */
  policyValid: boolean;
}

/** True only when every precondition is met. `Create task` never navigates until then. */
export function canCreateTask(g: CreateTaskGate): boolean {
  return g.authValid && g.projectSelected && g.folderSelected && g.policyValid;
}

/**
 * The exact accessible reason `Create task` is disabled, or null when it is enabled.
 * The first unmet precondition wins, so the message is deterministic.
 */
export function createTaskDisabledReason(g: CreateTaskGate): string | null {
  if (!g.authValid) return "Sign in to this provider to create a task.";
  if (!g.projectSelected) return "Choose a project.";
  if (!g.folderSelected) return "Choose a folder.";
  if (!g.policyValid) return "Choose a permission policy.";
  return null;
}

/** Claude's three model observations. Any may be unknown (null/omitted). */
export interface ClaudeModelReport {
  /** The model the task requested. */
  requested?: string | null;
  /** The model the init/session event reported. */
  sessionReported?: string | null;
  /** The model the response actually used. */
  responseUsed?: string | null;
}

export interface ClaudeModelDisclosure {
  /** True when a known reported/used model differs from the requested one. */
  diverges: boolean;
  requested: string | null;
  sessionReported: string | null;
  responseUsed: string | null;
  /** `Model differs from request` when diverging; null otherwise. */
  message: string | null;
}

/**
 * Resolve Claude's model disclosure. When the session-reported or response-used model
 * differs from the requested model, this reports divergence and surfaces the exact
 * copy `Model differs from request`. Critically, it NEVER collapses the three values
 * into one and never claims the requested model ran — the caller shows each observed
 * value under its own label so the requested model is not presented as the one used.
 */
export function resolveClaudeModelDisclosure(
  report: ClaudeModelReport,
): ClaudeModelDisclosure {
  const requested = report.requested ?? null;
  const sessionReported = report.sessionReported ?? null;
  const responseUsed = report.responseUsed ?? null;
  const observed = [sessionReported, responseUsed].filter(
    (m): m is string => typeof m === "string" && m.length > 0,
  );
  const diverges = requested != null && observed.some((m) => m !== requested);
  return {
    diverges,
    requested,
    sessionReported,
    responseUsed,
    message: diverges ? TASK_HEADER_COPY.modelDiffersFromRequest : null,
  };
}

export type TaskHeaderSetupMode = "devhub" | "legacy";

/**
 * Slice-flag gate. Mirrors `resolveShellChromeMode`/`resolveTaskRailMode`: the
 * capability-gated header + setup mount only for a server-resolved true
 * `taskHeaderSetup`; anything else (false / undefined / missing settings) keeps the
 * legacy `ChatPane` header + setup — the immediate, non-destructive rollback surface.
 */
export function resolveTaskHeaderSetupMode(
  settings: { devHubFeatures?: Partial<DevHubFeatureFlags> } | null | undefined,
): TaskHeaderSetupMode {
  return settings?.devHubFeatures?.taskHeaderSetup === true ? "devhub" : "legacy";
}

/** True only when the task-header/setup slice flag is applied. */
export function isTaskHeaderSetupApplied(
  features: Partial<DevHubFeatureFlags> | undefined,
): boolean {
  return features?.taskHeaderSetup === true;
}
