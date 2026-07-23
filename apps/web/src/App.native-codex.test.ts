// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PaneFallback,
  codexNavPresentation,
  isLatestSettingsResponse,
  nativeClaudePreferredTaskId,
  nativeClaudeHomeFromSessionFile,
  nativeLoadFailureMessage,
  nativePaneRouteKey,
  navigationAriaCurrent,
  resolveClaudeShellMode,
  resolveCodexShellMode,
  TOP_BAR_SECONDARY_CLASS,
  type CodexShellMode,
} from "./App.js";
import App from "./App.js";
import { api, type AppSettings } from "./lib/api.js";
import { providerApi, type ProviderCapabilities } from "./lib/provider-api.js";

const loadHomeDataMock = vi.hoisted(() => vi.fn());
const chatPaneTracker = vi.hoisted(() => ({ mounts: 0 }));

vi.mock("./lib/home-data.js", () => ({ loadHomeData: loadHomeDataMock }));
vi.mock("./components/ChatPane.js", async () => {
  const { createElement: element, useState } = await import("react");
  return {
    ChatPane: ({ initialSessionId }: { initialSessionId?: string }) => {
      const [instance] = useState(() => ++chatPaneTracker.mounts);
      return element("div", {
        "data-testid": "fresh-claude-chat",
        "data-instance": String(instance),
        "data-session-id": initialSessionId ?? "",
      });
    },
  };
});

const FEATURES = {
  nativeCodex: true,
  persistentClaude: false,
  unifiedTaskIndex: true,
  shellChrome: false,
  taskRail: true,
  taskHeaderSetup: false,
  threadWorkspace: false,
  composerSurface: false,
  inspectorDock: false,
  searchCommands: false,
  settingsSecondary: false,
  codexStyleShell: false,
  crossProviderFork: false,
  workMode: false,
} as const;

const CAPABILITIES: ProviderCapabilities = {
  list: true,
  read: true,
  start: true,
  resume: true,
  fork: true,
  send: true,
  steer: false,
  interrupt: true,
  subscribe: true,
  approveCommand: false,
  approveFileChange: false,
  approvePermissions: false,
  requestUserInput: false,
  mcpElicitation: false,
  archive: true,
  rename: true,
  skills: false,
  plugins: false,
  hooks: false,
  mcp: false,
  backgroundWork: false,
};

const PROJECT = {
  id: "project-1",
  cwd: "/workspace/project-1",
  name: "Project One",
  sessionCount: 0,
  lastActivity: null,
  totalUsage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
  encodedFolders: [],
  favorite: false,
  archived: false,
  sortOrder: 0,
  color: null,
  defaultModel: null,
  defaultPermissionMode: null,
};

function settingsFor(defaultMechanics: "claude" | "codex"): AppSettings {
  return {
    defaultMechanics,
    devHubFeatures: FEATURES,
    requestedDevHubFeatures: FEATURES,
  };
}

describe("App New Task dispatch", () => {
  beforeEach(() => {
    cleanup();
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => { values.delete(key); },
      setItem: (key, value) => { values.set(key, String(value)); },
    };
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
    vi.stubGlobal("localStorage", storage);
    window.history.replaceState(null, "", "/");
    chatPaneTracker.mounts = 0;
    vi.stubGlobal("EventSource", class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      close() {}
    });
    vi.spyOn(api, "projects").mockResolvedValue([PROJECT]);
    vi.spyOn(api, "sessions").mockResolvedValue([]);
    vi.spyOn(api, "health").mockResolvedValue({ ok: true, ready: true, sessionCount: 1 });
    vi.spyOn(providerApi, "providers").mockResolvedValue([{
      provider: "openai",
      home: "/Users/test/.codex",
      status: "available",
      capabilities: CAPABILITIES,
    }]);
    vi.spyOn(providerApi, "list").mockResolvedValue({ items: [], nextCursor: null });
    loadHomeDataMock.mockResolvedValue({
      claudeSessions: [],
      claudeTotal: 0,
      claudeLast30Days: 0,
      codexSessions: [],
      codexStats: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens and re-keys the native Codex create flow when Codex is the default", async () => {
    vi.spyOn(api, "getSettings").mockResolvedValue(settingsFor("codex"));
    const user = userEvent.setup();
    render(createElement(App));
    await waitFor(() => expect(api.sessions).toHaveBeenCalledWith(PROJECT.id));

    await user.click(await screen.findByRole("button", { name: "New Claude Session" }));
    // Generous timeout: the form renders after an async default-model resolution, which
    // the default 1s findBy timeout can miss on a slow CI runner (flaky red, passes
    // locally). 5s is comfortably above CI variance without masking a real hang.
    expect(await screen.findByRole("form", { name: "New native Codex task setup" }, { timeout: 5000 }))
      .toBeInTheDocument();

    const workingFolder = screen.getByLabelText("Working folder");
    await user.type(workingFolder, "/tmp/stale-draft");
    await user.click(screen.getByRole("button", { name: "Command palette (⌘⇧P)" }));
    const commands = screen.getByRole("dialog", { name: "Search commands and tasks" });
    await user.click(within(commands).getByRole("option", { name: /New task/ }));
    await waitFor(() => expect(screen.getByLabelText("Working folder")).toHaveValue(""));
  });

  it("opens and re-keys a fresh Claude chat when Claude is the default", async () => {
    vi.spyOn(api, "getSettings").mockResolvedValue(settingsFor("claude"));
    const user = userEvent.setup();
    render(createElement(App));
    await waitFor(() => expect(api.sessions).toHaveBeenCalledWith(PROJECT.id));

    await user.click(await screen.findByRole("button", { name: "New Claude Session" }));
    expect(await screen.findByTestId("fresh-claude-chat", {}, { timeout: 5000 })).toHaveAttribute("data-instance", "1");
    expect(screen.getByTestId("fresh-claude-chat")).toHaveAttribute("data-session-id", "");

    // Aurora Cockpit Sidebar renamed the rail's new-session control ("New task" →
    // "New session", icon button) — same startNewChat re-key behavior.
    await user.click(screen.getByRole("button", { name: "New session" }));
    await waitFor(() => expect(screen.getByTestId("fresh-claude-chat"))
      .toHaveAttribute("data-instance", "2"));
  });
});

describe("App native Codex shell gate", () => {
  it("derives a Claude provider home from its canonical transcript path, never from cwd", () => {
    expect(nativeClaudeHomeFromSessionFile("/Users/test/.claude/projects/-workspace/session.jsonl"))
      .toBe("/Users/test/.claude");
    expect(nativeClaudeHomeFromSessionFile("/workspace/project/session.jsonl")).toBeUndefined();
  });
  it("rejects stale settings responses that finish after a newer request", () => {
    expect(isLatestSettingsResponse(4, 5)).toBe(false);
    expect(isLatestSettingsResponse(5, 5)).toBe(true);
  });
  it("uses native Codex only for the server-resolved true feature flag", () => {
    const enabled: AppSettings = {
      devHubFeatures: {
        nativeCodex: true,
        persistentClaude: false,
        unifiedTaskIndex: false,
        shellChrome: false,
        taskRail: false,
        taskHeaderSetup: false,
        threadWorkspace: false,
        composerSurface: false,
        inspectorDock: false,
        searchCommands: false,
        settingsSecondary: false,
        codexStyleShell: false,
        crossProviderFork: false,
        workMode: false,
      },
    };

    expect(resolveCodexShellMode(enabled)).toBe("native");
    expect(resolveCodexShellMode({
      ...enabled,
      devHubFeatures: { ...enabled.devHubFeatures!, nativeCodex: false },
    })).toBe("history");
    expect(resolveCodexShellMode({})).toBe("history");
    expect(resolveCodexShellMode(null)).toBe("history");
  });

  it("uses persistent Claude only for the server-resolved runtime flag", () => {
    const enabled: AppSettings = {
      devHubFeatures: {
        nativeCodex: false,
        persistentClaude: true,
        unifiedTaskIndex: false,
        shellChrome: false,
        taskRail: false,
        taskHeaderSetup: false,
        threadWorkspace: false,
        composerSurface: false,
        inspectorDock: false,
        searchCommands: false,
        settingsSecondary: false,
        codexStyleShell: false,
        crossProviderFork: false,
        workMode: false,
      },
    };

    expect(resolveClaudeShellMode(enabled)).toBe("native");
    expect(resolveClaudeShellMode({
      ...enabled,
      devHubFeatures: { ...enabled.devHubFeatures!, persistentClaude: false },
    })).toBe("legacy");
    expect(resolveClaudeShellMode({})).toBe("legacy");
    expect(resolveClaudeShellMode(null)).toBe("legacy");
  });

  it("changes the Codex destination label and icon only in native mode", () => {
    const expected: Record<CodexShellMode, { label: string; icon: string }> = {
      native: { label: "Codex", icon: "bot" },
      history: { label: "History", icon: "history" },
    };

    expect(codexNavPresentation("native")).toEqual(expected.native);
    expect(codexNavPresentation("history")).toEqual(expected.history);
  });

  it("keeps secondary header utilities out of the minimum-width layout", () => {
    // Revealed at ≥1360px, not `lg`/`xl`: the spend/count cluster only fits once
    // the 324px rail leaves enough frame width, else it overflowed the Settings
    // gear off-canvas (QA BLOCKER — see TopBar.tsx TOP_BAR_SECONDARY_CLASS).
    expect(TOP_BAR_SECONDARY_CLASS.split(/\s+/)).toContain("hidden");
    expect(TOP_BAR_SECONDARY_CLASS.split(/\s+/)).toContain("min-[1360px]:flex");
    expect(TOP_BAR_SECONDARY_CLASS.split(/\s+/)).not.toContain("flex");
  });

  it("gives each native provider route a distinct React identity", () => {
    expect(nativePaneRouteKey("openai")).toBe("native-provider:openai");
    expect(nativePaneRouteKey("anthropic")).toBe("native-provider:anthropic");
  });

  it("carries a legacy Continue target into the native Claude route", () => {
    expect(nativeClaudePreferredTaskId({ sessionId: "session-17" }))
      .toBe("session-17");
    expect(nativeClaudePreferredTaskId(null)).toBeUndefined();
  });

  it("uses provider-aware lazy-load failure copy", () => {
    expect(nativeLoadFailureMessage("anthropic")).toContain("Native Claude");
    expect(nativeLoadFailureMessage("anthropic")).not.toMatch(/Codex/i);
    expect(nativeLoadFailureMessage("openai")).toContain("Native Codex");
  });

  it("marks the current navigation destination as the current page", () => {
    expect(navigationAriaCurrent(true)).toBe("page");
    expect(navigationAriaCurrent(false)).toBeUndefined();
  });

  it("announces lazy pane loading exactly once as a polite status", () => {
    const html = renderToStaticMarkup(createElement(PaneFallback));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Loading view");
  });
});
