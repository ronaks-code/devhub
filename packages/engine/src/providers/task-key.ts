import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_PROVIDER_HOME_CHARS,
  normalizeProviderNativeId,
} from "./native-id.js";
import type { NativeTaskKey, ProviderId } from "./types.js";

const PROVIDERS = new Set<ProviderId>(["openai", "anthropic"]);
const KEY_SEPARATOR = "\u0000";

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 ||
    value.length > MAX_PROVIDER_HOME_CHARS) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.includes(KEY_SEPARATOR)) {
    throw new TypeError(`${label} must not contain a NUL character`);
  }
  return normalized;
}

export function canonicalizeProviderHome(home: string): string {
  const value = nonEmpty(home, "provider home");
  const expanded = value === "~" || value.startsWith(`~${path.sep}`)
    ? path.join(os.homedir(), value.slice(2))
    : value;
  const resolved = path.resolve(expanded);
  try {
    return realpathSync(resolved);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return resolved;
    }
    throw error;
  }
}

export function createNativeTaskKey(
  provider: ProviderId,
  home: string,
  nativeTaskId: string,
): Readonly<NativeTaskKey> {
  if (!PROVIDERS.has(provider)) {
    throw new TypeError(`unsupported provider: ${String(provider)}`);
  }
  return Object.freeze({
    provider,
    home: canonicalizeProviderHome(home),
    nativeTaskId: normalizeProviderNativeId(nativeTaskId, "native task id"),
  });
}

export function assertNativeTaskKey(value: unknown): asserts value is NativeTaskKey {
  if (!value || typeof value !== "object") {
    throw new TypeError("native task key must be an object");
  }
  const key = value as Partial<NativeTaskKey>;
  if (!PROVIDERS.has(key.provider as ProviderId)) {
    throw new TypeError(`unsupported provider: ${String(key.provider)}`);
  }
  const home = canonicalizeProviderHome(key.home as string);
  if (key.home !== home) {
    throw new TypeError("provider home must be canonical");
  }
  normalizeProviderNativeId(key.nativeTaskId, "native task id");
}

export function nativeTaskKeyId(key: NativeTaskKey): string {
  assertNativeTaskKey(key);
  return [key.provider, key.home, key.nativeTaskId].join(KEY_SEPARATOR);
}

/** Snapshot and freeze an untrusted key before crossing an asynchronous boundary. */
export function snapshotNativeTaskKey(key: NativeTaskKey): Readonly<NativeTaskKey> {
  assertNativeTaskKey(key);
  return createNativeTaskKey(key.provider, key.home, key.nativeTaskId);
}
