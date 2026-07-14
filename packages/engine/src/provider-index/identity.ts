import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { redactSecrets } from "../redact.js";
import {
  normalizeProviderEvent,
  type ProviderEvent,
} from "../providers/events.js";
import { normalizeProviderNativeId } from "../providers/native-id.js";
import {
  assertNativeTaskKey,
  snapshotNativeTaskKey,
} from "../providers/task-key.js";
import type {
  JsonRpcRequestId,
  NativeTaskKey,
  ProviderId,
  ProviderRequestIdentity,
} from "../providers/types.js";
import {
  hasCanonicalUnicode,
  MAX_PROVIDER_INDEX_EVENT_JSON_CHARS,
  sqliteTextLengthAtMost,
} from "./text-boundary.js";

const LOCATOR_VERSION = 1 as const;
const LOCATOR_PREFIX = "pt1";
const MAX_SERIALIZED_LOCATOR_CHARS = 1_024;
const MAX_CACHED_KEY_CHARS = 1_024;
const MAX_EVENT_ORDINAL = 1_000_000;
const MAX_OCCURRED_AT_CHARS = 32;
const MAX_DIAGNOSTIC_CODE_CHARS = 128;
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 512;
const MAX_DIAGNOSTIC_METHOD_CHARS = 256;
const MAX_DIAGNOSTIC_SHAPE_KEY_CHARS = 64;
const MAX_DIAGNOSTIC_SHAPE_KEYS = 32;
const MAX_CANONICAL_JSON_ARRAY_ITEMS = 1_000_000;
const MAX_CANONICAL_JSON_DEPTH = 32;
const MAX_CANONICAL_JSON_VISITS = 1_000_000;
const MAX_CANONICAL_JSON_OBJECT_KEYS = 100_000;
const MAX_CANONICAL_JSON_OUTPUT_CODE_POINTS = 64 * 1024 * 1024;
const MAX_CANONICAL_JSON_OUTPUT_BYTES = 64 * 1024 * 1024;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const HIDDEN_PROVIDER_MARKER =
  /(?:hidden|private|internal)[-_ ]?(?:reasoning|thought)|chain[-_ ]?of[-_ ]?thought/iu;
const LOCATOR_ERROR = "provider task locator is invalid";
const EVENT_PROJECTION_ERROR = "provider event could not be safely projected";
const TASK_KEY_ERROR = "native task key is unsafe for provider indexing";
const HOME_ERROR = "provider home must be canonical exact UTF-8";
const CACHED_TURN_KEY_ERROR = "cached turn key is invalid";
const CACHED_EVENT_ITEM_KEY_ERROR = "cached event item key is invalid";
const HOME_REPLACEMENT = "[PROVIDER_HOME]";

export interface ProviderTaskLocator {
  readonly version: 1;
  readonly provider: ProviderId;
  readonly homeFingerprint: string;
  readonly nativeTaskId: string;
}

export interface IndexedProviderRequestIdentity {
  readonly locator: ProviderTaskLocator;
  readonly generation: number | null;
  readonly turnId: string | null;
  readonly requestId: JsonRpcRequestId;
  readonly itemId: string | null;
  readonly approvalId: JsonRpcRequestId | null;
}

interface IndexedProviderEventBase {
  readonly provider: ProviderId;
  readonly locator: ProviderTaskLocator;
  readonly occurredAt: string;
}

type IndexedProviderRequest =
  | { readonly kind: "command-approval"; readonly identity: IndexedProviderRequestIdentity }
  | { readonly kind: "file-change-approval"; readonly identity: IndexedProviderRequestIdentity }
  | { readonly kind: "mcp-elicitation"; readonly identity: IndexedProviderRequestIdentity }
  | { readonly kind: "permission"; readonly identity: IndexedProviderRequestIdentity }
  | {
      readonly kind: "user-input";
      readonly identity: IndexedProviderRequestIdentity;
      readonly autoResolutionMs: number | null;
    };

export type IndexedProviderEvent =
  | (IndexedProviderEventBase & {
      readonly type: "message";
      readonly role: "user" | "assistant" | "system";
      readonly text: string;
      readonly turnId: string | null;
      readonly itemId: string | null;
    })
  | (IndexedProviderEventBase & {
      readonly type: "message-delta";
      readonly role: "user" | "assistant" | "system";
      readonly delta: string;
      readonly turnId: string | null;
      readonly itemId: string | null;
    })
  | (IndexedProviderEventBase & {
      readonly type: "plan";
      readonly turnId: string | null;
      readonly itemId: string | null;
      readonly stepIndex: number | null;
      readonly text: string;
      readonly status: string;
    })
  | (IndexedProviderEventBase & {
      readonly type: "activity";
      readonly turnId: string | null;
      readonly itemId: string | null;
      readonly activity: string;
      readonly status: string;
      readonly message: string | null;
    })
  | (IndexedProviderEventBase & {
      readonly type: "diff-summary";
      readonly turnId: string | null;
      readonly changedFiles: number;
      readonly additions: number;
      readonly deletions: number;
    })
  | (IndexedProviderEventBase & {
      readonly type: "usage";
      readonly turnId: string | null;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cachedInputTokens: number;
      readonly totalTokens: number;
    })
  | (IndexedProviderEventBase & {
      readonly type: "status";
      readonly scope: "task" | "turn" | "item";
      readonly status: string;
      readonly nativeId: string | null;
    })
  | (IndexedProviderEventBase & {
      readonly type: "request";
      readonly request: IndexedProviderRequest;
    })
  | (IndexedProviderEventBase & {
      readonly type: "request-resolved";
      readonly identity: IndexedProviderRequestIdentity;
    })
  | (IndexedProviderEventBase & {
      readonly type: "diagnostic";
      readonly level: "warning" | "error";
      readonly code: string;
      readonly message: string;
      readonly method: string | null;
      readonly shapeKeys: readonly string[];
    });

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasExactUtf8Encoding(value: string): boolean {
  return hasCanonicalUnicode(value);
}

function canonicalNativeId(value: unknown, label: string): string {
  const normalized = normalizeProviderNativeId(value, label);
  if (normalized !== value || !hasExactUtf8Encoding(normalized)) {
    throw new TypeError(`${label} must be canonical`);
  }
  return normalized;
}

function assertProvider(provider: unknown): asserts provider is ProviderId {
  assertNativeTaskKey({
    provider: provider as ProviderId,
    home: "/",
    nativeTaskId: "provider-validation",
  });
}

function validatedLocator(value: unknown): ProviderTaskLocator {
  try {
    if (value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
      Array.isArray(value)) throw new TypeError();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const requiredKeys = new Set([
      "version",
      "provider",
      "homeFingerprint",
      "nativeTaskId",
    ]);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== requiredKeys.size ||
      keys.some((key) => typeof key !== "string" || !requiredKeys.has(key))) {
      throw new TypeError();
    }

    const dataValue = (key: string): unknown => {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) throw new TypeError();
      return descriptor.value;
    };
    const version = dataValue("version");
    const provider = dataValue("provider");
    const fingerprint = dataValue("homeFingerprint");
    const nativeTaskIdValue = dataValue("nativeTaskId");
    if (version !== LOCATOR_VERSION) throw new TypeError();
    assertProvider(provider);
    if (typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint)) {
      throw new TypeError();
    }
    const nativeTaskId = canonicalNativeId(nativeTaskIdValue, "native task id");
    return Object.freeze({
      version: LOCATOR_VERSION,
      provider,
      homeFingerprint: fingerprint,
      nativeTaskId,
    });
  } catch {
    throw new TypeError(LOCATOR_ERROR);
  }
}

export function homeFingerprint(provider: ProviderId, canonicalHome: string): string {
  try {
    if (typeof canonicalHome !== "string" || !hasExactUtf8Encoding(canonicalHome)) {
      throw new TypeError();
    }
    assertNativeTaskKey({
      provider,
      home: canonicalHome,
      nativeTaskId: "home-fingerprint-validation",
    });
    return sha256(`devhub-home:v1\u0000${provider}\u0000${canonicalHome}`);
  } catch {
    throw new TypeError(HOME_ERROR);
  }
}

function snapshotTaskKeyBoundary(value: unknown): Readonly<NativeTaskKey> {
  try {
    if (value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
      Array.isArray(value)) throw new TypeError();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const requiredKeys = new Set(["provider", "home", "nativeTaskId"]);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== requiredKeys.size ||
      keys.some((key) => typeof key !== "string" || !requiredKeys.has(key))) {
      throw new TypeError();
    }

    const dataValue = (key: string): unknown => {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) throw new TypeError();
      return descriptor.value;
    };
    const provider = dataValue("provider");
    const home = dataValue("home");
    const nativeTaskId = dataValue("nativeTaskId");
    if (typeof provider !== "string" || typeof home !== "string" ||
      typeof nativeTaskId !== "string") {
      throw new TypeError();
    }
    return snapshotNativeTaskKey({
      provider: provider as ProviderId,
      home,
      nativeTaskId,
    });
  } catch {
    throw new TypeError(TASK_KEY_ERROR);
  }
}

export function taskLocator(key: NativeTaskKey): ProviderTaskLocator {
  try {
    const snapshot = snapshotTaskKeyBoundary(key);
    const nativeTaskId = canonicalNativeId(snapshot.nativeTaskId, "native task id");
    if (nativeTaskId.includes(snapshot.home)) throw new TypeError();
    return Object.freeze({
      version: LOCATOR_VERSION,
      provider: snapshot.provider,
      homeFingerprint: homeFingerprint(snapshot.provider, snapshot.home),
      nativeTaskId,
    });
  } catch {
    throw new TypeError(TASK_KEY_ERROR);
  }
}

export function serializeTaskLocator(locatorValue: ProviderTaskLocator): string {
  const locator = validatedLocator(locatorValue);
  const nativeTaskId = Buffer.from(locator.nativeTaskId, "utf8").toString("base64url");
  const serialized = [
    LOCATOR_PREFIX,
    locator.provider,
    locator.homeFingerprint,
    nativeTaskId,
  ].join(".");
  if (serialized.length > MAX_SERIALIZED_LOCATOR_CHARS) {
    throw new TypeError(LOCATOR_ERROR);
  }
  return serialized;
}

export function parseTaskLocator(value: unknown): ProviderTaskLocator {
  try {
    if (typeof value !== "string" || value.length === 0 ||
      value.length > MAX_SERIALIZED_LOCATOR_CHARS || /\s/u.test(value)) {
      throw new TypeError();
    }
    const parts = value.split(".");
    if (parts.length !== 4 || parts[0] !== LOCATOR_PREFIX) throw new TypeError();
    const provider = parts[1];
    const fingerprint = parts[2];
    const encodedNativeTaskId = parts[3];
    assertProvider(provider);
    if (fingerprint === undefined || !FINGERPRINT.test(fingerprint) ||
      encodedNativeTaskId === undefined || !BASE64URL.test(encodedNativeTaskId)) {
      throw new TypeError();
    }

    const bytes = Buffer.from(encodedNativeTaskId, "base64url");
    const nativeTaskId = bytes.toString("utf8");
    if (!Buffer.from(nativeTaskId, "utf8").equals(bytes) ||
      Buffer.from(nativeTaskId, "utf8").toString("base64url") !== encodedNativeTaskId) {
      throw new TypeError();
    }
    canonicalNativeId(nativeTaskId, "native task id");
    return Object.freeze({
      version: LOCATOR_VERSION,
      provider,
      homeFingerprint: fingerprint,
      nativeTaskId,
    });
  } catch {
    throw new TypeError(LOCATOR_ERROR);
  }
}

export function assertLocatorMatchesKey(
  locatorValue: ProviderTaskLocator,
  keyValue: NativeTaskKey,
): void {
  const locator = validatedLocator(locatorValue);
  const expected = taskLocator(keyValue);
  if (
    locator.provider !== expected.provider ||
    locator.homeFingerprint !== expected.homeFingerprint ||
    locator.nativeTaskId !== expected.nativeTaskId
  ) {
    throw new TypeError("provider task locator does not match native task key");
  }
}

function nativeCacheKey(value: unknown, label: string): string {
  const nativeId = canonicalNativeId(value, label);
  const cacheKey = `native:v1:${Buffer.from(nativeId, "utf8").toString("base64url")}`;
  if (cacheKey.length > MAX_CACHED_KEY_CHARS) throw new TypeError();
  return cacheKey;
}

function parseNativeCacheKey(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 ||
    value.length > MAX_CACHED_KEY_CHARS || !value.startsWith("native:v1:")) {
    throw new TypeError();
  }
  const encoded = value.slice("native:v1:".length);
  if (!BASE64URL.test(encoded)) throw new TypeError();
  const bytes = Buffer.from(encoded, "base64url");
  const nativeId = bytes.toString("utf8");
  if (!Buffer.from(nativeId, "utf8").equals(bytes) ||
    Buffer.from(nativeId, "utf8").toString("base64url") !== encoded) {
    throw new TypeError();
  }
  canonicalNativeId(nativeId, label);
  if (nativeCacheKey(nativeId, label) !== value) throw new TypeError();
  return nativeId;
}

export function cachedTurnKey(nativeTurnId: string | null): string {
  try {
    return nativeTurnId === null ? "none:v1" : nativeCacheKey(nativeTurnId, "native turn id");
  } catch {
    throw new TypeError(CACHED_TURN_KEY_ERROR);
  }
}

export function parseCachedTurnKey(value: unknown): string | null {
  try {
    if (value === "none:v1") return null;
    return parseNativeCacheKey(value, "native turn id");
  } catch {
    throw new TypeError(CACHED_TURN_KEY_ERROR);
  }
}

function indexedIdentity(
  identity: Readonly<ProviderRequestIdentity>,
  providerHome: string,
): IndexedProviderRequestIdentity {
  return Object.freeze({
    locator: taskLocator(identity.key),
    generation: identity.generation,
    turnId: indexedNativeId(identity.turnId, providerHome, "turnId"),
    requestId: indexedJsonRpcId(identity.requestId, providerHome, "requestId"),
    itemId: indexedNativeId(identity.itemId, providerHome, "itemId"),
    approvalId: indexedJsonRpcId(identity.approvalId, providerHome, "approvalId"),
  });
}

function indexedNativeId(
  value: string | null,
  providerHome: string,
  label: string,
): string | null {
  if (value === null) return null;
  const nativeId = canonicalNativeId(value, label);
  if (nativeId.includes(providerHome)) throw new TypeError(EVENT_PROJECTION_ERROR);
  return nativeId;
}

function indexedJsonRpcId(
  value: JsonRpcRequestId,
  providerHome: string,
  label: string,
): JsonRpcRequestId;
function indexedJsonRpcId(
  value: JsonRpcRequestId | null,
  providerHome: string,
  label: string,
): JsonRpcRequestId | null;
function indexedJsonRpcId(
  value: JsonRpcRequestId | null,
  providerHome: string,
  label: string,
): JsonRpcRequestId | null {
  if (value === null || typeof value === "number") return value;
  return indexedNativeId(value, providerHome, label);
}

function contentEscapeSentinel(providerHome: string): string {
  const unavailable = new Set<string>();
  for (let index = 0; index < providerHome.length; index += 1) {
    unavailable.add(providerHome[index]!);
  }
  for (let index = 0; index < HOME_REPLACEMENT.length; index += 1) {
    unavailable.add(HOME_REPLACEMENT[index]!);
  }
  const ranges = [
    [0xe000, 0xf8ff],
    [0x00a1, 0xd7ff],
    [0xf900, 0xfffd],
  ] as const;
  for (const [start, end] of ranges) {
    for (let codeUnit = start; codeUnit <= end; codeUnit += 1) {
      const candidate = String.fromCharCode(codeUnit);
      if (!unavailable.has(candidate)) return candidate;
    }
  }
  throw new TypeError(EVENT_PROJECTION_ERROR);
}

type ContentTransform = (value: string, providerHome: string) => string;

function readableContentString(value: string, providerHome: string): string {
  const first = value.indexOf(providerHome);
  if (first < 0) return value;
  let projected = "";
  let cursor = 0;
  let match = first;
  while (match >= 0) {
    projected += `${value.slice(cursor, match)}${HOME_REPLACEMENT}`;
    cursor = match + providerHome.length;
    match = value.indexOf(providerHome, cursor);
  }
  return `${projected}${value.slice(cursor)}`;
}

function injectiveContentString(value: string, providerHome: string): string {
  const sentinel = contentEscapeSentinel(providerHome);
  // Prefix-decodable tokens: home -> marker, literal marker -> S1, literal S -> S0.
  let projected = "";
  let index = 0;
  while (index < value.length) {
    if (value.startsWith(providerHome, index)) {
      projected += HOME_REPLACEMENT;
      index += providerHome.length;
    } else if (value.startsWith(HOME_REPLACEMENT, index)) {
      projected += `${sentinel}1`;
      index += HOME_REPLACEMENT.length;
    } else if (value[index] === sentinel) {
      projected += `${sentinel}0`;
      index += 1;
    } else {
      projected += value[index]!;
      index += 1;
    }
  }
  return projected;
}

function nullableContentString(
  value: string | null,
  providerHome: string,
  transform: ContentTransform,
): string | null {
  return value === null ? null : transform(value, providerHome);
}

function projectionDataRecord(
  value: unknown,
  maximumKeys: number,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
    Array.isArray(value)) throw new TypeError(EVENT_PROJECTION_ERROR);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(EVENT_PROJECTION_ERROR);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > maximumKeys || keys.some((key) => typeof key !== "string")) {
    throw new TypeError(EVENT_PROJECTION_ERROR);
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(EVENT_PROJECTION_ERROR);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function projectionDenseArray(
  value: unknown,
  maximumItems: number,
): readonly unknown[] | null {
  if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
    throw new TypeError(EVENT_PROJECTION_ERROR);
  }
  if (value === null || typeof value !== "object" || !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximumItems) return null;
  const length = lengthDescriptor.value;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") ||
    keys.length !== length + 1 || !keys.includes("length")) {
    return null;
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(EVENT_PROJECTION_ERROR);
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function projectedContentLengths(
  value: string,
  providerHome: string,
): Readonly<{ readable: number; injective: number }> {
  if (sqliteTextLengthAtMost(value, MAX_PROVIDER_INDEX_EVENT_JSON_CHARS) === null) {
    throw new TypeError(EVENT_PROJECTION_ERROR);
  }
  const sentinel = contentEscapeSentinel(providerHome);
  let readableLength = 0;
  let injectiveLength = 0;
  for (let index = 0; index < value.length;) {
    if (value.startsWith(providerHome, index)) {
      readableLength += HOME_REPLACEMENT.length;
      injectiveLength += HOME_REPLACEMENT.length;
      index += providerHome.length;
    } else if (value.startsWith(HOME_REPLACEMENT, index)) {
      readableLength += HOME_REPLACEMENT.length;
      injectiveLength += 2;
      index += HOME_REPLACEMENT.length;
    } else if (value.startsWith(sentinel, index)) {
      readableLength += 1;
      injectiveLength += 2;
      index += sentinel.length;
    } else {
      const codeUnit = value.charCodeAt(index);
      index += codeUnit >= 0xd800 && codeUnit <= 0xdbff ? 2 : 1;
      readableLength += 1;
      injectiveLength += 1;
    }
    if (readableLength > MAX_PROVIDER_INDEX_EVENT_JSON_CHARS ||
      injectiveLength > MAX_PROVIDER_INDEX_EVENT_JSON_CHARS) {
      throw new TypeError(EVENT_PROJECTION_ERROR);
    }
  }
  return Object.freeze({ readable: readableLength, injective: injectiveLength });
}

function preflightProjectionBoundary(eventValue: unknown): void {
  const event = projectionDataRecord(eventValue, 32);
  const key = projectionDataRecord(event.key, 3);
  const providerHome = key.home;
  if (typeof providerHome !== "string" || providerHome.length === 0 ||
    !hasCanonicalUnicode(providerHome)) throw new TypeError(EVENT_PROJECTION_ERROR);
  const values: unknown[] = [];
  switch (event.type) {
    case "message": values.push(event.text); break;
    case "message-delta": values.push(event.delta); break;
    case "plan": values.push(event.text, event.status); break;
    case "activity": values.push(event.activity, event.status, event.message); break;
    case "status": values.push(event.status); break;
    case "diagnostic": {
      values.push(event.code, event.message, event.method);
      const shapeKeys = projectionDenseArray(event.shapeKeys, MAX_DIAGNOSTIC_SHAPE_KEYS);
      if (shapeKeys !== null) {
        for (const keyValue of shapeKeys) values.push(keyValue);
      }
      break;
    }
    default:
      break;
  }
  let readableLength = 0;
  let injectiveLength = 0;
  for (const value of values) {
    if (typeof value !== "string") continue;
    const lengths = projectedContentLengths(value, providerHome);
    readableLength += lengths.readable;
    injectiveLength += lengths.injective;
    if (readableLength > MAX_PROVIDER_INDEX_EVENT_JSON_CHARS ||
      injectiveLength > MAX_PROVIDER_INDEX_EVENT_JSON_CHARS) {
      throw new TypeError(EVENT_PROJECTION_ERROR);
    }
  }
}

function canonicalOccurredAt(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_OCCURRED_AT_CHARS) {
    throw new TypeError(EVENT_PROJECTION_ERROR);
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new TypeError(EVENT_PROJECTION_ERROR);
  }
  return value;
}

type DiagnosticEvent = Extract<ProviderEvent, { type: "diagnostic" }>;
type NativeProviderRequest = Extract<ProviderEvent, { type: "request" }>["request"];

interface ProjectionContext {
  readonly provider: ProviderId;
  readonly key: NativeTaskKey;
  readonly occurredAt: string;
}

function diagnosticText(value: unknown, maximum: number, minimum = 1): string | null {
  if (typeof value !== "string" || value.includes("\u0000")) return null;
  const length = sqliteTextLengthAtMost(value, maximum);
  return length === null || length < minimum ? null : value;
}

function diagnosticShapeKeys(value: unknown): readonly string[] | null {
  const values = projectionDenseArray(value, MAX_DIAGNOSTIC_SHAPE_KEYS);
  if (values === null) return null;
  const result: string[] = [];
  for (const value of values) {
    const key = diagnosticText(value, MAX_DIAGNOSTIC_SHAPE_KEY_CHARS, 0);
    if (key === null) return null;
    result.push(key);
  }
  return Object.freeze(result);
}

function preservedDiagnostic(event: DiagnosticEvent): DiagnosticEvent | null {
  const code = diagnosticText(event.code, MAX_DIAGNOSTIC_CODE_CHARS);
  const message = diagnosticText(event.message, MAX_DIAGNOSTIC_MESSAGE_CHARS);
  const method = event.method === null
    ? null
    : diagnosticText(event.method, MAX_DIAGNOSTIC_METHOD_CHARS, 0);
  const shapeKeys = diagnosticShapeKeys(event.shapeKeys);
  if ((event.level !== "warning" && event.level !== "error") || code === null ||
    message === null || (event.method !== null && method === null) || shapeKeys === null) {
    return null;
  }
  const redactedCode = diagnosticText(redactSecrets(code), MAX_DIAGNOSTIC_CODE_CHARS);
  const redactedMessage = diagnosticText(redactSecrets(message), MAX_DIAGNOSTIC_MESSAGE_CHARS);
  const redactedMethod = method === null
    ? null
    : diagnosticText(redactSecrets(method), MAX_DIAGNOSTIC_METHOD_CHARS, 0);
  const redactedShapeKeys = shapeKeys.map((key) =>
    diagnosticText(redactSecrets(key), MAX_DIAGNOSTIC_SHAPE_KEY_CHARS, 0));
  if (redactedCode === null || redactedMessage === null ||
    (method !== null && redactedMethod === null) || redactedShapeKeys.includes(null)) {
    return null;
  }
  return {
    provider: event.provider,
    key: snapshotNativeTaskKey(event.key),
    occurredAt: canonicalOccurredAt(event.occurredAt),
    type: "diagnostic",
    level: event.level,
    code: redactedCode,
    message: redactedMessage,
    method: redactedMethod,
    shapeKeys: Object.freeze(redactedShapeKeys as string[]),
  };
}

function hasHiddenDiagnosticMarker(event: DiagnosticEvent): boolean {
  return [event.code, event.message, event.method, ...event.shapeKeys]
    .some((value) => typeof value === "string" && HIDDEN_PROVIDER_MARKER.test(value));
}

function isExpectedUnknownDiagnostic(event: ProviderEvent): boolean {
  return event.type === "diagnostic" &&
    event.level === "warning" &&
    event.code === "UNKNOWN_PROVIDER_EVENT" &&
    event.message === "Provider emitted an unknown or unsafe event shape";
}

function hiddenDiagnostic(context: ProjectionContext): ProviderEvent {
  return normalizeProviderEvent({ hiddenReasoning: true }, context);
}

function normalizeProjectionBoundary(event: ProviderEvent, trustedSnapshot = false): ProviderEvent {
  try {
    preflightProjectionBoundary(event);
    const snapshot = trustedSnapshot ? event : structuredClone(event);
    if (snapshot === null || typeof snapshot !== "object") throw new TypeError();
    const context: ProjectionContext = {
      provider: snapshot.provider,
      key: snapshot.key,
      occurredAt: canonicalOccurredAt(snapshot.occurredAt),
    };
    const boundary = normalizeProviderEvent(snapshot, context);
    if (snapshot.type !== "diagnostic") return boundary;
    if (!isExpectedUnknownDiagnostic(boundary)) return boundary;
    const preserved = preservedDiagnostic(snapshot);
    if (preserved !== null && hasHiddenDiagnosticMarker(preserved)) {
      return hiddenDiagnostic(context);
    }
    return preserved ?? boundary;
  } catch {
    throw new TypeError(EVENT_PROJECTION_ERROR);
  }
}

function assertNever(value: never): never {
  void value;
  throw new TypeError(EVENT_PROJECTION_ERROR);
}

function indexedRequest(
  request: NativeProviderRequest,
  providerHome: string,
): IndexedProviderRequest {
  const identity = indexedIdentity(request.identity, providerHome);
  switch (request.kind) {
    case "command-approval":
      return Object.freeze({ kind: "command-approval", identity });
    case "file-change-approval":
      return Object.freeze({ kind: "file-change-approval", identity });
    case "mcp-elicitation":
      return Object.freeze({ kind: "mcp-elicitation", identity });
    case "permission":
      return Object.freeze({ kind: "permission", identity });
    case "user-input":
      return Object.freeze({
        kind: "user-input",
        identity,
        autoResolutionMs: request.autoResolutionMs,
      });
    default:
      return assertNever(request);
  }
}

function projectNormalizedEvent(
  normalized: ProviderEvent,
  transformContent: ContentTransform,
): IndexedProviderEvent {
  const providerHome = normalized.key.home;
  const locator = taskLocator(normalized.key);
  const occurredAt = canonicalOccurredAt(normalized.occurredAt);
  switch (normalized.type) {
    case "message":
      return Object.freeze({
        provider: normalized.provider,
        locator,
        occurredAt,
        type: "message",
        role: normalized.role,
        text: transformContent(normalized.text, providerHome),
        turnId: indexedNativeId(normalized.turnId, providerHome, "turnId"),
        itemId: indexedNativeId(normalized.itemId, providerHome, "itemId"),
      });
    case "message-delta":
      return Object.freeze({
        provider: normalized.provider,
        locator,
        occurredAt,
        type: "message-delta",
        role: normalized.role,
        delta: transformContent(normalized.delta, providerHome),
        turnId: indexedNativeId(normalized.turnId, providerHome, "turnId"),
        itemId: indexedNativeId(normalized.itemId, providerHome, "itemId"),
      });
    case "plan":
      return Object.freeze({
        provider: normalized.provider,
        locator,
        occurredAt,
        type: "plan",
        turnId: indexedNativeId(normalized.turnId, providerHome, "turnId"),
        itemId: indexedNativeId(normalized.itemId, providerHome, "itemId"),
        stepIndex: normalized.stepIndex,
        text: transformContent(normalized.text, providerHome),
        status: transformContent(normalized.status, providerHome),
      });
    case "activity":
      return Object.freeze({
        provider: normalized.provider,
        locator,
        occurredAt,
        type: "activity",
        turnId: indexedNativeId(normalized.turnId, providerHome, "turnId"),
        itemId: indexedNativeId(normalized.itemId, providerHome, "itemId"),
        activity: transformContent(normalized.activity, providerHome),
        status: transformContent(normalized.status, providerHome),
        message: nullableContentString(normalized.message, providerHome, transformContent),
      });
    case "diff-summary":
      return Object.freeze({
        provider: normalized.provider,
        locator,
        occurredAt,
        type: "diff-summary",
        turnId: indexedNativeId(normalized.turnId, providerHome, "turnId"),
        changedFiles: normalized.changedFiles,
        additions: normalized.additions,
        deletions: normalized.deletions,
      });
    case "usage":
      return Object.freeze({
        provider: normalized.provider,
        locator,
        occurredAt,
        type: "usage",
        turnId: indexedNativeId(normalized.turnId, providerHome, "turnId"),
        inputTokens: normalized.inputTokens,
        outputTokens: normalized.outputTokens,
        cachedInputTokens: normalized.cachedInputTokens,
        totalTokens: normalized.totalTokens,
      });
    case "status":
      return Object.freeze({
        provider: normalized.provider,
        locator,
        occurredAt,
        type: "status",
        scope: normalized.scope,
        status: transformContent(normalized.status, providerHome),
        nativeId: indexedNativeId(normalized.nativeId, providerHome, "nativeId"),
      });
    case "request":
      return Object.freeze({
        provider: normalized.provider,
        locator,
        occurredAt,
        type: "request",
        request: indexedRequest(normalized.request, providerHome),
      });
    case "request-resolved":
      return Object.freeze({
        provider: normalized.provider,
        locator,
        occurredAt,
        type: "request-resolved",
        identity: indexedIdentity(normalized.identity, providerHome),
      });
    case "diagnostic": {
      const suppressed = normalized.code === "HIDDEN_PROVIDER_CONTENT_SUPPRESSED";
      return Object.freeze({
        provider: normalized.provider,
        locator,
        occurredAt,
        type: "diagnostic",
        level: normalized.level,
        code: transformContent(normalized.code, providerHome),
        message: transformContent(normalized.message, providerHome),
        method: suppressed
          ? null
          : nullableContentString(normalized.method, providerHome, transformContent),
        shapeKeys: Object.freeze(
          normalized.shapeKeys.map((key) => transformContent(key, providerHome)),
        ),
      });
    }
    default:
      return assertNever(normalized);
  }
}

export function projectIndexedProviderEvent(event: ProviderEvent): IndexedProviderEvent {
  try {
    return projectNormalizedEvent(
      normalizedEventForProjection(event, false),
      readableContentString,
    );
  } catch {
    throw new TypeError(EVENT_PROJECTION_ERROR);
  }
}

function normalizedEventForProjection(
  event: ProviderEvent,
  trustedSnapshot: boolean,
): ProviderEvent {
  const normalized = normalizeProjectionBoundary(event, trustedSnapshot);
  preflightProjectionBoundary(normalized);
  return normalized;
}

function eventProjectionsForHash(event: ProviderEvent, trustedSnapshot: boolean): {
  readonly publicEvent: IndexedProviderEvent;
  readonly hashEvent: IndexedProviderEvent;
} {
  try {
    const normalized = normalizedEventForProjection(event, trustedSnapshot);
    return Object.freeze({
      publicEvent: projectNormalizedEvent(normalized, readableContentString),
      hashEvent: projectNormalizedEvent(normalized, injectiveContentString),
    });
  } catch {
    throw new TypeError(EVENT_PROJECTION_ERROR);
  }
}

function eventOrdinal(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_EVENT_ORDINAL) {
    throw new TypeError("event ordinal must be a safe integer from 0 through 1000000");
  }
  return value;
}

export function indexedProviderEventItemId(event: IndexedProviderEvent): string | null {
  try {
    const { raw, locator } = indexedExtractorBoundary(event);
    switch (raw.type) {
      case "message":
      case "message-delta":
      case "plan":
      case "activity":
        return extractedNullableNativeId(raw.itemId);
      case "request": {
        const request = projectionDataRecord(raw.request, 3);
        return extractedNullableNativeId(indexedExtractorIdentity(request.identity, locator).itemId);
      }
      case "request-resolved":
        return extractedNullableNativeId(indexedExtractorIdentity(raw.identity, locator).itemId);
      case "status":
        return raw.scope === "item" ? extractedNullableNativeId(raw.nativeId) : null;
      case "diff-summary":
      case "usage":
      case "diagnostic":
        return null;
      default:
        throw new TypeError(EVENT_PROJECTION_ERROR);
    }
  } catch {
    throw new TypeError(EVENT_PROJECTION_ERROR);
  }
}

function indexedExtractorBoundary(event: IndexedProviderEvent): {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly locator: ProviderTaskLocator;
} {
  const raw = projectionDataRecord(event, 32);
  const locator = validatedLocator(raw.locator);
  if (raw.provider !== locator.provider) throw new TypeError(EVENT_PROJECTION_ERROR);
  return Object.freeze({ raw, locator });
}

function indexedExtractorIdentity(
  value: unknown,
  expectedLocator: ProviderTaskLocator,
): Readonly<Record<string, unknown>> {
  const identity = projectionDataRecord(value, 6);
  const locator = validatedLocator(identity.locator);
  if (locator.version !== expectedLocator.version || locator.provider !== expectedLocator.provider ||
    locator.homeFingerprint !== expectedLocator.homeFingerprint ||
    locator.nativeTaskId !== expectedLocator.nativeTaskId) {
    throw new TypeError(EVENT_PROJECTION_ERROR);
  }
  return identity;
}

function extractedNullableNativeId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(EVENT_PROJECTION_ERROR);
  return value;
}

interface CanonicalJsonState {
  sqliteCodePoints: number;
  utf8Bytes: number;
  visits: number;
  readonly maximumCodePoints: number;
  readonly maximumUtf8Bytes: number;
  readonly chunks: string[] | null;
}

function appendCanonicalJson(
  state: CanonicalJsonState,
  value: string,
  sqliteCodePoints = value.length,
  utf8Bytes = value.length,
): void {
  if (sqliteCodePoints > state.maximumCodePoints - state.sqliteCodePoints ||
    utf8Bytes > state.maximumUtf8Bytes - state.utf8Bytes) throw new TypeError();
  state.sqliteCodePoints += sqliteCodePoints;
  state.utf8Bytes += utf8Bytes;
  if (state.chunks !== null) {
    const lastIndex = state.chunks.length - 1;
    const last = state.chunks[lastIndex];
    if (last !== undefined && last.length + value.length <= 8_192) {
      state.chunks[lastIndex] = last + value;
    } else {
      state.chunks.push(value);
    }
  }
}

function encodeCanonicalJsonString(state: CanonicalJsonState, value: string): void {
  appendCanonicalJson(state, '"');
  let rawStart = 0;
  let rawCodePoints = 0;
  let rawUtf8Bytes = 0;
  let index = 0;
  while (index < value.length) {
    const codeUnit = value.charCodeAt(index);
    let escaped: string | null = null;
    let width = 1;
    switch (codeUnit) {
      case 0x08: escaped = "\\b"; break;
      case 0x09: escaped = "\\t"; break;
      case 0x0a: escaped = "\\n"; break;
      case 0x0c: escaped = "\\f"; break;
      case 0x0d: escaped = "\\r"; break;
      case 0x22: escaped = '\\"'; break;
      case 0x5c: escaped = "\\\\"; break;
      default:
        if (codeUnit < 0x20) {
          escaped = `\\u${codeUnit.toString(16).padStart(4, "0")}`;
        } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
          if (index + 1 >= value.length) throw new TypeError();
          const next = value.charCodeAt(index + 1);
          if (next < 0xdc00 || next > 0xdfff) throw new TypeError();
          width = 2;
        } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
          throw new TypeError();
        }
        break;
    }
    if (escaped === null) {
      rawCodePoints += 1;
      if (width === 2) {
        rawUtf8Bytes += 4;
      } else if (codeUnit <= 0x7f) {
        rawUtf8Bytes += 1;
      } else if (codeUnit <= 0x7ff) {
        rawUtf8Bytes += 2;
      } else {
        rawUtf8Bytes += 3;
      }
      index += width;
      continue;
    }
    if (rawCodePoints > 0) {
      appendCanonicalJson(
        state,
        state.chunks === null ? "" : value.slice(rawStart, index),
        rawCodePoints,
        rawUtf8Bytes,
      );
    }
    appendCanonicalJson(state, escaped);
    index += 1;
    rawStart = index;
    rawCodePoints = 0;
    rawUtf8Bytes = 0;
  }
  if (rawCodePoints > 0) {
    appendCanonicalJson(
      state,
      state.chunks === null ? "" : value.slice(rawStart),
      rawCodePoints,
      rawUtf8Bytes,
    );
  }
  appendCanonicalJson(state, '"');
}

function encodeCanonicalProviderIndexJson(
  value: unknown,
  state: CanonicalJsonState,
  depth: number,
  ancestors: WeakSet<object>,
): void {
  if (depth > MAX_CANONICAL_JSON_DEPTH) throw new TypeError();
  state.visits += 1;
  if (state.visits > MAX_CANONICAL_JSON_VISITS) throw new TypeError();
  if (value === null) {
    appendCanonicalJson(state, "null");
    return;
  }
  if (typeof value === "string") {
    encodeCanonicalJsonString(state, value);
    return;
  }
  if (typeof value === "boolean") {
    appendCanonicalJson(state, value ? "true" : "false");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError();
    appendCanonicalJson(state, JSON.stringify(value));
    return;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) throw new TypeError();
  if (ancestors.has(value)) throw new TypeError();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError();
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
        lengthDescriptor.value > MAX_CANONICAL_JSON_ARRAY_ITEMS) throw new TypeError();
      const length = lengthDescriptor.value;
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key !== "string") ||
        ownKeys.length !== length + 1 || !ownKeys.includes("length")) {
        throw new TypeError();
      }
      appendCanonicalJson(state, "[");
      for (let index = 0; index < length; index += 1) {
        if (index > 0) appendCanonicalJson(state, ",");
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) throw new TypeError();
        encodeCanonicalProviderIndexJson(descriptor.value, state, depth + 1, ancestors);
      }
      appendCanonicalJson(state, "]");
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_CANONICAL_JSON_OBJECT_KEYS || keys.some(
      (key) => typeof key !== "string" || !hasExactUtf8Encoding(key),
    )) throw new TypeError();
    const sortedKeys = (keys as string[]).sort();
    appendCanonicalJson(state, "{");
    for (let index = 0; index < sortedKeys.length; index += 1) {
      if (index > 0) appendCanonicalJson(state, ",");
      const key = sortedKeys[index]!;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) throw new TypeError();
      encodeCanonicalJsonString(state, key);
      appendCanonicalJson(state, ":");
      encodeCanonicalProviderIndexJson(descriptor.value, state, depth + 1, ancestors);
    }
    appendCanonicalJson(state, "}");
  } finally {
    ancestors.delete(value);
  }
}

interface CanonicalJsonMetrics {
  readonly sqliteCodePoints: number;
  readonly utf8Bytes: number;
}

function canonicalProviderIndexJsonMetrics(
  value: unknown,
  maximumCodePoints: number,
  maximumUtf8Bytes: number,
): CanonicalJsonMetrics | null {
  try {
    if (!Number.isSafeInteger(maximumCodePoints) || maximumCodePoints < 0 ||
      !Number.isSafeInteger(maximumUtf8Bytes) || maximumUtf8Bytes < 0) throw new TypeError();
    const state: CanonicalJsonState = {
      sqliteCodePoints: 0,
      utf8Bytes: 0,
      visits: 0,
      maximumCodePoints,
      maximumUtf8Bytes,
      chunks: null,
    };
    encodeCanonicalProviderIndexJson(value, state, 0, new WeakSet<object>());
    return Object.freeze({
      sqliteCodePoints: state.sqliteCodePoints,
      utf8Bytes: state.utf8Bytes,
    });
  } catch {
    return null;
  }
}

export function canonicalProviderIndexJson(value: unknown): string {
  try {
    const metrics = canonicalProviderIndexJsonMetrics(
      value,
      MAX_CANONICAL_JSON_OUTPUT_CODE_POINTS,
      MAX_CANONICAL_JSON_OUTPUT_BYTES,
    );
    if (metrics === null) throw new TypeError();
    const chunks: string[] = [];
    const state: CanonicalJsonState = {
      sqliteCodePoints: 0,
      utf8Bytes: 0,
      visits: 0,
      maximumCodePoints: metrics.sqliteCodePoints,
      maximumUtf8Bytes: metrics.utf8Bytes,
      chunks,
    };
    encodeCanonicalProviderIndexJson(value, state, 0, new WeakSet<object>());
    if (state.sqliteCodePoints !== metrics.sqliteCodePoints ||
      state.utf8Bytes !== metrics.utf8Bytes) throw new TypeError();
    return chunks.join("");
  } catch {
    throw new TypeError("provider index canonical JSON is invalid");
  }
}

function projectedEventDigest(event: IndexedProviderEvent, ordinal: number): string {
  return sha256(canonicalProviderIndexJson({ event, ordinal }));
}

export function cachedEventItemId(event: ProviderEvent, ordinalValue: number): string {
  try {
    const bundle = providerEventCacheBundle(
      event,
      ordinalValue,
      false,
      MAX_PROVIDER_INDEX_EVENT_JSON_CHARS,
      MAX_PROVIDER_INDEX_EVENT_JSON_CHARS * 4,
    );
    if (!bundle.ok) throw new TypeError();
    return bundle.nativeItemKey;
  } catch {
    throw new TypeError(CACHED_EVENT_ITEM_KEY_ERROR);
  }
}

export function providerEventReplayKey(event: ProviderEvent, ordinalValue: number): string {
  const bundle = providerEventCacheBundle(
    event,
    ordinalValue,
    false,
    MAX_PROVIDER_INDEX_EVENT_JSON_CHARS,
    MAX_PROVIDER_INDEX_EVENT_JSON_CHARS * 4,
  );
  if (!bundle.ok) throw new TypeError(EVENT_PROJECTION_ERROR);
  return bundle.replayKey;
}

type ProviderEventCacheBundle =
  | Readonly<{ ok: false; limit: "PER_EVENT" | "AGGREGATE" }>
  | Readonly<{
      ok: true;
      event: IndexedProviderEvent;
      nativeItemKey: string;
      replayKey: string;
      canonicalEventJsonChars: number;
      canonicalEventJsonBytes: number;
    }>;

function providerEventCacheBundle(
  event: ProviderEvent,
  ordinalValue: number,
  trustedSnapshot: boolean,
  remainingCanonicalEventJsonChars: number,
  remainingCanonicalEventJsonBytes: number,
): ProviderEventCacheBundle {
  const ordinal = eventOrdinal(ordinalValue);
  const projections = eventProjectionsForHash(event, trustedSnapshot);
  const canonicalEventJsonMetrics = canonicalProviderIndexJsonMetrics(
    projections.publicEvent,
    MAX_PROVIDER_INDEX_EVENT_JSON_CHARS,
    MAX_PROVIDER_INDEX_EVENT_JSON_CHARS * 4,
  );
  if (canonicalEventJsonMetrics === null) {
    return Object.freeze({ ok: false as const, limit: "PER_EVENT" as const });
  }
  const canonicalEventJsonChars = canonicalEventJsonMetrics.sqliteCodePoints;
  const canonicalEventJsonBytes = canonicalEventJsonMetrics.utf8Bytes;
  if (!Number.isSafeInteger(remainingCanonicalEventJsonChars) ||
    !Number.isSafeInteger(remainingCanonicalEventJsonBytes) ||
    remainingCanonicalEventJsonChars < canonicalEventJsonChars ||
    remainingCanonicalEventJsonBytes < canonicalEventJsonBytes) {
    return Object.freeze({ ok: false as const, limit: "AGGREGATE" as const });
  }
  const digest = projectedEventDigest(projections.hashEvent, ordinal);
  const nativeItemId = indexedProviderEventItemId(projections.publicEvent);
  const nativeItemKey = nativeItemId === null
    ? `synthetic:v1:${ordinal}:${digest}`
    : nativeCacheKey(nativeItemId, "native item id");
  if (nativeItemKey.length > MAX_CACHED_KEY_CHARS) throw new TypeError();
  return Object.freeze({
    ok: true as const,
    event: projections.publicEvent,
    nativeItemKey,
    replayKey: `replay:v1:${ordinal}:${digest}`,
    canonicalEventJsonChars,
    canonicalEventJsonBytes,
  });
}

/** Internal persistence path: caller must supply the already bounded deep-frozen event snapshot. */
export function projectProviderEventCacheBundleFromSnapshot(
  event: Readonly<ProviderEvent>,
  ordinalValue: number,
  remainingCanonicalEventJsonChars: number,
  remainingCanonicalEventJsonBytes: number,
): ProviderEventCacheBundle {
  return providerEventCacheBundle(
    event,
    ordinalValue,
    true,
    remainingCanonicalEventJsonChars,
    remainingCanonicalEventJsonBytes,
  );
}

export type ParsedCachedEventItemKey =
  | Readonly<{ kind: "native"; nativeItemId: string }>
  | Readonly<{ kind: "synthetic"; nativeItemId: null }>;

export function parseCachedEventItemKey(
  value: unknown,
  expectedOrdinalValue: number,
): ParsedCachedEventItemKey {
  try {
    const expectedOrdinal = eventOrdinal(expectedOrdinalValue);
    if (typeof value === "string" && value.startsWith("native:v1:")) {
      return Object.freeze({
        kind: "native" as const,
        nativeItemId: parseNativeCacheKey(value, "native item id"),
      });
    }
    if (typeof value !== "string" || value.length > MAX_CACHED_KEY_CHARS ||
      value !== `synthetic:v1:${expectedOrdinal}:${value.slice(-64)}`) {
      throw new TypeError();
    }
    const digest = value.slice(-64);
    if (!FINGERPRINT.test(digest)) throw new TypeError();
    return Object.freeze({ kind: "synthetic" as const, nativeItemId: null });
  } catch {
    throw new TypeError(CACHED_EVENT_ITEM_KEY_ERROR);
  }
}

export function parseProviderEventReplayKey(
  value: unknown,
  expectedOrdinalValue: number,
): string {
  try {
    const expectedOrdinal = eventOrdinal(expectedOrdinalValue);
    if (typeof value !== "string" || value.length > MAX_CACHED_KEY_CHARS ||
      value !== `replay:v1:${expectedOrdinal}:${value.slice(-64)}` ||
      !FINGERPRINT.test(value.slice(-64))) {
      throw new TypeError();
    }
    return value;
  } catch {
    throw new TypeError("provider event replay key is invalid");
  }
}

export function indexedProviderEventTurnId(event: IndexedProviderEvent): string | null {
  try {
    const { raw, locator } = indexedExtractorBoundary(event);
    switch (raw.type) {
      case "message":
      case "message-delta":
      case "plan":
      case "activity":
      case "diff-summary":
      case "usage":
        return extractedNullableNativeId(raw.turnId);
      case "request": {
        const request = projectionDataRecord(raw.request, 3);
        return extractedNullableNativeId(indexedExtractorIdentity(request.identity, locator).turnId);
      }
      case "request-resolved":
        return extractedNullableNativeId(indexedExtractorIdentity(raw.identity, locator).turnId);
      case "status":
        return raw.scope === "turn" ? extractedNullableNativeId(raw.nativeId) : null;
      case "diagnostic":
        return null;
      default:
        throw new TypeError(EVENT_PROJECTION_ERROR);
    }
  } catch {
    throw new TypeError(EVENT_PROJECTION_ERROR);
  }
}
