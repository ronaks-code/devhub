import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AppSettings } from "../lib/api.js";
import {
  deliverSettingsResponse,
  completeDevHubFeatures,
  dirtySettingsUpdatePayload,
  mergeAuthoritativeSettings,
  requestSettingsReconciliation,
  settingsUpdatePayload,
  withNativeCodexPreference,
  withPersistentClaudePreference,
  SettingsPane,
} from "./SettingsPane.js";

const FEATURES = {
  nativeCodex: false,
  persistentClaude: true,
  unifiedTaskIndex: false,
  shellChrome: false,
  codexStyleShell: true,
  crossProviderFork: false,
  workMode: true,
} as const;

describe("SettingsPane native Codex feature persistence", () => {
  it("delivers a completed response to the shell even after the pane unmounts", () => {
    const delivered: Array<{ settings: AppSettings; version?: number }> = [];
    const next: AppSettings = { theme: "light" };

    expect(deliverSettingsResponse(
      next,
      9,
      (settings, version) => {
        delivered.push({ settings, version });
        return true;
      },
      false,
    )).toBe(false);
    expect(delivered).toEqual([{ settings: next, version: 9 }]);
  });

  it("requests shell-owned reconciliation after an unconfirmed save", () => {
    let reconciliations = 0;
    requestSettingsReconciliation(() => {
      reconciliations += 1;
    });
    expect(reconciliations).toBe(1);
  });

  it("always completes the server's exact feature payload", () => {
    expect(completeDevHubFeatures({ nativeCodex: true })).toEqual({
      nativeCodex: true,
      persistentClaude: false,
      unifiedTaskIndex: false,
      shellChrome: false,
      codexStyleShell: false,
      crossProviderFork: false,
      workMode: false,
    });
    expect(Object.keys(completeDevHubFeatures(undefined))).toHaveLength(7);
  });

  it("changes only nativeCodex while retaining the other requested feature flags", () => {
    const settings: AppSettings = {
      theme: "dark",
      devHubFeatures: FEATURES,
    };

    const next = withNativeCodexPreference(settings, true);

    expect(next).not.toBe(settings);
    expect(next.devHubFeatures).toEqual({ ...FEATURES, nativeCodex: true });
    expect(settings.devHubFeatures).toEqual(FEATURES);
    expect(next.theme).toBe("dark");
  });

  it("changes nativeCodex without erasing requested flags hidden by runtime clamping", () => {
    const settings: AppSettings = {
      devHubFeatures: {
        ...FEATURES,
        persistentClaude: false,
        codexStyleShell: false,
        workMode: false,
      },
      requestedDevHubFeatures: FEATURES,
    };

    const next = withNativeCodexPreference(settings, true);

    expect(next.devHubFeatures?.nativeCodex).toBe(false);
    expect(next.requestedDevHubFeatures).toEqual({ ...FEATURES, nativeCodex: true });
  });

  it("keeps effective runtime truth clamped while letting the user clear a latent request", () => {
    const clamped: AppSettings = {
      devHubFeatures: { ...FEATURES, nativeCodex: false },
      requestedDevHubFeatures: { ...FEATURES, nativeCodex: true },
    };

    const disabled = withNativeCodexPreference(clamped, false);

    expect(disabled.devHubFeatures?.nativeCodex).toBe(false);
    expect(disabled.requestedDevHubFeatures?.nativeCodex).toBe(false);
    expect(settingsUpdatePayload(disabled).devHubFeatures?.nativeCodex).toBe(false);
  });

  it("changes only persistentClaude while preserving clamped effective truth and every request", () => {
    const settings: AppSettings = {
      theme: "dark",
      devHubFeatures: { ...FEATURES, persistentClaude: false },
      requestedDevHubFeatures: { ...FEATURES, persistentClaude: false },
    };

    const next = withPersistentClaudePreference(settings, true);

    expect(next.devHubFeatures).toEqual({ ...FEATURES, persistentClaude: false });
    expect(next.requestedDevHubFeatures).toEqual({ ...FEATURES, persistentClaude: true });
    expect(next.theme).toBe("dark");
    expect(settings.requestedDevHubFeatures?.persistentClaude).toBe(false);
  });

  it("includes all six features in the settings save without dropping existing preferences", () => {
    const settings: AppSettings = {
      defaultModel: "claude-sonnet-4-6",
      defaultPermissionMode: "default",
      theme: "system",
      density: "compact",
      monthlyBudgetUsd: null,
      devHubFeatures: FEATURES,
    };

    expect(settingsUpdatePayload(settings)).toEqual({
      defaultModel: "claude-sonnet-4-6",
      defaultPermissionMode: "default",
      theme: "system",
      density: "compact",
      monthlyBudgetUsd: null,
      devHubFeatures: FEATURES,
    });
  });

  it("serializes requested flags instead of a runtime-clamped display snapshot", () => {
    const settings: AppSettings = {
      devHubFeatures: { ...FEATURES, persistentClaude: false, workMode: false },
      requestedDevHubFeatures: FEATURES,
    };

    expect(settingsUpdatePayload(settings).devHubFeatures).toEqual(FEATURES);
    expect(settingsUpdatePayload(settings)).not.toHaveProperty("requestedDevHubFeatures");
  });

  it("sends only fields edited in Settings so concurrent header patches survive", () => {
    const settings: AppSettings = {
      defaultModel: "claude-sonnet-4-6",
      theme: "dark",
      devHubFeatures: { ...FEATURES, nativeCodex: false },
      requestedDevHubFeatures: FEATURES,
    };

    expect(dirtySettingsUpdatePayload(settings, new Set(["defaultModel"]))).toEqual({
      defaultModel: "claude-sonnet-4-6",
    });
    expect(dirtySettingsUpdatePayload(settings, new Set(["devHubFeatures"]))).toEqual({
      devHubFeatures: FEATURES,
    });
  });

  it("rebases a reconciliation snapshot beneath unsaved local intent", () => {
    const dirty = new Set<keyof AppSettings>(["defaultModel"]);
    const merged = mergeAuthoritativeSettings(
      { defaultModel: "claude-opus-4-8", theme: "dark" },
      { defaultModel: "claude-sonnet-4-6", theme: "light" },
      dirty,
    );
    expect(merged).toMatchObject({ defaultModel: "claude-opus-4-8", theme: "light" });
    expect(dirty.has("defaultModel")).toBe(true);

    const confirmed = mergeAuthoritativeSettings(merged, {
      defaultModel: "claude-opus-4-8",
      theme: "light",
    }, dirty);
    expect(confirmed.defaultModel).toBe("claude-opus-4-8");
    expect(dirty.size).toBe(0);
  });

  it("announces settings loading as a named polite status", () => {
    const html = renderToStaticMarkup(createElement(SettingsPane));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Loading settings");
  });
});
