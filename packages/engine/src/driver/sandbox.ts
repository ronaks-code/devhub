/**
 * Optional sandbox for a headless `claude` turn — best-effort network/process
 * isolation for an UNATTENDED run you don't want phoning home.
 *
 * WHAT THIS IS NOT: the installed `claude` CLI has NO native sandbox or
 * network-isolation flag (checked against `claude --help`: there is only
 * `--dangerously-skip-permissions`, whose own text says "Recommended only for
 * sandboxes with no internet access" — i.e. it expects the *caller* to provide the
 * sandbox). So we provide the sandbox AROUND the process, additively, in two layers:
 *
 *   1. ENV SCRUB (always, every platform). We strip the proxy/network-enabling env
 *      vars the child would otherwise inherit (HTTP(S)_PROXY, ALL_PROXY, NO_PROXY,
 *      npm/pip proxy mirrors, …) and stamp a documented marker (`CLAUDE_UI_SANDBOX=1`)
 *      so the run is auditable. This does NOT by itself block sockets — it removes the
 *      *configured* egress paths and signals intent; honest tooling that reads the
 *      proxy env will have no route, but a determined process can still open a raw
 *      socket. Treat env-scrub as "no configured network", not "no network".
 *
 *   2. OS WRAPPER (macOS only, opt-in & auto-detected). When `sandbox-exec` is on
 *      PATH we can wrap the spawn in an Apple Seatbelt profile that DENIES
 *      `network*` outright while allowing local file/process operations the CLI needs.
 *      THIS is the layer that actually blocks sockets — but only on macOS, and Apple
 *      has long deprecated `sandbox-exec` (it still ships and works as of macOS 15).
 *      On Linux/Windows, or if `sandbox-exec` is absent, we fall back to layer 1 alone
 *      and report `network: "scrubbed"` (not `"blocked"`) so callers never overclaim.
 *
 * The whole module is PURE + side-effect-free except {@link sandboxExecAvailable},
 * which probes PATH. {@link buildSandboxConfig} computes what a sandboxed spawn would
 * look like; {@link applySandbox} rewrites a `{ command, args, env }` spawn spec to
 * the sandboxed form. Both are no-ops when sandboxing is off, so threading an absent
 * flag through changes nothing.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Options requesting a sandboxed turn. All optional; an absent object means "off". */
export interface SandboxOptions {
  /** Master switch. When false/absent, every helper here is a no-op. */
  enabled?: boolean;
  /**
   * Use the macOS `sandbox-exec` Seatbelt wrapper when available (the layer that
   * actually denies network sockets). Defaults to true; set false to force env-scrub
   * only even on macOS (e.g. for a run that legitimately needs localhost MCP servers).
   */
  osWrapper?: boolean;
}

/** What isolation a sandboxed spawn ACTUALLY provides — reported, never overclaimed. */
export interface SandboxConfig {
  /** Whether sandboxing is active at all (mirrors {@link SandboxOptions.enabled}). */
  enabled: boolean;
  /**
   * The strongest network guarantee in effect:
   *  - `"none"`     — sandbox off; the child inherits the full environment.
   *  - `"scrubbed"` — proxy/network env removed + marker set, but sockets NOT blocked
   *     (env-scrub only — the platform has no socket-level sandbox here).
   *  - `"blocked"`  — an OS sandbox (macOS Seatbelt) DENIES outbound network sockets.
   */
  network: "none" | "scrubbed" | "blocked";
  /** Env var names removed from the child's environment under the sandbox. */
  scrubbedEnv: string[];
  /** True when the spawn is wrapped by an OS sandbox binary (macOS `sandbox-exec`). */
  osWrapped: boolean;
  /** One-line human-readable description of the isolation actually applied. */
  description: string;
}

/**
 * Network-enabling environment variables we remove under the sandbox. These are the
 * *configured egress paths* an inheriting child would otherwise pick up: HTTP proxies
 * (and their package-manager-specific cousins). Removing them gives honest tooling no
 * configured route out. Both upper- and lower-case forms exist in the wild, so we list
 * both. Case-insensitive matching is also applied (see {@link networkEnvKeys}).
 */
export const NETWORK_ENV_VARS: readonly string[] = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "FTP_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "ftp_proxy",
  "no_proxy",
  "npm_config_proxy",
  "npm_config_https_proxy",
  "PIP_PROXY",
  "GLOBAL_AGENT_HTTP_PROXY",
  "GLOBAL_AGENT_HTTPS_PROXY",
];

/** The documented marker stamped on a sandboxed child's env so the run is auditable. */
export const SANDBOX_ENV_MARKER = "CLAUDE_UI_SANDBOX";

/** Lower-cased set of the network env names, for case-insensitive matching. */
const NETWORK_ENV_LOWER = new Set(NETWORK_ENV_VARS.map((k) => k.toLowerCase()));

/**
 * The keys actually present in `env` that we would scrub: every network/proxy var
 * (matched case-insensitively against {@link NETWORK_ENV_VARS}). The marker is added
 * separately by {@link scrubEnv}; it is not "scrubbed" (it's set), so it isn't here.
 */
export function networkEnvKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((k) => NETWORK_ENV_LOWER.has(k.toLowerCase()));
}

/**
 * Return a COPY of `env` with the network/proxy vars removed and the sandbox marker
 * set. Pure: the input is never mutated. Used as the child's environment under the
 * sandbox; layer 1 of the isolation (see the module docblock).
 */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of networkEnvKeys(out)) delete out[k];
  out[SANDBOX_ENV_MARKER] = "1";
  return out;
}

/** macOS `sandbox-exec` binary path (Apple Seatbelt). Deprecated by Apple but present. */
const SANDBOX_EXEC_BIN = "/usr/bin/sandbox-exec";

/**
 * Whether the macOS Seatbelt wrapper (`sandbox-exec`) is usable: we are on darwin AND
 * the binary exists. The single side-effecting helper here (an `existsSync` probe).
 * Off-darwin it is always false, so callers degrade to env-scrub only.
 */
export function sandboxExecAvailable(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "darwin") return false;
  if (existsSync(SANDBOX_EXEC_BIN)) return true;
  // Fall back to a PATH lookup in case it lives elsewhere on this machine.
  const pathEnv = process.env.PATH ?? "";
  return pathEnv
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, "sandbox-exec")));
}

/**
 * An Apple Seatbelt (`sandbox-exec`) profile that DENIES outbound network sockets
 * while allowing everything else the `claude` CLI needs (file read/write, process
 * fork/exec, signals, sysctl, mach lookups). `(deny network*)` is the operative line —
 * it blocks `network-outbound`/`network-inbound`/`network-bind` etc. Everything else
 * defaults to allow so the turn still runs normally (just offline). Inlined as a
 * profile string passed via `-p`, so no temp file is written.
 *
 * Documented limitation: this is a COARSE profile (allow-by-default minus network). It
 * is NOT a full filesystem jail — the child can still read/write the user's files as
 * itself. Its single guarantee is "no outbound network".
 */
export const SEATBELT_NO_NETWORK_PROFILE = [
  "(version 1)",
  "(allow default)",
  "(deny network*)",
].join("\n");

/** A process spawn spec: the binary, its argv, and the environment to run it under. */
export interface SpawnSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Compute what a sandboxed spawn of `base` (the un-sandboxed `{ command, args, env }`)
 * would look like, plus the {@link SandboxConfig} describing the isolation actually
 * achieved. PURE — does not spawn anything. When `opts.enabled` is false/absent the
 * `spec` is `base` unchanged and `config.network` is `"none"`.
 *
 * Layering (see module docblock): always env-scrub; additionally wrap in
 * `sandbox-exec` on macOS when available and `opts.osWrapper !== false`. The reported
 * `network` is `"blocked"` only when the OS wrapper is in effect, otherwise
 * `"scrubbed"` — we never claim socket-level blocking we don't have.
 */
export function buildSandboxConfig(
  base: SpawnSpec,
  opts: SandboxOptions = {},
): { spec: SpawnSpec; config: SandboxConfig } {
  if (!opts.enabled) {
    return {
      spec: base,
      config: {
        enabled: false,
        network: "none",
        scrubbedEnv: [],
        osWrapped: false,
        description: "sandbox off (full inherited environment)",
      },
    };
  }

  const scrubbed = networkEnvKeys(base.env);
  const env = scrubEnv(base.env);
  const wantWrapper = opts.osWrapper !== false;
  const osWrapped = wantWrapper && sandboxExecAvailable();

  if (osWrapped) {
    // Prepend the Seatbelt wrapper: `sandbox-exec -p <profile> <claude> <args...>`.
    return {
      spec: {
        command: SANDBOX_EXEC_BIN,
        args: ["-p", SEATBELT_NO_NETWORK_PROFILE, base.command, ...base.args],
        env,
      },
      config: {
        enabled: true,
        network: "blocked",
        scrubbedEnv: scrubbed,
        osWrapped: true,
        description:
          "macOS sandbox-exec Seatbelt profile denies outbound network; proxy env scrubbed",
      },
    };
  }

  // Env-scrub only (non-macOS, or sandbox-exec unavailable, or osWrapper:false).
  return {
    spec: { command: base.command, args: base.args, env },
    config: {
      enabled: true,
      network: "scrubbed",
      scrubbedEnv: scrubbed,
      osWrapped: false,
      description:
        "proxy/network env scrubbed + marker set; sockets NOT blocked (no OS sandbox here)",
    },
  };
}

/**
 * Rewrite a spawn spec to its sandboxed form, returning the new spec. Thin wrapper
 * over {@link buildSandboxConfig} for call sites that only need the spec (the config
 * is also returned for callers that want to surface what was applied). A no-op (returns
 * `base` unchanged) when sandboxing is off.
 */
export function applySandbox(
  base: SpawnSpec,
  opts: SandboxOptions = {},
): { spec: SpawnSpec; config: SandboxConfig } {
  return buildSandboxConfig(base, opts);
}
