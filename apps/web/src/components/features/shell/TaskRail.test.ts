import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_LOCAL_LABEL,
  TASK_RAIL_COPY,
  TASK_RAIL_GEOMETRY,
  TaskRail,
  type TaskRailModel,
  isTaskRailApplied,
  nextRovingIndex,
  providerIdentity,
  resolveTaskRailMode,
  sanitizeRailKey,
} from "./TaskRail.js";
import { SHELL_GEOMETRY } from "./DevHubShell.js";

/** Count non-overlapping occurrences of a substring. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function render(props: Parameters<typeof TaskRail>[0]): string {
  return renderToStaticMarkup(createElement(TaskRail, props));
}

const twoTaskModel: TaskRailModel = {
  sections: [
    {
      id: "today",
      label: "Today",
      tasks: [
        { id: "t-codex", title: "Wire the gateway", provider: "openai" },
        { id: "t-claude", title: "Refactor the store", provider: "anthropic", active: true },
      ],
    },
  ],
  destinations: [
    { id: "home", label: "Home" },
    { id: "settings", label: "Settings" },
    { id: "hidden", label: "Hidden", reachable: false },
  ],
};

const emptyModel: TaskRailModel = { sections: [], destinations: [] };

describe("TaskRail is an open list (design-lock §4)", () => {
  it("renders task rows as flat list items, not nested cards", () => {
    const html = render({ model: twoTaskModel });
    expect(html).toContain('data-dh-taskrail=""');
    expect(html).toContain('data-dh-open-list=""');
    // Each task is one list item; the two tasks yield exactly two task rows.
    expect(count(html, 'data-dh-task-row=""')).toBe(2);
    // Open list uses list semantics, not card containers.
    expect(count(html, 'role="listitem"')).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain("card");
  });

  it("groups rows under a quiet section heading", () => {
    const html = render({ model: twoTaskModel });
    expect(html).toContain('data-dh-section-heading=""');
    expect(html).toContain(">Today<");
  });

  it("shows the No tasks empty state and the New task action", () => {
    const html = render({ model: emptyModel });
    expect(html).toContain('data-dh-empty=""');
    expect(html).toContain(`>${TASK_RAIL_COPY.noTasks}<`);
    expect(html).toContain(`>${TASK_RAIL_COPY.newTask}<`);
    expect(count(html, 'data-dh-task-row=""')).toBe(0);
  });

  it("never renders a provider logo (no svg/img in the rail)", () => {
    const html = render({ model: twoTaskModel });
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<img");
  });
});

describe("TaskRail selection state (measured 256x30 at 8 inset)", () => {
  it("exposes the measured selected-row geometry as a single source of truth", () => {
    expect(TASK_RAIL_GEOMETRY.selectedRowWidth).toBe(256);
    expect(TASK_RAIL_GEOMETRY.selectedRowHeight).toBe(30);
    expect(TASK_RAIL_GEOMETRY.railInset).toBe(8);
    // Mirrors the shell geometry so the rail and shell never drift.
    expect(TASK_RAIL_GEOMETRY.selectedRowWidth).toBe(SHELL_GEOMETRY.selectedRowWidth);
    expect(TASK_RAIL_GEOMETRY.selectedRowHeight).toBe(SHELL_GEOMETRY.selectedRowHeight);
    expect(TASK_RAIL_GEOMETRY.railInset).toBe(SHELL_GEOMETRY.railInset);
    expect(Object.isFrozen(TASK_RAIL_GEOMETRY)).toBe(true);
  });

  it("marks the selected row with the compact fill dimensions and aria-current", () => {
    const html = render({ model: twoTaskModel, selectedTaskId: "t-codex" });
    expect(count(html, 'data-dh-selected=""')).toBe(1);
    expect(html).toContain(`data-dh-row-width="${TASK_RAIL_GEOMETRY.selectedRowWidth}"`);
    expect(html).toContain(`data-dh-row-height="${TASK_RAIL_GEOMETRY.selectedRowHeight}"`);
    expect(count(html, 'aria-current="page"')).toBe(1);
  });

  it("keeps the selected row height when a quiet active spinner appears", () => {
    // t-claude is active AND selected — its height attribute must equal the resting one.
    const html = render({ model: twoTaskModel, selectedTaskId: "t-claude" });
    expect(html).toContain(`data-dh-row-height="${TASK_RAIL_GEOMETRY.selectedRowHeight}"`);
    expect(html).toContain('data-dh-active=""');
    // The spinner is present but the row still carries the exact fixed height.
    expect(html).toContain("Working");
  });

  it("puts exactly one row in the roving tab order (tabIndex 0)", () => {
    const html = render({ model: twoTaskModel, selectedTaskId: "t-claude" });
    // The selected row is the single roving-tabbable open button; the other is -1.
    expect(html).toContain('data-dh-task-key="t-claude" tabindex="0"');
    expect(html).toContain('data-dh-task-key="t-codex" tabindex="-1"');
  });
});

describe("TaskRail provider identity is quiet text but never absent", () => {
  it("renders the quiet visible suffix and the full accessible name", () => {
    const html = render({ model: twoTaskModel });
    // Quiet visible suffixes.
    expect(html).toContain(">Codex<");
    expect(html).toContain(">Claude<");
    // Full identity in the accessible name (sr-only text inside the row button).
    expect(html).toContain("OpenAI · Codex");
    expect(html).toContain("Anthropic · Claude");
  });

  it("maps each provider to its identity", () => {
    expect(providerIdentity("openai")).toMatchObject({
      org: "OpenAI",
      product: "Codex",
      suffix: "Codex",
      accessibleName: "OpenAI · Codex",
    });
    expect(providerIdentity("anthropic")).toMatchObject({
      org: "Anthropic",
      product: "Claude",
      suffix: "Claude",
      accessibleName: "Anthropic · Claude",
    });
  });

  it("labels DevHub-local archive as local, never as native deletion", () => {
    expect(ARCHIVE_LOCAL_LABEL).toBe("Archive in DevHub");
    expect(TASK_RAIL_COPY.archiveLocal).toBe("Archive in DevHub");
    expect(ARCHIVE_LOCAL_LABEL.toLowerCase()).not.toContain("delete");
  });
});

describe("TaskRail ARIA list structure (M8-PERF-A11Y: axe aria-required-children)", () => {
  it("never marks a section group li role=presentation while it holds a nested role=list", () => {
    // axe-core's aria-required-children rule flags a `role="list"` whose only
    // effective children (after presentation roles are collapsed out of the a11y
    // tree) are themselves a nested `role="list"` — exactly what a
    // `role="presentation"` group wrapper produces here. `role="listitem"` keeps
    // the outer list valid while a nested list inside a listitem stays a
    // standard, allowed ARIA grouping pattern.
    const html = render({ model: twoTaskModel });
    expect(html).toContain('data-dh-section-heading=""');
    expect(html).not.toMatch(/role="presentation"[^>]*class="dh-tasklist-group"/);
    // The section group li that wraps the nested rows list must itself be a
    // valid listitem of the outer role="list" ul.
    const groupStart = html.indexOf('class="dh-tasklist-group"');
    const groupTag = html.slice(Math.max(0, groupStart - 200), groupStart);
    expect(groupTag).toContain('role="listitem"');
  });
});

describe("TaskRail overflow actions and destinations", () => {
  it("renders overflow actions reachable without hover and independently tabbable", () => {
    const html = render({ model: twoTaskModel });
    expect(count(html, 'data-dh-task-actions=""')).toBe(2);
    expect(html).toContain('aria-label="Actions for Wire the gateway"');
    expect(html).toContain('aria-label="Actions for Refactor the store"');
    // Each overflow trigger is in the tab order (tabIndex 0), not hover-gated.
    expect(count(html, 'data-dh-task-actions="" tabindex="0"')).toBe(2);
  });

  it("renders only reachable secondary destinations and never inert ones", () => {
    const destModel: TaskRailModel = {
      sections: [],
      destinations: [
        { id: "home", label: "Home", current: true },
        { id: "settings", label: "Settings" },
        { id: "hidden", label: "Hidden", reachable: false },
      ],
    };
    const html = render({ model: destModel });
    expect(html).toContain('data-dh-destinations=""');
    expect(html).toContain(">Home<");
    expect(html).toContain(">Settings<");
    // The unreachable destination is absent (never rendered disabled/inert).
    expect(html).not.toContain(">Hidden<");
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("aria-disabled");
    // The current destination carries aria-current (no task is selected here).
    expect(count(html, 'aria-current="page"')).toBe(1);
  });
});

describe("TaskRail failure isolation", () => {
  it("marks only the failed provider's rows, never the other provider's", () => {
    const html = render({ model: twoTaskModel, failedProvider: "anthropic" });
    // Exactly one row is flagged failed, with one accessible "Failed" marker.
    expect(count(html, 'data-dh-task-failed=""')).toBe(1);
    expect(count(html, "Failed")).toBe(1);
    // The openai row's button region carries no failure marker.
    const codexButton = html.slice(
      html.indexOf('data-dh-task-key="t-codex"'),
      html.indexOf('data-dh-task-key="t-claude"'),
    );
    expect(codexButton).not.toContain("Failed");
    // Flipping the failed provider flips which row is marked, proving isolation.
    const flipped = render({ model: twoTaskModel, failedProvider: "openai" });
    const claudeButton = flipped.slice(flipped.indexOf('data-dh-task-key="t-claude"'));
    expect(claudeButton).not.toContain("Failed");
  });
});

describe("TaskRail renders no raw-home / NUL in keys or attributes", () => {
  it("sanitizes NUL/control chars and path separators out of rendered keys", () => {
    const nul = String.fromCharCode(0);
    expect(sanitizeRailKey(`a${nul}b`)).toBe("ab");
    expect(sanitizeRailKey("/Users/ronak/.codex/sessions/abc")).not.toContain("/");
    expect(sanitizeRailKey("/Users/ronak/.codex/sessions/abc")).toBe(
      "-Users-ronak-.codex-sessions-abc",
    );
  });

  it("emits no NUL and no raw filesystem home in the rendered markup", () => {
    const nul = String.fromCharCode(0);
    const dirtyModel: TaskRailModel = {
      sections: [
        {
          id: `/Users/ronak/.codex/sessions/${nul}task`,
          label: "Group",
          tasks: [
            {
              id: `/Users/ronak/.codex/sessions/${nul}task`,
              title: "Task one",
              provider: "openai",
            },
          ],
        },
      ],
      destinations: [],
    };
    const html = render({ model: dirtyModel });
    expect(html).not.toContain(nul);
    expect(html).not.toContain("/Users/");
    expect(html).not.toContain(".codex/sessions");
    expect(html).toContain("data-dh-task-key=");
  });
});

describe("nextRovingIndex keyboard math", () => {
  it("moves down/up with Arrow and J/K and wraps", () => {
    expect(nextRovingIndex("ArrowDown", 0, 3)).toBe(1);
    expect(nextRovingIndex("j", 2, 3)).toBe(0);
    expect(nextRovingIndex("ArrowUp", 0, 3)).toBe(2);
    expect(nextRovingIndex("k", 1, 3)).toBe(0);
  });

  it("jumps to Home/End and ignores other keys", () => {
    expect(nextRovingIndex("Home", 2, 3)).toBe(0);
    expect(nextRovingIndex("End", 0, 3)).toBe(2);
    expect(nextRovingIndex("Tab", 1, 3)).toBe(1);
    expect(nextRovingIndex("ArrowDown", 0, 0)).toBe(-1);
  });
});

describe("taskRail slice-flag gate", () => {
  it("defaults to the DevHub rail; only an explicit false taskRail flag selects legacy", () => {
    expect(resolveTaskRailMode({ devHubFeatures: { taskRail: true } })).toBe("devhub");
    expect(resolveTaskRailMode({ devHubFeatures: { taskRail: false } })).toBe("legacy");
    // Missing settings default to the new rail (no legacy first-paint flash).
    expect(resolveTaskRailMode({ devHubFeatures: {} })).toBe("devhub");
    expect(resolveTaskRailMode({})).toBe("devhub");
    expect(resolveTaskRailMode(null)).toBe("devhub");
    expect(resolveTaskRailMode(undefined)).toBe("devhub");
  });

  it("reports applied only when taskRail is explicitly true", () => {
    expect(isTaskRailApplied({ taskRail: true })).toBe(true);
    expect(isTaskRailApplied({ taskRail: false })).toBe(false);
    expect(isTaskRailApplied({})).toBe(false);
    expect(isTaskRailApplied(undefined)).toBe(false);
  });
});
