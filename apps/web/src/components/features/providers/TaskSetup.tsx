import { useId } from "react";
import {
  TASK_SETUP_COPY,
  canCreateTask,
  createTaskDisabledReason,
  decideSetupFields,
  providerIdentity,
  type CreateTaskGate,
  type ProviderCapabilityInventory,
  type ProviderId,
  type SetupFieldDecision,
} from "./provider-capabilities.js";

/**
 * TaskSetup — the compact anchored new-task setup (M6 slice 3, design-lock §5).
 *
 * This is a small anchored popover, NOT a wizard or hero. It exposes ONLY the fields
 * the selected provider/version proves it supports (`decideSetupFields`): `Provider`,
 * `Model`, (Codex-only) `Reasoning`, `Mode`, `Project`, `Folder`, and the
 * provider-native permission field. A control with no proven runtime contract is
 * absent; a schema-named-but-unproven control is rendered explicitly `disabled` with
 * its exact capability reason — CSS state never substitutes for a missing contract.
 *
 * The setup states the fixed-provider disclosure and `Create task` stays disabled
 * (with an accessible reason) until auth/project/folder/policy are valid. Provider is
 * a picker HERE only because the task does not exist yet; once created, provider is
 * immutable read-only identity in `TaskHeader`.
 */
export interface TaskSetupProps {
  /** Currently selected provider (setup-time only; becomes immutable after creation). */
  provider: ProviderId;
  /** Providers offered in the setup picker. */
  availableProviders?: readonly ProviderId[];
  /** The selected provider's proven capability inventory. */
  inventory: ProviderCapabilityInventory;
  /** Preconditions for enabling `Create task`. */
  gate: CreateTaskGate;
  onProviderChange?: (provider: ProviderId) => void;
  onCreate?: () => void;
}

function FieldRow({ field, describedById }: { field: SetupFieldDecision; describedById: string }) {
  if (field.presentation === "absent") return null;

  const disabled = field.presentation === "disabled";
  return (
    <div
      className="dh-setup-field"
      data-dh-setup-field={field.key}
      data-dh-field-state={field.presentation}
    >
      <label className="dh-setup-field-label" data-dh-field-label="">
        {field.label}
      </label>
      {disabled ? (
        <>
          {/* A disabled control carries a REAL disabled attribute + an explicit
              reason wired via aria-describedby — never a greyed style alone. */}
          <button
            type="button"
            className="dh-setup-control"
            data-dh-setup-control=""
            disabled
            aria-disabled="true"
            aria-describedby={describedById}
          >
            {field.label}
          </button>
          <p
            id={describedById}
            className="dh-setup-capability-reason"
            data-dh-capability-reason=""
          >
            {field.reason}
          </p>
        </>
      ) : field.values && field.values.length > 0 ? (
        <select className="dh-setup-control" data-dh-setup-control="" aria-label={field.label}>
          {field.values.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      ) : (
        <button
          type="button"
          className="dh-setup-control"
          data-dh-setup-control=""
          aria-label={field.label}
        >
          {field.label}
        </button>
      )}
    </div>
  );
}

export function TaskSetup({
  provider,
  availableProviders = ["openai", "anthropic"],
  inventory,
  gate,
  onProviderChange,
  onCreate,
}: TaskSetupProps) {
  const baseId = useId();
  const fields = decideSetupFields(inventory);
  const createEnabled = canCreateTask(gate);
  const disabledReason = createTaskDisabledReason(gate);
  const reasonId = `${baseId}-create-reason`;

  return (
    <div
      className="dh-task-setup"
      data-dh-task-setup=""
      role="group"
      aria-label={TASK_SETUP_COPY.title}
    >
      <div className="dh-setup-title" data-dh-setup-title="">
        {TASK_SETUP_COPY.title}
      </div>

      {/* Fixed-provider disclosure (design-lock §5). Always present in setup. */}
      <p className="dh-setup-disclosure" data-dh-provider-fixed-disclosure="">
        {TASK_SETUP_COPY.providerFixedDisclosure}
      </p>

      <div className="dh-setup-fields">
        {fields.map((field) => {
          // The provider field is the setup-time picker (a real select). Every other
          // field routes through FieldRow's capability-gated presentation.
          if (field.key === "provider" && field.presentation === "shown") {
            return (
              <div
                key="provider"
                className="dh-setup-field"
                data-dh-setup-field="provider"
                data-dh-field-state="shown"
              >
                <label className="dh-setup-field-label" data-dh-field-label="">
                  {field.label}
                </label>
                <select
                  className="dh-setup-control"
                  data-dh-setup-control=""
                  data-dh-provider-picker=""
                  aria-label={field.label}
                  value={provider}
                  onChange={(e) => onProviderChange?.(e.target.value as ProviderId)}
                >
                  {availableProviders.map((p) => (
                    <option key={p} value={p}>
                      {providerIdentity(p).label}
                    </option>
                  ))}
                </select>
              </div>
            );
          }
          return (
            <FieldRow
              key={field.key}
              field={field}
              describedById={`${baseId}-${field.key}-reason`}
            />
          );
        })}
      </div>

      <div className="dh-setup-actions">
        <button
          type="button"
          className="dh-setup-create"
          data-dh-create-task=""
          disabled={!createEnabled}
          aria-disabled={createEnabled ? undefined : "true"}
          aria-describedby={createEnabled ? undefined : reasonId}
          onClick={() => {
            if (createEnabled) onCreate?.();
          }}
        >
          {TASK_SETUP_COPY.createTask}
        </button>
        {!createEnabled && disabledReason ? (
          <p id={reasonId} className="dh-setup-create-reason" data-dh-create-reason="">
            {disabledReason}
          </p>
        ) : null}
      </div>
    </div>
  );
}
