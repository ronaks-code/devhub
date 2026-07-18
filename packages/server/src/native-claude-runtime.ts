import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { paths, isDevHubNamespaceKey } from "@devhub/engine";
import {
  ClaudeNativeAdapter,
  ClaudePersistentSupervisor,
  ClaudeSessionHelpers,
  createAdapterReconciliationStore,
  NativeTaskWriterLeaseStore,
  resolveClaudeAuth,
  type ClaudeAuthDecision,
  type ClaudeNativeAdapterHelpers,
  type ClaudeNativeAdapterWriterLeases,
  type ClaudeProgrammaticAuthMethod,
  type ClaudeSupervisorRuntimeFactory,
  type ProviderReconciliationStore,
  type ProviderRegistry,
} from "@devhub/engine/providers";

export interface NativeClaudeInstallation {
  readonly executable: string;
  readonly home: string;
}

export interface NativeClaudeDiscoveryOptions {
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly homedir?: string;
  readonly platform?: NodeJS.Platform;
}

export interface NativeClaudeWriterLeases extends ClaudeNativeAdapterWriterLeases {
  close(): void;
}

export interface NativeClaudeLifecycleEvidence {
  readonly cliVersion: "2.1.207";
  readonly rawResume: true;
  readonly postInterruptResume: true;
  readonly forkContinuation: true;
  readonly persistentMultiQuery: true;
  readonly rawPermissionResponse: true;
  readonly rawInterruptReceipt: true;
}

export interface NativeClaudeCompatibility {
  readonly cliVersion: "2.1.207";
  readonly lifecycleVerified: boolean;
}

export interface NativeClaudeVersionProbeInvocation {
  readonly executable: string;
  readonly args: readonly ["--version"];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export interface NativeClaudeVersionProbeResult {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type NativeClaudeVersionProbe = (
  invocation: Readonly<NativeClaudeVersionProbeInvocation>,
) => Readonly<NativeClaudeVersionProbeResult>;

export interface CreateNativeClaudeRuntimeOptions {
  readonly registry: ProviderRegistry;
  readonly isEnabled: () => boolean;
  /** undefined discovers locally; null explicitly disables discovery/runtime. */
  readonly installation?: NativeClaudeInstallation | null;
  readonly baseEnv?: Readonly<NodeJS.ProcessEnv>;
  readonly helpers?: ClaudeNativeAdapterHelpers;
  readonly writerLeaseDbPath?: string;
  readonly writerLeases?: NativeClaudeWriterLeases;
  /**
   * Raw durable reconciliation seam over `provider_reconciliation_state` (the
   * shared engine index store). The runtime wraps it in the fail-closed adapter
   * seam and injects it so the in-memory latch is mirrored durably.
   */
  readonly reconciliationStore?: ProviderReconciliationStore;
  readonly runtimeFactory?: ClaudeSupervisorRuntimeFactory;
  readonly idFactory?: () => string;
  readonly discovery?: NativeClaudeDiscoveryOptions;
  /** Hermetic compatibility seam. Production uses a bounded `--version` subprocess. */
  readonly versionProbe?: NativeClaudeVersionProbe;
  /** Explicit hardware/lifecycle evidence; intentionally absent in production by default. */
  readonly lifecycleEvidence?: Readonly<NativeClaudeLifecycleEvidence>;
}

export interface NativeClaudeRuntime {
  readonly available: true;
  readonly installation: Readonly<NativeClaudeInstallation>;
  readonly auth: Readonly<ClaudeAuthDecision>;
  readonly compatibility: Readonly<NativeClaudeCompatibility>;
  readonly helpers: ClaudeNativeAdapterHelpers;
  readonly writerLeases: NativeClaudeWriterLeases;
  readonly adapter: ClaudeNativeAdapter;
  readonly supervisor: ClaudePersistentSupervisor;
  canEnable(): boolean;
  isAppliedEnabled(): boolean;
  refreshEnabled(): Promise<boolean>;
  close(): Promise<void>;
}

const SUPPORTED_CLAUDE_VERSION_OUTPUT = "2.1.207 (Claude Code)";
const SUPPORTED_CLAUDE_VERSION = "2.1.207" as const;
const VERSION_PROBE_TIMEOUT_MS = 2_000;
const VERSION_PROBE_MAX_OUTPUT_BYTES = 4_096;

function executableFile(candidate: string, platform: NodeJS.Platform): string | null {
  if (
    typeof candidate !== "string" || candidate.length === 0 ||
    candidate.trim() !== candidate || candidate.includes("\u0000") ||
    !path.isAbsolute(candidate)
  ) return null;
  try {
    const resolved = realpathSync(candidate);
    if (!statSync(resolved).isFile()) return null;
    if (platform !== "win32") accessSync(resolved, fsConstants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

function providerHome(candidate: string, homedir: string): string | null {
  if (
    typeof candidate !== "string" || candidate.length === 0 ||
    candidate.trim() !== candidate || candidate.includes("\u0000")
  ) return null;
  const expanded = candidate === "~" || candidate.startsWith(`~${path.sep}`)
    ? path.join(homedir, candidate.slice(candidate === "~" ? 1 : 2))
    : candidate;
  if (!path.isAbsolute(expanded)) return null;
  try {
    const resolved = realpathSync(expanded);
    return statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/** Filesystem-only discovery; never invokes Claude, a shell, or a provider API. */
export function discoverNativeClaudeInstallation(
  options: NativeClaudeDiscoveryOptions = {},
): Readonly<NativeClaudeInstallation> | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir();
  if (!path.isAbsolute(homedir)) return null;
  const home = providerHome(env.CLAUDE_CONFIG_DIR ?? path.join(homedir, ".claude"), homedir);
  if (home === null) return null;

  const explicit = env.DEVHUB_CLAUDE_EXECUTABLE;
  if (explicit !== undefined) {
    const executable = executableFile(explicit, platform);
    return executable === null ? null : Object.freeze({ executable, home });
  }

  const executableName = platform === "win32" ? "claude.exe" : "claude";
  const delimiter = platform === "win32" ? ";" : ":";
  const candidates: string[] = [];
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (entry.length > 0 && path.isAbsolute(entry)) {
      candidates.push(path.join(entry, executableName));
    }
  }
  candidates.push(
    path.join(homedir, ".local", "bin", executableName),
    path.join(homedir, ".claude", "bin", executableName),
    path.join(homedir, ".claude", "local", executableName),
  );
  if (platform === "darwin") {
    candidates.push("/opt/homebrew/bin/claude", "/usr/local/bin/claude");
  } else if (platform !== "win32") {
    candidates.push("/usr/local/bin/claude", "/usr/bin/claude");
  }

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
  installation: NativeClaudeInstallation,
): Readonly<NativeClaudeInstallation> | null {
  const executable = executableFile(installation.executable, process.platform);
  const home = providerHome(installation.home, os.homedir());
  return executable === null || home === null
    ? null
    : Object.freeze({ executable, home });
}

const VERSION_ENV_KEYS = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
] as const);

function versionProbeEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
): Readonly<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of VERSION_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }
  return Object.freeze(env);
}

const defaultVersionProbe: NativeClaudeVersionProbe = (invocation) => {
  const result = spawnSync(invocation.executable, [...invocation.args], {
    encoding: "utf8",
    env: { ...invocation.env },
    maxBuffer: invocation.maxOutputBytes,
    shell: false,
    timeout: invocation.timeoutMs,
    windowsHide: true,
  });
  return Object.freeze({
    status: result.status,
    signal: result.signal,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  });
};

function compatibleClaudeVersion(
  executable: string,
  sourceEnv: Readonly<NodeJS.ProcessEnv>,
  probe: NativeClaudeVersionProbe,
): boolean {
  const invocation: Readonly<NativeClaudeVersionProbeInvocation> = Object.freeze({
    executable,
    args: Object.freeze(["--version"] as const),
    timeoutMs: VERSION_PROBE_TIMEOUT_MS,
    maxOutputBytes: VERSION_PROBE_MAX_OUTPUT_BYTES,
    env: versionProbeEnvironment(sourceEnv),
  });
  try {
    const result = probe(invocation);
    if (
      !result || typeof result !== "object" || result.status !== 0 ||
      result.signal !== null || typeof result.stdout !== "string" ||
      typeof result.stderr !== "string"
    ) return false;
    const bytes = Buffer.byteLength(result.stdout, "utf8") +
      Buffer.byteLength(result.stderr, "utf8");
    if (bytes > invocation.maxOutputBytes || result.stderr.length !== 0) return false;
    return result.stdout === SUPPORTED_CLAUDE_VERSION_OUTPUT ||
      result.stdout === `${SUPPORTED_CLAUDE_VERSION_OUTPUT}\n` ||
      result.stdout === `${SUPPORTED_CLAUDE_VERSION_OUTPUT}\r\n`;
  } catch {
    return false;
  }
}

export function isNativeClaudeLifecycleEvidence(
  value: unknown,
): value is NativeClaudeLifecycleEvidence {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expected = [
      "cliVersion",
      "rawResume",
      "postInterruptResume",
      "forkContinuation",
      "persistentMultiQuery",
      "rawPermissionResponse",
      "rawInterruptReceipt",
    ] as const;
    if (
      Reflect.ownKeys(value).length !== expected.length ||
      expected.some((key) => {
        const descriptor = descriptors[key];
        return !descriptor || !descriptor.enumerable || !("value" in descriptor);
      })
    ) return false;
    return descriptors.cliVersion!.value === SUPPORTED_CLAUDE_VERSION &&
      descriptors.rawResume!.value === true &&
      descriptors.postInterruptResume!.value === true &&
      descriptors.forkContinuation!.value === true &&
      descriptors.persistentMultiQuery!.value === true &&
      descriptors.rawPermissionResponse!.value === true &&
      descriptors.rawInterruptReceipt!.value === true;
  } catch {
    return false;
  }
}

const AUTH_PATH_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "GCLOUD_PROJECT",
  "CLOUD_ML_REGION",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TENANT_ID",
] as const);

const CROSS_PROVIDER_CREDENTIAL_KEYS = new Set([
  "OPENAI_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
]);

function isDevHubOwnedOrCrossProviderSecret(key: string): boolean {
  // Both DevHub namespaces (DEVHUB_*, CLAUDE_UI_*) route through the one shared engine
  // predicate so child-provider scrubbing can never drift between the two prefixes.
  return isDevHubNamespaceKey(key) || CROSS_PROVIDER_CREDENTIAL_KEYS.has(key);
}

function selectedAuthKeys(
  method: ClaudeProgrammaticAuthMethod,
): ReadonlySet<string> {
  switch (method) {
    case "api-key":
      return new Set(["ANTHROPIC_API_KEY"]);
    case "workload-identity":
      return new Set(["ANTHROPIC_AUTH_TOKEN"]);
    case "bedrock":
      return new Set([
        "CLAUDE_CODE_USE_BEDROCK",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_PROFILE",
        "AWS_WEB_IDENTITY_TOKEN_FILE",
        "AWS_ROLE_ARN",
      ]);
    case "vertex":
      return new Set([
        "CLAUDE_CODE_USE_VERTEX",
        "ANTHROPIC_VERTEX_PROJECT_ID",
        "GCLOUD_PROJECT",
        "CLOUD_ML_REGION",
        "GOOGLE_APPLICATION_CREDENTIALS",
      ]);
    case "foundry":
      return new Set([
        "CLAUDE_CODE_USE_FOUNDRY",
        "ANTHROPIC_FOUNDRY_RESOURCE",
        "AZURE_CLIENT_ID",
        "AZURE_CLIENT_SECRET",
        "AZURE_TENANT_ID",
      ]);
  }
}

function authorizedEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
): {
  readonly auth: Readonly<ClaudeAuthDecision>;
  readonly env: Readonly<NodeJS.ProcessEnv>;
} | null {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(source);
    const env: NodeJS.ProcessEnv = {};
    for (const key of Reflect.ownKeys(source)) {
      if (typeof key !== "string") return null;
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
      if (descriptor.value !== undefined && typeof descriptor.value !== "string") return null;
      if (descriptor.value !== undefined && !isDevHubOwnedOrCrossProviderSecret(key)) {
        env[key] = descriptor.value;
      }
    }
    const auth = resolveClaudeAuth(env);
    // Subscription (Pro/Max OAuth) auth relies on the CLI resolving its own login from
    // CLAUDE_CONFIG_DIR, so CLAUDE_CODE_OAUTH_TOKEN must survive here. Every other
    // AUTH_PATH_KEYS entry is still stripped — a subscription login carries no
    // programmatic credential to select, so nothing else in that list is relevant.
    const allowed = auth.method === "subscription"
      ? new Set(["CLAUDE_CODE_OAUTH_TOKEN"])
      : selectedAuthKeys(auth.method);
    for (const key of AUTH_PATH_KEYS) {
      if (!allowed.has(key)) delete env[key];
    }
    return Object.freeze({ auth, env: Object.freeze(env) });
  } catch {
    return null;
  }
}

function defaultWriterLeaseDbPath(): string {
  return path.join(paths.appDataDir(), "native-task-writer-leases.sqlite");
}

export function createNativeClaudeRuntime(
  options: CreateNativeClaudeRuntimeOptions,
): NativeClaudeRuntime | null {
  if (!options || !options.registry || typeof options.isEnabled !== "function") {
    throw new TypeError("Native Claude runtime requires a registry and enabled predicate");
  }
  const candidate = options.installation === undefined
    ? discoverNativeClaudeInstallation(options.discovery)
    : options.installation;
  if (candidate === null) return null;
  const installation = normalizeInstallation(candidate);
  if (installation === null) return null;
  const authorized = authorizedEnvironment(options.baseEnv ?? process.env);
  if (authorized === null) return null;
  if (!compatibleClaudeVersion(
    installation.executable,
    authorized.env,
    options.versionProbe ?? defaultVersionProbe,
  )) return null;
  const compatibility: Readonly<NativeClaudeCompatibility> = Object.freeze({
    cliVersion: SUPPORTED_CLAUDE_VERSION,
    lifecycleVerified: isNativeClaudeLifecycleEvidence(options.lifecycleEvidence),
  });

  let ownsWriterStore = false;
  let writerLeases: NativeClaudeWriterLeases;
  try {
    if (options.writerLeases !== undefined) {
      writerLeases = options.writerLeases;
    } else {
      const dbPath = options.writerLeaseDbPath ?? defaultWriterLeaseDbPath();
      if (!path.isAbsolute(dbPath) || path.normalize(dbPath) !== dbPath) return null;
      mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
      writerLeases = new NativeTaskWriterLeaseStore({ dbPath });
      ownsWriterStore = true;
    }
  } catch {
    return null;
  }

  let supervisor: ClaudePersistentSupervisor | null = null;
  let adapter: ClaudeNativeAdapter | null = null;
  try {
    const requestedEnabled = (): boolean => {
      if (!compatibility.lifecycleVerified) return false;
      try { return options.isEnabled() === true; } catch { return false; }
    };
    let supervisorEnabled = false;
    let adapterEnabled = false;
    let appliedEnabled = false;
    const supervisorReady = (): boolean => supervisorEnabled;
    const adapterExposed = (): boolean => adapterEnabled;
    const helpers = options.helpers ?? new ClaudeSessionHelpers({
      configHome: installation.home,
      cwd: installation.home,
      scope: "all-projects",
    });
    supervisor = new ClaudePersistentSupervisor({
      executable: installation.executable,
      isEnabled: supervisorReady,
      baseEnv: authorized.env,
      reconcile: (context) => adapter!.reconcile(context),
      ...(options.runtimeFactory === undefined ? {} : { runtimeFactory: options.runtimeFactory }),
    });
    const reconciliationStore = options.reconciliationStore === undefined
      ? undefined
      : createAdapterReconciliationStore(options.reconciliationStore);
    adapter = new ClaudeNativeAdapter({
      home: installation.home,
      helpers,
      supervisor,
      writerLeases,
      isEnabled: adapterExposed,
      ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
      ...(reconciliationStore === undefined ? {} : { reconciliationStore }),
    });
    const bootstrapRefresh = adapter.refreshEnabled().catch(() => undefined);
    options.registry.register(installation.home, adapter);

    let refreshChain: Promise<unknown> = bootstrapRefresh;
    let closePromise: Promise<void> | null = null;
    let closed = false;
    let transitionEpoch = 0;
    const closeGates = (): void => {
      appliedEnabled = false;
      adapterEnabled = false;
      supervisorEnabled = false;
    };
    const drainClosed = async (): Promise<void> => {
      closeGates();
      try { await adapter!.refreshEnabled(); } catch { /* Adapter remains gated closed. */ }
      try { await supervisor!.refreshEnabled(); } catch { /* Supervisor gate remains closed. */ }
    };
    const refreshEnabled = (): Promise<boolean> => {
      if (closed) return Promise.resolve(false);
      const target = requestedEnabled();
      const epoch = ++transitionEpoch;
      if (!target) {
        appliedEnabled = false;
        adapterEnabled = false;
      }
      const refresh = async (): Promise<boolean> => {
        if (closed || epoch !== transitionEpoch) return false;
        try {
          if (target) {
            supervisorEnabled = true;
            await supervisor!.refreshEnabled();
            if (closed || epoch !== transitionEpoch) return false;
            adapterEnabled = true;
            await adapter!.refreshEnabled();
            if (closed || epoch !== transitionEpoch) return false;
            appliedEnabled = true;
            return true;
          }

          await adapter!.refreshEnabled();
          if (closed || epoch !== transitionEpoch) return false;
          supervisorEnabled = false;
          await supervisor!.refreshEnabled();
          return !closed && epoch === transitionEpoch;
        } catch {
          await drainClosed();
          return false;
        }
      };
      refreshChain = refreshChain.then(refresh, refresh);
      return refreshChain as Promise<boolean>;
    };
    const close = (): Promise<void> => {
      if (closePromise !== null) return closePromise;
      closed = true;
      transitionEpoch += 1;
      closeGates();
      closePromise = (async () => {
        let failure: unknown;
        try { await refreshChain; } catch (error) { failure = error; }
        try { await adapter!.dispose(); } catch (error) { failure ??= error; }
        try { await supervisor!.shutdown(); } catch (error) { failure ??= error; }
        try { writerLeases.close(); } catch (error) { failure ??= error; }
        if (failure !== undefined) throw failure;
      })();
      return closePromise;
    };

    return Object.freeze({
      available: true as const,
      installation,
      auth: authorized.auth,
      compatibility,
      helpers,
      writerLeases,
      adapter,
      supervisor,
      canEnable: () => compatibility.lifecycleVerified,
      isAppliedEnabled: () => !closed && appliedEnabled && adapterEnabled && supervisorEnabled,
      refreshEnabled,
      close,
    });
  } catch {
    void (async () => {
      if (adapter !== null) {
        try { await adapter.dispose(); } catch { /* Construction remains fail-closed. */ }
      }
      if (supervisor !== null) {
        try { await supervisor.shutdown(); } catch { /* Construction remains fail-closed. */ }
      }
      if (ownsWriterStore) {
        try { writerLeases.close(); } catch { /* Construction remains fail-closed. */ }
      }
    })();
    return null;
  }
}
