// @vitest-environment jsdom
import { createElement, createRef, useEffect, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  TopBar,
  dismissWorkModeOverlay,
  openHeaderOverlay,
  toggleWorkModeOverlay,
  useWorkModeEscapeDismiss,
} from "./App.js";
import { WorkModePanel, type WorkModeTaskView } from "./components/features/shell/WorkModePanel.js";

const TASK: WorkModeTaskView = {
  title: "Prepare release audit",
  folderScope: "/active/claude-ui",
  outcome: { summary: "Ship", current: 1, total: 2 },
  deliverables: [],
};

function topBarProps(overrides: Record<string, unknown> = {}) {
  return {
    tab: "home" as const,
    onTab: vi.fn(),
    onOpenSearch: vi.fn(),
    onOpenCommands: vi.fn(),
    onOpenShortcuts: vi.fn(),
    perfPreference: "auto" as const,
    perfReduced: false,
    onCyclePerf: vi.fn(),
    themePreference: "dark" as const,
    theme: "dark" as const,
    onCycleTheme: vi.fn(),
    progress: null,
    sessionCount: 12,
    projectCount: 3,
    recents: [],
    onOpenRecent: vi.fn(),
    onClearRecents: vi.fn(),
    onBeforeOpenRecent: vi.fn(),
    projectSessions: [],
    projectName: "DevHub",
    workModeAvailable: false,
    workModeOpen: false,
    onToggleWorkMode: vi.fn(),
    workModeTriggerRef: createRef<HTMLButtonElement>(),
    ...overrides,
  };
}

describe("TopBar navigation and utilities", () => {
  it("does not duplicate rail destinations while preserving top-bar utilities", () => {
    render(createElement(TopBar, topBarProps({
      recents: [{ sessionId: "s1", title: "Release audit", projectId: "p1", openedAt: Date.now() }],
    })));
    expect(screen.queryByRole("navigation", { name: "Primary views" })).toBeNull();
    for (const route of ["Home", "Browse", "Chat", "Ops", "Inbox", "Dashboard"]) {
      expect(screen.queryByRole("button", { name: route })).toBeNull();
    }
    expect(screen.getByRole("button", { name: /search/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /command palette/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Motion: auto" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Theme: dark" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /keyboard shortcuts/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("12 sessions")).toBeInTheDocument();
    expect(screen.getByText("3 projects")).toBeInTheDocument();
  });

  it("shows the gated Work trigger outside hidden utility chrome and reflects its open state", async () => {
    const onToggleWorkMode = vi.fn();
    const { rerender } = render(createElement(TopBar, topBarProps({ workModeAvailable: true, onToggleWorkMode })));
    const trigger = screen.getByRole("button", { name: "Work mode" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger.closest('[class~="lg:flex"]')).toBeNull();
    await userEvent.setup().click(trigger);
    expect(onToggleWorkMode).toHaveBeenCalledOnce();

    rerender(createElement(TopBar, topBarProps({ workModeAvailable: true, workModeOpen: true })));
    expect(screen.getByRole("button", { name: "Work mode" })).toHaveAttribute("aria-expanded", "true");
  });

  it("gives the Recent header popover topmost ownership before opening", async () => {
    const onBeforeOpenRecent = vi.fn();
    render(createElement(TopBar, topBarProps({
      workModeAvailable: true,
      workModeOpen: true,
      onBeforeOpenRecent,
      recents: [{ sessionId: "s1", title: "Release audit", projectId: "p1", openedAt: Date.now() }],
    })));
    await userEvent.setup().click(screen.getByRole("button", { name: "Recent" }));
    expect(onBeforeOpenRecent).toHaveBeenCalledOnce();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("closes an open Search overlay before opening Work", async () => {
    function ReverseOverlayHarness() {
      const [workOpen, setWorkOpen] = useState(false);
      const [searchOpen, setSearchOpen] = useState(true);
      return createElement(
        "div",
        null,
        createElement(TopBar, topBarProps({
          workModeAvailable: true,
          workModeOpen: workOpen,
          onToggleWorkMode: () => toggleWorkModeOverlay(
            workOpen,
            setWorkOpen,
            () => setSearchOpen(false),
          ),
        })),
        searchOpen ? createElement("div", { role: "dialog" }, "Search dialog") : null,
        workOpen ? createElement("div", { "data-testid": "work-overlay" }) : null,
      );
    }

    render(createElement(ReverseOverlayHarness));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Work mode" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("work-overlay")).toBeInTheDocument();
    const workTrigger = screen.getByRole("button", { name: "Work mode" });
    expect(workTrigger).toHaveFocus();

    await user.click(workTrigger);
    expect(screen.queryByTestId("work-overlay")).toBeNull();
    expect(workTrigger).toHaveFocus();
  });
});

describe("Work overlay dismissal", () => {
  function Harness() {
      const [open, setOpen] = useState(true);
      const triggerRef = createRef<HTMLButtonElement>();
      const dismiss = () => dismissWorkModeOverlay(setOpen, triggerRef);
      useWorkModeEscapeDismiss(open, dismiss);
      return createElement(
        "div",
        null,
        createElement("button", { ref: triggerRef, type: "button" }, "Work mode"),
        open
          ? createElement(WorkModePanel, {
              enabled: true,
              task: TASK,
              onDismiss: dismiss,
            })
          : null,
      );
  }

  it("removes the overlay and restores focus to its trigger when Code dismisses", async () => {
    render(createElement(Harness));
    await userEvent.setup().click(screen.getByRole("tab", { name: "Code" }));
    expect(screen.queryByRole("tab", { name: "Code" })).toBeNull();
    expect(screen.getByRole("button", { name: "Work mode" })).toHaveFocus();
  });

  it("removes the overlay and restores focus to its trigger when Escape dismisses", async () => {
    render(createElement(Harness));
    await userEvent.setup().keyboard("{Escape}");
    expect(screen.queryByRole("tab", { name: "Code" })).toBeNull();
    expect(screen.getByRole("button", { name: "Work mode" })).toHaveFocus();
  });

  it("lets the topmost header overlay own Escape without restoring focus to Work", async () => {
    const onWorkDismiss = vi.fn();

    function OverlayHarness() {
      const [workOpen, setWorkOpen] = useState(true);
      const [searchOpen, setSearchOpen] = useState(false);
      const triggerRef = createRef<HTMLButtonElement>();
      useEffect(() => {
        if (!searchOpen) return;
        const closeSearch = (event: KeyboardEvent) => {
          if (event.key === "Escape") setSearchOpen(false);
        };
        window.addEventListener("keydown", closeSearch);
        return () => window.removeEventListener("keydown", closeSearch);
      }, [searchOpen]);
      useWorkModeEscapeDismiss(
        workOpen && !searchOpen,
        () => {
          onWorkDismiss();
          dismissWorkModeOverlay(setWorkOpen, triggerRef);
        },
      );
      return createElement(
        "div",
        null,
        createElement("button", { ref: triggerRef, type: "button" }, "Work mode"),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => openHeaderOverlay(setWorkOpen, () => setSearchOpen(true)),
          },
          "Search",
        ),
        workOpen ? createElement("div", { "data-testid": "work-overlay" }) : null,
        searchOpen ? createElement("div", { role: "dialog" }, "Search dialog") : null,
      );
    }

    render(createElement(OverlayHarness));
    const user = userEvent.setup();
    const searchTrigger = screen.getByRole("button", { name: "Search" });
    await user.click(searchTrigger);
    expect(screen.queryByTestId("work-overlay")).toBeNull();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(searchTrigger).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onWorkDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Work mode" })).not.toHaveFocus();
  });
});
