// @vitest-environment jsdom
import { createElement } from "react";
import { render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  COMMAND_COPY,
  CommandDialog,
  DEFAULT_COMMANDS,
  type CommandAction,
  type CommandDialogProps,
  describeEscapeRestore,
  describeSearchTasksTransition,
  filterCommands,
  isSearchCommandsApplied,
  isSearchTasksAction,
  resolveSearchCommandsMode,
  visibleCommands,
} from "./CommandDialog.js";

function render(props: CommandDialogProps = {}): string {
  return renderToStaticMarkup(createElement(CommandDialog, props));
}

// --- Separate `Search commands and tasks` palette ------------------------------

describe("CommandDialog — separate Search commands and tasks palette", () => {
  it("titles itself `Search commands and tasks` on a real dialog", () => {
    const html = render();
    expect(COMMAND_COPY.title).toBe("Search commands and tasks");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Search commands and tasks"');
    expect(html).toContain("data-dh-command-dialog");
    // It is NOT the search dialog.
    expect(html).not.toContain("Search tasks and messages");
    expect(html).not.toContain("data-dh-search-dialog");
  });

  it("opens with a focused query (searchbox + autofocus marker)", () => {
    const html = render({ query: "set" });
    expect(html).toContain('role="searchbox"');
    expect(html).toContain("data-dh-command-autofocus");
  });

  it("keeps the approved primary actions with their shortcuts", () => {
    const html = render();
    for (const title of ["New task", "Search tasks", "Toggle inspector", "Open Settings", "Go to Ops"]) {
      expect(html).toContain(title);
    }
    expect(html).toContain("⌘N");
    expect(html).toContain("⌘K");
    expect(html).toContain("⌘⇧I");
    expect(html).toContain("⌘,");
    // The default registry is exactly the five approved rows.
    expect(DEFAULT_COMMANDS.map((c) => c.title)).toEqual([
      "New task",
      "Search tasks",
      "Toggle inspector",
      "Open Settings",
      "Go to Ops",
    ]);
  });

  it("renders no provider logo (no svg/img)", () => {
    const html = render();
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<img");
  });
});

// --- Search tasks transitions to Search, never merged --------------------------

describe("CommandDialog — Search tasks closes Commands and opens Search", () => {
  it("identifies the `Search tasks` action as the open-search transition", () => {
    const searchTasks = DEFAULT_COMMANDS.find((c) => c.id === "search-tasks")!;
    expect(searchTasks.kind).toBe("open-search");
    expect(isSearchTasksAction(searchTasks)).toBe(true);
    expect(isSearchTasksAction(DEFAULT_COMMANDS[0]!)).toBe(false);
  });

  it("describes the transition as close-Commands-then-open-Search, never merged", () => {
    expect(describeSearchTasksTransition()).toEqual({
      closeCommands: true,
      openSearch: true,
      merged: false,
    });
  });

  it("routes the Search tasks row to onSearchTasks, not onRun (no silent provider call)", () => {
    const searchTasks = DEFAULT_COMMANDS.find((c) => c.id === "search-tasks")!;
    let opened = 0;
    let ran: CommandAction | null = null;
    // Exercise the same dispatch the row's click uses.
    const dispatch = (a: CommandAction) => {
      if (isSearchTasksAction(a)) opened += 1;
      else ran = a;
    };
    dispatch(searchTasks);
    expect(opened).toBe(1);
    expect(ran).toBeNull();
    // The row is tagged so the invoker performs the handoff, not an inline merge.
    const html = render();
    expect(html).toContain('data-dh-command-kind="open-search"');
  });
});

// --- Keyboard-active row distinct from scope/date; Escape restores invoker -----

describe("CommandDialog — active row + no scope/date + escape restore", () => {
  it("marks the keyboard-active row and carries NO scope/date facets", () => {
    const html = render({ activeIndex: 2 });
    expect(html).toContain('aria-activedescendant="dh-command-toggle-inspector"');
    expect(html).toMatch(/data-dh-command-row="2"[^>]*aria-selected="true"/);
    expect(html).toMatch(/data-dh-command-row="0"[^>]*aria-selected="false"/);
    // Commands has no scope/date selection to confuse with the active row.
    expect(html).not.toContain("data-dh-search-scope");
    expect(html).not.toContain("data-dh-date-facet");
  });

  it("describes Escape as close + restore focus to the invoker", () => {
    expect(describeEscapeRestore("global-search-button")).toEqual({
      close: true,
      restoreFocusToInvoker: true,
      invoker: "global-search-button",
    });
    expect(describeEscapeRestore(null).invoker).toBeNull();
  });
});

// --- Provider-scoped commands hidden unless capability-valid -------------------

describe("visibleCommands — never offer a silently-cross-provider command", () => {
  const withGated: CommandAction[] = [
    ...DEFAULT_COMMANDS,
    { id: "codex-review", title: "Codex review", kind: "action", providerScoped: true, capable: false },
    { id: "claude-fork", title: "Claude fork", kind: "action", providerScoped: true, capable: true },
  ];

  it("drops a provider-scoped command whose runtime capability is absent", () => {
    const visible = visibleCommands(withGated).map((c) => c.id);
    expect(visible).toContain("claude-fork");
    expect(visible).not.toContain("codex-review");
  });

  it("does not render an incapable provider command", () => {
    const html = render({ commands: withGated });
    expect(html).toContain("Claude fork");
    expect(html).not.toContain("Codex review");
  });
});

// --- Filtering -----------------------------------------------------------------

describe("filterCommands — fuzzy filter over visible commands", () => {
  it("returns every visible command for an empty query", () => {
    expect(filterCommands(DEFAULT_COMMANDS, "").length).toBe(DEFAULT_COMMANDS.length);
  });

  it("subsequence-matches and drops non-matches", () => {
    const ids = filterCommands(DEFAULT_COMMANDS, "ops").map((c) => c.id);
    expect(ids).toContain("go-to-ops");
    expect(filterCommands(DEFAULT_COMMANDS, "zzzz")).toHaveLength(0);
  });

  it("renders the empty state when nothing matches", () => {
    const html = render({ query: "zzzz" });
    expect(html).toContain(COMMAND_COPY.empty);
    expect(html).toContain("data-dh-command-empty");
  });
});

// --- Footer --------------------------------------------------------------------

describe("CommandDialog — footer", () => {
  it("shows the command footer copy `↑↓ navigate` / `↵ run` / `esc close`", () => {
    const html = render();
    expect(html).toContain("↑↓ navigate");
    expect(html).toContain("↵ run");
    expect(html).toContain("esc close");
    // Commands `run`; it does not `open` a search result.
    expect(html).not.toContain("↵ open");
  });
});

// --- Slice-flag gate: flag-off keeps Commands UNMOUNTED (as today) -------------

describe("searchCommands slice-flag gate (Commands)", () => {
  it("shares the searchCommands gate with Search (single flag, separate contracts)", () => {
    expect(resolveSearchCommandsMode({ devHubFeatures: { searchCommands: true } })).toBe("devhub");
    expect(resolveSearchCommandsMode({ devHubFeatures: { searchCommands: false } })).toBe("legacy");
    expect(resolveSearchCommandsMode({})).toBe("devhub");
    expect(resolveSearchCommandsMode(null)).toBe("devhub");
    expect(isSearchCommandsApplied({ searchCommands: true })).toBe(true);
    expect(isSearchCommandsApplied({ searchCommands: false })).toBe(false);
    expect(isSearchCommandsApplied(undefined)).toBe(false);
  });
});

describe("CommandDialog — live interaction (mounted DOM)", () => {
  it("Escape closes the palette", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    rtlRender(createElement(CommandDialog, { onClose }));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking a regular command runs it via onRun", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    rtlRender(createElement(CommandDialog, { onRun }));
    await user.click(screen.getByText("New task"));
    expect(onRun).toHaveBeenCalledWith(DEFAULT_COMMANDS[0]);
  });

  it("clicking Search tasks transitions to Search instead of running it as a normal command", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    const onSearchTasks = vi.fn();
    rtlRender(createElement(CommandDialog, { onRun, onSearchTasks }));
    await user.click(screen.getByText("Search tasks"));
    expect(onSearchTasks).toHaveBeenCalledTimes(1);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("typing filters the visible command rows live", async () => {
    const { rerender } = rtlRender(createElement(CommandDialog, { onQueryChange: vi.fn() }));
    // Unfiltered render shows the full approved primary row set.
    expect(screen.getByText("New task")).toBeInTheDocument();
    expect(screen.getByText("Go to Ops")).toBeInTheDocument();

    rerender(createElement(CommandDialog, { query: "ops", onQueryChange: vi.fn() }));
    expect(screen.getByText("Go to Ops")).toBeInTheDocument();
    expect(screen.queryByText("New task")).not.toBeInTheDocument();
  });

  it("shows the exact empty-state copy when a query matches nothing", () => {
    rtlRender(createElement(CommandDialog, { query: "zzzznomatch" }));
    expect(screen.getByText(COMMAND_COPY.empty)).toBeInTheDocument();
  });
});
