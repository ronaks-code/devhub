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

describe("provider task index server composition (post-M5 cutover: default ON)", () => {
  it("initializes the coordinator once at ready and reports the feature applied", async () => {
    // Fresh engine, no stored override: the M5 cutover default requests unifiedTaskIndex ON,
    // so onReady builds + initializes the coordinator exactly once and registers the trusted
    // runtime home. The settings surface reports it applied (available store + initialized).
    const { app, codexHome, registerHome } = composition();
    await app.ready();

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
    // Path-free registration result: the canonical home never leaves the backend.
    expect(JSON.stringify(registration)).not.toContain(codexHome);

    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settings.json().devHubFeatures.unifiedTaskIndex).toBe(true);
  });

  it("treats an explicit stored false as the immediate rollback switch (no coordinator)", async () => {
    // ROLLBACK REHEARSAL: an explicit stored `unifiedTaskIndex: false` wins over the ON
    // default. Persist it BEFORE ready so onReady never instantiates the coordinator; the
    // server then reports the feature disabled (applied only when the coordinator initialized).
    const { app, engine, registerHome } = composition();
    engine.setSettings({
      devHubFeatures: { ...DEFAULT_DEVHUB_FEATURE_FLAGS, unifiedTaskIndex: false },
    });
    await app.ready();

    expect(registerHome).not.toHaveBeenCalled();
    const disabled = await app.inject({ method: "GET", url: "/api/settings" });
    expect(disabled.json().devHubFeatures.unifiedTaskIndex).toBe(false);

    // Re-enabling from the rolled-back state builds the coordinator exactly once.
    expect(await putFeatures(app, { unifiedTaskIndex: true })).toBe(200);
    expect(registerHome).toHaveBeenCalledTimes(1);
    const reenabled = await app.inject({ method: "GET", url: "/api/settings" });
    expect(reenabled.json().devHubFeatures.unifiedTaskIndex).toBe(true);
  });

  it("does not rebuild or tear down the coordinator across repeat/flip-back transitions", async () => {
    const { app, registerHome } = composition();
    await app.ready();
    // Built once at ready under the ON default.
    expect(registerHome).toHaveBeenCalledTimes(1);

    // Repeat true: coordinator already exists, no second registration.
    expect(await putFeatures(app, { unifiedTaskIndex: true })).toBe(200);
    expect(registerHome).toHaveBeenCalledTimes(1);

    // Flip to explicit false (rollback), then true again: still the same single coordinator,
    // never torn down and never re-registered.
    expect(await putFeatures(app, { unifiedTaskIndex: false })).toBe(200);
    expect(await putFeatures(app, { unifiedTaskIndex: true })).toBe(200);
    expect(registerHome).toHaveBeenCalledTimes(1);
  });
});
