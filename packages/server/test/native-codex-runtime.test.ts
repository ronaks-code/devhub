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
  AppServerProcessError,
  DEFAULT_DEVHUB_FEATURE_FLAGS,
  ProviderRegistry,
  type CodexSupervisorProcess,
  type CodexSupervisorProcessFactory,
} from "@devhub/engine/providers";
import {
  createNativeCodexRuntime,
  discoverNativeCodexInstallation,
} from "../src/native-codex-runtime.js";
import { buildApp } from "../src/app.js";

const created: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "devhub-native-codex-"));
  created.push(root);
  return root;
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native Codex installation discovery", () => {
  it("resolves an executable PATH candidate and canonical CODEX_HOME without spawning", () => {
    const root = temporaryRoot();
    const bin = path.join(root, "bin");
    const home = path.join(root, "codex-home");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    const executable = path.join(bin, "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    expect(discoverNativeCodexInstallation({
      env: { PATH: bin, CODEX_HOME: home },
      homedir: root,
      platform: "darwin",
    })).toEqual({
      executable: realpathSync(executable),
      home: realpathSync(home),
    });
  });

  it("fails closed for invalid explicit binaries, permissions, and relative homes", () => {
    const root = temporaryRoot();
    const bin = path.join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const executable = path.join(bin, "codex");
    writeFileSync(executable, "not executable");
    chmodSync(executable, 0o644);

    expect(discoverNativeCodexInstallation({
      env: { DEVHUB_CODEX_EXECUTABLE: "relative/codex", PATH: bin },
      homedir: root,
      platform: "darwin",
    })).toBeNull();
    expect(discoverNativeCodexInstallation({
      env: { DEVHUB_CODEX_EXECUTABLE: executable },
      homedir: root,
      platform: "darwin",
    })).toBeNull();
    chmodSync(executable, 0o755);
    expect(discoverNativeCodexInstallation({
      env: { DEVHUB_CODEX_EXECUTABLE: executable, CODEX_HOME: "relative-home" },
      homedir: root,
      platform: "darwin",
    })).toBeNull();
  });
});

function fakeProcesses(): {
  readonly factory: CodexSupervisorProcessFactory;
  readonly creations: ReturnType<typeof vi.fn>;
  readonly shutdowns: ReturnType<typeof vi.fn>;
} {
  const creations = vi.fn();
  const shutdowns = vi.fn();
  const factory: CodexSupervisorProcessFactory = (options) => {
    creations(options.generation);
    let resolveTerminal!: (value: Awaited<CodexSupervisorProcess["terminated"]>) => void;
    const terminated = new Promise<Awaited<CodexSupervisorProcess["terminated"]>>((resolve) => {
      resolveTerminal = resolve;
    });
    let terminal: Awaited<CodexSupervisorProcess["terminated"]> | null = null;
    const process: CodexSupervisorProcess = {
      home: options.home,
      generation: options.generation,
      terminated,
      async start() {
        const signal = new AbortController().signal;
        await options.reconcile({
          home: options.home,
          generation: options.generation,
          signal,
          rpc: {
            async call<T>(): Promise<T> {
              throw new Error("unexpected reconcile RPC");
            },
          },
        });
        return { home: options.home, generation: options.generation, signal };
      },
      async call<T>(method: string): Promise<T> {
        if (method === "thread/list") {
          return { data: [], nextCursor: null, backwardsCursor: null } as T;
        }
        throw new Error(`unexpected fake Codex method ${method}`);
      },
      async shutdown() {
        if (terminal !== null) return terminal;
        shutdowns(options.generation);
        terminal = {
          home: options.home,
          generation: options.generation,
          intentional: true,
          exitSeen: true,
          safeToRestart: true,
          error: new AppServerProcessError("SHUTDOWN", "test shutdown"),
        };
        resolveTerminal(terminal);
        return terminal;
      },
    };
    return process;
  };
  return { factory, creations, shutdowns };
}

describe("native Codex runtime composition", () => {
  it("registers dormant, spawns lazily, suspends, and reacquires after re-enable", async () => {
    const root = temporaryRoot();
    const executable = path.join(root, "codex");
    const home = path.join(root, "home");
    writeFileSync(executable, "binary", { mode: 0o755 });
    mkdirSync(home);
    const registry = new ProviderRegistry();
    const fake = fakeProcesses();
    let enabled = false;
    const runtime = createNativeCodexRuntime({
      registry,
      isEnabled: () => enabled,
      installation: { executable, home },
      cursorSecret: "0123456789abcdef0123456789abcdef",
      processFactory: fake.factory,
      clientVersion: "test",
    });
    expect(runtime).not.toBeNull();
    expect(await registry.descriptorCensus()).toMatchObject([{
      provider: "openai",
      status: "available",
      capabilities: { list: false, start: false, subscribe: false },
    }]);
    expect(fake.creations).not.toHaveBeenCalled();

    enabled = true;
    await runtime!.refreshEnabled();
    expect(fake.creations).not.toHaveBeenCalled();
    await expect(registry.listTasks("openai", { home })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(fake.creations).toHaveBeenCalledTimes(1);

    enabled = false;
    await runtime!.refreshEnabled();
    expect(fake.shutdowns).toHaveBeenCalledTimes(1);
    await expect(registry.listTasks("openai", { home })).rejects.toMatchObject({
      code: "PROVIDER_CAPABILITY_UNAVAILABLE",
    });
    expect(fake.creations).toHaveBeenCalledTimes(1);

    enabled = true;
    await runtime!.refreshEnabled();
    await registry.listTasks("openai", { home });
    expect(fake.creations).toHaveBeenCalledTimes(2);

    await runtime!.close();
    await runtime!.close();
    expect(fake.shutdowns).toHaveBeenCalledTimes(2);
  });

  it("does not register anything when no verified installation exists", () => {
    const registry = new ProviderRegistry();
    const runtime = createNativeCodexRuntime({
      registry,
      isEnabled: () => true,
      installation: null,
    });
    expect(runtime).toBeNull();
    expect(() => registry.lookup("openai", path.join(temporaryRoot(), "missing")))
      .toThrow(/no openai provider adapter/i);
  });
});

function settingsEngine(nativeCodex: boolean): {
  readonly engine: Engine;
  readonly settings: () => AppSettings;
} {
  let settings: AppSettings = {
    devHubFeatures: { ...DEFAULT_DEVHUB_FEATURE_FLAGS, nativeCodex },
  };
  return {
    engine: {
      getSettings: () => settings,
      setSettings: (partial: Partial<AppSettings>) => {
        settings = { ...settings, ...partial };
        return settings;
      },
    } as Engine,
    settings: () => settings,
  };
}

describe("buildApp native Codex wiring", () => {
  it("exposes availability, enables lazily, and shuts down through settings and app close", async () => {
    const root = temporaryRoot();
    const executable = path.join(root, "codex");
    const home = path.join(root, "home");
    writeFileSync(executable, "binary", { mode: 0o755 });
    mkdirSync(home);
    const fake = fakeProcesses();
    const state = settingsEngine(false);
    const { app } = buildApp({
      engine: state.engine,
      nativeCodex: {
        installation: { executable, home },
        processFactory: fake.factory,
        cursorSecret: "0123456789abcdef0123456789abcdef",
        clientVersion: "test",
      },
    });
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/api/providers" })).json())
      .toMatchObject([{
        provider: "openai",
        capabilities: { list: false, start: false },
      }]);
    const enabled = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        devHubFeatures: { ...DEFAULT_DEVHUB_FEATURE_FLAGS, nativeCodex: true },
      },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().devHubFeatures.nativeCodex).toBe(true);
    expect(fake.creations).not.toHaveBeenCalled();

    const tasks = await app.inject({
      method: "GET",
      url: `/api/providers/openai/tasks?home=${encodeURIComponent(home)}`,
    });
    expect(tasks.statusCode).toBe(200);
    expect(tasks.json()).toEqual({ items: [], nextCursor: null });
    expect(fake.creations).toHaveBeenCalledTimes(1);

    const disabled = await app.inject({
      method: "PUT",
      url: "/api/settings",
      // Post-M3 cutover: nativeCodex now defaults ON, so the rollback step must set it
      // explicitly false to exercise the disable-triggers-shutdown path.
      payload: { devHubFeatures: { ...DEFAULT_DEVHUB_FEATURE_FLAGS, nativeCodex: false } },
    });
    expect(disabled.statusCode).toBe(200);
    expect(fake.shutdowns).toHaveBeenCalledTimes(1);
    await app.close();
    expect(fake.shutdowns).toHaveBeenCalledTimes(1);
  });

  it("clamps a requested flag when runtime is missing and suppresses host discovery for an injected registry", async () => {
    const missingState = settingsEngine(true);
    const missing = buildApp({
      engine: missingState.engine,
      nativeCodex: { installation: null },
    }).app;
    await missing.ready();
    expect((await missing.inject({ method: "GET", url: "/api/settings" })).json()
      .devHubFeatures.nativeCodex).toBe(false);
    expect((await missing.inject({ method: "GET", url: "/api/providers" })).json()).toEqual([]);
    await missing.close();

    const injectedState = settingsEngine(true);
    const injected = buildApp({
      engine: injectedState.engine,
      providerRegistry: new ProviderRegistry(),
    }).app;
    await injected.ready();
    expect((await injected.inject({ method: "GET", url: "/api/providers" })).json()).toEqual([]);
    await injected.close();
  });
});
