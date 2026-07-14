import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
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
  cachedEventItemId,
  cachedTurnKey,
  canonicalProviderIndexJson,
  homeFingerprint,
  indexedProviderEventItemId,
  indexedProviderEventTurnId,
  parseCachedEventItemKey,
  parseCachedTurnKey,
  parseProviderEventReplayKey,
  parseTaskLocator,
  projectIndexedProviderEvent,
  providerEventReplayKey,
  serializeTaskLocator,
  taskLocator,
  type IndexedProviderEvent,
  type IndexedProviderRequestIdentity,
  type ProviderTaskLocator,
} from "./identity.js";
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
const MAX_EVENT_JSON_CHARS = 8_388_608;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/u;

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
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError();
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
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError();
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

function denseDataArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") ||
    keys.length !== value.length + 1 || !keys.includes("length")) {
    throw new TypeError();
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) throw new TypeError();
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function hasExactUtf8(value: string): boolean {
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

function boundedText(value: unknown, maximum: number, minimum = 1): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum ||
    value.includes("\u0000") || !hasExactUtf8(value)) throw new TypeError();
  return value;
}

function optionalText(value: unknown, maximum: number): string | null {
  return value === null ? null : boundedText(value, maximum);
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
      if (resolved.length > MAX_PATH_CHARS || !hasExactUtf8(resolved)) throw new TypeError();
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

function normalizedRevision(value: unknown): Readonly<NativeRevision> | null {
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
    status: boundedText(snapshot.status, MAX_SHORT_TEXT_CHARS),
    lastTurnId: snapshot.lastTurnId === null
      ? null
      : canonicalNativeId(snapshot.lastTurnId, "revision last turn id"),
    lastTurnStatus: optionalText(snapshot.lastTurnStatus, MAX_SHORT_TEXT_CHARS),
    lastItemId: snapshot.lastItemId === null
      ? null
      : canonicalNativeId(snapshot.lastItemId, "revision last item id"),
    fingerprint: boundedText(snapshot.fingerprint, MAX_FINGERPRINT_CHARS),
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
  readonly turns: readonly unknown[] | null;
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
  const revision = normalizedRevision(raw.revision);
  const prepared = Object.freeze({
    locator: methodLocator,
    title: boundedText(raw.title, MAX_TITLE_CHARS, 0),
    cwd: cwd.cwd,
    cwdRedacted: cwd.cwdRedacted,
    model: optionalText(raw.model, MAX_SHORT_TEXT_CHARS),
    status: boundedText(raw.status, MAX_SHORT_TEXT_CHARS),
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
    turns: includeTurns ? denseDataArray(raw.turns) : null,
  });
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
): Readonly<PreparedProviderEvent> {
  assertRawEventOwnership(eventValue, locator);
  const event = projectIndexedProviderEvent(eventValue as ProviderEvent);
  if (event.provider !== locator.provider || !sameLocator(event.locator, locator)) {
    throw new TypeError();
  }
  const eventTurnId = indexedProviderEventTurnId(event);
  if (eventTurnId !== null && eventTurnId !== containingTurnId) throw new TypeError();
  const nativeItemKey = cachedEventItemId(eventValue as ProviderEvent, ordinal);
  const replayKey = providerEventReplayKey(eventValue as ProviderEvent, ordinal);
  const eventJson = canonicalProviderIndexJson(event);
  const eventFingerprint = sha256(
    `devhub-provider-event-cache:v1\u0000${replayKey}\u0000${eventJson}`,
  );
  return Object.freeze({
    nativeTurnKey,
    nativeItemKey,
    replayKey,
    ordinal,
    eventFingerprint,
    eventJson,
    event,
  });
}

function revisionPayload(revision: Readonly<NativeRevision> | null): readonly unknown[] | null {
  return revision === null ? null : Object.freeze([
    revision.updatedAt,
    revision.status,
    revision.lastTurnId,
    revision.lastTurnStatus,
    revision.lastItemId,
    revision.fingerprint,
  ]);
}

function providerTaskSnapshotFingerprintUnsafe(
  summary: PreparedProviderTaskSummary,
  turns: readonly PreparedProviderTurn[],
): string {
  const summaryPayload = Object.freeze([
    summary.title,
    summary.cwd,
    summary.cwdRedacted,
    summary.model,
    summary.status,
    summary.createdAt,
    summary.updatedAt,
    summary.archived,
    summary.source,
    revisionPayload(summary.revision),
  ]);
  const turnPayload = Object.freeze(turns.map((turn) => Object.freeze([
    turn.nativeTurnKey,
    turn.status,
    turn.startedAt,
    turn.completedAt,
    turn.ordinal,
    Object.freeze(turn.events.map((event) => Object.freeze([
      event.ordinal,
      event.nativeItemKey,
      event.replayKey,
      event.eventFingerprint,
      event.eventJson,
    ]))),
  ])));
  const payload = Object.freeze([
    1,
    serializeTaskLocator(summary.locator),
    summaryPayload,
    turnPayload,
  ]);
  return sha256(`devhub-provider-snapshot:v1\u0000${canonicalProviderIndexJson(payload)}`);
}

export function providerTaskSnapshotFingerprint(
  summary: PreparedProviderTaskSummary,
  turns: readonly PreparedProviderTurn[],
): string {
  try {
    return providerTaskSnapshotFingerprintUnsafe(summary, turns);
  } catch {
    throw new ProviderIndexStoreError("INVALID_INPUT");
  }
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

export function providerTaskSnapshotReceiptKey(
  summary: PreparedProviderTaskSummary,
  fingerprint: string,
): string {
  try {
    return providerTaskSnapshotReceiptKeyUnsafe(summary, fingerprint);
  } catch {
    throw new ProviderIndexStoreError("INVALID_INPUT");
  }
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
    if (typeof value !== "string" || value.length === 0 || value.length > 512 ||
      value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value) ||
      Buffer.from(value, "utf8").toString("utf8") !== value) {
      throw new TypeError();
    }
    return value;
  } catch {
    throw new ProviderIndexStoreError("TOKEN_FAILURE");
  }
}

export function prepareProviderTaskSummary(
  registration: ProviderIndexRegisteredHome,
  methodKey: NativeTaskKey,
  summary: NativeTaskSummary,
): Readonly<PreparedProviderTaskSummary> {
  try {
    return normalizedSummary(registration, methodKey, summary, false).summary;
  } catch (error) {
    if (error instanceof ProviderIndexStoreError) throw error;
    throw new ProviderIndexStoreError("INVALID_INPUT");
  }
}

export function prepareProviderTaskSnapshot(
  registration: ProviderIndexRegisteredHome,
  methodKey: NativeTaskKey,
  task: NativeTask,
  config: NormalizedProviderIndexStoreConfig = normalizeProviderIndexStoreOptions(),
): Readonly<PreparedProviderTaskSnapshot> {
  try {
    const normalized = normalizedSummary(registration, methodKey, task, true);
    if (normalized.summary.source === "native" && normalized.summary.revision === null) {
      throw new TypeError();
    }
    const rawTurns = normalized.turns!;
    if (rawTurns.length > config.maxTurnsPerGeneration) {
      throw new ProviderIndexStoreError("CAPACITY");
    }
    const turns: PreparedProviderTurn[] = [];
    let eventOrdinal = 0;
    for (let turnOrdinal = 0; turnOrdinal < rawTurns.length; turnOrdinal += 1) {
      const rawTurn = exactOwnData(rawTurns[turnOrdinal], [
        "id",
        "status",
        "startedAt",
        "completedAt",
        "events",
      ]);
      const id = canonicalNativeId(rawTurn.id, "native turn id");
      const nativeTurnKey = cachedTurnKey(id);
      const rawEvents = denseDataArray(rawTurn.events);
      if (eventOrdinal + rawEvents.length > config.maxEventsPerTask) {
        throw new ProviderIndexStoreError("CAPACITY");
      }
      const events = rawEvents.map((event) => {
        const prepared = preparedEvent(event, normalized.summary.locator, id, nativeTurnKey, eventOrdinal);
        eventOrdinal += 1;
        return prepared;
      });
      turns.push(Object.freeze({
        nativeTurnKey,
        id,
        status: boundedText(rawTurn.status, MAX_SHORT_TEXT_CHARS),
        startedAt: canonicalTimestamp(rawTurn.startedAt),
        completedAt: canonicalTimestamp(rawTurn.completedAt),
        ordinal: turnOrdinal,
        events: Object.freeze(events),
      }));
    }
    const frozenTurns = Object.freeze(turns);
    const fingerprint = providerTaskSnapshotFingerprint(normalized.summary, frozenTurns);
    return Object.freeze({
      ...normalized.summary,
      turns: frozenTurns,
      eventCount: eventOrdinal,
      snapshotFingerprint: fingerprint,
      receiptKey: providerTaskSnapshotReceiptKey(normalized.summary, fingerprint),
    });
  } catch (error) {
    if (error instanceof ProviderIndexStoreError) throw error;
    throw new ProviderIndexStoreError("INVALID_INPUT");
  }
}

function requiredEventText(value: unknown, maximum = MAX_EVENT_JSON_CHARS): string {
  return boundedText(value, maximum, 0);
}

function nullableNativeId(value: unknown, label: string): string | null {
  return value === null ? null : canonicalNativeId(value, label);
}

function jsonRpcId(value: unknown, nullable: boolean): string | number | null {
  if (value === null && nullable) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError();
    return value;
  }
  return canonicalNativeId(value, "JSON-RPC request id");
}

function normalizedIndexedIdentity(
  value: unknown,
  expectedLocator: ProviderTaskLocator,
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
    turnId: nullableNativeId(raw.turnId, "request turn id"),
    requestId: jsonRpcId(raw.requestId, false)!,
    itemId: nullableNativeId(raw.itemId, "request item id"),
    approvalId: jsonRpcId(raw.approvalId, true),
  });
}

type IndexedProviderRequest = Extract<IndexedProviderEvent, { type: "request" }>["request"];

function normalizedIndexedRequest(
  value: unknown,
  expectedLocator: ProviderTaskLocator,
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
      identity: normalizedIndexedIdentity(raw.identity, expectedLocator),
      autoResolutionMs,
    });
  }
  if (kind !== "command-approval" && kind !== "file-change-approval" &&
    kind !== "mcp-elicitation" && kind !== "permission") throw new TypeError();
  const raw = exactOwnData(value, ["kind", "identity"]);
  return Object.freeze({
    kind,
    identity: normalizedIndexedIdentity(raw.identity, expectedLocator),
  });
}

function commonIndexedEvent(
  raw: Readonly<Record<string, unknown>>,
  expectedLocator: ProviderTaskLocator,
): {
  readonly provider: ProviderId;
  readonly locator: ProviderTaskLocator;
  readonly occurredAt: string;
} {
  const provider = providerId(raw.provider);
  const locator = parseTaskLocator(serializeTaskLocator(raw.locator as ProviderTaskLocator));
  const occurredAt = canonicalTimestamp(raw.occurredAt);
  if (provider !== expectedLocator.provider || !sameLocator(locator, expectedLocator) ||
    occurredAt === null) throw new TypeError();
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
): IndexedProviderEvent {
  const boundary = ownDataRecord(value);
  const type = boundary.type;
  switch (type) {
    case "message": {
      const raw = exactOwnData(value, [
        "provider", "locator", "occurredAt", "type", "role", "text", "turnId", "itemId",
      ]);
      return Object.freeze({
        ...commonIndexedEvent(raw, expectedLocator),
        type,
        role: role(raw.role),
        text: requiredEventText(raw.text),
        turnId: nullableNativeId(raw.turnId, "event turn id"),
        itemId: nullableNativeId(raw.itemId, "event item id"),
      });
    }
    case "message-delta": {
      const raw = exactOwnData(value, [
        "provider", "locator", "occurredAt", "type", "role", "delta", "turnId", "itemId",
      ]);
      return Object.freeze({
        ...commonIndexedEvent(raw, expectedLocator),
        type,
        role: role(raw.role),
        delta: requiredEventText(raw.delta),
        turnId: nullableNativeId(raw.turnId, "event turn id"),
        itemId: nullableNativeId(raw.itemId, "event item id"),
      });
    }
    case "plan": {
      const raw = exactOwnData(value, [
        "provider", "locator", "occurredAt", "type", "turnId", "itemId", "stepIndex",
        "text", "status",
      ]);
      return Object.freeze({
        ...commonIndexedEvent(raw, expectedLocator),
        type,
        turnId: nullableNativeId(raw.turnId, "event turn id"),
        itemId: nullableNativeId(raw.itemId, "event item id"),
        stepIndex: raw.stepIndex === null ? null : safeInteger(raw.stepIndex),
        text: requiredEventText(raw.text),
        status: requiredEventText(raw.status, MAX_SHORT_TEXT_CHARS),
      });
    }
    case "activity": {
      const raw = exactOwnData(value, [
        "provider", "locator", "occurredAt", "type", "turnId", "itemId", "activity",
        "status", "message",
      ]);
      return Object.freeze({
        ...commonIndexedEvent(raw, expectedLocator),
        type,
        turnId: nullableNativeId(raw.turnId, "event turn id"),
        itemId: nullableNativeId(raw.itemId, "event item id"),
        activity: requiredEventText(raw.activity, MAX_SHORT_TEXT_CHARS),
        status: requiredEventText(raw.status, MAX_SHORT_TEXT_CHARS),
        message: raw.message === null ? null : requiredEventText(raw.message),
      });
    }
    case "diff-summary": {
      const raw = exactOwnData(value, [
        "provider", "locator", "occurredAt", "type", "turnId", "changedFiles", "additions",
        "deletions",
      ]);
      return Object.freeze({
        ...commonIndexedEvent(raw, expectedLocator),
        type,
        turnId: nullableNativeId(raw.turnId, "event turn id"),
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
        ...commonIndexedEvent(raw, expectedLocator),
        type,
        turnId: nullableNativeId(raw.turnId, "event turn id"),
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
        ...commonIndexedEvent(raw, expectedLocator),
        type,
        scope: raw.scope,
        status: requiredEventText(raw.status, MAX_SHORT_TEXT_CHARS),
        nativeId: nullableNativeId(raw.nativeId, "event native id"),
      });
    }
    case "request": {
      const raw = exactOwnData(value, [
        "provider", "locator", "occurredAt", "type", "request",
      ]);
      return Object.freeze({
        ...commonIndexedEvent(raw, expectedLocator),
        type,
        request: normalizedIndexedRequest(raw.request, expectedLocator),
      });
    }
    case "request-resolved": {
      const raw = exactOwnData(value, [
        "provider", "locator", "occurredAt", "type", "identity",
      ]);
      return Object.freeze({
        ...commonIndexedEvent(raw, expectedLocator),
        type,
        identity: normalizedIndexedIdentity(raw.identity, expectedLocator),
      });
    }
    case "diagnostic": {
      const raw = exactOwnData(value, [
        "provider", "locator", "occurredAt", "type", "level", "code", "message", "method",
        "shapeKeys",
      ]);
      if (raw.level !== "warning" && raw.level !== "error") throw new TypeError();
      const shapeKeys = denseDataArray(raw.shapeKeys);
      if (shapeKeys.length > 32) throw new TypeError();
      return Object.freeze({
        ...commonIndexedEvent(raw, expectedLocator),
        type,
        level: raw.level,
        code: boundedText(raw.code, 128),
        message: boundedText(raw.message, 512),
        method: raw.method === null ? null : boundedText(raw.method, 256),
        shapeKeys: Object.freeze(shapeKeys.map((key) => boundedText(key, 64, 0))),
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
    const locator = parseTaskLocator(serializeTaskLocator(locatorValue));
    if (row.provider !== locator.provider || row.home_fingerprint !== locator.homeFingerprint ||
      row.native_task_id !== locator.nativeTaskId ||
      row.native_turn_key !== containingTurnKeyValue) throw new TypeError();
    const containingTurnId = parseCachedTurnKey(containingTurnKeyValue);
    if (containingTurnId === null) throw new TypeError();
    const ordinal = safeInteger(row.ordinal);
    const replayKey = parseProviderEventReplayKey(row.replay_key, ordinal);
    const itemKey = parseCachedEventItemKey(row.native_item_key, ordinal);
    const eventJson = boundedText(row.event_json, MAX_EVENT_JSON_CHARS);
    const receivedFingerprint = boundedText(row.event_fingerprint, 64);
    if (!LOWER_HEX_64.test(receivedFingerprint)) throw new TypeError();
    const parsed = JSON.parse(eventJson) as unknown;
    const event = normalizedIndexedEvent(parsed, locator);
    if (canonicalProviderIndexJson(event) !== eventJson) throw new TypeError();
    const eventTurnId = indexedProviderEventTurnId(event);
    if (eventTurnId !== null && eventTurnId !== containingTurnId) throw new TypeError();
    const eventItemId = indexedProviderEventItemId(event);
    if ((itemKey.kind === "native" && itemKey.nativeItemId !== eventItemId) ||
      (itemKey.kind === "synthetic" && eventItemId !== null)) throw new TypeError();
    if (sha256(`devhub-provider-event-cache:v1\u0000${replayKey}\u0000${eventJson}`) !==
      receivedFingerprint) throw new TypeError();
    return event;
  } catch {
    throw new ProviderIndexStoreError("CORRUPT_ROW");
  }
}
