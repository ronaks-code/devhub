// @vitest-environment jsdom
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProjectSummary, SessionSummary, TokenUsage } from "../lib/types.js";
import { ProjectsPane } from "./ProjectsPane.js";
import { SessionsPane } from "./SessionsPane.js";

// jsdom has no layout engine and doesn't implement scrollIntoView; the shared
// useListKeyboardNav hook calls it on every focus change. Stub it once so
// mounting either pane doesn't throw.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

/**
 * DEVHUB-A11Y-NESTED-INTERACTIVE: axe-core's serious `nested-interactive`
 * violation (logged as a follow-up in evidence/m8/a11y/a11y.md) flagged
 * SessionsPane's `role="option"` row for containing multiple focusable
 * descendants (select checkbox, pin, rename).
 *
 * Fix, SessionsPane: switched the whole list from the `listbox`/`option`
 * pattern to a `grid`/`row`/`gridcell` pattern — a real per-row action button
 * living anywhere under a `role="option"` (or even just under `role="listbox"`
 * with no `option`/`group` in between) is either `nested-interactive` or
 * `aria-required-children`; a `gridcell` is explicitly built to host exactly
 * one focusable widget, so neither rule fires. Each action (checkbox/pin/
 * rename) is its own sibling `gridcell` within the row.
 *
 * Fix, ProjectsPane: no per-row actions exist today, so the simpler
 * `listbox`/`option` pattern is kept, with the option leaf made a real,
 * non-focusable (`tabIndex=-1`) DOM node rather than a native `<button>` (so a
 * future action added inside the row doesn't reintroduce nested-interactive).
 *
 * These are full RTL mounts (unlike the cheaper source-static check in
 * listbox-accessible-names.test.ts) because this task needs to assert real
 * DOM containment, not just presence of a literal string.
 */

const usage: TokenUsage = {
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "sess-1",
    filePath: "/tmp/sess-1.jsonl",
    cwd: "/tmp/project",
    projectId: "proj-1",
    title: "Fix the flaky test",
    titleSource: "ai-title",
    gitBranch: "main",
    firstTimestamp: "2026-07-01T00:00:00Z",
    lastTimestamp: "2026-07-02T00:00:00Z",
    messageCount: 12,
    usage,
    sizeBytes: 1024,
    mtimeMs: Date.now(),
    hasSubagents: false,
    model: "claude-opus-4-8",
    pinned: false,
    archived: false,
    tags: ["bug"],
    costUsd: 0.42,
    notes: null,
    indexed: true,
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: "proj-1",
    cwd: "/tmp/project",
    name: "project",
    sessionCount: 3,
    lastActivity: "2026-07-02T00:00:00Z",
    totalUsage: usage,
    encodedFolders: ["/tmp/project"],
    favorite: false,
    archived: false,
    sortOrder: 0,
    color: null,
    defaultModel: null,
    defaultPermissionMode: null,
    ...overrides,
  };
}

/** Every real focusable descendant (button/a/input/[tabindex] excluding -1) of `el`. */
function focusableDescendants(el: Element): Element[] {
  return Array.from(
    el.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
  );
}

describe("SessionsPane rows: grid/row/gridcell — no interactive role nests another", () => {
  function renderPane(sessions: SessionSummary[], extra: Partial<Parameters<typeof SessionsPane>[0]> = {}) {
    const onSelect = vi.fn();
    const onRename = vi.fn();
    const onTogglePin = vi.fn();
    render(
      createElement(SessionsPane, {
        project: makeProject(),
        sessions,
        selectedId: null,
        onSelect,
        onRename,
        onTogglePin,
        ...extra,
      }),
    );
    return { onSelect, onRename, onTogglePin };
  }

  it("the list container is a grid, each row a row, with no role=option/listbox left", () => {
    renderPane([makeSession(), makeSession({ sessionId: "sess-2", title: "Second session", pinned: true })]);
    expect(screen.getByRole("grid", { name: "Sessions" })).toBeInTheDocument();
    expect(document.querySelectorAll('[role="row"]').length).toBe(2);
    expect(document.querySelectorAll('[role="option"]').length).toBe(0);
    expect(document.querySelectorAll('[role="listbox"]').length).toBe(0);
  });

  it("every gridcell holds at most one focusable descendant (no nested-interactive)", () => {
    renderPane([makeSession(), makeSession({ sessionId: "sess-2", title: "Second session", pinned: true })]);
    const cells = document.querySelectorAll('[role="gridcell"]');
    // 3 cells per row (checkbox, pin, content+rename cells: checkbox, pin,
    // content, rename = 4) — assert every cell individually stays a leaf for
    // interactive nesting purposes (<= 1 focusable descendant, and no cell
    // contains ANOTHER cell/row/grid — the actual failure mode axe flags).
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(focusableDescendants(cell).length).toBeLessThanOrEqual(1);
      expect(cell.querySelector('[role="gridcell"], [role="row"], [role="grid"]')).toBeNull();
    }
  });

  it("the checkbox, pin, and rename buttons are real, keyboard-reachable buttons", async () => {
    const { onTogglePin } = renderPane([makeSession()]);
    const pinButton = screen.getByTitle("Pin");
    const checkboxButton = screen.getByLabelText("Select session");
    const renameButton = screen.getByTitle("Rename");

    for (const btn of [pinButton, checkboxButton, renameButton]) {
      expect(btn.tagName).toBe("BUTTON");
    }

    await userEvent.click(pinButton);
    expect(onTogglePin).toHaveBeenCalledWith("sess-1", true);
  });

  it("clicking the session's open control still opens the session", async () => {
    const { onSelect } = renderPane([makeSession()]);
    await userEvent.click(screen.getByTestId("session"));
    expect(onSelect).toHaveBeenCalledWith("sess-1");
  });

  it("useListKeyboardNav j/Enter navigation still opens a session", async () => {
    const { onSelect } = renderPane([
      makeSession(),
      makeSession({ sessionId: "sess-2", title: "Second session" }),
    ]);
    const grid = screen.getByRole("grid", { name: "Sessions" });
    grid.focus();
    await userEvent.keyboard("j");
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("sess-1");
  });
});

describe("ProjectsPane rows: role=option is a non-focusable leaf", () => {
  it("the option row carries tabIndex=-1 and no focusable descendant", () => {
    const onSelect = vi.fn();
    render(
      createElement(ProjectsPane, {
        projects: [makeProject(), makeProject({ id: "proj-2", name: "second" })],
        selectedId: null,
        onSelect,
      }),
    );
    const options = document.querySelectorAll('[role="option"]');
    expect(options.length).toBe(2);
    for (const option of options) {
      expect(option.getAttribute("tabindex")).toBe("-1");
      expect(focusableDescendants(option)).toHaveLength(0);
    }
  });

  it("useListKeyboardNav j/Enter navigation still selects a project", async () => {
    const onSelect = vi.fn();
    render(
      createElement(ProjectsPane, {
        projects: [makeProject(), makeProject({ id: "proj-2", name: "second" })],
        selectedId: null,
        onSelect,
      }),
    );
    const listbox = screen.getByRole("listbox", { name: "Projects" });
    listbox.focus();
    await userEvent.keyboard("j");
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("proj-1");
  });
});
