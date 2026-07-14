import { createHash } from "node:crypto";
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

const LOCATOR_VERSION = 1 as const;
const LOCATOR_PREFIX = "pt1";
const MAX_SERIALIZED_LOCATOR_CHARS = 1_024;
const MAX_EVENT_ORDINAL = 1_000_000;
const MAX_OCCURRED_AT_CHARS = 32;
const MAX_DIAGNOSTIC_CODE_CHARS = 128;
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 512;
const MAX_DIAGNOSTIC_METHOD_CHARS = 256;
const MAX_DIAGNOSTIC_SHAPE_KEY_CHARS = 64;
const MAX_DIAGNOSTIC_SHAPE_KEYS = 32;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const HIDDEN_PROVIDER_MARKER =
  /(?:hidden|private|internal)[-_ ]?(?:reasoning|thought)|chain[-_ ]?of[-_ ]?thought/iu;
const LOCATOR_ERROR = "provider task locator is invalid";
const EVENT_PROJECTION_ERROR = "provider event could not be safely projected";
const TASK_KEY_ERROR = "native task key is unsafe for provider indexing";
const HOME_ERROR = "provider home must be canonical exact UTF-8";
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
  return Buffer.from(value, "utf8").toString("utf8") === value;
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
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError();
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
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError();
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
  return `native:v1:${Buffer.from(nativeId, "utf8").toString("base64url")}`;
}

export function cachedTurnKey(nativeTurnId: string | null): string {
  return nativeTurnId === null ? "none:v1" : nativeCacheKey(nativeTurnId, "native turn id");
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
  return value.split(providerHome).join(HOME_REPLACEMENT);
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

function preservedDiagnostic(event: DiagnosticEvent): DiagnosticEvent | null {
  if ((event.level !== "warning" && event.level !== "error") ||
    typeof event.code !== "string" || event.code.length === 0 ||
    event.code.length > MAX_DIAGNOSTIC_CODE_CHARS ||
    typeof event.message !== "string" || event.message.length === 0 ||
    event.message.length > MAX_DIAGNOSTIC_MESSAGE_CHARS ||
    (event.method !== null && typeof event.method !== "string") ||
    (event.method !== null && event.method.length > MAX_DIAGNOSTIC_METHOD_CHARS) ||
    !isDenseDiagnosticShapeKeys(event.shapeKeys)) {
    return null;
  }
  return {
    provider: event.provider,
    key: snapshotNativeTaskKey(event.key),
    occurredAt: canonicalOccurredAt(event.occurredAt),
    type: "diagnostic",
    level: event.level,
    code: redactSecrets(event.code),
    message: redactSecrets(event.message),
    method: event.method === null
      ? null
      : redactSecrets(event.method).slice(0, MAX_DIAGNOSTIC_METHOD_CHARS),
    shapeKeys: Object.freeze(
      event.shapeKeys.map((key) => redactSecrets(key).slice(0, MAX_DIAGNOSTIC_SHAPE_KEY_CHARS)),
    ),
  };
}

function isDenseDiagnosticShapeKeys(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_DIAGNOSTIC_SHAPE_KEYS) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index) ||
      typeof value[index] !== "string" ||
      value[index].length > MAX_DIAGNOSTIC_SHAPE_KEY_CHARS) {
      return false;
    }
  }
  return true;
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

function normalizeProjectionBoundary(event: ProviderEvent): ProviderEvent {
  try {
    const snapshot = structuredClone(event);
    if (snapshot === null || typeof snapshot !== "object") throw new TypeError();
    const context: ProjectionContext = {
      provider: snapshot.provider,
      key: snapshot.key,
      occurredAt: canonicalOccurredAt(snapshot.occurredAt),
    };
    const boundary = normalizeProviderEvent(snapshot, context);
    if (snapshot.type !== "diagnostic") return boundary;
    if (!isExpectedUnknownDiagnostic(boundary)) return boundary;
    if (hasHiddenDiagnosticMarker(snapshot)) return hiddenDiagnostic(context);
    return preservedDiagnostic(snapshot) ?? boundary;
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
    return projectNormalizedEvent(normalizeProjectionBoundary(event), readableContentString);
  } catch {
    throw new TypeError(EVENT_PROJECTION_ERROR);
  }
}

function eventProjectionsForHash(event: ProviderEvent): {
  readonly publicEvent: IndexedProviderEvent;
  readonly hashEvent: IndexedProviderEvent;
} {
  try {
    const normalized = normalizeProjectionBoundary(event);
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

function actualItemId(event: IndexedProviderEvent): string | null {
  switch (event.type) {
    case "message":
    case "message-delta":
    case "plan":
    case "activity":
      return event.itemId;
    case "request":
      return event.request.identity.itemId;
    case "request-resolved":
      return event.identity.itemId;
    case "status":
      return event.scope === "item" ? event.nativeId : null;
    case "diff-summary":
    case "usage":
    case "diagnostic":
      return null;
    default:
      return assertNever(event);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new TypeError("canonical JSON contains a sparse array");
      }
      items.push(canonicalJson(value[index]));
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("canonical JSON contains an unsupported value");
}

function projectedEventDigest(event: IndexedProviderEvent, ordinal: number): string {
  return sha256(canonicalJson({ event, ordinal }));
}

export function cachedEventItemId(event: ProviderEvent, ordinalValue: number): string {
  const ordinal = eventOrdinal(ordinalValue);
  const projections = eventProjectionsForHash(event);
  const nativeItemId = actualItemId(projections.publicEvent);
  if (nativeItemId !== null) return nativeCacheKey(nativeItemId, "native item id");
  return `synthetic:v1:${ordinal}:${projectedEventDigest(projections.hashEvent, ordinal)}`;
}

export function providerEventReplayKey(event: ProviderEvent, ordinalValue: number): string {
  const ordinal = eventOrdinal(ordinalValue);
  const projections = eventProjectionsForHash(event);
  return `replay:v1:${ordinal}:${projectedEventDigest(projections.hashEvent, ordinal)}`;
}
