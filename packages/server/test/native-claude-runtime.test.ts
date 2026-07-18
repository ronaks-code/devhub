import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "@devhub/engine";
import type { AppSettings } from "@devhub/engine/types";
import {
  ClaudeNativeAdapter,
  ClaudePersistentSupervisor,
  CodexAppServerSupervisor,
  CodexNativeAdapter,
  DEFAULT_DEVHUB_FEATURE_FLAGS,
  ProviderRegistry,
} from "@devhub/engine/providers";
import {
  createNativeClaudeRuntime,
  discoverNativeClaudeInstallation,
  isNativeClaudeLifecycleEvidence,
} from "../src/native-claude-runtime.js";
import { buildApp } from "../src/app.js";

const created: string[] = [];
const ACCESS_TOKEN = "native-claude-browser-token";
const SESSION = "019f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const TURN = "219f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const SUPPORTED_VERSION = "2.1.207 (Claude Code)";

const lifecycleEvidence = () => ({
  cliVersion: "2.1.207" as const,
  rawResume: true as const,
  postInterruptResume: true as const,
  forkContinuation: true as const,
  persistentMultiQuery: true as const,
  rawPermissionResponse: true as const,
  rawInterruptReceipt: true as const,
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "devhub-native-claude-"));
  created.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

function installation(root: string) {
  const bin = path.join(root, "bin");
  const home = path.join(root, "claude-home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  const executable = path.join(bin, "claude");
  writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${SUPPORTED_VERSION}'\n`, {
    mode: 0o755,
  });
  return { executable, home };
}

const helpers = () => ({
  listSessions: vi.fn(async () => []),
  getSessionInfo: vi.fn(async () => null),
  getSessionMessages: vi.fn(async () => ({ messages: [], limit: 200, offset: 0 })),
  renameSession: vi.fn(async () => undefined),
  forkSession: vi.fn(async () => "119f5b78-18c0-7b60-8f0c-6afc120ecd7d"),
});

function fakeRuntime(options: {
  configHome: string;
  sessionId: string;
}) {
  return {
    terminated: new Promise<never>(() => undefined),
    start: vi.fn(async () => undefined),
    send: vi.fn(async () => ({
      taskKey: {
        provider: "anthropic" as const,
        home: options.configHome,
        nativeTaskId: options.sessionId,
      },
      turnId: TURN,
    })),
    interrupt: vi.fn(async () => undefined),
    respond: vi.fn(async () => undefined),
    modelEvidence: vi.fn(() => Object.freeze({
      observations: Object.freeze([]),
      bySource: Object.freeze({
        requested: Object.freeze([]),
        "system-init": Object.freeze([]),
        "stream-message-start": Object.freeze([]),
        "assistant-message": Object.freeze([]),
        "result-model-usage": Object.freeze([]),
        "result-total-usage": Object.freeze([]),
      }),
      distinctModels: Object.freeze([]),
      hasDivergence: false,
    })),
    shutdown: vi.fn(async () => ({ kind: "shutdown" as const })),
  };
}

describe("native Claude installation discovery", () => {
  it("resolves the explicit executable and canonical CLAUDE_CONFIG_DIR without spawning", () => {
    const root = temporaryRoot();
    const found = installation(root);
    expect(discoverNativeClaudeInstallation({
      env: {
        DEVHUB_CLAUDE_EXECUTABLE: found.executable,
        CLAUDE_CONFIG_DIR: found.home,
      },
      homedir: root,
      platform: "darwin",
    })).toEqual({
      executable: realpathSync(found.executable),
      home: realpathSync(found.home),
    });
  });

  it("fails closed for a non-executable binary and relative provider home", () => {
    const root = temporaryRoot();
    const found = installation(root);
    chmodSync(found.executable, 0o644);
    expect(discoverNativeClaudeInstallation({
      env: { DEVHUB_CLAUDE_EXECUTABLE: found.executable, CLAUDE_CONFIG_DIR: found.home },
      homedir: root,
      platform: "darwin",
    })).toBeNull();
    chmodSync(found.executable, 0o755);
    expect(discoverNativeClaudeInstallation({
      env: { DEVHUB_CLAUDE_EXECUTABLE: found.executable, CLAUDE_CONFIG_DIR: "relative" },
      homedir: root,
      platform: "darwin",
    })).toBeNull();
  });

  it("discovers an executable from an absolute PATH entry and uses the default home", () => {
    const root = temporaryRoot();
    const found = installation(root);
    const home = path.join(root, ".claude");
    mkdirSync(home);
    expect(discoverNativeClaudeInstallation({
      env: { PATH: path.dirname(found.executable) },
      homedir: root,
      platform: "darwin",
    })).toEqual({
      executable: realpathSync(found.executable),
      home: realpathSync(home),
    });
  });

  it("falls back to the user-local executable candidate without invoking a shell", () => {
    const root = temporaryRoot();
    const home = path.join(root, ".claude");
    const bin = path.join(root, ".local", "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const executable = path.join(bin, "claude");
    writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${SUPPORTED_VERSION}'\n`, {
      mode: 0o755,
    });

    expect(discoverNativeClaudeInstallation({
      env: { PATH: "" },
      homedir: root,
      platform: "darwin",
    })).toEqual({
      executable: realpathSync(executable),
      home: realpathSync(home),
    });
  });
});

describe("native Claude runtime composition", () => {
  it("accepts only the complete exact mandatory lifecycle evidence shape", () => {
    const complete = lifecycleEvidence();
    expect(isNativeClaudeLifecycleEvidence(complete)).toBe(true);
    for (const key of Object.keys(complete)) {
      const missing = { ...complete } as Record<string, unknown>;
      delete missing[key];
      expect(isNativeClaudeLifecycleEvidence(missing), `missing ${key}`).toBe(false);
      expect(isNativeClaudeLifecycleEvidence({ ...complete, [key]: false }), `false ${key}`)
        .toBe(false);
    }
    expect(isNativeClaudeLifecycleEvidence({ ...complete, extra: true })).toBe(false);
  });

  it("refuses ambiguous programmatic auth but registers a dormant adapter with programmatic or subscription auth", async () => {
    const root = temporaryRoot();
    const found = installation(root);
    const ambiguousRegistry = new ProviderRegistry();
    expect(createNativeClaudeRuntime({
      registry: ambiguousRegistry,
      isEnabled: () => true,
      installation: found,
      baseEnv: { ANTHROPIC_API_KEY: "api-secret", ANTHROPIC_AUTH_TOKEN: "workload-secret" },
      writerLeaseDbPath: path.join(root, "unauthorized-leases.sqlite"),
      helpers: helpers(),
      lifecycleEvidence: lifecycleEvidence(),
    })).toBeNull();
    expect(await ambiguousRegistry.descriptorCensus()).toEqual([]);

    const registry = new ProviderRegistry();
    let enabled = false;
    const sessionHelpers = helpers();
    const runtimeFactory = vi.fn(() => {
      throw new Error("runtime must stay lazy during history reads");
    });
    const runtime = createNativeClaudeRuntime({
      registry,
      isEnabled: () => enabled,
      installation: found,
      baseEnv: { ANTHROPIC_API_KEY: "test-api-key" },
      writerLeaseDbPath: path.join(root, "leases.sqlite"),
      helpers: sessionHelpers,
      runtimeFactory,
      lifecycleEvidence: lifecycleEvidence(),
    });
    expect(runtime).not.toBeNull();
    expect(await registry.descriptorCensus()).toMatchObject([{
      provider: "anthropic",
      status: "available",
      capabilities: { list: false, read: false, start: false },
    }]);

    enabled = true;
    await runtime!.refreshEnabled();
    await expect(registry.listTasks("anthropic", { home: realpathSync(found.home) }))
      .resolves.toEqual({ items: [], nextCursor: null });
    expect(sessionHelpers.listSessions).toHaveBeenCalledTimes(1);
    expect(runtimeFactory).not.toHaveBeenCalled();

    enabled = false;
    await runtime!.refreshEnabled();
    await expect(registry.listTasks("anthropic", { home: realpathSync(found.home) }))
      .rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
    await runtime!.close();
    await runtime!.close();
  });

  it("constructs under a subscription-only login and hands the CLI its own OAuth token", async () => {
    const root = temporaryRoot();
    const found = installation(root);
    const registry = new ProviderRegistry();
    const sessionHelpers = helpers();
    const runtimeFactory = vi.fn((options: {
      configHome: string;
      sessionId: string;
      baseEnv: Readonly<NodeJS.ProcessEnv>;
    }) => fakeRuntime(options));
    const runtime = createNativeClaudeRuntime({
      registry,
      isEnabled: () => true,
      installation: found,
      baseEnv: { CLAUDE_CODE_OAUTH_TOKEN: "subscription-token" },
      writerLeaseDbPath: path.join(root, "subscription-leases.sqlite"),
      helpers: sessionHelpers,
      runtimeFactory,
      lifecycleEvidence: lifecycleEvidence(),
      idFactory: () => SESSION,
    });
    expect(runtime).not.toBeNull();
    expect(runtime!.auth).toEqual({ authorized: true, method: "subscription" });

    await runtime!.refreshEnabled();
    await expect(registry.listTasks("anthropic", { home: realpathSync(found.home) }))
      .resolves.toEqual({ items: [], nextCursor: null });
    expect(sessionHelpers.listSessions).toHaveBeenCalledTimes(1);

    await expect(runtime!.adapter.startTask({
      home: realpathSync(found.home),
      cwd: realpathSync(found.home),
      permissionMode: "plan",
      input: { text: "verify subscription auth reaches the child env" },
    })).rejects.toMatchObject({ code: "PARTIAL_START" });
    const childEnv = runtimeFactory.mock.calls[0]![0].baseEnv;
    expect(childEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("subscription-token");
    await runtime!.close();
  });

  it("closes adapter, supervisor, and writer store exactly once even when each fails", async () => {
    const root = temporaryRoot();
    const found = installation(root);
    const writerLeases = {
      acquire: vi.fn(() => null),
      close: vi.fn(() => { throw new Error("writer close failed"); }),
    };
    const runtime = createNativeClaudeRuntime({
      registry: new ProviderRegistry(),
      isEnabled: () => false,
      installation: found,
      baseEnv: { ANTHROPIC_API_KEY: "test-api-key" },
      helpers: helpers(),
      writerLeases,
      lifecycleEvidence: lifecycleEvidence(),
    });
    expect(runtime).not.toBeNull();
    const adapterDispose = vi.spyOn(runtime!.adapter, "dispose")
      .mockRejectedValue(new Error("adapter close failed"));
    const supervisorShutdown = vi.spyOn(runtime!.supervisor, "shutdown")
      .mockRejectedValue(new Error("supervisor close failed"));

    const closing = runtime!.close();
    expect(runtime!.close()).toBe(closing);
    await expect(closing).rejects.toThrow("adapter close failed");
    expect(adapterDispose).toHaveBeenCalledTimes(1);
    expect(supervisorShutdown).toHaveBeenCalledTimes(1);
    expect(writerLeases.close).toHaveBeenCalledTimes(1);

    adapterDispose.mockRestore();
    supervisorShutdown.mockRestore();
    await runtime!.adapter.dispose();
    await runtime!.supervisor.shutdown();
  });

  it("serializes captured enable and disable transitions in safe order", async () => {
    const root = temporaryRoot();
    const found = installation(root);
    let enabled = false;
    const runtime = createNativeClaudeRuntime({
      registry: new ProviderRegistry(),
      isEnabled: () => enabled,
      installation: found,
      baseEnv: { ANTHROPIC_API_KEY: "test-api-key" },
      writerLeaseDbPath: path.join(root, "leases.sqlite"),
      helpers: helpers(),
      lifecycleEvidence: lifecycleEvidence(),
    });
    expect(runtime).not.toBeNull();
    const order: string[] = [];
    let supervisorCalls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    vi.spyOn(runtime!.supervisor, "refreshEnabled").mockImplementation(async () => {
      order.push("supervisor");
      supervisorCalls += 1;
      if (supervisorCalls === 1) await firstGate;
    });
    vi.spyOn(runtime!.adapter, "refreshEnabled").mockImplementation(async () => {
      order.push("adapter");
    });

    enabled = true;
    const enabling = runtime!.refreshEnabled();
    await vi.waitFor(() => expect(supervisorCalls).toBe(1));
    expect((await runtime!.adapter.capabilities()).list).toBe(false);
    enabled = false;
    const disabling = runtime!.refreshEnabled();
    expect((await runtime!.adapter.capabilities()).list).toBe(false);
    releaseFirst();
    await Promise.all([enabling, disabling]);
    expect((await runtime!.adapter.capabilities()).list).toBe(false);
    expect(order.at(-1)).toBe("supervisor");
    await runtime!.close();
  });

  it("fails closed when the adapter transition rejects after supervisor readiness", async () => {
    const root = temporaryRoot();
    const found = installation(root);
    let enabled = false;
    const runtime = createNativeClaudeRuntime({
      registry: new ProviderRegistry(),
      isEnabled: () => enabled,
      installation: found,
      baseEnv: { ANTHROPIC_API_KEY: "test-api-key" },
      writerLeaseDbPath: path.join(root, "leases.sqlite"),
      helpers: helpers(),
      lifecycleEvidence: lifecycleEvidence(),
    });
    expect(runtime).not.toBeNull();
    vi.spyOn(runtime!.adapter, "refreshEnabled")
      .mockRejectedValueOnce(new Error("synthetic adapter activation failure"));

    enabled = true;
    await expect(runtime!.refreshEnabled()).resolves.toBe(false);
    expect(runtime!.isAppliedEnabled()).toBe(false);
    expect((await runtime!.adapter.capabilities()).start).toBe(false);
    await runtime!.close();
  });

  it("keeps production execution disabled without explicit lifecycle evidence", async () => {
    const root = temporaryRoot();
    const found = installation(root);
    const runtime = createNativeClaudeRuntime({
      registry: new ProviderRegistry(),
      isEnabled: () => true,
      installation: found,
      baseEnv: { ANTHROPIC_API_KEY: "test-api-key" },
      writerLeaseDbPath: path.join(root, "leases.sqlite"),
      helpers: helpers(),
    });

    expect(runtime).not.toBeNull();
    expect(runtime?.compatibility).toEqual({
      cliVersion: "2.1.207",
      lifecycleVerified: false,
    });
    expect((await runtime!.adapter.capabilities()).start).toBe(false);
    await runtime!.close();
  });

  it("runs a bounded credential-free version probe before accepting compatibility", async () => {
    const root = temporaryRoot();
    const found = installation(root);
    const versionProbe = vi.fn(() => ({
      status: 0,
      signal: null,
      stdout: `${SUPPORTED_VERSION}\n`,
      stderr: "",
    }));
    const runtime = createNativeClaudeRuntime({
      registry: new ProviderRegistry(),
      isEnabled: () => false,
      installation: found,
      baseEnv: {
        ANTHROPIC_API_KEY: "must-not-enter-version-probe",
        KEEP: "operational",
      },
      writerLeaseDbPath: path.join(root, "leases.sqlite"),
      helpers: helpers(),
      lifecycleEvidence: lifecycleEvidence(),
      versionProbe,
    });

    expect(runtime).not.toBeNull();
    expect(versionProbe).toHaveBeenCalledTimes(1);
    const invocation = versionProbe.mock.calls[0]![0] as {
      executable: string;
      args: readonly string[];
      timeoutMs: number;
      maxOutputBytes: number;
      env: Readonly<Record<string, string>>;
    };
    expect(invocation).toMatchObject({
      executable: realpathSync(found.executable),
      args: ["--version"],
      timeoutMs: expect.any(Number),
      maxOutputBytes: expect.any(Number),
    });
    expect(invocation.timeoutMs).toBeGreaterThan(0);
    expect(invocation.timeoutMs).toBeLessThanOrEqual(5_000);
    expect(invocation.maxOutputBytes).toBeGreaterThan(0);
    expect(invocation.maxOutputBytes).toBeLessThanOrEqual(16_384);
    expect(invocation.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(invocation.env).not.toHaveProperty("KEEP");
    await runtime!.close();
  });

  it.each([
    ["fake", { status: 0, signal: null, stdout: "fake Claude 2.1.207\n", stderr: "" }],
    ["incompatible", { status: 0, signal: null, stdout: "2.1.206 (Claude Code)\n", stderr: "" }],
    ["timeout", { status: null, signal: "SIGTERM", stdout: "", stderr: "" }],
    ["oversized", {
      status: 0,
      signal: null,
      stdout: `${SUPPORTED_VERSION}\n${"x".repeat(20_000)}`,
      stderr: "",
    }],
  ])("rejects a %s Claude version probe", async (_label, result) => {
    const root = temporaryRoot();
    const found = installation(root);
    const registry = new ProviderRegistry();
    const runtime = createNativeClaudeRuntime({
      registry,
      isEnabled: () => true,
      installation: found,
      baseEnv: { ANTHROPIC_API_KEY: "test-api-key" },
      writerLeaseDbPath: path.join(root, `${_label}-leases.sqlite`),
      helpers: helpers(),
      lifecycleEvidence: lifecycleEvidence(),
      versionProbe: () => result,
    });
    if (runtime) await runtime.close();

    expect(runtime).toBeNull();
    expect(await registry.descriptorCensus()).toEqual([]);
  });

  it("rejects ambiguous programmatic auth methods before registration", async () => {
    const root = temporaryRoot();
    const found = installation(root);
    const registry = new ProviderRegistry();
    const runtime = createNativeClaudeRuntime({
      registry,
      isEnabled: () => true,
      installation: found,
      baseEnv: {
        ANTHROPIC_API_KEY: "api-key",
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: "us-east-1",
      },
      writerLeaseDbPath: path.join(root, "leases.sqlite"),
      helpers: helpers(),
      lifecycleEvidence: lifecycleEvidence(),
    });
    if (runtime) await runtime.close();

    expect(runtime).toBeNull();
    expect(await registry.descriptorCensus()).toEqual([]);
  });

  it("passes only the selected billing method plus operational env to the runtime", async () => {
    const root = temporaryRoot();
    const found = installation(root);
    const runtimeFactory = vi.fn((options: {
      configHome: string;
      sessionId: string;
      baseEnv: Readonly<NodeJS.ProcessEnv>;
    }) =>
      fakeRuntime(options));
    const runtime = createNativeClaudeRuntime({
      registry: new ProviderRegistry(),
      isEnabled: () => true,
      installation: found,
      baseEnv: {
        ANTHROPIC_API_KEY: "api-key",
        CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
        CLAUDE_CODE_USE_BEDROCK: "0",
        CLAUDE_CODE_USE_VERTEX: "0",
        CLAUDE_CODE_USE_FOUNDRY: "0",
        ANTHROPIC_VERTEX_PROJECT_ID: "unused-project",
        ANTHROPIC_FOUNDRY_RESOURCE: "unused-resource",
        CLAUDE_UI_TOKEN: "product-secret",
        CLAUDE_UI_CLAUDE_BIN: "/untrusted/product/path",
        DEVHUB_PROVIDER_MUTATION_TOKEN: "devhub-secret",
        DEVHUB_CLAUDE_EXECUTABLE: "/untrusted/devhub/path",
        OPENAI_KEY: "cross-provider-secret",
        OPENAI_API_KEY: "cross-provider-secret",
        CODEX_API_KEY: "cross-provider-secret",
        CUSTOM_MCP_TOKEN: "hook-token",
        KEEP: "operational",
        HOME: "/Users/test",
        LANG: "en_US.UTF-8",
        HTTPS_PROXY: "http://localhost:8080",
        PATH: "/usr/bin:/bin",
      },
      writerLeaseDbPath: path.join(root, "leases.sqlite"),
      helpers: helpers(),
      lifecycleEvidence: lifecycleEvidence(),
      runtimeFactory,
      idFactory: () => SESSION,
    });
    expect(runtime).not.toBeNull();

    await runtime!.refreshEnabled();
    await expect(runtime!.adapter.startTask({
      home: realpathSync(found.home),
      cwd: realpathSync(found.home),
      permissionMode: "plan",
      input: { text: "verify the authorized child environment" },
    })).rejects.toMatchObject({ code: "PARTIAL_START" });
    const childEnv = runtimeFactory.mock.calls[0]![0].baseEnv;
    expect(childEnv).toEqual({
      ANTHROPIC_API_KEY: "api-key",
      CUSTOM_MCP_TOKEN: "hook-token",
      KEEP: "operational",
      HOME: "/Users/test",
      LANG: "en_US.UTF-8",
      HTTPS_PROXY: "http://localhost:8080",
      PATH: "/usr/bin:/bin",
    });
    expect(childEnv).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(childEnv).not.toHaveProperty("CLAUDE_CODE_USE_BEDROCK");
    expect(childEnv).not.toHaveProperty("CLAUDE_CODE_USE_VERTEX");
    expect(childEnv).not.toHaveProperty("CLAUDE_CODE_USE_FOUNDRY");
    expect(childEnv).not.toHaveProperty("ANTHROPIC_VERTEX_PROJECT_ID");
    expect(childEnv).not.toHaveProperty("ANTHROPIC_FOUNDRY_RESOURCE");
    expect(childEnv).not.toHaveProperty("CLAUDE_UI_TOKEN");
    expect(childEnv).not.toHaveProperty("CLAUDE_UI_CLAUDE_BIN");
    expect(childEnv).not.toHaveProperty("DEVHUB_PROVIDER_MUTATION_TOKEN");
    expect(childEnv).not.toHaveProperty("DEVHUB_CLAUDE_EXECUTABLE");
    expect(childEnv).not.toHaveProperty("OPENAI_KEY");
    expect(childEnv).not.toHaveProperty("OPENAI_API_KEY");
    expect(childEnv).not.toHaveProperty("CODEX_API_KEY");
    await runtime!.close();
  });
});

function settingsEngine(persistentClaude: boolean): Engine {
  let settings: AppSettings = {
    devHubFeatures: { ...DEFAULT_DEVHUB_FEATURE_FLAGS, persistentClaude },
  };
  return {
    getSettings: () => settings,
    setSettings: (partial: Partial<AppSettings>) => {
      settings = { ...settings, ...partial };
      return settings;
    },
  } as Engine;
}

describe("buildApp native Claude wiring", () => {
  it("exposes availability through settings and provider routes, then closes cleanly", async () => {
    const root = temporaryRoot();
    const found = installation(root);
    const sessionHelpers = helpers();
    const { app } = buildApp({
      engine: settingsEngine(false),
      token: ACCESS_TOKEN,
      nativeCodex: false,
      nativeClaude: {
        installation: found,
        baseEnv: { ANTHROPIC_API_KEY: "test-api-key" },
        writerLeaseDbPath: path.join(root, "leases.sqlite"),
        helpers: sessionHelpers,
        lifecycleEvidence: lifecycleEvidence(),
      },
    });
    await app.ready();

    const enabled = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      payload: {
        devHubFeatures: { ...DEFAULT_DEVHUB_FEATURE_FLAGS, persistentClaude: true },
      },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().devHubFeatures.persistentClaude).toBe(true);
    const tasks = await app.inject({
      method: "GET",
      url: `/api/providers/anthropic/tasks?home=${encodeURIComponent(realpathSync(found.home))}`,
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(tasks.statusCode).toBe(200);
    expect(tasks.json()).toEqual({ items: [], nextCursor: null });
    await app.close();
  });

  it("applies a saved request under a subscription-only login with a valid mutation token", async () => {
    const root = temporaryRoot();
    const found = installation(root);
    const { app } = buildApp({
      engine: settingsEngine(true),
      token: ACCESS_TOKEN,
      nativeCodex: false,
      nativeClaude: {
        installation: found,
        baseEnv: { CLAUDE_CODE_OAUTH_TOKEN: "subscription-only" },
        writerLeaseDbPath: path.join(root, "leases.sqlite"),
        helpers: helpers(),
        lifecycleEvidence: lifecycleEvidence(),
      },
    });
    await app.ready();
    const response = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(response.json().devHubFeatures.persistentClaude).toBe(true);
    expect(response.json().requestedDevHubFeatures.persistentClaude).toBe(true);
    await app.close();
  });

  it("keeps a saved request clamped off when auth is ambiguous", async () => {
    const root = temporaryRoot();
    const found = installation(root);
    const { app } = buildApp({
      engine: settingsEngine(true),
      token: ACCESS_TOKEN,
      nativeCodex: false,
      nativeClaude: {
        installation: found,
        baseEnv: { ANTHROPIC_API_KEY: "api-secret", ANTHROPIC_AUTH_TOKEN: "workload-secret" },
        writerLeaseDbPath: path.join(root, "ambiguous-leases.sqlite"),
        helpers: helpers(),
        lifecycleEvidence: lifecycleEvidence(),
      },
    });
    await app.ready();
    const response = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(response.json().devHubFeatures.persistentClaude).toBe(false);
    expect(response.json().requestedDevHubFeatures.persistentClaude).toBe(true);
    await app.close();
  });

  it("keeps persistent Claude requested but ineffective without a mutation token", async () => {
    const root = temporaryRoot();
    const found = installation(root);
    const { app } = buildApp({
      engine: settingsEngine(true),
      nativeCodex: false,
      nativeClaude: {
        installation: found,
        baseEnv: { ANTHROPIC_API_KEY: "test-api-key" },
        writerLeaseDbPath: path.join(root, "leases.sqlite"),
        helpers: helpers(),
        lifecycleEvidence: lifecycleEvidence(),
      },
    });
    await app.ready();

    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settings.json().requestedDevHubFeatures.persistentClaude).toBe(true);
    expect(settings.json().devHubFeatures.persistentClaude).toBe(false);
    const providers = await app.inject({ method: "GET", url: "/api/providers" });
    expect(providers.json()[0].capabilities.start).toBe(false);
    const mutation = await app.inject({
      method: "POST",
      url: "/api/providers/anthropic/tasks",
      payload: { home: realpathSync(found.home), cwd: realpathSync(found.home) },
    });
    expect(mutation.statusCode).toBe(503);
    expect(mutation.json()).toEqual({ error: "provider_mutations_disabled" });
    await app.close();
  });

  it("does not let runtime option objects override the server-owned registry or token clamp", async () => {
    const root = temporaryRoot();
    const found = installation(root);
    const ownedRegistry = new ProviderRegistry();
    const hostileRegistry = new ProviderRegistry();
    const hostileOptions = {
      installation: found,
      baseEnv: { ANTHROPIC_API_KEY: "test-api-key" },
      writerLeaseDbPath: path.join(root, "hostile-leases.sqlite"),
      helpers: helpers(),
      lifecycleEvidence: lifecycleEvidence(),
      registry: hostileRegistry,
      isEnabled: () => true,
    } as never;
    const { app } = buildApp({
      engine: settingsEngine(true),
      providerRegistry: ownedRegistry,
      nativeCodex: false,
      nativeClaude: hostileOptions,
    });
    await app.ready();

    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settings.json().requestedDevHubFeatures.persistentClaude).toBe(true);
    expect(settings.json().devHubFeatures.persistentClaude).toBe(false);
    const providers = await app.inject({ method: "GET", url: "/api/providers" });
    expect(providers.json()).toMatchObject([{
      provider: "anthropic",
      status: "available",
      capabilities: { start: false, resume: false, send: false },
    }]);
    expect(await hostileRegistry.descriptorCensus()).toEqual([]);
    await app.close();
  });

  it("returns an honest partial task when the fake runtime is not helper-visible", async () => {
    const root = temporaryRoot();
    const found = installation(root);
    const runtimeFactory = vi.fn((options: { configHome: string; sessionId: string }) =>
      fakeRuntime(options));
    const { app } = buildApp({
      engine: settingsEngine(false),
      token: ACCESS_TOKEN,
      nativeCodex: false,
      nativeClaude: {
        installation: found,
        baseEnv: { ANTHROPIC_API_KEY: "test-api-key" },
        writerLeaseDbPath: path.join(root, "leases.sqlite"),
        helpers: helpers(),
        lifecycleEvidence: lifecycleEvidence(),
        runtimeFactory,
        idFactory: () => SESSION,
      },
    });
    await app.ready();
    const enabled = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      payload: {
        devHubFeatures: { ...DEFAULT_DEVHUB_FEATURE_FLAGS, persistentClaude: true },
      },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().devHubFeatures.persistentClaude).toBe(true);

    const started = await app.inject({
      method: "POST",
      url: "/api/providers/anthropic/tasks",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      payload: {
        home: realpathSync(found.home),
        cwd: realpathSync(found.home),
        permissionMode: "plan",
        input: { text: "synthetic only" },
      },
    });
    expect(started.statusCode).toBe(201);
    expect(started.json()).toMatchObject({
      outcome: "partial",
      code: "PARTIAL_START",
      provider: "anthropic",
      task: {
        key: { provider: "anthropic", nativeTaskId: SESSION },
        source: "native",
      },
    });
    expect(runtimeFactory).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("returns a requested-but-clamped setting after a failed Claude activation", async () => {
    const root = temporaryRoot();
    const found = installation(root);
    vi.spyOn(ClaudePersistentSupervisor.prototype, "refreshEnabled")
      .mockRejectedValueOnce(new Error("synthetic activation failure"));
    const { app } = buildApp({
      engine: settingsEngine(false),
      token: ACCESS_TOKEN,
      nativeCodex: false,
      nativeClaude: {
        installation: found,
        baseEnv: { ANTHROPIC_API_KEY: "test-api-key" },
        writerLeaseDbPath: path.join(root, "leases.sqlite"),
        helpers: helpers(),
        lifecycleEvidence: lifecycleEvidence(),
      },
    });
    await app.ready();

    const response = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      payload: {
        devHubFeatures: { ...DEFAULT_DEVHUB_FEATURE_FLAGS, persistentClaude: true },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().requestedDevHubFeatures.persistentClaude).toBe(true);
    expect(response.json().devHubFeatures.persistentClaude).toBe(false);
    const later = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(later.json().requestedDevHubFeatures.persistentClaude).toBe(true);
    expect(later.json().devHubFeatures.persistentClaude).toBe(false);
    await app.close();
  });

  it("honors explicit disable and suppresses implicit discovery for an injected registry", async () => {
    const disabled = buildApp({
      engine: settingsEngine(true),
      nativeCodex: false,
      nativeClaude: false,
    }).app;
    await disabled.ready();
    expect((await disabled.inject({ method: "GET", url: "/api/providers" })).json())
      .toEqual([]);
    expect((await disabled.inject({ method: "GET", url: "/api/settings" })).json()
      .devHubFeatures.persistentClaude).toBe(false);
    await disabled.close();

    const injected = buildApp({
      engine: settingsEngine(true),
      providerRegistry: new ProviderRegistry(),
      nativeCodex: false,
    }).app;
    await injected.ready();
    expect((await injected.inject({ method: "GET", url: "/api/providers" })).json())
      .toEqual([]);
    expect((await injected.inject({ method: "GET", url: "/api/settings" })).json()
      .devHubFeatures.persistentClaude).toBe(false);
    await injected.close();
  });

  it("awaits both provider runtime refreshes before resolving a feature change", async () => {
    const root = temporaryRoot();
    const found = installation(root);
    const codexHome = path.join(root, "codex-home");
    const codexExecutable = path.join(root, "codex");
    mkdirSync(codexHome);
    writeFileSync(codexExecutable, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const codexRefresh = vi.spyOn(CodexAppServerSupervisor.prototype, "refreshEnabled")
      .mockImplementation(async () => gate);
    const claudeRefresh = vi.spyOn(ClaudePersistentSupervisor.prototype, "refreshEnabled")
      .mockImplementation(async () => gate);
    const { app } = buildApp({
      engine: settingsEngine(false),
      token: ACCESS_TOKEN,
      nativeCodex: {
        installation: { executable: codexExecutable, home: codexHome },
        cursorSecret: "0123456789abcdef0123456789abcdef",
      },
      nativeClaude: {
        installation: found,
        baseEnv: { ANTHROPIC_API_KEY: "test-api-key" },
        writerLeaseDbPath: path.join(root, "leases.sqlite"),
        helpers: helpers(),
        lifecycleEvidence: lifecycleEvidence(),
      },
    });
    await app.ready();

    let settled = false;
    const pending = app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      payload: {
        devHubFeatures: {
          ...DEFAULT_DEVHUB_FEATURE_FLAGS,
          nativeCodex: true,
          persistentClaude: true,
        },
      },
    }).then((response) => {
      settled = true;
      return response;
    });
    await vi.waitFor(() => {
      expect(codexRefresh).toHaveBeenCalledTimes(1);
      expect(claudeRefresh).toHaveBeenCalledTimes(1);
    });
    expect(settled).toBe(false);
    release();
    expect((await pending).statusCode).toBe(200);
    await app.close();
  });

  it("closes both provider runtimes when one peer close fails", async () => {
    const root = temporaryRoot();
    const found = installation(root);
    const codexHome = path.join(root, "codex-home");
    const codexExecutable = path.join(root, "codex");
    mkdirSync(codexHome);
    writeFileSync(codexExecutable, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const codexDispose = vi.spyOn(CodexNativeAdapter.prototype, "dispose")
      .mockRejectedValue(new Error("codex close failed"));
    const claudeDispose = vi.spyOn(ClaudeNativeAdapter.prototype, "dispose")
      .mockResolvedValue();
    const { app } = buildApp({
      engine: settingsEngine(false),
      token: ACCESS_TOKEN,
      nativeCodex: {
        installation: { executable: codexExecutable, home: codexHome },
        cursorSecret: "0123456789abcdef0123456789abcdef",
      },
      nativeClaude: {
        installation: found,
        baseEnv: { ANTHROPIC_API_KEY: "test-api-key" },
        writerLeaseDbPath: path.join(root, "leases.sqlite"),
        helpers: helpers(),
        lifecycleEvidence: lifecycleEvidence(),
      },
    });
    await app.ready();

    await expect(app.close()).rejects.toThrow("codex close failed");
    expect(codexDispose).toHaveBeenCalledTimes(1);
    expect(claudeDispose).toHaveBeenCalledTimes(1);
  });
});
