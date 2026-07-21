// @vitest-environment jsdom
import { createElement, useEffect, useRef, useState } from "react";
import { render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  INSPECTOR_COPY,
  INSPECTOR_DESTINATIONS,
  INSPECTOR_GEOMETRY,
  InspectorDock,
  type InspectorDockProps,
  computeDestinationView,
  describeDestructiveConfirmation,
  isInspectorDockApplied,
  nextTabIndex,
  resolveInspectorDockMode,
  unavailableMessage,
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

/** The persistent Environment summary region markup (a single non-nested <section>). */
function environmentRegion(html: string): string {
  const start = html.indexOf("<section");
  expect(start).toBeGreaterThanOrEqual(0);
  const close = html.indexOf("</section>", start);
  expect(close).toBeGreaterThan(start);
  return html.slice(start, close + "</section>".length);
}

/** The single rendered tabpanel markup. */
function tabPanel(html: string): string {
  const start = html.indexOf('role="tabpanel"');
  expect(start).toBeGreaterThanOrEqual(0);
  const open = html.lastIndexOf("<div", start);
  // The panel is a self-contained <div>…</div>; find its matching close by scanning depth.
  let depth = 0;
  let i = open;
  while (i < html.length) {
    if (html.startsWith("<div", i)) depth++;
    else if (html.startsWith("</div>", i)) {
      depth--;
      if (depth === 0) return html.slice(open, i + "</div>".length);
    }
    i++;
  }
  throw new Error("unbalanced tabpanel");
}

const baseEnv = {
  changes: "2 files · +84 -19",
  branch: "feat/inspector",
  subagents: [],
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
    const tag = dockTag(render({ environment: baseEnv }));
    expect(tag).toContain(`data-dh-inspector-width="${INSPECTOR_GEOMETRY.width}"`);
    expect(tag).toContain(`data-dh-inspector-radius="${INSPECTOR_GEOMETRY.radius}"`);
    expect(tag).toContain(`data-dh-inspector-padding="${INSPECTOR_GEOMETRY.padding}"`);
    // Content-height, NOT a permanent full-height IDE split pane.
    expect(tag).toContain('data-dh-inspector-height-mode="content"');
    expect(tag).not.toContain('height-mode="full"');
    // The dock is the elevated #2d2d2d surface.
    expect(tag).toContain("data-dh-surface");
  });

  it("keeps the dock container tag byte-identical across selected destinations (never resizes)", () => {
    const onDiff = dockTag(render({ environment: baseEnv, selected: "diff" }));
    const onTerminal = dockTag(render({ environment: baseEnv, selected: "terminal" }));
    const onArtifacts = dockTag(render({ environment: baseEnv, selected: "artifacts" }));
    expect(onDiff).toBe(onTerminal);
    expect(onDiff).toBe(onArtifacts);
  });

  it("renders no provider logo (no svg/img)", () => {
    const html = render({
      provider: "openai",
      environment: baseEnv,
      selected: "diff",
      content: { diff: { files: ["a.ts"], summary: "1 file · +1 -0" } },
    });
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<img");
  });
});

// --- Environment summary: persistent, compact, NOT a tab -----------------------

describe("InspectorDock — persistent Environment summary (not a sixth tab)", () => {
  it("renders the Environment heading as a summary region, never a tab", () => {
    const html = render({ environment: baseEnv });
    expect(html).toContain(`>${INSPECTOR_COPY.environmentHeading}<`);
    // The Environment region carries no tab role.
    const env = environmentRegion(html);
    expect(env).not.toContain('role="tab"');
    expect(env).toContain('aria-label="Environment"');
    // M8-PERF-A11Y: axe-core's heading-order rule flagged this as an `<h3>` with
    // no `<h2>` anywhere earlier in the dock's own subtree (an invalid level-2
    // jump). It's the ONLY heading the "dock" variant renders, at the same
    // structural depth as the "disclosure" variant's own top-level `<h2>` — so
    // `<h2>` is correct here, not `<h3>`.
    expect(env).toContain(`<h2 class="dh-inspector-env-heading"`);
    expect(env).not.toContain(`<h3 class="dh-inspector-env-heading"`);
  });

  it("owns only backed environment/repository/subagent/source rows", () => {
    const html = render({
      environment: {
        changes: "2 files · +84 -19",
        branch: "main",
        repoActions: [INSPECTOR_COPY.env.commitOrPush, INSPECTOR_COPY.env.createPullRequest],
        subagents: ["planner"],
        sources: [INSPECTOR_COPY.env.webSearch],
      },
    });
    const env = environmentRegion(html);
    expect(env).toContain("2 files · +84 -19");
    expect(env).toContain("main");
    expect(env).toContain(INSPECTOR_COPY.env.commitOrPush);
    expect(env).toContain("planner");
    expect(env).toContain(INSPECTOR_COPY.env.webSearch);
  });

  it("shows 'No active subagents' when none are backed", () => {
    const env = environmentRegion(render({ environment: { subagents: [] } }));
    expect(env).toContain(INSPECTOR_COPY.env.noSubagents);
  });

  it("keeps the Environment region byte-identical when the selected destination changes", () => {
    const onDiff = environmentRegion(render({ environment: baseEnv, selected: "diff" }));
    const onFiles = environmentRegion(render({ environment: baseEnv, selected: "files" }));
    const onArtifacts = environmentRegion(render({ environment: baseEnv, selected: "artifacts" }));
    expect(onDiff).toBe(onFiles);
    expect(onDiff).toBe(onArtifacts);
  });

  it("places the Environment summary ABOVE the tablist and the panel in DOM order", () => {
    const html = render({ environment: baseEnv, selected: "diff" });
    const envIdx = html.indexOf("data-dh-inspector-env");
    const tablistIdx = html.indexOf('role="tablist"');
    const panelIdx = html.indexOf('role="tabpanel"');
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(envIdx).toBeLessThan(tablistIdx);
    expect(tablistIdx).toBeLessThan(panelIdx);
  });
});

// --- Exactly five destinations + footer ----------------------------------------

describe("InspectorDock — exactly five destinations and the runtime footer", () => {
  it("exposes exactly five tabs Diff/Files/Terminal/Browser/Artifacts, in order", () => {
    expect(INSPECTOR_DESTINATIONS.map((d) => d.label)).toEqual([
      "Diff",
      "Files",
      "Terminal",
      "Browser",
      "Artifacts",
    ]);
    const html = render({ environment: baseEnv });
    expect(count(html, 'role="tab"')).toBe(5);
    for (const d of INSPECTOR_DESTINATIONS) {
      expect(html).toContain(`data-dh-inspector-tab="${d.id}"`);
      expect(html).toContain(`>${d.label}</button>`);
    }
  });

  it("renders the footer 'Availability follows the task runtime'", () => {
    const html = render({ environment: baseEnv });
    expect(html).toContain(INSPECTOR_COPY.footer);
    expect(INSPECTOR_COPY.footer).toBe("Availability follows the task runtime");
  });
});

// --- Tablist + roving focus + tabpanel -----------------------------------------

describe("InspectorDock — tablist roving focus and tabpanel entry", () => {
  it("nextTabIndex moves Left/Right (wrapping) and jumps Home/End", () => {
    expect(nextTabIndex("ArrowRight", 0, 5)).toBe(1);
    expect(nextTabIndex("ArrowRight", 4, 5)).toBe(0); // wraps
    expect(nextTabIndex("ArrowLeft", 0, 5)).toBe(4); // wraps
    expect(nextTabIndex("ArrowLeft", 2, 5)).toBe(1);
    expect(nextTabIndex("Home", 3, 5)).toBe(0);
    expect(nextTabIndex("End", 1, 5)).toBe(4);
    // Any other key holds position; empty tablist is -1.
    expect(nextTabIndex("Enter", 2, 5)).toBe(2);
    expect(nextTabIndex("ArrowRight", 0, 0)).toBe(-1);
  });

  it("marks role=tablist with a single roving-tabbable tab (selected = tabIndex 0)", () => {
    const html = render({ environment: baseEnv, selected: "terminal" });
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-orientation="horizontal"');
    // Exactly one tab is in the tab order.
    expect(count(html, 'tabindex="0"')).toBe(2); // the selected tab + the tabpanel
    // The selected tab is aria-selected and the tabbable one.
    const termTabIdx = html.indexOf('data-dh-inspector-tab="terminal"');
    const termTag = html.slice(html.lastIndexOf("<button", termTabIdx), html.indexOf(">", termTabIdx) + 1);
    expect(termTag).toContain('aria-selected="true"');
    expect(termTag).toContain('tabindex="0"');
  });

  it("only the selected tab has aria-selected=true; the other four are false", () => {
    const html = render({ environment: baseEnv, selected: "browser" });
    expect(count(html, 'aria-selected="true"')).toBe(1);
    expect(count(html, 'aria-selected="false"')).toBe(4);
  });

  it("puts the tabpanel in the tab order and labels it by the selected tab so Tab enters it", () => {
    const html = render({ environment: baseEnv, selected: "files" });
    const panel = tabPanel(html);
    expect(panel).toContain('role="tabpanel"');
    expect(panel).toContain('tabindex="0"');
    expect(panel).toContain('aria-labelledby="dh-inspector-tab-files"');
    expect(panel).toContain('id="dh-inspector-panel-files"');
    // And the tab points at the panel.
    expect(html).toContain('aria-controls="dh-inspector-panel-files"');
  });

  it("renders exactly ONE destination panel (only the selected one)", () => {
    const html = render({ environment: baseEnv, selected: "diff" });
    expect(count(html, 'role="tabpanel"')).toBe(1);
    expect(html).toContain('data-dh-inspector-panel="diff"');
    expect(html).not.toContain('data-dh-inspector-panel="files"');
    expect(html).not.toContain('data-dh-inspector-panel="terminal"');
  });
});

// --- Runtime-gated availability -------------------------------------------------

describe("InspectorDock — runtime-gated destination views", () => {
  it("resolves unsupported → unavailable, disconnected → cached, empty artifacts → empty", () => {
    expect(computeDestinationView("diff", { supported: false })).toEqual({
      kind: "unavailable",
      cause: undefined,
    });
    expect(computeDestinationView("diff", { supported: false, cause: "Review not enabled" })).toEqual({
      kind: "unavailable",
      cause: "Review not enabled",
    });
    expect(computeDestinationView("files", { connection: "disconnected" })).toEqual({ kind: "cached" });
    expect(computeDestinationView("files", { connection: "stale" })).toEqual({ kind: "cached" });
    // Empty artifacts is a distinct state, NOT unsupported.
    expect(computeDestinationView("artifacts", { hasContent: false })).toEqual({ kind: "empty" });
    expect(computeDestinationView("artifacts", { hasContent: true })).toEqual({ kind: "content" });
    // Default (all supported/connected) is live content.
    expect(computeDestinationView("terminal", undefined)).toEqual({ kind: "content" });
  });

  it("unsupported takes precedence over disconnected", () => {
    expect(
      computeDestinationView("browser", { supported: false, connection: "disconnected" }).kind,
    ).toBe("unavailable");
  });

  it("shows 'Not available for this task' for a gated destination (with cause when useful)", () => {
    const gated = render({
      environment: baseEnv,
      selected: "browser",
      runtime: { browser: { supported: false } },
    });
    expect(gated).toContain(INSPECTOR_COPY.notAvailable);
    expect(gated).toContain("data-dh-inspector-unavailable");

    const withCause = render({
      environment: baseEnv,
      selected: "diff",
      runtime: { diff: { supported: false, cause: "Codex review not product-enabled" } },
    });
    expect(withCause).toContain("Not available for this task — Codex review not product-enabled");
    expect(unavailableMessage()).toBe("Not available for this task");
    expect(unavailableMessage("cause")).toBe("Not available for this task — cause");
  });

  it("shows 'No artifacts' (distinct from unsupported) for empty but supported Artifacts", () => {
    const html = render({
      environment: baseEnv,
      selected: "artifacts",
      runtime: { artifacts: { hasContent: false } },
      content: { artifacts: [] },
    });
    expect(html).toContain(INSPECTOR_COPY.noArtifacts);
    expect(html).toContain("data-dh-inspector-no-artifacts");
    // It is NOT the unsupported message.
    expect(html).not.toContain(INSPECTOR_COPY.notAvailable);
    expect(INSPECTOR_COPY.noArtifacts).not.toBe(INSPECTOR_COPY.notAvailable);
  });

  it("populated Artifacts lists label+source from real events", () => {
    const html = render({
      environment: baseEnv,
      selected: "artifacts",
      runtime: { artifacts: { hasContent: true } },
      content: { artifacts: [{ label: "Build report", source: "ci" }, { label: "Screenshot", source: "browser" }] },
    });
    expect(html).toContain("Build report");
    expect(html).toContain("Screenshot");
    expect(html).not.toContain(INSPECTOR_COPY.noArtifacts);
  });
});

// --- Terminal: provider output only, never an unsandboxed shell ----------------

describe("InspectorDock — Terminal is provider-emitted output only", () => {
  it("renders provider output with no input/prompt and never invokes an unsandboxed shell", () => {
    const html = render({
      environment: baseEnv,
      selected: "terminal",
      content: { terminal: ["pnpm test", "622 passed"] },
    });
    const panel = tabPanel(html);
    expect(panel).toContain("pnpm test");
    expect(panel).toContain("622 passed");
    // No interactive shell input anywhere in the terminal panel.
    expect(panel).not.toContain("<input");
    expect(panel).not.toContain("<textarea");
    expect(panel).not.toContain("<button");
    // Never references the raw shell-command tool.
    expect(html.toLowerCase()).not.toContain("shellcommand");
    expect(html).not.toContain("thread/shellCommand");
  });

  it("an empty terminal is honestly unavailable, not a fabricated shell prompt", () => {
    const html = render({ environment: baseEnv, selected: "terminal", content: { terminal: [] } });
    const panel = tabPanel(html);
    expect(panel).toContain(INSPECTOR_COPY.notAvailable);
    expect(panel).not.toContain("$ ");
  });
});

// --- Browser: only a real browser runtime --------------------------------------

describe("InspectorDock — Browser updates only from a real browser runtime", () => {
  it("shows page/url only when real browser activity exists, else unavailable", () => {
    const withActivity = render({
      environment: baseEnv,
      selected: "browser",
      content: { browser: { title: "Docs", url: "https://example.test/docs" } },
    });
    expect(withActivity).toContain("Docs");
    expect(withActivity).toContain("https://example.test/docs");

    const noActivity = render({ environment: baseEnv, selected: "browser", content: { browser: {} } });
    expect(tabPanel(noActivity)).toContain(INSPECTOR_COPY.notAvailable);
  });
});

// --- Disconnected: cached read --------------------------------------------------

describe("InspectorDock — disconnected panels read cached", () => {
  it("shows the cached note when the panel's transport is disconnected", () => {
    const html = render({
      environment: baseEnv,
      selected: "diff",
      runtime: { diff: { connection: "disconnected" } },
      content: { diff: { files: ["packages/engine/src/providers/types.ts"], summary: "1 file · +4 -1" } },
    });
    expect(html).toContain(INSPECTOR_COPY.cachedNote);
    expect(html).toContain("data-dh-inspector-cached");
    expect(INSPECTOR_COPY.cachedNote).toBe("Showing cached data — reconnect to refresh.");
    // The cached content is still readable.
    expect(html).toContain("packages/engine/src/providers/types.ts");
  });
});

// --- Destructive actions: explicit confirmation, never in a tab ----------------

describe("InspectorDock — destructive actions are confirmed outside the tab", () => {
  it("describes a discard/unstage/worktree-deletion confirmation with focus on Cancel", () => {
    const c = describeDestructiveConfirmation("delete-worktree", "wip/inspector");
    expect(c.rendersInTab).toBe(false);
    expect(c.initialFocus).toBe("cancel");
    expect(c.cancelLabel).toBe("Cancel");
    expect(c.target).toBe("wip/inspector");
    // Names the target and states the provider task is unaffected.
    expect(c.title).toContain("wip/inspector");
    expect(c.body.toLowerCase()).toContain("provider task is unaffected");
    expect(describeDestructiveConfirmation("discard", "a.ts").title).toContain("Discard");
    expect(describeDestructiveConfirmation("unstage", "b.ts").title).toContain("Unstage");
  });

  it("never renders a destructive control inside any destination tabpanel", () => {
    for (const dest of INSPECTOR_DESTINATIONS.map((d) => d.id)) {
      const html = render({
        environment: baseEnv,
        selected: dest,
        content: {
          diff: { files: ["a.ts"], summary: "1 file · +1 -0", lines: ["+ added"] },
          files: [{ path: "a.ts", selected: true }],
          terminal: ["pnpm test"],
          browser: { title: "t", url: "u" },
          artifacts: [{ label: "Build report", source: "ci" }],
        },
      });
      const panel = tabPanel(html);
      for (const banned of ["Discard", "Unstage", "Delete worktree", "delete-worktree"]) {
        expect(panel).not.toContain(banned);
      }
    }
  });
});

// --- ScrollArea only inside a bounded diff -------------------------------------

describe("InspectorDock — ScrollArea only inside a bounded diff", () => {
  it("only the diff panel carries a scroll region", () => {
    const diff = render({
      environment: baseEnv,
      selected: "diff",
      content: { diff: { files: ["a.ts"], lines: ["+ a", "- b"], summary: "1 file · +1 -1" } },
    });
    expect(diff).toContain("data-dh-diff-scroll");

    for (const dest of ["files", "terminal", "browser", "artifacts"] as const) {
      const html = render({
        environment: baseEnv,
        selected: dest,
        content: {
          files: [{ path: "a.ts" }],
          terminal: ["pnpm test"],
          browser: { title: "t", url: "u" },
          artifacts: [{ label: "Build report", source: "ci" }],
        },
      });
      expect(tabPanel(html)).not.toContain("data-dh-diff-scroll");
    }
  });
});

// --- Narrow / PWA disclosure ----------------------------------------------------

describe("InspectorDock — narrow/PWA disclosure variant", () => {
  it("renders a titled 'Desktop required for terminal and diff' disclosure, not the full dock", () => {
    const html = render({ environment: baseEnv, variant: "disclosure", label: "Task inspector" });
    expect(html).toContain(INSPECTOR_COPY.desktopRequired);
    expect(INSPECTOR_COPY.desktopRequired).toBe("Desktop required for terminal and diff");
    // A title is present.
    expect(html).toContain("data-dh-inspector-disclosure-title");
    expect(html).toContain(">Task inspector<");
    // NOT the full desktop dock: no tablist, no terminal panel.
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tabpanel"');
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

/** A stateful host: owns `selected` and moves real DOM focus to the newly-active tab —
 * the roving-focus behavior a live host layers on top of InspectorDock's pure wiring. */
function RovingDock({ onSelect }: { onSelect?: (id: string) => void }) {
  const [selected, setSelected] = useState<InspectorDockProps["selected"]>("diff");
  const tablistRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = tablistRef.current?.querySelector<HTMLElement>('[role="tab"][tabindex="0"]');
    active?.focus();
  }, [selected]);
  return createElement(
    "div",
    { ref: tablistRef },
    createElement(InspectorDock, {
      selected,
      onSelectDestination: (id) => {
        setSelected(id);
        onSelect?.(id);
      },
    }),
  );
}

describe("InspectorDock — live interaction (mounted DOM, roving tablist)", () => {
  it("clicking a tab selects it and switches the visible tabpanel", async () => {
    const user = userEvent.setup();
    rtlRender(createElement(RovingDock));
    await user.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("data-dh-inspector-panel", "files");
  });

  it("ArrowRight/ArrowLeft roves focus and selection across the five destinations, wrapping at the ends", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    rtlRender(createElement(RovingDock, { onSelect }));

    const diffTab = screen.getByRole("tab", { name: "Diff" });
    diffTab.focus();
    expect(diffTab).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(onSelect).toHaveBeenLastCalledWith("files");
    expect(screen.getByRole("tab", { name: "Files" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Diff" })).toHaveAttribute("tabindex", "-1");

    // Left from Files wraps back to Diff... then Left again wraps to the last (Artifacts).
    await user.keyboard("{ArrowLeft}");
    expect(onSelect).toHaveBeenLastCalledWith("diff");
    await user.keyboard("{ArrowLeft}");
    expect(onSelect).toHaveBeenLastCalledWith("artifacts");
    expect(screen.getByRole("tab", { name: "Artifacts" })).toHaveFocus();
  });

  it("Home/End jump focus+selection to the first/last destination", async () => {
    const user = userEvent.setup();
    rtlRender(createElement(RovingDock));
    screen.getByRole("tab", { name: "Files" }).focus();

    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Artifacts" })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("data-dh-inspector-panel", "artifacts");

    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Diff" })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("data-dh-inspector-panel", "diff");
  });

  it("only ever exposes exactly one tab (tabIndex 0) in the roving tab order at a time", async () => {
    const user = userEvent.setup();
    rtlRender(createElement(RovingDock));
    const tablist = screen.getByRole("tablist");
    await user.click(within(tablist).getByRole("tab", { name: "Terminal" }));
    const zeroTabIndex = within(tablist)
      .getAllByRole("tab")
      .filter((t) => t.getAttribute("tabindex") === "0");
    expect(zeroTabIndex).toHaveLength(1);
    expect(zeroTabIndex[0]).toHaveTextContent("Terminal");
  });
});
