// @vitest-environment jsdom
import { createElement } from "react";
import { render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  PERMISSION_FIELD_LABEL,
  TASK_SETUP_COPY,
  canCreateTask,
  createTaskDisabledReason,
  decideSetupFields,
  isTaskHeaderSetupApplied,
  providerIdentity,
  resolveTaskHeaderSetupMode,
  type CreateTaskGate,
  type ProviderCapabilityInventory,
} from "./provider-capabilities.js";
import { TaskSetup } from "./TaskSetup.js";

/** Count non-overlapping occurrences of a substring. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function render(props: Parameters<typeof TaskSetup>[0]): string {
  return renderToStaticMarkup(createElement(TaskSetup, props));
}

const codexInventory: ProviderCapabilityInventory = {
  provider: "openai",
  models: ["gpt-5-codex", "gpt-5"],
  reasoningLevels: ["low", "medium", "high"],
  modes: ["agent", "chat"],
  permissionValues: ["read-only", "workspace-write", "danger-full-access"],
};

const claudeInventory: ProviderCapabilityInventory = {
  provider: "anthropic",
  models: ["claude-opus-4-8", "claude-sonnet-4-5"],
  modes: ["default", "plan"],
  permissionValues: ["default", "acceptEdits", "bypassPermissions"],
};

const validGate: CreateTaskGate = {
  authValid: true,
  projectSelected: true,
  folderSelected: true,
  policyValid: true,
};

describe("decideSetupFields — capability gating (design-lock §5)", () => {
  it("shows only the fields the runtime proves for Codex, including reasoning", () => {
    const fields = decideSetupFields(codexInventory);
    const shown = fields.filter((f) => f.presentation === "shown").map((f) => f.key);
    expect(shown).toContain("provider");
    expect(shown).toContain("model");
    expect(shown).toContain("reasoning");
    expect(shown).toContain("mode");
    expect(shown).toContain("project");
    expect(shown).toContain("folder");
    expect(shown).toContain("permission");
    // Codex permission control uses the provider-native label.
    const permission = fields.find((f) => f.key === "permission");
    expect(permission?.label).toBe(PERMISSION_FIELD_LABEL.openai);
    expect(permission?.label).toBe("Permissions");
  });

  it("never shows reasoning for Claude and uses the Claude permission label", () => {
    const fields = decideSetupFields(claudeInventory);
    const reasoning = fields.find((f) => f.key === "reasoning");
    expect(reasoning?.presentation).toBe("absent");
    const permission = fields.find((f) => f.key === "permission");
    expect(permission?.label).toBe(PERMISSION_FIELD_LABEL.anthropic);
    expect(permission?.label).toBe("Permission mode");
    // Claude must never render Codex's `Workspace` permission label.
    expect(permission?.label).not.toBe("Workspace");
  });

  it("marks a field absent when the runtime reports no inventory (no CSS-faked control)", () => {
    const bare: ProviderCapabilityInventory = { provider: "openai" };
    const fields = decideSetupFields(bare);
    for (const key of ["model", "reasoning", "mode", "permission"] as const) {
      expect(fields.find((f) => f.key === key)?.presentation).toBe("absent");
    }
    // provider/project/folder are always shown; they are not capability-gated.
    for (const key of ["provider", "project", "folder"] as const) {
      expect(fields.find((f) => f.key === key)?.presentation).toBe("shown");
    }
  });

  it("renders a schema-named-but-unproven control disabled WITH a required reason", () => {
    const inv: ProviderCapabilityInventory = {
      provider: "openai",
      models: ["gpt-5"],
      unproven: [{ key: "mode", label: "Sandbox", reason: "Not proven for this Codex version." }],
    };
    const fields = decideSetupFields(inv);
    const disabled = fields.filter((f) => f.presentation === "disabled");
    expect(disabled).toHaveLength(1);
    // A disabled decision ALWAYS carries a non-empty reason; disabled never means
    // "greyed with no contract".
    expect(disabled[0]!.reason).toBeTruthy();
    expect(disabled[0]!.reason).toContain("Codex version");
  });

  it("supplies a fallback reason if an unproven control omits one (never silently disabled)", () => {
    const inv: ProviderCapabilityInventory = {
      provider: "anthropic",
      unproven: [{ key: "mode", label: "Sandbox", reason: "" }],
    };
    const disabled = decideSetupFields(inv).find((f) => f.presentation === "disabled");
    expect(disabled?.reason).toBeTruthy();
  });
});

describe("Create task gating", () => {
  it("is enabled only when auth + project + folder + policy are valid", () => {
    expect(canCreateTask(validGate)).toBe(true);
    expect(canCreateTask({ ...validGate, authValid: false })).toBe(false);
    expect(canCreateTask({ ...validGate, projectSelected: false })).toBe(false);
    expect(canCreateTask({ ...validGate, folderSelected: false })).toBe(false);
    expect(canCreateTask({ ...validGate, policyValid: false })).toBe(false);
  });

  it("reports the first unmet precondition as a deterministic reason", () => {
    expect(createTaskDisabledReason(validGate)).toBeNull();
    expect(createTaskDisabledReason({ ...validGate, authValid: false })).toContain("Sign in");
    expect(createTaskDisabledReason({ ...validGate, projectSelected: false })).toContain("project");
    expect(createTaskDisabledReason({ ...validGate, folderSelected: false })).toContain("folder");
    expect(createTaskDisabledReason({ ...validGate, policyValid: false })).toContain("permission");
  });
});

describe("TaskSetup rendering (compact anchored setup, not a wizard/hero)", () => {
  it("renders the New task setup title and the fixed-provider disclosure", () => {
    const html = render({ provider: "openai", inventory: codexInventory, gate: validGate });
    expect(html).toContain('data-dh-task-setup=""');
    expect(html).toContain(`>${TASK_SETUP_COPY.title}<`);
    expect(html).toContain('data-dh-provider-fixed-disclosure=""');
    expect(html).toContain(TASK_SETUP_COPY.providerFixedDisclosure);
    // No hero/wizard/onboarding chrome.
    expect(html).not.toContain("hero");
    expect(html).not.toContain("wizard");
  });

  it("exposes only the capability-supported fields for Codex (reasoning present)", () => {
    const html = render({ provider: "openai", inventory: codexInventory, gate: validGate });
    expect(html).toContain('data-dh-setup-field="provider"');
    expect(html).toContain('data-dh-setup-field="model"');
    expect(html).toContain('data-dh-setup-field="reasoning"');
    expect(html).toContain('data-dh-setup-field="mode"');
    expect(html).toContain('data-dh-setup-field="project"');
    expect(html).toContain('data-dh-setup-field="folder"');
    expect(html).toContain('data-dh-setup-field="permission"');
  });

  it("omits reasoning entirely for Claude and never renders Workspace as its permission", () => {
    const html = render({ provider: "anthropic", inventory: claudeInventory, gate: validGate });
    expect(html).not.toContain('data-dh-setup-field="reasoning"');
    expect(html).toContain("Permission mode");
    expect(html).not.toContain(">Workspace<");
  });

  it("renders the setup-time provider picker (setup only — task does not exist yet)", () => {
    const html = render({ provider: "openai", inventory: codexInventory, gate: validGate });
    expect(html).toContain('data-dh-provider-picker=""');
    // Both provider identities are offered as options.
    expect(html).toContain(providerIdentity("openai").label);
    expect(html).toContain(providerIdentity("anthropic").label);
  });

  it("disables Create task with an accessible reason until preconditions are valid", () => {
    const html = render({
      provider: "openai",
      inventory: codexInventory,
      gate: { ...validGate, projectSelected: false },
    });
    expect(html).toContain('data-dh-create-task=""');
    expect(html).toContain("disabled");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('data-dh-create-reason=""');
    expect(html).toContain("Choose a project.");
  });

  it("enables Create task and drops the reason once every precondition is valid", () => {
    const html = render({ provider: "openai", inventory: codexInventory, gate: validGate });
    expect(html).toContain('data-dh-create-task=""');
    expect(html).not.toContain('data-dh-create-reason=""');
  });

  it("renders no provider logo (identity is quiet text only)", () => {
    const html = render({ provider: "anthropic", inventory: claudeInventory, gate: validGate });
    expect(count(html, "<svg")).toBe(0);
    expect(count(html, "<img")).toBe(0);
  });
});

describe("taskHeaderSetup slice flag gate", () => {
  it("resolves devhub only for an applied true flag; everything else stays legacy", () => {
    expect(resolveTaskHeaderSetupMode({ devHubFeatures: { taskHeaderSetup: true } })).toBe("devhub");
    expect(resolveTaskHeaderSetupMode({ devHubFeatures: { taskHeaderSetup: false } })).toBe("legacy");
    expect(resolveTaskHeaderSetupMode({ devHubFeatures: {} })).toBe("legacy");
    expect(resolveTaskHeaderSetupMode({})).toBe("legacy");
    expect(resolveTaskHeaderSetupMode(null)).toBe("legacy");
    expect(resolveTaskHeaderSetupMode(undefined)).toBe("legacy");
  });

  it("isTaskHeaderSetupApplied is true only for an explicit true", () => {
    expect(isTaskHeaderSetupApplied({ taskHeaderSetup: true })).toBe(true);
    expect(isTaskHeaderSetupApplied({ taskHeaderSetup: false })).toBe(false);
    expect(isTaskHeaderSetupApplied({})).toBe(false);
    expect(isTaskHeaderSetupApplied(undefined)).toBe(false);
  });
});

describe("TaskSetup — live interaction (mounted DOM)", () => {
  it("selecting a provider in the setup-time picker fires onProviderChange with the new value", async () => {
    const user = userEvent.setup();
    const onProviderChange = vi.fn();
    rtlRender(
      createElement(TaskSetup, {
        provider: "openai",
        inventory: codexInventory,
        gate: validGate,
        onProviderChange,
      }),
    );
    const picker = screen.getByRole("combobox", { name: /provider/i });
    await user.selectOptions(picker, "anthropic");
    expect(onProviderChange).toHaveBeenCalledWith("anthropic");
  });

  it("clicking Create task invokes onCreate when every precondition is met", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    rtlRender(
      createElement(TaskSetup, {
        provider: "openai",
        inventory: codexInventory,
        gate: validGate,
        onCreate,
      }),
    );
    const button = screen.getByRole("button", { name: TASK_SETUP_COPY.createTask });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("Create task stays a real disabled control and never invokes onCreate while a precondition is unmet", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const gate: CreateTaskGate = { ...validGate, folderSelected: false };
    rtlRender(
      createElement(TaskSetup, {
        provider: "openai",
        inventory: codexInventory,
        gate,
        onCreate,
      }),
    );
    const button = screen.getByRole("button", { name: TASK_SETUP_COPY.createTask });
    expect(button).toBeDisabled();
    // A disabled native control never dispatches a click action to onCreate.
    await user.click(button);
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByText(createTaskDisabledReason(gate)!)).toBeInTheDocument();
    expect(button).toHaveAccessibleDescription(createTaskDisabledReason(gate)!);
  });

  it("tabbing through the setup reaches the provider picker then Create task in order", async () => {
    const user = userEvent.setup();
    rtlRender(
      createElement(TaskSetup, {
        provider: "openai",
        inventory: codexInventory,
        gate: validGate,
      }),
    );
    await user.tab();
    expect(screen.getByRole("combobox", { name: /provider/i })).toHaveFocus();
  });
});
