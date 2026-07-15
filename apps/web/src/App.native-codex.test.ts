import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PaneFallback,
  codexNavPresentation,
  isLatestSettingsResponse,
  nativeClaudePreferredTaskId,
  nativeLoadFailureMessage,
  nativePaneRouteKey,
  navigationAriaCurrent,
  resolveClaudeShellMode,
  resolveCodexShellMode,
  TOP_BAR_SECONDARY_CLASS,
  type CodexShellMode,
} from "./App.js";
import type { AppSettings } from "./lib/api.js";

describe("App native Codex shell gate", () => {
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
    expect(TOP_BAR_SECONDARY_CLASS.split(/\s+/)).toContain("hidden");
    expect(TOP_BAR_SECONDARY_CLASS.split(/\s+/)).toContain("lg:flex");
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
