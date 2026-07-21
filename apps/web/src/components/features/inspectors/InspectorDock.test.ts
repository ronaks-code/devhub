// @vitest-environment jsdom
import { createElement } from "react";
import { render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  INSPECTOR_COPY,
  INSPECTOR_GEOMETRY,
  InspectorDock,
  type InspectorDockProps,
  isInspectorDockApplied,
  nextTabIndex,
  resolveInspectorDockMode,
} from "./InspectorDock.js";
import { SHELL_GEOMETRY } from "../shell/DevHubShell.js";

function render(props: InspectorDockProps): string {
  return renderToStaticMarkup(createElement(InspectorDock, props));
}

/** Count non-overlapping occurrences of a substring. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The geometry-bearing dock container opening tag. */
function dockTag(html: string): string {
  const start = html.indexOf('<div class="dh-inspector dh-inspector-dock"');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = html.indexOf(">", start);
  return html.slice(start, end + 1);
}

const baseWorktree = {
  branch: "feat/inspector",
  base: "from main @ 9f3c2ea",
  project: "devhub",
  changesSummary: "2 files · +84 -19",
};

// --- Geometry: one measured content-height dock --------------------------------

describe("InspectorDock — measured content-height dock", () => {
  it("mirrors the shell's inspector geometry from a single frozen source", () => {
    expect(INSPECTOR_GEOMETRY.width).toBe(SHELL_GEOMETRY.inspectorWidth);
    expect(INSPECTOR_GEOMETRY.laneWidth).toBe(SHELL_GEOMETRY.inspectorLaneWidth);
    expect(INSPECTOR_GEOMETRY.topGutter).toBe(SHELL_GEOMETRY.inspectorTopGutter);
    expect(INSPECTOR_GEOMETRY.rightGutter).toBe(SHELL_GEOMETRY.inspectorRightGutter);
    expect(INSPECTOR_GEOMETRY.radius).toBe(SHELL_GEOMETRY.inspectorRadius);
    expect(INSPECTOR_GEOMETRY.width).toBe(300);
    expect(INSPECTOR_GEOMETRY.padding).toBe(16);
    expect(INSPECTOR_GEOMETRY.topGutter).toBe(12);
    expect(INSPECTOR_GEOMETRY.rightGutter).toBe(16);
    expect(Object.isFrozen(INSPECTOR_GEOMETRY)).toBe(true);
  });

  it("writes 300 width / 16 radius / 16 padding as constant data attrs and is content-height", () => {
    const tag = dockTag(render({ worktree: baseWorktree }));
    expect(tag).toContain(`data-dh-inspector-width="${INSPECTOR_GEOMETRY.width}"`);
    expect(tag).toContain(`data-dh-inspector-radius="${INSPECTOR_GEOMETRY.radius}"`);
    expect(tag).toContain(`data-dh-inspector-padding="${INSPECTOR_GEOMETRY.padding}"`);
    expect(tag).toContain('data-dh-inspector-height-mode="content"');
    expect(tag).not.toContain('height-mode="full"');
    expect(tag).toContain("data-dh-surface");
  });

  it("keeps the dock container tag byte-identical as its section data changes (never resizes)", () => {
    const empty = dockTag(render({}));
    const full = dockTag(
      render({ worktree: baseWorktree, session: { model: "opus" }, changedFiles: [{ path: "a.ts" }] }),
    );
    expect(empty).toBe(full);
  });

  it("renders no provider logo (no svg/img)", () => {
    const html = render({
      provider: "openai",
      worktree: baseWorktree,
      session: { model: "gpt-5" },
      changedFiles: [{ path: "a.ts", added: 1 }],
    });
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<img");
    // Provider identity is quiet screen-reader text, never a visible logo.
    expect(html).toContain('data-dh-inspector-provider="openai"');
  });

  it("renders exactly three sections in order: worktree, session, changed-files", () => {
    const html = render({ worktree: baseWorktree });
    const wt = html.indexOf('data-dh-inspector-section="worktree"');
    const ss = html.indexOf('data-dh-inspector-section="session"');
    const cf = html.indexOf('data-dh-inspector-section="changed-files"');
    expect(wt).toBeGreaterThanOrEqual(0);
    expect(wt).toBeLessThan(ss);
    expect(ss).toBeLessThan(cf);
    // No diff-forward UI: never a diff viewer / terminal / browser panel.
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tabpanel"');
    expect(html).not.toContain("dh-inspector-diff-scroll");
  });
});

// --- WORKTREE section -----------------------------------------------------------

describe("InspectorDock — WORKTREE section", () => {
  it("shows the branch, base/project subline and change summary when backed", () => {
    const html = render({ worktree: baseWorktree });
    expect(html).toContain(`>${INSPECTOR_COPY.worktreeHeading}<`);
    expect(html).toContain("feat/inspector");
    expect(html).toContain("from main @ 9f3c2ea");
    expect(html).toContain("devhub");
    expect(html).toContain("2 files · +84 -19");
  });

  it("shows a quiet 'no worktree' state (never a fake branch) when nothing is backed", () => {
    const html = render({});
    expect(html).toContain("data-dh-worktree-none");
    expect(html).toContain(INSPECTOR_COPY.noWorktreeSuffix);
    // Defaults to the honest `main` label, not a fabricated worktree name.
    expect(html).toContain("main");
    expect(html).not.toContain("data-dh-worktree-changes");
  });

  it("prefixes wt/ and flags the worktree when isWorktree is set", () => {
    const html = render({ worktree: { branch: "eye2-hotplug", isWorktree: true } });
    expect(html).toContain("wt/eye2-hotplug");
    expect(html).toContain("data-dh-worktree");
  });
});

// --- SESSION section ------------------------------------------------------------

describe("InspectorDock — SESSION section (backed rows only)", () => {
  it("renders only the session rows that are backed", () => {
    const html = render({
      session: { model: "claude-opus-4-8", permissionMode: "acceptEdits", cost: "$4.87" },
    });
    expect(html).toContain(`>${INSPECTOR_COPY.sessionHeading}<`);
    expect(html).toContain('data-dh-session-row="model"');
    expect(html).toContain("claude-opus-4-8");
    expect(html).toContain('data-dh-session-row="permission"');
    expect(html).toContain('data-dh-session-row="cost"');
    expect(html).toContain("$4.87");
    // Unbacked rows do not render (no tokens/started/duration here).
    expect(html).not.toContain('data-dh-session-row="tokens"');
    expect(html).not.toContain('data-dh-session-row="started"');
  });

  it("shows a quiet placeholder when no session state is backed", () => {
    const html = render({ worktree: baseWorktree });
    expect(html).toContain("data-dh-session-none");
  });
});

// --- CHANGED FILES section ------------------------------------------------------

describe("InspectorDock — CHANGED FILES section (names + deltas, no diff hunks)", () => {
  it("lists each changed file path with its +/- deltas", () => {
    const html = render({
      changedFiles: [
        { path: "packages/engine/src/types.ts", added: 12, removed: 3 },
        { path: "apps/web/src/App.tsx", added: 4 },
      ],
    });
    expect(html).toContain(`>${INSPECTOR_COPY.changedFilesHeading}<`);
    expect(html).toContain("packages/engine/src/types.ts");
    expect(html).toContain("+12");
    expect(html).toContain("-3");
    expect(html).toContain("apps/web/src/App.tsx");
    // Never a diff hunk — just the deltas.
    expect(html).not.toContain("dh-inspector-diff");
  });

  it("shows 'No changes' when the changed-files list is empty", () => {
    const html = render({ changedFiles: [] });
    expect(html).toContain(INSPECTOR_COPY.noChanges);
    expect(html).toContain("data-dh-changed-none");
  });

  it("renders file rows as buttons and fires onOpenFile on click", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    rtlRender(
      createElement(InspectorDock, {
        changedFiles: [{ path: "a.ts", added: 1 }],
        onOpenFile,
      }),
    );
    await user.click(screen.getByRole("button", { name: /a\.ts/ }));
    expect(onOpenFile).toHaveBeenCalledWith("a.ts");
  });

  it("renders file rows as plain text (not buttons) when no onOpenFile handler is given", () => {
    const html = render({ changedFiles: [{ path: "a.ts" }] });
    expect(html).toContain('data-dh-file="a.ts"');
    expect(html).not.toContain("dh-inspector-file--action");
  });
});

// --- Narrow / PWA disclosure ----------------------------------------------------

describe("InspectorDock — narrow/PWA disclosure variant", () => {
  it("renders a titled desktop-required disclosure, not the full dock", () => {
    const html = render({ variant: "disclosure", label: "Task inspector" });
    expect(html).toContain(INSPECTOR_COPY.desktopRequired);
    expect(html).toContain("data-dh-inspector-disclosure-title");
    expect(html).toContain(">Task inspector<");
    // NOT the full desktop dock.
    expect(html).not.toContain("dh-inspector-dock");
    expect(html).not.toContain('data-dh-inspector-section="worktree"');
  });
});

// --- Slice flag: flag-off never instantiates the dock --------------------------

describe("inspectorDock slice-flag gate", () => {
  it("mounts the dock only for a resolved true inspectorDock flag", () => {
    expect(resolveInspectorDockMode({ devHubFeatures: { inspectorDock: true } })).toBe("devhub");
    expect(resolveInspectorDockMode({ devHubFeatures: { inspectorDock: false } })).toBe("legacy");
    expect(resolveInspectorDockMode({ devHubFeatures: {} })).toBe("devhub");
    expect(resolveInspectorDockMode({})).toBe("devhub");
    expect(resolveInspectorDockMode(null)).toBe("devhub");
    expect(resolveInspectorDockMode(undefined)).toBe("devhub");
  });

  it("reports applied only when inspectorDock is explicitly true", () => {
    expect(isInspectorDockApplied({ inspectorDock: true })).toBe(true);
    expect(isInspectorDockApplied({ inspectorDock: false })).toBe(false);
    expect(isInspectorDockApplied({})).toBe(false);
    expect(isInspectorDockApplied(undefined)).toBe(false);
  });
});

// --- nextTabIndex stays the shared roving-focus helper (settings-ui reuses it) ---

describe("nextTabIndex — shared roving-focus math", () => {
  it("moves Left/Right (wrapping) and jumps Home/End", () => {
    expect(nextTabIndex("ArrowRight", 0, 5)).toBe(1);
    expect(nextTabIndex("ArrowRight", 4, 5)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, 5)).toBe(4);
    expect(nextTabIndex("ArrowLeft", 2, 5)).toBe(1);
    expect(nextTabIndex("Home", 3, 5)).toBe(0);
    expect(nextTabIndex("End", 1, 5)).toBe(4);
    expect(nextTabIndex("Enter", 2, 5)).toBe(2);
    expect(nextTabIndex("ArrowRight", 0, 0)).toBe(-1);
  });
});

describe("InspectorDock — single dock container", () => {
  it("renders exactly one dock container", () => {
    expect(count(render({ worktree: baseWorktree }), 'data-dh-inspector-dock=""')).toBe(1);
  });
});
