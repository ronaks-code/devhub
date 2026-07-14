import { createHash, timingSafeEqual } from "node:crypto";
import {
  serializeTaskLocator,
  type ProviderTaskLocator,
} from "./identity.js";
import type { ProviderId } from "../providers/types.js";

const CURSOR_PREFIX = "pi1";
const CURSOR_VERSION = 1 as const;
const MAX_CURSOR_CHARS = 2_048;
const MAX_TIMESTAMP_CHARS = 32;
const DEFAULT_LIMIT = 50;
export const MAX_PROVIDER_INDEX_PAGE_SIZE = 200;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/u;
const CURSOR_ERROR = "provider index cursor is invalid";
const OPTIONS_ERROR = "provider index list options are invalid";

export interface ProviderIndexListScope {
  readonly provider: ProviderId | null;
  readonly homeFingerprint: string | null;
  readonly includeArchived: boolean;
}

export interface ProviderIndexCursorPosition {
  readonly updatedAt: string | null;
  readonly provider: ProviderId;
  readonly homeFingerprint: string;
  readonly nativeTaskId: string;
}

export interface ProviderIndexListOptions {
  readonly provider?: ProviderId | null;
  readonly homeFingerprint?: string | null;
  readonly includeArchived?: boolean;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface NormalizedProviderIndexListOptions {
  readonly scope: Readonly<ProviderIndexListScope>;
  readonly limit: number;
  readonly position: Readonly<ProviderIndexCursorPosition> | null;
}

type CursorPayload = readonly [
  version: 1,
  scopeProvider: ProviderId | null,
  scopeHomeFingerprint: string | null,
  includeArchived: 0 | 1,
  updatedAt: string | null,
  provider: ProviderId,
  homeFingerprint: string,
  nativeTaskId: string,
];

/**
 * Corruption/canonical-encoding checksum only. This is deliberately not an
 * authorization primitive: callers must treat every parsed position as
 * attacker-controlled and bind it into parameterized, scope-constrained SQL.
 */
function sha256(value: string): string {
  return createHash("sha256")
    .update(`devhub-provider-index-cursor-v1\u0000${value}`, "utf8")
    .digest("hex");
}

function providerId(value: unknown): ProviderId {
  if (value !== "openai" && value !== "anthropic") throw new TypeError();
  return value;
}

function fingerprint(value: unknown): string {
  if (typeof value !== "string" || !LOWER_HEX_64.test(value)) throw new TypeError();
  return value;
}

function canonicalTimestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TIMESTAMP_CHARS) {
    throw new TypeError();
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) throw new TypeError();
  return value;
}

function exactOwnData(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key))) {
    throw new TypeError();
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) throw new TypeError();
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function normalizedScope(value: unknown): Readonly<ProviderIndexListScope> {
  const snapshot = exactOwnData(value, ["provider", "homeFingerprint", "includeArchived"]);
  const provider = snapshot.provider === null ? null : providerId(snapshot.provider);
  const homeFingerprint = snapshot.homeFingerprint === null
    ? null
    : fingerprint(snapshot.homeFingerprint);
  if (provider === null && homeFingerprint !== null) throw new TypeError();
  if (typeof snapshot.includeArchived !== "boolean") throw new TypeError();
  return Object.freeze({ provider, homeFingerprint, includeArchived: snapshot.includeArchived });
}

function nativeTaskId(
  provider: ProviderId,
  homeFingerprint: string,
  value: unknown,
): string {
  if (typeof value !== "string") throw new TypeError();
  const locator: ProviderTaskLocator = {
    version: 1,
    provider,
    homeFingerprint,
    nativeTaskId: value,
  };
  serializeTaskLocator(locator);
  return value;
}

function normalizedPosition(value: unknown): Readonly<ProviderIndexCursorPosition> {
  const snapshot = exactOwnData(
    value,
    ["updatedAt", "provider", "homeFingerprint", "nativeTaskId"],
  );
  const provider = providerId(snapshot.provider);
  const homeFingerprint = fingerprint(snapshot.homeFingerprint);
  const position = {
    updatedAt: canonicalTimestamp(snapshot.updatedAt),
    provider,
    homeFingerprint,
    nativeTaskId: nativeTaskId(provider, homeFingerprint, snapshot.nativeTaskId),
  };
  return Object.freeze(position);
}

function assertPositionInScope(
  scope: ProviderIndexListScope,
  position: ProviderIndexCursorPosition,
): void {
  if (scope.provider !== null && scope.provider !== position.provider) throw new TypeError();
  if (scope.homeFingerprint !== null &&
    scope.homeFingerprint !== position.homeFingerprint) throw new TypeError();
}

function payloadFor(
  scope: ProviderIndexListScope,
  position: ProviderIndexCursorPosition,
): CursorPayload {
  return Object.freeze([
    CURSOR_VERSION,
    scope.provider,
    scope.homeFingerprint,
    scope.includeArchived ? 1 : 0,
    position.updatedAt,
    position.provider,
    position.homeFingerprint,
    position.nativeTaskId,
  ]);
}

function sameScope(left: ProviderIndexListScope, right: ProviderIndexListScope): boolean {
  return left.provider === right.provider &&
    left.homeFingerprint === right.homeFingerprint &&
    left.includeArchived === right.includeArchived;
}

export function serializeProviderIndexCursor(
  scopeValue: ProviderIndexListScope,
  positionValue: ProviderIndexCursorPosition,
): string {
  try {
    const scope = normalizedScope(scopeValue);
    const position = normalizedPosition(positionValue);
    assertPositionInScope(scope, position);
    const json = JSON.stringify(payloadFor(scope, position));
    const payload = Buffer.from(json, "utf8").toString("base64url");
    const cursor = `${CURSOR_PREFIX}.${payload}.${sha256(json)}`;
    if (cursor.length > MAX_CURSOR_CHARS) throw new TypeError();
    return cursor;
  } catch {
    throw new TypeError(CURSOR_ERROR);
  }
}

export function parseProviderIndexCursor(
  value: unknown,
  expectedScopeValue: ProviderIndexListScope,
): Readonly<ProviderIndexCursorPosition> {
  try {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_CURSOR_CHARS ||
      /\s/u.test(value)) throw new TypeError();
    const parts = value.split(".");
    if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX) throw new TypeError();
    const encoded = parts[1];
    const receivedChecksum = parts[2];
    if (encoded === undefined || !BASE64URL.test(encoded) ||
      receivedChecksum === undefined || !LOWER_HEX_64.test(receivedChecksum)) {
      throw new TypeError();
    }
    const bytes = Buffer.from(encoded, "base64url");
    const json = bytes.toString("utf8");
    if (!Buffer.from(json, "utf8").equals(bytes) ||
      Buffer.from(json, "utf8").toString("base64url") !== encoded) throw new TypeError();
    const expectedChecksum = sha256(json);
    if (!timingSafeEqual(Buffer.from(receivedChecksum, "hex"), Buffer.from(expectedChecksum, "hex"))) {
      throw new TypeError();
    }

    const payload = JSON.parse(json) as unknown;
    if (!Array.isArray(payload) || payload.length !== 8 || payload[0] !== CURSOR_VERSION ||
      (payload[3] !== 0 && payload[3] !== 1)) throw new TypeError();
    const encodedScope = normalizedScope({
      provider: payload[1],
      homeFingerprint: payload[2],
      includeArchived: payload[3] === 1,
    });
    const expectedScope = normalizedScope(expectedScopeValue);
    if (!sameScope(encodedScope, expectedScope)) throw new TypeError();
    const position = normalizedPosition({
      updatedAt: payload[4],
      provider: payload[5],
      homeFingerprint: payload[6],
      nativeTaskId: payload[7],
    });
    assertPositionInScope(encodedScope, position);
    if (JSON.stringify(payloadFor(encodedScope, position)) !== json) throw new TypeError();
    return position;
  } catch {
    throw new TypeError(CURSOR_ERROR);
  }
}

export function normalizeProviderIndexListOptions(
  value: ProviderIndexListOptions = {},
): Readonly<NormalizedProviderIndexListOptions> {
  try {
    const snapshot = exactOwnData(
      value,
      [],
      ["provider", "homeFingerprint", "includeArchived", "limit", "cursor"],
    );
    const providerValue = snapshot.provider === undefined ? null : snapshot.provider;
    const homeFingerprintValue = snapshot.homeFingerprint === undefined
      ? null
      : snapshot.homeFingerprint;
    const includeArchivedValue = snapshot.includeArchived === undefined
      ? false
      : snapshot.includeArchived;
    const scope = normalizedScope({
      provider: providerValue,
      homeFingerprint: homeFingerprintValue,
      includeArchived: includeArchivedValue,
    });
    const limitValue = snapshot.limit === undefined ? DEFAULT_LIMIT : snapshot.limit;
    if (typeof limitValue !== "number" || !Number.isSafeInteger(limitValue) ||
      limitValue < 1 || limitValue > MAX_PROVIDER_INDEX_PAGE_SIZE) throw new TypeError();
    const cursorValue = snapshot.cursor === undefined ? null : snapshot.cursor;
    if (cursorValue !== null && typeof cursorValue !== "string") throw new TypeError();
    const position = cursorValue === null ? null : parseProviderIndexCursor(cursorValue, scope);
    return Object.freeze({ scope, limit: limitValue, position });
  } catch {
    throw new TypeError(OPTIONS_ERROR);
  }
}
