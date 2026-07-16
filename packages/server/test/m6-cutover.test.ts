/**
 * M6 umbrella cutover: end-to-end proof (through the REAL `buildApp` wiring, not the
 * generic `registerSettingsRoutes` unit seam) that `codexStyleShell` + the eight slice
 * flags now resolve true by default, and that an explicit stored `false` on any single
 * flag is the immediate, isolated rollback for that flag alone — every other slice
 * (and the umbrella) stays resolved true. Hermetic: points CLAUDE_CONFIG_DIR at a fresh
 * temp dir per test, same seam packages/server/test/app.test.ts uses.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Engine } from "@devhub/engine";
import { buildApp } from "../src/app.js";

const M6_SLICE_KEYS = [
  "shellChrome",
  "taskRail",
  "taskHeaderSetup",
  "threadWorkspace",
  "composerSurface",
  "inspectorDock",
  "searchCommands",
  "settingsSecondary",
] as const;

let prevConfigDir: string | undefined;
let current: { app: FastifyInstance; engine: Engine } | undefined;

async function makeApp(): Promise<{ app: FastifyInstance; engine: Engine }> {
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), "cui-m6-cutover-test-"));
  const engine = new Engine(path.join(process.env.CLAUDE_CONFIG_DIR, "index.db"));
  // Disable native Codex/Claude runtime discovery — this suite is only about the M6
  // umbrella flags, and we don't want a real CLI probe slowing/flaking the test.
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

describe("M6 codexStyleShell umbrella cutover (real buildApp wiring)", () => {
  it("resolves codexStyleShell + every slice flag true on a fresh install (no explicit overrides)", async () => {
    current = await makeApp();
    const res = await current.app.inject({ method: "GET", url: "/api/settings" });
    expect(res.statusCode).toBe(200);
    const features = res.json().devHubFeatures as Record<string, boolean>;
    expect(features.codexStyleShell).toBe(true);
    for (const key of M6_SLICE_KEYS) expect(features[key]).toBe(true);
  });

  it.each(M6_SLICE_KEYS)(
    "an explicit stored false on %s rolls back ONLY that slice — every other slice + the umbrella stay true",
    async (rolledBackKey) => {
      current = await makeApp();
      const getBefore = await current.app.inject({ method: "GET", url: "/api/settings" });
      const requested = getBefore.json().devHubFeatures as Record<string, boolean>;

      const put = await current.app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { devHubFeatures: { ...requested, [rolledBackKey]: false } },
      });
      expect(put.statusCode).toBe(200);
      const resolved = put.json().devHubFeatures as Record<string, boolean>;

      expect(resolved[rolledBackKey]).toBe(false);
      expect(resolved.codexStyleShell).toBe(true);
      for (const key of M6_SLICE_KEYS) {
        if (key === rolledBackKey) continue;
        expect(resolved[key]).toBe(true);
      }
    },
  );

  it("an explicit stored false on the codexStyleShell umbrella itself rolls back only the umbrella flag — every slice stays true", async () => {
    current = await makeApp();
    const getBefore = await current.app.inject({ method: "GET", url: "/api/settings" });
    const requested = getBefore.json().devHubFeatures as Record<string, boolean>;

    const put = await current.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { devHubFeatures: { ...requested, codexStyleShell: false } },
    });
    expect(put.statusCode).toBe(200);
    const resolved = put.json().devHubFeatures as Record<string, boolean>;

    expect(resolved.codexStyleShell).toBe(false);
    for (const key of M6_SLICE_KEYS) expect(resolved[key]).toBe(true);
  });
});
