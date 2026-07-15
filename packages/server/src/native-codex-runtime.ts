import { randomBytes } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  realpathSync,
  statSync,
} from "node:fs";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths } from "@devhub/engine";
import {
  canonicalizeProviderHome,
  CodexAppServerSupervisor,
  CodexNativeAdapter,
  createAdapterReconciliationStore,
  NativeTaskWriterLeaseStore,
  type CodexNativeAdapterWriterLeases,
  type CodexSupervisorProcessFactory,
  type ProviderReconciliationStore,
  type ProviderRegistry,
} from "@devhub/engine/providers";

export interface NativeCodexInstallation {
  readonly executable: string;
  readonly home: string;
}

export interface NativeCodexDiscoveryOptions {
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly homedir?: string;
  readonly platform?: NodeJS.Platform;
}

export interface NativeCodexWriterLeases extends CodexNativeAdapterWriterLeases {
  close(): void;
}

export interface CreateNativeCodexRuntimeOptions {
  readonly registry: ProviderRegistry;
  readonly isEnabled: () => boolean;
  /** undefined discovers locally; null explicitly disables discovery/runtime. */
  readonly installation?: NativeCodexInstallation | null;
  readonly cursorSecret?: string | Uint8Array;
  readonly processFactory?: CodexSupervisorProcessFactory;
  readonly clientVersion?: string;
  readonly discovery?: NativeCodexDiscoveryOptions;
  /**
   * The exact writer-lease store Claude uses (`native-task-writer-leases.sqlite`).
   * Inject the shared instance so Codex and Claude fence the same key space with
   * no second competing lease. When omitted the runtime opens its own handle on
   * the same default path; when the path is unavailable the runtime stays
   * unfenced rather than failing to start.
   */
  readonly writerLeases?: NativeCodexWriterLeases;
  readonly writerLeaseDbPath?: string;
  /**
   * Raw durable reconciliation seam over `provider_reconciliation_state` (the
   * shared engine index store). The runtime wraps it in the fail-closed adapter
   * seam and injects it. Fencing engages only when both this and a writer-lease
   * store are present.
   */
  readonly reconciliationStore?: ProviderReconciliationStore;
}

export interface NativeCodexRuntime {
  readonly available: true;
  readonly installation: Readonly<NativeCodexInstallation>;
  readonly adapter: CodexNativeAdapter;
  readonly supervisor: CodexAppServerSupervisor;
  refreshEnabled(): Promise<void>;
  close(): Promise<void>;
}

function executableFile(candidate: string, platform: NodeJS.Platform): string | null {
  if (typeof candidate !== "string" || candidate.length === 0 || !path.isAbsolute(candidate) ||
    candidate.includes("\u0000")) return null;
  try {
    const resolved = realpathSync(candidate);
    const stat = statSync(resolved);
    if (!stat.isFile()) return null;
    if (platform !== "win32") accessSync(resolved, fsConstants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

function codexHome(
  env: Readonly<NodeJS.ProcessEnv>,
  homedir: string,
): string | null {
  const configured = env.CODEX_HOME;
  let candidate: string;
  if (configured === undefined) {
    candidate = path.join(homedir, ".codex");
  } else {
    if (configured.length === 0 || configured !== configured.trim() || configured.includes("\u0000")) {
      return null;
    }
    candidate = configured === "~" || configured.startsWith(`~${path.sep}`)
      ? path.join(homedir, configured.slice(configured === "~" ? 1 : 2))
      : configured;
  }
  if (!path.isAbsolute(candidate)) return null;
  try { return canonicalizeProviderHome(candidate); } catch { return null; }
}

/** Filesystem-only discovery; never invokes Codex or a shell. */
export function discoverNativeCodexInstallation(
  options: NativeCodexDiscoveryOptions = {},
): Readonly<NativeCodexInstallation> | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir();
  if (!path.isAbsolute(homedir)) return null;
  const home = codexHome(env, homedir);
  if (home === null) return null;

  const explicit = env.DEVHUB_CODEX_EXECUTABLE;
  if (explicit !== undefined) {
    if (explicit.length === 0 || explicit !== explicit.trim()) return null;
    const executable = executableFile(explicit, platform);
    return executable === null ? null : Object.freeze({ executable, home });
  }

  const executableName = platform === "win32" ? "codex.exe" : "codex";
  const candidates: string[] = [];
  for (const entry of (env.PATH ?? "").split(path.delimiter)) {
    if (entry.length > 0 && path.isAbsolute(entry)) candidates.push(path.join(entry, executableName));
  }
  if (platform === "darwin") {
    candidates.push(
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
    );
  }
  candidates.push(path.join(homedir, ".local", "bin", executableName));

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const executable = executableFile(candidate, platform);
    if (executable !== null) return Object.freeze({ executable, home });
  }
  return null;
}

function normalizeInstallation(
  installation: NativeCodexInstallation,
): Readonly<NativeCodexInstallation> | null {
  const executable = executableFile(installation.executable, process.platform);
  if (executable === null || !path.isAbsolute(installation.home)) return null;
  try {
    return Object.freeze({ executable, home: canonicalizeProviderHome(installation.home) });
  } catch {
    return null;
  }
}

export function createNativeCodexRuntime(
  options: CreateNativeCodexRuntimeOptions,
): NativeCodexRuntime | null {
  if (!options || !options.registry || typeof options.isEnabled !== "function") {
    throw new TypeError("Native Codex runtime requires a registry and enabled predicate");
  }
  const candidate = options.installation === undefined
    ? discoverNativeCodexInstallation(options.discovery)
    : options.installation;
  if (candidate === null) return null;
  const installation = normalizeInstallation(candidate);
  if (installation === null) return null;

  // Shared writer-lease store: reuse the exact Claude path/primitive; never build
  // a second competing lease. A path/open failure leaves Codex unfenced (still
  // functional) rather than failing the runtime.
  let ownsWriterStore = false;
  let writerLeases: NativeCodexWriterLeases | null = null;
  if (options.writerLeases !== undefined) {
    writerLeases = options.writerLeases;
  } else {
    try {
      const dbPath = options.writerLeaseDbPath ??
        path.join(paths.appDataDir(), "native-task-writer-leases.sqlite");
      if (path.isAbsolute(dbPath) && path.normalize(dbPath) === dbPath) {
        mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
        writerLeases = new NativeTaskWriterLeaseStore({ dbPath });
        ownsWriterStore = true;
      }
    } catch {
      writerLeases = null;
    }
  }
  const reconciliationStore = options.reconciliationStore === undefined
    ? null
    : createAdapterReconciliationStore(options.reconciliationStore);

  let adapter!: CodexNativeAdapter;
  const supervisor = new CodexAppServerSupervisor({
    executable: installation.executable,
    clientVersion: options.clientVersion ?? "devhub-0.0.1",
    isEnabled: options.isEnabled,
    reconcile: (context) => adapter.reconcile(context),
    ...(options.processFactory === undefined ? {} : { processFactory: options.processFactory }),
  });
  adapter = new CodexNativeAdapter({
    home: installation.home,
    supervisor,
    cursorSecret: options.cursorSecret ?? randomBytes(32),
    isEnabled: options.isEnabled,
    ...(writerLeases === null ? {} : { writerLeases }),
    ...(reconciliationStore === null ? {} : { reconciliationStore }),
  });
  options.registry.register(installation.home, adapter);

  let refreshChain: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | null = null;
  let closed = false;
  const enabled = (): boolean => {
    try { return options.isEnabled() === true; } catch { return false; }
  };
  const refreshEnabled = (): Promise<void> => {
    if (closed) return Promise.resolve();
    const refresh = async (): Promise<void> => {
      if (closed) return;
      if (enabled()) {
        await supervisor.refreshEnabled();
        await adapter.refreshEnabled();
      } else {
        await adapter.refreshEnabled();
        await supervisor.refreshEnabled();
      }
    };
    refreshChain = refreshChain.then(refresh, refresh);
    return refreshChain;
  };
  const close = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    closed = true;
    closePromise = (async () => {
      try { await refreshChain; } catch { /* continue shutdown */ }
      let adapterFailure: unknown;
      try { await adapter.dispose(); } catch (error) { adapterFailure = error; }
      try { await supervisor.shutdown(); } catch (error) {
        if (adapterFailure === undefined) adapterFailure = error;
      }
      if (ownsWriterStore && writerLeases !== null) {
        try { writerLeases.close(); } catch (error) {
          if (adapterFailure === undefined) adapterFailure = error;
        }
      }
      if (adapterFailure !== undefined) throw adapterFailure;
    })();
    return closePromise;
  };

  return Object.freeze({
    available: true as const,
    installation,
    adapter,
    supervisor,
    refreshEnabled,
    close,
  });
}
