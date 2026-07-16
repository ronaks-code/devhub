/**
 * M7-WORKMODE-CUTOVER: end-to-end proof (through the REAL `buildApp` wiring, not
 * the generic `registerSettingsRoutes` unit seam) that `workMode` is now the
 * requested default, but the server still clamps available/applied to a real,
 * initialized durable Work-mode store (`engine.index?.workModeTasks`) — a
 * partial/mocked Engine without a real `index` reports the feature unavailable
 * and unapplied, and an explicit stored `false` is still the immediate,
 * non-destructive rollback, isolated from every other flag. Hermetic: points
 * CLAUDE_CONFIG_DIR at a fresh temp dir per test, no real provider process
 * spawned.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Engine } from "@devhub/engine";
import { buildApp } from "../src/app.js";

let prevConfigDir: string | undefined;
let current: { app: FastifyInstance; engine: Engine } | undefined;

async function makeRealEngineApp(): Promise<{ app: FastifyInstance; engine: Engine }> {
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), "cui-m7-workmode-cutover-test-"));
  const engine = new Engine(path.join(process.env.CLAUDE_CONFIG_DIR, "index.db"));
  // Disable native Codex/Claude runtime discovery — this suite only cares about
  // the workMode availability/applied clamp, not real CLI probing.
  const { app } = buildApp({ engine, nativeCodex: false, nativeClaude: false });
  await app.ready();
  return { app, engine };
}

afterEach(async () => {
  if (current) {
    await current.app.close();
    current.engine.close();
    current = undefined;
  }
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
});

describe("M7-WORKMODE-CUTOVER workMode default (real buildApp wiring)", () => {
  it("resolves true by default with a real Engine — the durable work_mode_tasks store is always initialized", async () => {
    current = await makeRealEngineApp();
    const res = await current.app.inject({ method: "GET", url: "/api/settings" });
    expect(res.statusCode).toBe(200);
    const features = res.json().devHubFeatures as Record<string, boolean>;
    expect(features.workMode).toBe(true);
  });

  it("reports the Work-mode status route enabled once the flag resolves true through the real wiring", async () => {
    current = await makeRealEngineApp();
    const status = await current.app.inject({ method: "GET", url: "/api/work-mode/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ enabled: true });
  });

  it("an explicit stored false instantly rolls back workMode, isolated from every other default-on flag", async () => {
    current = await makeRealEngineApp();
    const getBefore = await current.app.inject({ method: "GET", url: "/api/settings" });
    const requested = getBefore.json().devHubFeatures as Record<string, boolean>;
    expect(requested.workMode).toBe(true);

    const put = await current.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { devHubFeatures: { ...requested, workMode: false } },
    });
    expect(put.statusCode).toBe(200);
    const resolved = put.json().devHubFeatures as Record<string, boolean>;

    expect(resolved.workMode).toBe(false);
    // Isolation: the rollback is scoped to workMode alone — the unrelated M6/M7
    // umbrella flags (also default-on) are untouched.
    expect(resolved.codexStyleShell).toBe(true);
    expect(resolved.unifiedTaskIndex).toBe(true);

    // The route layer re-checks the resolved flag itself, off the live engine
    // settings — the rollback takes effect immediately, no restart needed.
    const status = await current.app.inject({ method: "GET", url: "/api/work-mode/status" });
    expect(status.json()).toEqual({ enabled: false });
  });

  it("reports workMode unavailable AND unapplied for a partial/mocked Engine lacking a real index (no durable store)", async () => {
    // Mirrors the exact `engine.index?.workModeTasks` tolerance app.ts applies for
    // the provider index: a hermetic test that builds buildApp with a partial
    // Engine (no `.index`) must see the feature clamp to false rather than
    // falsely claim durable persistence it cannot provide.
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), "cui-m7-workmode-cutover-partial-"));
    let stored = { devHubFeatures: {} as Record<string, boolean> };
    const partialEngine = {
      getSettings: () => stored,
      setSettings: (partial: { devHubFeatures?: Record<string, boolean> }) => {
        stored = { devHubFeatures: { ...stored.devHubFeatures, ...(partial.devHubFeatures ?? {}) } };
        return stored;
      },
      index: undefined,
      getRunningSessions: () => [],
      ready: true,
    } as unknown as Engine;
    const { app } = buildApp({ engine: partialEngine, nativeCodex: false, nativeClaude: false });
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/api/settings" });
      expect(res.statusCode).toBe(200);
      const features = res.json().devHubFeatures as Record<string, boolean>;
      // Requested default is still true, but the availability clamp resolves it
      // false without a real durable store to back it.
      expect(features.workMode).toBe(false);
    } finally {
      await app.close();
      if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    }
  });
});
