// @vitest-environment jsdom
import { createElement } from "react";
import { render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  WORK_MODE_COPY,
  WORK_MODE_DELIVERABLE_STATUS_LABEL,
  WorkModePanel,
  type WorkModeTaskView,
} from "./WorkModePanel.js";

const TASK: WorkModeTaskView = {
  title: "Prepare release audit",
  folderScope: "…/active/claude-ui",
  outcome: { summary: "Ship a release-ready package", current: 3, total: 5 },
  deliverables: [
    { id: "build-report", label: "Build report", status: "ready" },
    { id: "desktop-package", label: "Desktop package", status: "in-progress" },
    { id: "release-notes", label: "Release notes", status: "pending" },
  ],
};

function render(overrides: Partial<{ enabled: boolean; task: WorkModeTaskView | null }> = {}) {
  return rtlRender(
    createElement(WorkModePanel, { enabled: true, task: TASK, ...overrides }),
  );
}

describe("WorkModePanel", () => {
  it("renders nothing when the workMode flag is off — no mode selector, no panel", () => {
    const { container } = render({ enabled: false });
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("renders nothing when there is no backing task, even with the flag on", () => {
    const { container } = render({ task: null });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows Work selected and Code unselected in the compact mode selector, with no provider picker", () => {
    render();
    const codeTab = screen.getByRole("tab", { name: WORK_MODE_COPY.modeLabelCode });
    const workTab = screen.getByRole("tab", { name: WORK_MODE_COPY.modeLabelWork });
    expect(codeTab).toHaveAttribute("aria-selected", "false");
    expect(workTab).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("renders fixed DevHub/Claude identity text and the DevHub Work mode label, never a provider picker", () => {
    render();
    expect(screen.getByText(WORK_MODE_COPY.identityLabel)).toBeInTheDocument();
    expect(screen.getByText(WORK_MODE_COPY.taskModeLabel)).toBeInTheDocument();
    expect(screen.queryByText(/cowork/i)).toBeNull();
  });

  it("renders folder scope and Permission mode / Default — never Permissions/Workspace", () => {
    render();
    expect(screen.getByText(WORK_MODE_COPY.folderScopeLabel)).toBeInTheDocument();
    expect(screen.getByText(TASK.folderScope)).toBeInTheDocument();
    expect(screen.getByText(WORK_MODE_COPY.permissionModeLabel)).toBeInTheDocument();
    expect(screen.getByText(WORK_MODE_COPY.permissionModeDefaultValue)).toBeInTheDocument();
    expect(screen.queryByText("Permissions")).toBeNull();
    expect(screen.queryByText("Workspace")).toBeNull();
  });

  it("renders progress, outcome, and every deliverable with its status", () => {
    render();
    expect(screen.getByText(TASK.outcome.summary)).toBeInTheDocument();
    expect(screen.getByText("3/5")).toBeInTheDocument();
    const progressbar = screen.getByRole("progressbar");
    expect(progressbar).toHaveAttribute("aria-valuenow", "60");

    for (const deliverable of TASK.deliverables) {
      expect(screen.getByText(deliverable.label)).toBeInTheDocument();
      expect(
        screen.getByText(WORK_MODE_DELIVERABLE_STATUS_LABEL[deliverable.status]),
      ).toBeInTheDocument();
    }
  });

  it("is a real, focusable tab control a user can interact with via keyboard/click", async () => {
    render();
    const user = userEvent.setup();
    const codeTab = screen.getByRole("tab", { name: WORK_MODE_COPY.modeLabelCode });
    await user.click(codeTab);
    // Clicking Code is a no-op in this slice (Work stays the rendered mode); the
    // important assertion is that the click doesn't throw and Work stays selected.
    expect(screen.getByRole("tab", { name: WORK_MODE_COPY.modeLabelWork })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
