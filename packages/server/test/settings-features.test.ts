import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "@devhub/engine";
import type { AppSettings } from "@devhub/engine/types";
import {
  DEFAULT_DEVHUB_FEATURE_FLAGS,
  type DevHubFeatureFlags,
} from "@devhub/engine/providers";
import { registerSettingsRoutes } from "../src/routes/settings.js";

const allEnabled: DevHubFeatureFlags = {
  nativeCodex: true,
  persistentClaude: true,
  unifiedTaskIndex: true,
  shellChrome: true,
  taskRail: true,
  taskHeaderSetup: true,
  codexStyleShell: true,
  crossProviderFork: true,
  workMode: true,
};

// Explicit fully-disabled resolution. Since the M5 cutover flipped
// DEFAULT_DEVHUB_FEATURE_FLAGS.unifiedTaskIndex on, the default object is no longer an
// all-false sentinel; the "no runtime capability available" cases must compare against
// this literal instead so they still assert every resolved flag clamps to false.
const allDisabled: DevHubFeatureFlags = {
  nativeCodex: false,
  persistentClaude: false,
  unifiedTaskIndex: false,
  shellChrome: false,
  taskRail: false,
  taskHeaderSetup: false,
  codexStyleShell: false,
  crossProviderFork: false,
  workMode: false,
};

async function makeApp(
  storedFeatures: DevHubFeatureFlags = { ...DEFAULT_DEVHUB_FEATURE_FLAGS },
  availableFeatures:
    | Partial<DevHubFeatureFlags>
    | (() => Partial<DevHubFeatureFlags>) = {},
  onFeaturesChanged?: (features: Readonly<DevHubFeatureFlags>) => void | Promise<void>,
  appliedFeatures?: () => Partial<DevHubFeatureFlags>,
): Promise<{ app: FastifyInstance; stored: () => AppSettings }> {
  let stored: AppSettings = { devHubFeatures: { ...storedFeatures } };
  const engine = {
    getSettings: () => stored,
    setSettings: (partial: Partial<AppSettings>) => {
      stored = { ...stored, ...partial };
      return stored;
    },
  } as Engine;
  const app = Fastify();
  registerSettingsRoutes(app, engine, {
    availableDevHubFeatures: availableFeatures,
    appliedDevHubFeatures: appliedFeatures,
    onDevHubFeaturesChanged: onFeaturesChanged,
  });
  await app.ready();
  return { app, stored: () => stored };
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
});

describe("DevHub feature settings HTTP resolution", () => {
  it("returns all six flags false when no runtime capability is available", async () => {
    const handle = await makeApp(allEnabled);
    apps.push(handle.app);

    const response = await handle.app.inject({ method: "GET", url: "/api/settings" });
    expect(response.statusCode).toBe(200);
    expect(response.json().devHubFeatures).toEqual(allDisabled);
  });

  it("persists requested flags but returns only the backend-resolved intersection", async () => {
    const handle = await makeApp(
      { ...DEFAULT_DEVHUB_FEATURE_FLAGS },
      { nativeCodex: true, unifiedTaskIndex: true },
    );
    apps.push(handle.app);

    const response = await handle.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { devHubFeatures: allEnabled },
    });
    expect(response.statusCode).toBe(200);
    expect(handle.stored().devHubFeatures).toEqual(allEnabled);
    expect(response.json().devHubFeatures).toEqual({
      ...DEFAULT_DEVHUB_FEATURE_FLAGS,
      nativeCodex: true,
      unifiedTaskIndex: true,
    });
    expect(response.json().requestedDevHubFeatures).toEqual(allEnabled);
  });

  it("returns requested flags separately so a later save cannot erase unavailable preferences", async () => {
    const handle = await makeApp(allEnabled, { nativeCodex: true });
    apps.push(handle.app);

    const response = await handle.app.inject({ method: "GET", url: "/api/settings" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      devHubFeatures: {
        ...allDisabled,
        nativeCodex: true,
      },
      requestedDevHubFeatures: allEnabled,
    });
    expect(handle.stored()).not.toHaveProperty("requestedDevHubFeatures");
  });

  it("rejects incomplete or unknown nested feature fields", async () => {
    const handle = await makeApp();
    apps.push(handle.app);

    const incomplete = await handle.app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { devHubFeatures: { nativeCodex: true } },
    });
    expect(incomplete.statusCode).toBe(400);

    const unknown = await handle.app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { devHubFeatures: { ...allEnabled, rawOpenAI: true } },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("persists first and awaits the resolved feature-change callback", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let handle!: Awaited<ReturnType<typeof makeApp>>;
    const callback = vi.fn(async (features: Readonly<DevHubFeatureFlags>) => {
      expect(handle.stored().devHubFeatures?.nativeCodex).toBe(true);
      expect(features.nativeCodex).toBe(true);
      await gate;
    });
    handle = await makeApp(
      { ...DEFAULT_DEVHUB_FEATURE_FLAGS },
      { nativeCodex: true },
      callback,
    );
    apps.push(handle.app);

    let settled = false;
    const pending = handle.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { devHubFeatures: { ...DEFAULT_DEVHUB_FEATURE_FLAGS, nativeCodex: true } },
    }).then((response) => {
      settled = true;
      return response;
    });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    release();
    expect((await pending).statusCode).toBe(200);
  });

  it("recomputes dynamic availability and applied truth after an awaited transition", async () => {
    let available = true;
    let applied = false;
    const callback = vi.fn(async () => {
      applied = true;
    });
    const handle = await makeApp(
      { ...DEFAULT_DEVHUB_FEATURE_FLAGS },
      () => ({ persistentClaude: available }),
      callback,
      () => ({ persistentClaude: applied }),
    );
    apps.push(handle.app);

    const enabled = await handle.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        devHubFeatures: { ...DEFAULT_DEVHUB_FEATURE_FLAGS, persistentClaude: true },
      },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().requestedDevHubFeatures.persistentClaude).toBe(true);
    expect(enabled.json().devHubFeatures.persistentClaude).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);

    available = false;
    const unavailable = await handle.app.inject({ method: "GET", url: "/api/settings" });
    expect(unavailable.json().requestedDevHubFeatures.persistentClaude).toBe(true);
    expect(unavailable.json().devHubFeatures.persistentClaude).toBe(false);
  });

  it("keeps a failed activation requested while returning clamped applied truth", async () => {
    const callback = vi.fn(async () => {
      throw new Error("synthetic transition failure");
    });
    const handle = await makeApp(
      { ...DEFAULT_DEVHUB_FEATURE_FLAGS },
      { persistentClaude: true },
      callback,
      () => ({ persistentClaude: false }),
    );
    apps.push(handle.app);

    const response = await handle.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        devHubFeatures: { ...DEFAULT_DEVHUB_FEATURE_FLAGS, persistentClaude: true },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().requestedDevHubFeatures.persistentClaude).toBe(true);
    expect(response.json().devHubFeatures.persistentClaude).toBe(false);
    expect(handle.stored().devHubFeatures?.persistentClaude).toBe(true);

    const later = await handle.app.inject({ method: "GET", url: "/api/settings" });
    expect(later.json().requestedDevHubFeatures.persistentClaude).toBe(true);
    expect(later.json().devHubFeatures.persistentClaude).toBe(false);
  });

  it("does not hide a transition failure behind an unverified effective feature", async () => {
    const handle = await makeApp(
      { ...DEFAULT_DEVHUB_FEATURE_FLAGS },
      { nativeCodex: true },
      async () => { throw new Error("synthetic unverified failure"); },
      () => ({ persistentClaude: false }),
    );
    apps.push(handle.app);

    const response = await handle.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        devHubFeatures: { ...DEFAULT_DEVHUB_FEATURE_FLAGS, nativeCodex: true },
      },
    });
    expect(response.statusCode).toBe(500);
    expect(handle.stored().devHubFeatures?.nativeCodex).toBe(true);
  });
});
