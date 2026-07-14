import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { types as utilTypes } from "node:util";
import { redactSecrets } from "../redact.js";
import { normalizeProviderNativeId } from "../providers/native-id.js";
import type { ProviderEvent } from "../providers/events.js";
import type {
  NativeRevision,
  NativeTask,
  NativeTaskKey,
  NativeTaskSource,
  NativeTaskSummary,
  ProviderId,
} from "../providers/types.js";
import {
  cachedTurnKey,
  canonicalProviderIndexJson,
  homeFingerprint,
  indexedProviderEventItemId,
  indexedProviderEventTurnId,
  parseCachedEventItemKey,
  parseCachedTurnKey,
  parseProviderEventReplayKey,
  parseTaskLocator,
  projectProviderEventCacheBundleFromSnapshot,
  serializeTaskLocator,
  taskLocator,
  type IndexedProviderEvent,
  type IndexedProviderRequestIdentity,
  type ProviderTaskLocator,
} from "./identity.js";
import {
  hasCanonicalUnicode,
  MAX_PROVIDER_INDEX_EVENT_JSON_CHARS,
  sqliteTextLengthAtMost,
} from "./text-boundary.js";
import {
  PROVIDER_INDEX_STORE_DEFAULTS,
  PROVIDER_INDEX_STORE_HARD_LIMITS,
  ProviderIndexStoreError,
  type NormalizedProviderIndexStoreConfig,
  type PreparedProviderEvent,
  type PreparedProviderTaskSnapshot,
  type PreparedProviderTaskSummary,
  type PreparedProviderTurn,
  type ProviderEventCacheRow,
  type ProviderIndexRegisteredHome,
  type ProviderIndexStoreOptions,
} from "./store-types.js";

const MAX_TITLE_CHARS = 65_536;
const MAX_SHORT_TEXT_CHARS = 512;
const MAX_TIMESTAMP_CHARS = 64;
const MAX_FINGERPRINT_CHARS = 1_024;
const MAX_PATH_CHARS = 16_384;
const MAX_EVENT_JSON_CHARS = MAX_PROVIDER_INDEX_EVENT_JSON_CHARS;
// Fixed aggregate canonical event-json reserves for one prepared task snapshot.
const MAX_EVENT_JSON_CODE_POINTS_PER_TASK = 64 * 1024 * 1024;
const MAX_EVENT_JSON_BYTES_PER_TASK = 64 * 1024 * 1024;
const MAX_EVENT_GRAPH_DEPTH = 16;
const MAX_EVENT_GRAPH_NODES = 128;
const MAX_EVENT_GRAPH_KEYS = 256;
const MAX_EVENT_GRAPH_ARRAY_ITEMS = 64;
const MAX_EVENT_GRAPH_KEY_CHARS = 512;
const MAX_EVENT_GRAPH_STRING_CHARS = MAX_EVENT_JSON_CHARS;
const MAX_EVENT_GRAPH_AGGREGATE_STRING_CHARS = MAX_EVENT_JSON_CHARS + 131_072;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/u;
const CAPACITY_SENTINEL = Object.freeze({ capacity: true });

const OPTION_KEYS = Object.freeze([
  "stageLeaseMs",
  "maxTasksPerGeneration",
  "maxTurnsPerGeneration",
  "maxEventsPerTask",
  "maxEventsPerGeneration",
  "maxMetadataDepth",
  "now",
  "tokenFactory",
] as const);

function exactOwnData(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
    Array.isArray(value)) throw new TypeError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const allowed = new Set<string>([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    required.some((key) => !keys.includes(key))) throw new TypeError();
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) throw new TypeError();
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function exactOwnOptions(value: unknown): Readonly<Record<string, unknown>> {
  return exactOwnData(value, [], OPTION_KEYS);
}

function ownDataRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
    Array.isArray(value)) throw new TypeError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) throw new TypeError();
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) throw new TypeError();
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function denseDataArray(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
  capacityOnOverflow = false,
): readonly unknown[] {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError();
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    throw new TypeError();
  }
  const length = lengthDescriptor.value;
  if (length > maximum) {
    if (capacityOnOverflow) throw CAPACITY_SENTINEL;
    throw new TypeError();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") ||
    keys.length !== length + 1 || !keys.includes("length")) {
    throw new TypeError();
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) throw new TypeError();
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function hasExactUtf8(value: string): boolean {
  return hasCanonicalUnicode(value);
}

function boundedText(value: unknown, maximum: number, minimum = 1): string {
  if (typeof value !== "string") throw new TypeError();
  const length = sqliteTextLengthAtMost(value, maximum);
  if (length === null || length < minimum || value.includes("\u0000") ||
    !hasExactUtf8(value)) throw new TypeError();
  return value;
}

function safeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError();
  }
  return value;
}

function optionalSafeInteger(value: unknown): number | null {
  return value === null ? null : safeInteger(value);
}

function canonicalTimestamp(value: unknown): string | null {
  if (value === null) return null;
  const timestamp = boundedText(value, MAX_TIMESTAMP_CHARS);
  const epoch = Date.parse(timestamp);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== timestamp) throw new TypeError();
  return timestamp;
}

function providerId(value: unknown): ProviderId {
  if (value !== "openai" && value !== "anthropic") throw new TypeError();
  return value;
}

function source(value: unknown): NativeTaskSource {
  if (value !== "native" && value !== "legacy-history" && value !== "degraded-fallback") {
    throw new TypeError();
  }
  return value;
}

function sameLocator(left: ProviderTaskLocator, right: ProviderTaskLocator): boolean {
  return left.version === right.version && left.provider === right.provider &&
    left.homeFingerprint === right.homeFingerprint &&
    left.nativeTaskId === right.nativeTaskId;
}

function canonicalRegisteredHome(value: unknown): Readonly<ProviderIndexRegisteredHome> {
  const snapshot = exactOwnData(
    value,
    ["provider", "homeFingerprint", "canonicalHome"],
  );
  const provider = providerId(snapshot.provider);
  const canonicalHome = boundedText(snapshot.canonicalHome, MAX_PATH_CHARS);
  const fingerprint = boundedText(snapshot.homeFingerprint, 64);
  if (homeFingerprint(provider, canonicalHome) !== fingerprint) throw new TypeError();
  return Object.freeze({ provider, homeFingerprint: fingerprint, canonicalHome });
}

function canonicalNativeId(value: unknown, label: string): string {
  const normalized = normalizeProviderNativeId(value, label);
  if (normalized !== value || !hasExactUtf8(normalized)) throw new TypeError();
  return normalized;
}

function canonicalizeDeepestExistingPath(value: unknown): string {
  const supplied = boundedText(value, MAX_PATH_CHARS);
  if (!path.isAbsolute(supplied) || path.resolve(supplied) !== supplied ||
    path.normalize(supplied) !== supplied) throw new TypeError();
  let candidate = supplied;
  const suffix: string[] = [];
  while (true) {
    try {
      const existing = realpathSync(candidate);
      const resolved = path.join(existing, ...suffix);
      if (sqliteTextLengthAtMost(resolved, MAX_PATH_CHARS) === null ||
        !hasExactUtf8(resolved)) throw new TypeError();
      return resolved;
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error
        ? error.code
        : null;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw new TypeError();
      suffix.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

function homeFreeText(
  value: unknown,
  canonicalHome: string,
  maximum: number,
  minimum = 1,
): string {
  const text = boundedText(value, maximum, minimum);
  if (text.includes(canonicalHome)) throw new TypeError();
  return text;
}

function redactedHomeFreeText(
  value: unknown,
  canonicalHome: string,
  maximum: number,
  minimum = 1,
): string {
  const text = homeFreeText(value, canonicalHome, maximum, minimum);
  return homeFreeText(redactSecrets(text), canonicalHome, maximum, minimum);
}

function secretFreeHomeText(
  value: unknown,
  canonicalHome: string,
  maximum: number,
  minimum = 1,
): string {
  const text = homeFreeText(value, canonicalHome, maximum, minimum);
  if (redactSecrets(text) !== text) throw new TypeError();
  return text;
}

function optionalSecretFreeHomeText(
  value: unknown,
  canonicalHome: string,
  maximum: number,
): string | null {
  return value === null ? null : secretFreeHomeText(value, canonicalHome, maximum);
}

function homeFreeNativeId(value: unknown, canonicalHome: string, label: string): string {
  const id = canonicalNativeId(value, label);
  if (id.includes(canonicalHome)) throw new TypeError();
  return id;
}

function persistedCwd(
  value: unknown,
  canonicalHome: string,
): Readonly<{ cwd: string | null; cwdRedacted: boolean }> {
  if (value === null) return Object.freeze({ cwd: null, cwdRedacted: false });
  const cwd = canonicalizeDeepestExistingPath(value);
  const relative = path.relative(canonicalHome, cwd);
  const contained = relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
  return Object.freeze({ cwd: contained ? null : cwd, cwdRedacted: contained });
}

function normalizedRevision(value: unknown, canonicalHome: string): Readonly<NativeRevision> | null {
  if (value === undefined) return null;
  const snapshot = exactOwnData(value, [
    "updatedAt",
    "status",
    "lastTurnId",
    "lastTurnStatus",
    "lastItemId",
    "fingerprint",
  ]);
  return Object.freeze({
    updatedAt: optionalSafeInteger(snapshot.updatedAt),
    status: secretFreeHomeText(snapshot.status, canonicalHome, MAX_SHORT_TEXT_CHARS),
    lastTurnId: snapshot.lastTurnId === null
      ? null
      : homeFreeNativeId(snapshot.lastTurnId, canonicalHome, "revision last turn id"),
    lastTurnStatus: optionalSecretFreeHomeText(
      snapshot.lastTurnStatus,
      canonicalHome,
      MAX_SHORT_TEXT_CHARS,
    ),
    lastItemId: snapshot.lastItemId === null
      ? null
      : homeFreeNativeId(snapshot.lastItemId, canonicalHome, "revision last item id"),
    fingerprint: secretFreeHomeText(
      snapshot.fingerprint,
      canonicalHome,
      MAX_FINGERPRINT_CHARS,
    ),
  });
}

const SUMMARY_KEYS = Object.freeze([
  "key",
  "title",
  "cwd",
  "model",
  "status",
  "createdAt",
  "updatedAt",
  "archived",
  "source",
] as const);

function normalizedSummary(
  registrationValue: unknown,
  methodKeyValue: unknown,
  summaryValue: unknown,
  includeTurns: boolean,
): {
  readonly registration: Readonly<ProviderIndexRegisteredHome>;
  readonly methodKey: NativeTaskKey;
  readonly summary: Readonly<PreparedProviderTaskSummary>;
  readonly turns: unknown | null;
} {
  const registration = canonicalRegisteredHome(registrationValue);
  const methodLocator = taskLocator(methodKeyValue as NativeTaskKey);
  const methodRecord = exactOwnData(
    methodKeyValue,
    ["provider", "home", "nativeTaskId"],
  );
  if (methodRecord.provider !== registration.provider ||
    methodRecord.home !== registration.canonicalHome ||
    methodLocator.homeFingerprint !== registration.homeFingerprint) {
    throw new TypeError();
  }
  const required = includeTurns ? [...SUMMARY_KEYS, "turns"] : [...SUMMARY_KEYS];
  const raw = exactOwnData(summaryValue, required, ["revision"]);
  const payloadLocator = taskLocator(raw.key as NativeTaskKey);
  if (!sameLocator(payloadLocator, methodLocator)) throw new TypeError();
  const cwd = persistedCwd(raw.cwd, registration.canonicalHome);
  const archived = raw.archived;
  if (archived !== null && typeof archived !== "boolean") throw new TypeError();
  const revision = normalizedRevision(raw.revision, registration.canonicalHome);
  const prepared = Object.freeze({
    locator: methodLocator,
    title: redactedHomeFreeText(raw.title, registration.canonicalHome, MAX_TITLE_CHARS, 0),
    cwd: cwd.cwd,
    cwdRedacted: cwd.cwdRedacted,
    model: optionalSecretFreeHomeText(
      raw.model,
      registration.canonicalHome,
      MAX_SHORT_TEXT_CHARS,
    ),
    status: secretFreeHomeText(
      raw.status,
      registration.canonicalHome,
      MAX_SHORT_TEXT_CHARS,
    ),
    createdAt: canonicalTimestamp(raw.createdAt),
    updatedAt: canonicalTimestamp(raw.updatedAt),
    archived,
    source: source(raw.source),
    revision,
  });
  return Object.freeze({
    registration,
    methodKey: methodKeyValue as NativeTaskKey,
    summary: prepared,
    turns: includeTurns ? raw.turns : null,
  });
}

interface EventGraphBudget {
  nodes: number;
  keys: number;
  stringChars: number;
}

function accountEventGraphString(
  value: string,
  budget: EventGraphBudget,
  perValueMaximum: number,
): void {
  const remaining = MAX_EVENT_GRAPH_AGGREGATE_STRING_CHARS - budget.stringChars;
  if (remaining < 0) throw new TypeError();
  const length = sqliteTextLengthAtMost(value, Math.min(perValueMaximum, remaining));
  if (length === null || !hasExactUtf8(value)) throw new TypeError();
  budget.stringChars += length;
}

function snapshotEventGraph(
  value: unknown,
  depth: number,
  budget: EventGraphBudget,
  ancestors: WeakSet<object>,
): unknown {
  if (depth > MAX_EVENT_GRAPH_DEPTH) throw new TypeError();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    accountEventGraphString(value, budget, MAX_EVENT_GRAPH_STRING_CHARS);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError();
    return value;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) throw new TypeError();
  budget.nodes += 1;
  if (budget.nodes > MAX_EVENT_GRAPH_NODES || ancestors.has(value)) throw new TypeError();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError();
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
        lengthDescriptor.value > MAX_EVENT_GRAPH_ARRAY_ITEMS) {
        throw new TypeError();
      }
      const length = lengthDescriptor.value;
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string") ||
        keys.length !== length + 1 || !keys.includes("length")) throw new TypeError();
      budget.keys += keys.length;
      if (budget.keys > MAX_EVENT_GRAPH_KEYS) throw new TypeError();
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) throw new TypeError();
        result.push(snapshotEventGraph(descriptor.value, depth + 1, budget, ancestors));
      }
      return Object.freeze(result);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string") || keys.length > 32) {
      throw new TypeError();
    }
    budget.keys += keys.length;
    if (budget.keys > MAX_EVENT_GRAPH_KEYS) throw new TypeError();
    const result = Object.create(prototype) as Record<string, unknown>;
    for (const key of keys as string[]) {
      accountEventGraphString(key, budget, MAX_EVENT_GRAPH_KEY_CHARS);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) throw new TypeError();
      Object.defineProperty(result, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: snapshotEventGraph(descriptor.value, depth + 1, budget, ancestors),
      });
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function assertRawDiagnosticShapeKeyCardinality(value: unknown): void {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
    Array.isArray(value)) throw new TypeError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const typeDescriptor = Object.getOwnPropertyDescriptor(value, "type");
  if (typeDescriptor === undefined || !("value" in typeDescriptor)) throw new TypeError();
  if (typeDescriptor.value !== "diagnostic") return;
  const shapeKeysDescriptor = Object.getOwnPropertyDescriptor(value, "shapeKeys");
  if (shapeKeysDescriptor === undefined || !("value" in shapeKeysDescriptor)) {
    throw new TypeError();
  }
  const shapeKeys = shapeKeysDescriptor.value;
  if (shapeKeys === null || typeof shapeKeys !== "object" || utilTypes.isProxy(shapeKeys) ||
    !Array.isArray(shapeKeys) || Object.getPrototypeOf(shapeKeys) !== Array.prototype) {
    throw new TypeError();
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(shapeKeys, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
    lengthDescriptor.value > 32) throw new TypeError();
}

function snapshotProviderEvent(value: unknown): Readonly<ProviderEvent> {
  assertRawDiagnosticShapeKeyCardinality(value);
  const budget: EventGraphBudget = { nodes: 0, keys: 0, stringChars: 0 };
  const snapshot = snapshotEventGraph(value, 0, budget, new WeakSet<object>());
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError();
  }
  return snapshot as Readonly<ProviderEvent>;
}

function assertRawDiagnosticBounds(event: Readonly<ProviderEvent>): void {
  if (event.type !== "diagnostic") return;
  boundedText(event.code, 128);
  boundedText(event.message, MAX_SHORT_TEXT_CHARS);
  if (event.method !== null) boundedText(event.method, 256);
  const keys = denseDataArray(event.shapeKeys, 32);
  for (const key of keys) boundedText(key, 64, 0);
}

function assertRawEventOwnership(eventValue: unknown, expectedLocator: ProviderTaskLocator): void {
  const event = ownDataRecord(eventValue);
  if (event.provider !== expectedLocator.provider ||
    !sameLocator(taskLocator(event.key as NativeTaskKey), expectedLocator)) {
    throw new TypeError();
  }
  let identityValue: unknown = null;
  if (event.type === "request") {
    const request = ownDataRecord(event.request);
    identityValue = request.identity;
  } else if (event.type === "request-resolved") {
    identityValue = event.identity;
  }
  if (identityValue !== null) {
    const identity = ownDataRecord(identityValue);
    if (!sameLocator(taskLocator(identity.key as NativeTaskKey), expectedLocator)) {
      throw new TypeError();
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function preparedEvent(
  eventValue: unknown,
  locator: ProviderTaskLocator,
  containingTurnId: string,
  nativeTurnKey: string,
  ordinal: number,
  remainingEventJsonChars: number,
  remainingEventJsonBytes: number,
): Readonly<{
  prepared: Readonly<PreparedProviderEvent>;
  eventJsonChars: number;
  eventJsonBytes: number;
}> {
  const rawEvent = snapshotProviderEvent(eventValue);
  assertRawEventOwnership(rawEvent, locator);
  assertRawDiagnosticBounds(rawEvent);
  const projection = projectProviderEventCacheBundleFromSnapshot(
    rawEvent,
    ordinal,
    remainingEventJsonChars,
    remainingEventJsonBytes,
  );
  if (!projection.ok) {
    if (projection.limit === "AGGREGATE") throw CAPACITY_SENTINEL;
    throw new TypeError();
  }
  const event = normalizedIndexedEvent(projection.event, locator);
  if (event.provider !== locator.provider || !sameLocator(event.locator, locator)) {
    throw new TypeError();
  }
  const eventTurnId = indexedProviderEventTurnId(event);
  if (eventTurnId !== null && eventTurnId !== containingTurnId) throw new TypeError();
  const nativeItemKey = projection.nativeItemKey;
  const replayKey = projection.replayKey;
  const eventJson = canonicalProviderIndexJson(event);
  const eventJsonChars = sqliteTextLengthAtMost(eventJson, MAX_EVENT_JSON_CHARS);
  const eventJsonBytes = Buffer.byteLength(eventJson, "utf8");
  if (eventJsonChars === null || eventJsonChars !== projection.canonicalEventJsonChars ||
    eventJsonBytes !== projection.canonicalEventJsonBytes) {
    throw new ProviderIndexStoreError("INVALID_INPUT");
  }
  const eventFingerprint = sha256(
    `devhub-provider-event-cache:v1\u0000${replayKey}\u0000${eventJson}`,
  );
  return Object.freeze({
    prepared: Object.freeze({
      nativeTurnKey,
      nativeItemKey,
      replayKey,
      ordinal,
      eventFingerprint,
      eventJson,
      event,
    }),
    eventJsonChars,
    eventJsonBytes,
  });
}

type SnapshotHash = ReturnType<typeof createHash>;

function updateCanonicalJsonString(hash: SnapshotHash, value: string): void {
  if (!hasExactUtf8(value)) throw new TypeError();
  hash.update('"', "utf8");
  let segmentStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    let escaped: string | null = null;
    switch (codeUnit) {
      case 0x08: escaped = "\\b"; break;
      case 0x09: escaped = "\\t"; break;
      case 0x0a: escaped = "\\n"; break;
      case 0x0c: escaped = "\\f"; break;
      case 0x0d: escaped = "\\r"; break;
      case 0x22: escaped = '\\"'; break;
      case 0x5c: escaped = "\\\\"; break;
      default:
        if (codeUnit < 0x20) escaped = `\\u${codeUnit.toString(16).padStart(4, "0")}`;
        break;
    }
    if (escaped === null) continue;
    if (segmentStart < index) hash.update(value.slice(segmentStart, index), "utf8");
    hash.update(escaped, "utf8");
    segmentStart = index + 1;
  }
  if (segmentStart < value.length) hash.update(value.slice(segmentStart), "utf8");
  hash.update('"', "utf8");
}

function updateCanonicalJsonScalar(hash: SnapshotHash, value: unknown): void {
  if (typeof value === "string") {
    updateCanonicalJsonString(hash, value);
    return;
  }
  hash.update(canonicalProviderIndexJson(value), "utf8");
}

function updateComma(hash: SnapshotHash, index: number): void {
  if (index > 0) hash.update(",", "utf8");
}

function providerTaskSnapshotFingerprintUnsafe(
  summary: PreparedProviderTaskSummary,
  turns: readonly PreparedProviderTurn[],
): string {
  const hash = createHash("sha256");
  hash.update("devhub-provider-snapshot:v1\u0000[1,", "utf8");
  updateCanonicalJsonString(hash, serializeTaskLocator(summary.locator));
  hash.update(",[", "utf8");
  const summaryValues: readonly unknown[] = [
    summary.title,
    summary.cwd,
    summary.cwdRedacted,
    summary.model,
    summary.status,
    summary.createdAt,
    summary.updatedAt,
    summary.archived,
    summary.source,
  ];
  for (let index = 0; index < summaryValues.length; index += 1) {
    updateComma(hash, index);
    updateCanonicalJsonScalar(hash, summaryValues[index]);
  }
  hash.update(",", "utf8");
  if (summary.revision === null) {
    hash.update("null", "utf8");
  } else {
    hash.update("[", "utf8");
    const revisionValues: readonly unknown[] = [
      summary.revision.updatedAt,
      summary.revision.status,
      summary.revision.lastTurnId,
      summary.revision.lastTurnStatus,
      summary.revision.lastItemId,
      summary.revision.fingerprint,
    ];
    for (let index = 0; index < revisionValues.length; index += 1) {
      updateComma(hash, index);
      updateCanonicalJsonScalar(hash, revisionValues[index]);
    }
    hash.update("]", "utf8");
  }
  hash.update("],[", "utf8");
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    updateComma(hash, turnIndex);
    const turn = turns[turnIndex]!;
    hash.update("[", "utf8");
    const turnValues: readonly unknown[] = [
      turn.nativeTurnKey,
      turn.status,
      turn.startedAt,
      turn.completedAt,
      turn.ordinal,
    ];
    for (let index = 0; index < turnValues.length; index += 1) {
      updateComma(hash, index);
      updateCanonicalJsonScalar(hash, turnValues[index]);
    }
    hash.update(",[", "utf8");
    for (let eventIndex = 0; eventIndex < turn.events.length; eventIndex += 1) {
      updateComma(hash, eventIndex);
      const event = turn.events[eventIndex]!;
      hash.update("[", "utf8");
      const eventValues: readonly unknown[] = [
        event.ordinal,
        event.nativeItemKey,
        event.replayKey,
        event.eventFingerprint,
        event.eventJson,
      ];
      for (let index = 0; index < eventValues.length; index += 1) {
        updateComma(hash, index);
        updateCanonicalJsonScalar(hash, eventValues[index]);
      }
      hash.update("]", "utf8");
    }
    hash.update("]]", "utf8");
  }
  hash.update("]]", "utf8");
  return hash.digest("hex");
}

function providerTaskSnapshotReceiptKeyUnsafe(
  summary: PreparedProviderTaskSummary,
  fingerprint: string,
): string {
  if (typeof fingerprint !== "string" || !LOWER_HEX_64.test(fingerprint)) {
    throw new TypeError();
  }
  let basis: string;
  if (summary.source === "native") {
    if (summary.revision === null) throw new TypeError();
    basis = `native:${summary.revision.fingerprint}`;
  } else {
    basis = `fallback:${fingerprint}`;
  }
  const digest = sha256(
    `devhub-provider-snapshot-revision:v1\u0000${serializeTaskLocator(summary.locator)}` +
      `\u0000${basis}`,
  );
  return `snapshot:v1:${digest}`;
}

function configuredInteger(
  snapshot: Readonly<Record<string, unknown>>,
  key: keyof typeof PROVIDER_INDEX_STORE_DEFAULTS,
  minimum: number,
  maximum: number,
): number {
  const supplied = snapshot[key];
  const value = supplied === undefined ? PROVIDER_INDEX_STORE_DEFAULTS[key] : supplied;
  if (typeof value !== "number" || !Number.isSafeInteger(value) ||
    value < minimum || value > maximum) {
    throw new TypeError();
  }
  return value;
}

export function normalizeProviderIndexStoreOptions(
  value: ProviderIndexStoreOptions = {},
): Readonly<NormalizedProviderIndexStoreConfig> {
  try {
    const snapshot = exactOwnOptions(value);
    const stageLeaseMs = configuredInteger(
      snapshot,
      "stageLeaseMs",
      PROVIDER_INDEX_STORE_HARD_LIMITS.stageLeaseMs.min,
      PROVIDER_INDEX_STORE_HARD_LIMITS.stageLeaseMs.max,
    );
    const maxTasksPerGeneration = configuredInteger(
      snapshot,
      "maxTasksPerGeneration",
      1,
      PROVIDER_INDEX_STORE_HARD_LIMITS.maxTasksPerGeneration,
    );
    const maxTurnsPerGeneration = configuredInteger(
      snapshot,
      "maxTurnsPerGeneration",
      1,
      PROVIDER_INDEX_STORE_HARD_LIMITS.maxTurnsPerGeneration,
    );
    const maxEventsPerTask = configuredInteger(
      snapshot,
      "maxEventsPerTask",
      1,
      PROVIDER_INDEX_STORE_HARD_LIMITS.maxEventsPerTask,
    );
    const maxEventsPerGeneration = configuredInteger(
      snapshot,
      "maxEventsPerGeneration",
      1,
      PROVIDER_INDEX_STORE_HARD_LIMITS.maxEventsPerGeneration,
    );
    const maxMetadataDepth = configuredInteger(
      snapshot,
      "maxMetadataDepth",
      1,
      PROVIDER_INDEX_STORE_HARD_LIMITS.maxMetadataDepth,
    );
    if (maxEventsPerTask > maxEventsPerGeneration) throw new TypeError();
    const nowValue = snapshot.now;
    const tokenFactoryValue = snapshot.tokenFactory;
    const now = nowValue === undefined ? Date.now : nowValue;
    const tokenFactory = tokenFactoryValue === undefined ? randomUUID : tokenFactoryValue;
    if (typeof now !== "function" || typeof tokenFactory !== "function") throw new TypeError();
    return Object.freeze({
      stageLeaseMs,
      maxTasksPerGeneration,
      maxTurnsPerGeneration,
      maxEventsPerTask,
      maxEventsPerGeneration,
      maxMetadataDepth,
      maxEventJsonBytesPerTask: MAX_EVENT_JSON_BYTES_PER_TASK,
      now: now as () => number,
      tokenFactory: tokenFactory as () => string,
    });
  } catch {
    throw new ProviderIndexStoreError("INVALID_INPUT");
  }
}

export function readProviderIndexNow(config: NormalizedProviderIndexStoreConfig): number {
  try {
    const value = config.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError();
    return value;
  } catch {
    throw new ProviderIndexStoreError("CLOCK_FAILURE");
  }
}

export function createProviderIndexOwnerToken(
  config: NormalizedProviderIndexStoreConfig,
): string {
  try {
    const value = config.tokenFactory();
    if (typeof value !== "string" || sqliteTextLengthAtMost(value, 512) === null ||
      value.length === 0 ||
      value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value) ||
      Buffer.from(value, "utf8").toString("utf8") !== value) {
      throw new TypeError();
    }
    return value;
  } catch {
    throw new ProviderIndexStoreError("TOKEN_FAILURE");
  }
}

export type ProviderIndexStorePreparationResult<T> = Readonly<
  | { status: "prepared"; value: Readonly<T> }
  | { status: "failed"; code: "CAPACITY" | "INVALID_INPUT" }
>;

function preparedForStore<T>(value: Readonly<T>): ProviderIndexStorePreparationResult<T> {
  return Object.freeze({ status: "prepared", value });
}

function preparationFailedForStore(
  code: "CAPACITY" | "INVALID_INPUT",
): ProviderIndexStorePreparationResult<never> {
  return Object.freeze({ status: "failed", code });
}

export function prepareProviderTaskSummaryForStore(
  registration: ProviderIndexRegisteredHome,
  methodKey: NativeTaskKey,
  summary: NativeTaskSummary,
): ProviderIndexStorePreparationResult<PreparedProviderTaskSummary> {
  try {
    return preparedForStore(normalizedSummary(registration, methodKey, summary, false).summary);
  } catch {
    return preparationFailedForStore("INVALID_INPUT");
  }
}

export function prepareProviderTaskSummary(
  registration: ProviderIndexRegisteredHome,
  methodKey: NativeTaskKey,
  summary: NativeTaskSummary,
): Readonly<PreparedProviderTaskSummary> {
  const result = prepareProviderTaskSummaryForStore(registration, methodKey, summary);
  if (result.status === "failed") throw new ProviderIndexStoreError(result.code);
  return result.value;
}

function prepareProviderTaskSnapshotResult(
  registration: ProviderIndexRegisteredHome,
  methodKey: NativeTaskKey,
  task: NativeTask,
  config: NormalizedProviderIndexStoreConfig = normalizeProviderIndexStoreOptions(),
): ProviderIndexStorePreparationResult<PreparedProviderTaskSnapshot> {
  try {
    const normalized = normalizedSummary(registration, methodKey, task, true);
    if (normalized.summary.source === "native" && normalized.summary.revision === null) {
      throw new TypeError();
    }
    const rawTurns = denseDataArray(
      normalized.turns,
      config.maxTurnsPerGeneration,
      true,
    );
    const aggregateEventJsonByteLimit = config.maxEventJsonBytesPerTask;
    if (!Number.isSafeInteger(aggregateEventJsonByteLimit) ||
      aggregateEventJsonByteLimit < 1 ||
      aggregateEventJsonByteLimit > MAX_EVENT_JSON_BYTES_PER_TASK) throw new TypeError();
    const turns: PreparedProviderTurn[] = [];
    const eventJsonMetricsByIdentity = new WeakMap<object, Readonly<{
      chars: number;
      bytes: number;
    }>>();
    let remainingEventJsonChars = MAX_EVENT_JSON_CODE_POINTS_PER_TASK;
    let remainingEventJsonBytes = aggregateEventJsonByteLimit;
    let eventOrdinal = 0;
    for (let turnOrdinal = 0; turnOrdinal < rawTurns.length; turnOrdinal += 1) {
      const rawTurn = exactOwnData(rawTurns[turnOrdinal], [
        "id",
        "status",
        "startedAt",
        "completedAt",
        "events",
      ]);
      const id = homeFreeNativeId(
        rawTurn.id,
        normalized.registration.canonicalHome,
        "native turn id",
      );
      const nativeTurnKey = cachedTurnKey(id);
      const rawEvents = denseDataArray(
        rawTurn.events,
        config.maxEventsPerTask - eventOrdinal,
        true,
      );
      const events: PreparedProviderEvent[] = [];
      for (const event of rawEvents) {
        if (event !== null && typeof event === "object") {
          const knownEventJsonMetrics = eventJsonMetricsByIdentity.get(event);
          if (knownEventJsonMetrics !== undefined &&
            (knownEventJsonMetrics.chars > remainingEventJsonChars ||
              knownEventJsonMetrics.bytes > remainingEventJsonBytes)) {
            throw CAPACITY_SENTINEL;
          }
        }
        const result = preparedEvent(
          event,
          normalized.summary.locator,
          id,
          nativeTurnKey,
          eventOrdinal,
          remainingEventJsonChars,
          remainingEventJsonBytes,
        );
        if (event !== null && typeof event === "object") {
          eventJsonMetricsByIdentity.set(event, Object.freeze({
            chars: result.eventJsonChars,
            bytes: result.eventJsonBytes,
          }));
        }
        remainingEventJsonChars -= result.eventJsonChars;
        remainingEventJsonBytes -= result.eventJsonBytes;
        eventOrdinal += 1;
        events.push(result.prepared);
      }
      turns.push(Object.freeze({
        nativeTurnKey,
        id,
        status: secretFreeHomeText(
          rawTurn.status,
          normalized.registration.canonicalHome,
          MAX_SHORT_TEXT_CHARS,
        ),
        startedAt: canonicalTimestamp(rawTurn.startedAt),
        completedAt: canonicalTimestamp(rawTurn.completedAt),
        ordinal: turnOrdinal,
        events: Object.freeze(events),
      }));
    }
    const frozenTurns = Object.freeze(turns);
    const fingerprint = providerTaskSnapshotFingerprintUnsafe(normalized.summary, frozenTurns);
    return preparedForStore(Object.freeze({
      ...normalized.summary,
      turns: frozenTurns,
      eventCount: eventOrdinal,
      snapshotFingerprint: fingerprint,
      receiptKey: providerTaskSnapshotReceiptKeyUnsafe(normalized.summary, fingerprint),
    }));
  } catch (error) {
    return preparationFailedForStore(error === CAPACITY_SENTINEL ? "CAPACITY" : "INVALID_INPUT");
  }
}

export function prepareProviderTaskSnapshotForStore(
  registration: ProviderIndexRegisteredHome,
  methodKey: NativeTaskKey,
  task: NativeTask,
  config: NormalizedProviderIndexStoreConfig = normalizeProviderIndexStoreOptions(),
): ProviderIndexStorePreparationResult<PreparedProviderTaskSnapshot> {
  return prepareProviderTaskSnapshotResult(registration, methodKey, task, config);
}

export function prepareProviderTaskSnapshot(
  registration: ProviderIndexRegisteredHome,
  methodKey: NativeTaskKey,
  task: NativeTask,
  config: NormalizedProviderIndexStoreConfig = normalizeProviderIndexStoreOptions(),
): Readonly<PreparedProviderTaskSnapshot> {
  const result = prepareProviderTaskSnapshotResult(registration, methodKey, task, config);
  if (result.status === "failed") throw new ProviderIndexStoreError(result.code);
  return result.value;
}

export function verifyPreparedProviderTaskSnapshotForStore(
  summary: PreparedProviderTaskSummary,
  turns: readonly PreparedProviderTurn[],
  receiptKey: string,
  snapshotFingerprint: string,
): boolean {
  try {
    const expectedFingerprint = providerTaskSnapshotFingerprintUnsafe(summary, turns);
    return snapshotFingerprint === expectedFingerprint &&
      receiptKey === providerTaskSnapshotReceiptKeyUnsafe(summary, expectedFingerprint);
  } catch {
    return false;
  }
}

function indexedEventText(
  value: unknown,
  maximum = MAX_EVENT_JSON_CHARS,
  minimum = 0,
  trimNonEmpty = false,
  canonicalHome: string | null = null,
): string {
  const text = boundedText(value, maximum, minimum);
  if ((trimNonEmpty && text.trim().length === 0) ||
    (canonicalHome !== null && (
      text.includes(canonicalHome) || redactSecrets(text) !== text
    ))) throw new TypeError();
  return text;
}

function nullableNativeId(
  value: unknown,
  label: string,
  canonicalHome: string | null = null,
): string | null {
  if (value === null) return null;
  const id = canonicalNativeId(value, label);
  if (canonicalHome !== null && id.includes(canonicalHome)) throw new TypeError();
  return id;
}

function jsonRpcId(
  value: unknown,
  nullable: boolean,
  canonicalHome: string | null,
): string | number | null {
  if (value === null && nullable) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError();
    return value;
  }
  const id = canonicalNativeId(value, "JSON-RPC request id");
  if (canonicalHome !== null && id.includes(canonicalHome)) throw new TypeError();
  return id;
}

function normalizedIndexedIdentity(
  value: unknown,
  expectedLocator: ProviderTaskLocator,
  canonicalHome: string | null,
): Readonly<IndexedProviderRequestIdentity> {
  const raw = exactOwnData(value, [
    "locator",
    "generation",
    "turnId",
    "requestId",
    "itemId",
    "approvalId",
  ]);
  const locator = parseTaskLocator(serializeTaskLocator(raw.locator as ProviderTaskLocator));
  if (!sameLocator(locator, expectedLocator)) throw new TypeError();
  return Object.freeze({
    locator,
    generation: raw.generation === null ? null : safeInteger(raw.generation),
    turnId: nullableNativeId(raw.turnId, "request turn id", canonicalHome),
    requestId: jsonRpcId(raw.requestId, false, canonicalHome)!,
    itemId: nullableNativeId(raw.itemId, "request item id", canonicalHome),
    approvalId: jsonRpcId(raw.approvalId, true, canonicalHome),
  });
}

type IndexedProviderRequest = Extract<IndexedProviderEvent, { type: "request" }>["request"];

function normalizedIndexedRequest(
  value: unknown,
  expectedLocator: ProviderTaskLocator,
  canonicalHome: string | null,
): IndexedProviderRequest {
  const boundary = ownDataRecord(value);
  const kind = boundary.kind;
  if (kind === "user-input") {
    const raw = exactOwnData(value, ["kind", "identity", "autoResolutionMs"]);
    const autoResolutionMs = raw.autoResolutionMs;
    if (autoResolutionMs !== null && (
      typeof autoResolutionMs !== "number" || !Number.isSafeInteger(autoResolutionMs) ||
      autoResolutionMs < 60_000 || autoResolutionMs > 240_000
    )) throw new TypeError();
    return Object.freeze({
      kind,
      identity: normalizedIndexedIdentity(raw.identity, expectedLocator, canonicalHome),
      autoResolutionMs,
    });
  }
  if (kind !== "command-approval" && kind !== "file-change-approval" &&
    kind !== "mcp-elicitation" && kind !== "permission") throw new TypeError();
  const raw = exactOwnData(value, ["kind", "identity"]);
  return Object.freeze({
    kind,
    identity: normalizedIndexedIdentity(raw.identity, expectedLocator, canonicalHome),
  });
}

function commonIndexedEvent(
  raw: Readonly<Record<string, unknown>>,
  expectedLocator: ProviderTaskLocator,
  canonicalHome: string | null,
): {
  readonly provider: ProviderId;
  readonly locator: ProviderTaskLocator;
  readonly occurredAt: string;
} {
  const provider = providerId(raw.provider);
  const locator = parseTaskLocator(serializeTaskLocator(raw.locator as ProviderTaskLocator));
  const occurredAt = canonicalTimestamp(raw.occurredAt);
  if (provider !== expectedLocator.provider || !sameLocator(locator, expectedLocator) ||
    occurredAt === null || (canonicalHome !== null && locator.nativeTaskId.includes(canonicalHome))) {
    throw new TypeError();
  }
  return Object.freeze({ provider, locator, occurredAt });
}

function role(value: unknown): "user" | "assistant" | "system" {
  if (value !== "user" && value !== "assistant" && value !== "system") {
    throw new TypeError();
  }
  return value;
}

function normalizedIndexedEvent(
  value: unknown,
  expectedLocator: ProviderTaskLocator,
  canonicalHome: string | null = null,
): IndexedProviderEvent {
  const boundary = ownDataRecord(value);
  const type = boundary.type;
  switch (type) {
    case "message": {
      const raw = exactOwnData(value, [
        "provider", "locator", "occurredAt", "type", "role", "text", "turnId", "itemId",
      ]);
      return Object.freeze({
        ...commonIndexedEvent(raw, expectedLocator, canonicalHome),
        type,
        role: role(raw.role),
        text: indexedEventText(raw.text, MAX_EVENT_JSON_CHARS, 0, false, canonicalHome),
        turnId: nullableNativeId(raw.turnId, "event turn id", canonicalHome),
        itemId: nullableNativeId(raw.itemId, "event item id", canonicalHome),
      });
    }
    case "message-delta": {
      const raw = exactOwnData(value, [
        "provider", "locator", "occurredAt", "type", "role", "delta", "turnId", "itemId",
      ]);
      return Object.freeze({
        ...commonIndexedEvent(raw, expectedLocator, canonicalHome),
        type,
        role: role(raw.role),
        delta: indexedEventText(raw.delta, MAX_EVENT_JSON_CHARS, 0, false, canonicalHome),
        turnId: nullableNativeId(raw.turnId, "event turn id", canonicalHome),
        itemId: nullableNativeId(raw.itemId, "event item id", canonicalHome),
      });
    }
    case "plan": {
      const raw = exactOwnData(value, [
        "provider", "locator", "occurredAt", "type", "turnId", "itemId", "stepIndex",
        "text", "status",
      ]);
      return Object.freeze({
        ...commonIndexedEvent(raw, expectedLocator, canonicalHome),
        type,
        turnId: nullableNativeId(raw.turnId, "event turn id", canonicalHome),
        itemId: nullableNativeId(raw.itemId, "event item id", canonicalHome),
        stepIndex: raw.stepIndex === null ? null : safeInteger(raw.stepIndex),
        text: indexedEventText(raw.text, MAX_EVENT_JSON_CHARS, 0, false, canonicalHome),
        status: indexedEventText(raw.status, MAX_SHORT_TEXT_CHARS, 0, true, canonicalHome),
      });
    }
    case "activity": {
      const raw = exactOwnData(value, [
        "provider", "locator", "occurredAt", "type", "turnId", "itemId", "activity",
        "status", "message",
      ]);
      return Object.freeze({
        ...commonIndexedEvent(raw, expectedLocator, canonicalHome),
        type,
        turnId: nullableNativeId(raw.turnId, "event turn id", canonicalHome),
        itemId: nullableNativeId(raw.itemId, "event item id", canonicalHome),
        activity: indexedEventText(raw.activity, MAX_SHORT_TEXT_CHARS, 0, true, canonicalHome),
        status: indexedEventText(raw.status, MAX_SHORT_TEXT_CHARS, 0, true, canonicalHome),
        message: raw.message === null
          ? null
          : indexedEventText(raw.message, MAX_EVENT_JSON_CHARS, 0, false, canonicalHome),
      });
    }
    case "diff-summary": {
      const raw = exactOwnData(value, [
        "provider", "locator", "occurredAt", "type", "turnId", "changedFiles", "additions",
        "deletions",
      ]);
      return Object.freeze({
        ...commonIndexedEvent(raw, expectedLocator, canonicalHome),
        type,
        turnId: nullableNativeId(raw.turnId, "event turn id", canonicalHome),
        changedFiles: safeInteger(raw.changedFiles),
        additions: safeInteger(raw.additions),
        deletions: safeInteger(raw.deletions),
      });
    }
    case "usage": {
      const raw = exactOwnData(value, [
        "provider", "locator", "occurredAt", "type", "turnId", "inputTokens", "outputTokens",
        "cachedInputTokens", "totalTokens",
      ]);
      return Object.freeze({
        ...commonIndexedEvent(raw, expectedLocator, canonicalHome),
        type,
        turnId: nullableNativeId(raw.turnId, "event turn id", canonicalHome),
        inputTokens: safeInteger(raw.inputTokens),
        outputTokens: safeInteger(raw.outputTokens),
        cachedInputTokens: safeInteger(raw.cachedInputTokens),
        totalTokens: safeInteger(raw.totalTokens),
      });
    }
    case "status": {
      const raw = exactOwnData(value, [
        "provider", "locator", "occurredAt", "type", "scope", "status", "nativeId",
      ]);
      if (raw.scope !== "task" && raw.scope !== "turn" && raw.scope !== "item") {
        throw new TypeError();
      }
      return Object.freeze({
        ...commonIndexedEvent(raw, expectedLocator, canonicalHome),
        type,
        scope: raw.scope,
        status: indexedEventText(raw.status, MAX_SHORT_TEXT_CHARS, 0, true, canonicalHome),
        nativeId: nullableNativeId(raw.nativeId, "event native id", canonicalHome),
      });
    }
    case "request": {
      const raw = exactOwnData(value, [
        "provider", "locator", "occurredAt", "type", "request",
      ]);
      return Object.freeze({
        ...commonIndexedEvent(raw, expectedLocator, canonicalHome),
        type,
        request: normalizedIndexedRequest(raw.request, expectedLocator, canonicalHome),
      });
    }
    case "request-resolved": {
      const raw = exactOwnData(value, [
        "provider", "locator", "occurredAt", "type", "identity",
      ]);
      return Object.freeze({
        ...commonIndexedEvent(raw, expectedLocator, canonicalHome),
        type,
        identity: normalizedIndexedIdentity(raw.identity, expectedLocator, canonicalHome),
      });
    }
    case "diagnostic": {
      const raw = exactOwnData(value, [
        "provider", "locator", "occurredAt", "type", "level", "code", "message", "method",
        "shapeKeys",
      ]);
      if (raw.level !== "warning" && raw.level !== "error") throw new TypeError();
      const shapeKeys = denseDataArray(raw.shapeKeys, 32);
      return Object.freeze({
        ...commonIndexedEvent(raw, expectedLocator, canonicalHome),
        type,
        level: raw.level,
        code: indexedEventText(raw.code, 128, 1, false, canonicalHome),
        message: indexedEventText(raw.message, 512, 1, false, canonicalHome),
        method: raw.method === null
          ? null
          : indexedEventText(raw.method, 256, 0, false, canonicalHome),
        shapeKeys: Object.freeze(shapeKeys.map((key) =>
          indexedEventText(key, 64, 0, false, canonicalHome))),
      });
    }
    default:
      throw new TypeError();
  }
}

export function decodeCachedProviderEvent(
  rowValue: ProviderEventCacheRow,
  locatorValue: ProviderTaskLocator,
  containingTurnKeyValue: string,
  registrationValue: ProviderIndexRegisteredHome,
): IndexedProviderEvent {
  try {
    const row = exactOwnData(rowValue, [
      "provider",
      "home_fingerprint",
      "native_task_id",
      "native_turn_key",
      "native_item_key",
      "replay_key",
      "ordinal",
      "event_fingerprint",
      "event_json",
    ]);
    const registration = canonicalRegisteredHome(registrationValue);
    const locator = parseTaskLocator(serializeTaskLocator(locatorValue));
    if (registration.provider !== locator.provider ||
      registration.homeFingerprint !== locator.homeFingerprint ||
      locator.nativeTaskId.includes(registration.canonicalHome)) throw new TypeError();
    if (row.provider !== locator.provider || row.home_fingerprint !== locator.homeFingerprint ||
      row.native_task_id !== locator.nativeTaskId ||
      row.native_turn_key !== containingTurnKeyValue) throw new TypeError();
    const containingTurnId = parseCachedTurnKey(containingTurnKeyValue);
    if (containingTurnId === null || containingTurnId.includes(registration.canonicalHome)) {
      throw new TypeError();
    }
    const ordinal = safeInteger(row.ordinal);
    const replayKey = parseProviderEventReplayKey(row.replay_key, ordinal);
    const itemKey = parseCachedEventItemKey(row.native_item_key, ordinal);
    const eventJson = boundedText(row.event_json, MAX_EVENT_JSON_CHARS);
    const receivedFingerprint = boundedText(row.event_fingerprint, 64);
    if (!LOWER_HEX_64.test(receivedFingerprint)) throw new TypeError();
    const parsed = JSON.parse(eventJson) as unknown;
    const event = normalizedIndexedEvent(parsed, locator, registration.canonicalHome);
    if (canonicalProviderIndexJson(event) !== eventJson) throw new TypeError();
    const eventTurnId = indexedProviderEventTurnId(event);
    if (eventTurnId !== null && eventTurnId !== containingTurnId) throw new TypeError();
    const eventItemId = indexedProviderEventItemId(event);
    if (itemKey.kind === "native" &&
      itemKey.nativeItemId.includes(registration.canonicalHome)) throw new TypeError();
    if ((itemKey.kind === "native" && itemKey.nativeItemId !== eventItemId) ||
      (itemKey.kind === "synthetic" && eventItemId !== null)) throw new TypeError();
    if (sha256(`devhub-provider-event-cache:v1\u0000${replayKey}\u0000${eventJson}`) !==
      receivedFingerprint) throw new TypeError();
    return event;
  } catch {
    throw new ProviderIndexStoreError("CORRUPT_ROW");
  }
}
