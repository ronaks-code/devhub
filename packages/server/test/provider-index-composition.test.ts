/**
 * Server composition wiring for the provider task index coordinator.
 *
 * These tests are HERMETIC: a real Engine against a temp SQLite DB (so the shared
 * ProviderTaskIndexStore exists) plus an explicit, non-spawning native Codex install
 * that only contributes a trusted registered home. The Codex runtime is never enabled,
 * so no provider process is spawned.
 *
 * They pin the Task 3 wiring contract:
 *  - TranscriptIndex owns the shared store; no coordinator is built eagerly.
 *  - Flag-off routing never instantiates the coordinator (store.registerHome untouched).
 *  - The coordinator is created + initialized lazily on the false->true effective
 *    unifiedTaskIndex transition, registering each trusted runtime home exactly once,
 *    and is not rebuilt on a repeat transition or torn down when the flag flips back.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Engine } from "@devhub/engine";
import { DEFAULT_DEVHUB_FEATURE_FLAGS } from "@devhub/engine/providers";
import { buildApp } from "../src/app.js";

const roots: string[] = [];
const apps: FastifyInstance[] = [];
const engines: Engine[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "devhub-provider-index-composition-"));
  roots.push(root);
  return root;
}

/** A real Engine (temp SQLite) plus a non-spawning explicit Codex install. */
function composition(): {
  readonly app: FastifyInstance;
  readonly engine: Engine;
  readonly codexHome: string;
  readonly registerHome: ReturnType<typeof vi.spyOn>;
} {
  const root = temporaryRoot();
  const executable = path.join(root, "codex");
  const codexHome = path.join(root, "codex-home");
  writeFileSync(executable, "binary", { mode: 0o755 });
  mkdirSync(codexHome);

  const engine = new Engine(path.join(root, "index.db"));
  engines.push(engine);
  const registerHome = vi.spyOn(engine.index.providerIndex, "registerHome");

  const { app } = buildApp({
    engine,
    // Explicit install so the coordinator has a trusted home to register; never enabled.
    nativeCodex: { installation: { executable, home: codexHome } },
    nativeClaude: false,
  });
  apps.push(app);
  // The runtime canonicalizes the install home (realpath), so registration uses that form.
  return { app, engine, codexHome: realpathSync(codexHome), registerHome };
}

async function putFeatures(
  app: FastifyInstance,
  overrides: Record<string, boolean>,
): Promise<number> {
  const response = await app.inject({
    method: "PUT",
    url: "/api/settings",
    payload: { devHubFeatures: { ...DEFAULT_DEVHUB_FEATURE_FLAGS, ...overrides } },
  });
  return response.statusCode;
}

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
  for (const engine of engines.splice(0)) {
    try { engine.close(); } catch { /* already closed */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("provider task index server composition", () => {
  it("never builds a coordinator while unifiedTaskIndex stays false", async () => {
    const { app, registerHome } = composition();
    await app.ready();

    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settings.json().devHubFeatures.unifiedTaskIndex).toBe(false);

    // A feature change that leaves unifiedTaskIndex false must not instantiate anything.
    expect(await putFeatures(app, { nativeCodex: false })).toBe(200);
    expect(await putFeatures(app, { unifiedTaskIndex: false })).toBe(200);

    expect(registerHome).not.toHaveBeenCalled();
  });

  it("creates + initializes the coordinator once on the false->true transition", async () => {
    const { app, codexHome, registerHome } = composition();
    await app.ready();
    expect(registerHome).not.toHaveBeenCalled();

    const enabled = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        devHubFeatures: { ...DEFAULT_DEVHUB_FEATURE_FLAGS, unifiedTaskIndex: true },
      },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().devHubFeatures.unifiedTaskIndex).toBe(true);

    // Exactly one trusted runtime home was registered, path-free result, canonical home in.
    expect(registerHome).toHaveBeenCalledTimes(1);
    expect(registerHome).toHaveBeenCalledWith(
      { provider: "openai", home: codexHome },
      expect.any(Number),
    );
    const registration = registerHome.mock.results[0]?.value as {
      provider: string;
      homeFingerprint: string;
      registeredAt: number;
    };
    expect(registration.provider).toBe("openai");
    expect(typeof registration.homeFingerprint).toBe("string");
    expect(JSON.stringify(registration)).not.toContain(codexHome);
  });

  it("does not rebuild the coordinator on a repeat transition or a flip back to false", async () => {
    const { app, registerHome } = composition();
    await app.ready();

    expect(await putFeatures(app, { unifiedTaskIndex: true })).toBe(200);
    expect(registerHome).toHaveBeenCalledTimes(1);

    // Repeat true: coordinator already exists, no second registration.
    expect(await putFeatures(app, { unifiedTaskIndex: true })).toBe(200);
    expect(registerHome).toHaveBeenCalledTimes(1);

    // Flip back to false, then true again: still the same single coordinator.
    expect(await putFeatures(app, { unifiedTaskIndex: false })).toBe(200);
    expect(await putFeatures(app, { unifiedTaskIndex: true })).toBe(200);
    expect(registerHome).toHaveBeenCalledTimes(1);
  });
});
