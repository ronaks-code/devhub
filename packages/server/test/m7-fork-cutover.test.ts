/**
 * M7 fork cutover: end-to-end proof (through the REAL `buildApp` wiring, not the
 * generic `registerSettingsRoutes` unit seam) that `crossProviderFork` is now the
 * requested default, but the server still clamps the resolved value to real
 * availability — it resolves true ONLY when a genuine cross-provider handoff target
 * (a second discovered provider home) exists — and that an explicit stored `false`
 * is still the immediate, non-destructive rollback in isolation. Hermetic: points
 * CLAUDE_CONFIG_DIR at a fresh temp dir per test, no real provider process spawned
 * (providerHomes here are opaque test seams, never enabled runtimes).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Engine } from "@devhub/engine";
import type { ConfiguredProviderHome } from "@devhub/engine";
import { buildApp } from "../src/app.js";

let prevConfigDir: string | undefined;
let current: { app: FastifyInstance; engine: Engine } | undefined;

async function makeApp(
  providerHomes: readonly ConfiguredProviderHome[],
): Promise<{ app: FastifyInstance; engine: Engine }> {
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), "cui-m7-fork-cutover-test-"));
  const engine = new Engine(path.join(process.env.CLAUDE_CONFIG_DIR, "index.db"));
  // Disable native Codex/Claude runtime discovery — this suite only cares about the
  // registeredProviderHomes census (via the opaque providerHomes test seam), not real
  // CLI probing.
  const { app } = buildApp({ engine, nativeCodex: false, nativeClaude: false, providerHomes });
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

describe("M7 crossProviderFork cutover (real buildApp wiring)", () => {
  it("resolves true by default when a genuine handoff target exists (two distinct provider homes discovered)", async () => {
    current = await makeApp([
      { provider: "openai", home: "/tmp/m7-fork-cutover-openai-home" },
      { provider: "anthropic", home: "/tmp/m7-fork-cutover-anthropic-home" },
    ]);
    const res = await current.app.inject({ method: "GET", url: "/api/settings" });
    expect(res.statusCode).toBe(200);
    const features = res.json().devHubFeatures as Record<string, boolean>;
    expect(features.crossProviderFork).toBe(true);
  });

  it("resolves false when only one provider has a discovered home — no fork target exists", async () => {
    current = await makeApp([{ provider: "openai", home: "/tmp/m7-fork-cutover-openai-only-home" }]);
    const res = await current.app.inject({ method: "GET", url: "/api/settings" });
    expect(res.statusCode).toBe(200);
    const features = res.json().devHubFeatures as Record<string, boolean>;
    expect(features.crossProviderFork).toBe(false);
  });

  it("resolves false when no provider has a discovered home at all", async () => {
    current = await makeApp([]);
    const res = await current.app.inject({ method: "GET", url: "/api/settings" });
    expect(res.statusCode).toBe(200);
    const features = res.json().devHubFeatures as Record<string, boolean>;
    expect(features.crossProviderFork).toBe(false);
  });

  it("an explicit stored false instantly rolls back crossProviderFork even with a target present, in isolation from other flags", async () => {
    current = await makeApp([
      { provider: "openai", home: "/tmp/m7-fork-cutover-rollback-openai-home" },
      { provider: "anthropic", home: "/tmp/m7-fork-cutover-rollback-anthropic-home" },
    ]);
    const getBefore = await current.app.inject({ method: "GET", url: "/api/settings" });
    const requested = getBefore.json().devHubFeatures as Record<string, boolean>;
    expect(requested.crossProviderFork).toBe(true);

    const put = await current.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { devHubFeatures: { ...requested, crossProviderFork: false } },
    });
    expect(put.statusCode).toBe(200);
    const resolved = put.json().devHubFeatures as Record<string, boolean>;

    expect(resolved.crossProviderFork).toBe(false);
    // Isolation: the rollback is scoped to crossProviderFork alone — the unrelated
    // M6 umbrella (also default-on) is untouched.
    expect(resolved.codexStyleShell).toBe(true);
  });
});
