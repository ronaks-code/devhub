/**
 * DEVHUB_* / CLAUDE_UI_* environment COMPAT layer.
 *
 * DevHub is the rename of the old "claude-ui" product. During the transition we accept
 * BOTH environment namespaces but treat the `DEVHUB_*` form as authoritative:
 *
 *   - PREFER `DEVHUB_*`. When it is set (non-blank) it always wins.
 *   - ACCEPT the exact `CLAUDE_UI_*` alias ONLY when the `DEVHUB_*` form is absent, so an
 *     existing deployment keeps working without any change.
 *   - On a real CONFLICT (both set to DIFFERENT non-blank values) use the DevHub value
 *     and emit a single VALUE-FREE diagnostic. The diagnostic names the two keys but
 *     NEVER their values, so a secret (token/key) can never leak into a log or a test.
 *
 * This module is PURE (no Node fs, no process side-effects beyond an optional injected
 * diagnostic sink) and every function takes its environment explicitly so it is trivially
 * unit-testable and never reads ambient `process.env` unless a caller passes it in.
 *
 * NOTE — data directory: {@link resolveAppDataDir} deliberately KEEPS the existing legacy
 * default data dir (`~/.claude-ui`) for M5. The on-disk directory RENAME/migration is M8;
 * this milestone only unifies how the override env var is READ, not where data lives.
 */
import os from "node:os";
import path from "node:path";

/** The authoritative DevHub environment namespace prefix. */
export const DEVHUB_ENV_PREFIX = "DEVHUB_";

/** The accepted legacy alias namespace prefix (product's former name). */
export const CLAUDE_UI_ENV_PREFIX = "CLAUDE_UI_";

/**
 * The legacy default app-data directory NAME (under the home dir). Unchanged in M5 —
 * the on-disk rename is owned by M8, so nothing here relocates existing data.
 */
export const LEGACY_APP_DATA_DIRNAME = ".claude-ui";

/** A minimal read-only view of an environment (a subset of `NodeJS.ProcessEnv`). */
export type CompatEnv = Readonly<Record<string, string | undefined>>;

/** A sink for value-free compat diagnostics (defaults to a value-free `console.warn`). */
export type CompatDiagnostic = (message: string) => void;

/** Where a resolved value came from. */
export type CompatEnvSource = "devhub" | "claude-ui" | "none";

/** The outcome of resolving one DevHub key + its CLAUDE_UI alias. */
export interface CompatEnvResult {
  /** The winning (trimmed) value, or undefined when neither namespace is set. */
  readonly value: string | undefined;
  /** Which namespace supplied {@link value}. */
  readonly source: CompatEnvSource;
  /** True when BOTH were set to different non-blank values (DevHub still wins). */
  readonly conflict: boolean;
}

/** True for a key in EITHER DevHub namespace (used by child-provider env scrubbing). */
export function isDevHubNamespaceKey(key: string): boolean {
  return key.startsWith(DEVHUB_ENV_PREFIX) || key.startsWith(CLAUDE_UI_ENV_PREFIX);
}

/** A non-blank env value, trimmed — or undefined when absent/blank. */
function present(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The default value-free diagnostic sink (never prints a value). */
function defaultDiagnostic(message: string): void {
  // eslint-disable-next-line no-console
  console.warn(message);
}

/**
 * Resolve ONE setting from its `DEVHUB_*` form and its exact `CLAUDE_UI_*` alias.
 *
 * @param devhubKey  the authoritative env var name, e.g. `"DEVHUB_DATA"`.
 * @param aliasKey   the accepted legacy alias, e.g. `"CLAUDE_UI_DATA"`.
 * @param env        the environment to read (explicit; defaults to `process.env`).
 * @param onDiagnostic  optional sink for the value-free conflict diagnostic. When omitted
 *                      a conflict logs a value-free warning via `console.warn`.
 *
 * Rules: DevHub wins whenever present. The alias is used only when the DevHub form is
 * absent/blank. A conflict (both present, different values) uses the DevHub value and
 * emits EXACTLY one value-free diagnostic (keys only, never values). Identical values are
 * NOT a conflict and emit nothing.
 */
export function resolveCompatEnv(
  devhubKey: string,
  aliasKey: string,
  env: CompatEnv = process.env,
  onDiagnostic: CompatDiagnostic = defaultDiagnostic,
): CompatEnvResult {
  const devhub = present(env[devhubKey]);
  const alias = present(env[aliasKey]);

  if (devhub !== undefined) {
    const conflict = alias !== undefined && alias !== devhub;
    if (conflict) {
      // VALUE-FREE by construction: names the two keys, never their values.
      onDiagnostic(
        `${devhubKey} and ${aliasKey} are both set to different values; using ${devhubKey} and ignoring ${aliasKey}.`,
      );
    }
    return { value: devhub, source: "devhub", conflict };
  }

  if (alias !== undefined) {
    return { value: alias, source: "claude-ui", conflict: false };
  }

  return { value: undefined, source: "none", conflict: false };
}

/**
 * Resolve the app-data directory through the SINGLE compat function. Honors
 * `DEVHUB_DATA` (preferred) or the `CLAUDE_UI_DATA` alias; otherwise returns the
 * EXISTING legacy default (`<home>/.claude-ui`). M5 keeps the legacy default on purpose —
 * M8 owns the actual on-disk migration.
 */
export function resolveAppDataDir(
  env: CompatEnv = process.env,
  homedir: string = os.homedir(),
  onDiagnostic: CompatDiagnostic = defaultDiagnostic,
): string {
  const resolved = resolveCompatEnv("DEVHUB_DATA", "CLAUDE_UI_DATA", env, onDiagnostic);
  if (resolved.value !== undefined) return resolved.value;
  return path.join(homedir, LEGACY_APP_DATA_DIRNAME);
}
