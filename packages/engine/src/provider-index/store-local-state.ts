import { randomUUID } from "node:crypto";
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { types as utilTypes } from "node:util";
import { normalizeProviderNativeId } from "../providers/native-id.js";
import type { ProviderId } from "../providers/types.js";
import {
  canonicalProviderIndexJson,
  parseTaskLocator,
  serializeTaskLocator,
  type ProviderTaskLocator,
} from "./identity.js";
import { hashPersistedProviderHome } from "./home-fingerprint.js";
import {
  PROVIDER_INDEX_STORE_HARD_LIMITS,
  type LegacySessionProvenance,
  type ProviderForkLink,
  type ProviderMetadataJson,
  type ProviderMetadataObject,
  type ProviderTaskMeta,
  type ProviderTaskMetaPatch,
  type VerifiedLegacyMapping,
  type VerifiedLegacySessionResolution,
} from "./store-types.js";
import { hasCanonicalUnicode, sqliteTextLengthAtMost } from "./text-boundary.js";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_LOCAL_LABEL_CHARS = 65_536;
const MAX_NOTES_CHARS = 1_048_576;
const MAX_TAGS = 256;
const MAX_TAG_CHARS = 512;
const MAX_METADATA_RECORD_KEYS = 32;
const MAX_METADATA_JSON_BYTES = 65_536;
const MAX_METADATA_JSON_CHARS = 65_536;
const MAX_METADATA_ARRAY_ITEMS = MAX_METADATA_JSON_BYTES;
// A canonical array needs at least one byte per item plus delimiters. This is the
// largest aggregate item count that can still fit the column's canonical byte budget.
const MAX_METADATA_AGGREGATE_ARRAY_ITEMS = 32_765;
const MAX_METADATA_GRAPH_VISITS =
  1 + MAX_METADATA_RECORD_KEYS + MAX_METADATA_AGGREGATE_ARRAY_ITEMS;
export const PROVIDER_FORK_LINKS_PER_LOCATOR_LIMIT = 1_024;

const PATCH_KEYS = Object.freeze([
  "favorite",
  "pinned",
  "localLabel",
  "tags",
  "notes",
  "localArchived",
  "uiState",
  "unsupportedLocal",
] as const);

export type ProviderLocalStateFailureCode =
  | "INVALID_INPUT"
  | "CORRUPT_ROW"
  | "DATABASE_UNAVAILABLE"
  | "CAPACITY"
  | "UNKNOWN_HOME"
  | "FORK_CONFLICT"
  | "LEGACY_MAPPING_CONFLICT";

class ProviderLocalStateFailure extends Error {
  readonly code: ProviderLocalStateFailureCode;

  constructor(code: ProviderLocalStateFailureCode) {
    super(`provider local state ${code.toLowerCase().replaceAll("_", " ")}`);
    this.name = "ProviderLocalStateFailure";
    this.code = code;
  }
}

function fail(code: ProviderLocalStateFailureCode): never {
  throw new ProviderLocalStateFailure(code);
}

export function providerLocalStateFailureCode(error: unknown): ProviderLocalStateFailureCode | null {
  return error instanceof ProviderLocalStateFailure ? error.code : null;
}

function validatedLocator(value: ProviderTaskLocator): ProviderTaskLocator {
  return parseTaskLocator(serializeTaskLocator(value));
}

function normalizeLocator(value: ProviderTaskLocator): ProviderTaskLocator {
  try {
    return validatedLocator(value);
  } catch {
    return fail("INVALID_INPUT");
  }
}

function safeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 ||
    value > MAX_SAFE_INTEGER) {
    throw new TypeError();
  }
  return value;
}

function metadataDepth(value: unknown): number {
  const depth = safeInteger(value);
  if (depth < 1 || depth > PROVIDER_INDEX_STORE_HARD_LIMITS.maxMetadataDepth) {
    throw new TypeError();
  }
  return depth;
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000") ||
    !hasCanonicalUnicode(value) || sqliteTextLengthAtMost(value, maximum) === null) {
    throw new TypeError();
  }
  return value;
}

function optionalBoundedText(value: unknown, maximum: number): string | null {
  return value === null ? null : boundedText(value, maximum);
}

function exactOwnData(
  value: unknown,
  allowedKeys: readonly string[],
  requireNonempty: boolean,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
    Array.isArray(value)) throw new TypeError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const keys = Reflect.ownKeys(value);
  if ((requireNonempty && keys.length === 0) || keys.length > allowedKeys.length ||
    keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))) {
    throw new TypeError();
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.value === undefined) {
      throw new TypeError();
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function snapshotTags(value: unknown): readonly string[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
    lengthDescriptor.value > MAX_TAGS) throw new TypeError();
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || keys.some((key) => {
    if (key === "length") return false;
    return typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
      Number(key) >= length;
  })) throw new TypeError();

  const seen = new Set<string>();
  const tags: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) throw new TypeError();
    const tag = boundedText(descriptor.value, MAX_TAG_CHARS);
    if (seen.has(tag)) throw new TypeError();
    seen.add(tag);
    tags.push(tag);
  }
  const frozen = Object.freeze(tags);
  const canonical = canonicalProviderIndexJson(frozen);
  if (Buffer.byteLength(canonical, "utf8") > MAX_METADATA_JSON_BYTES) throw new TypeError();
  return frozen;
}

interface MetadataSnapshotState {
  readonly ancestors: Set<object>;
  recordKeys: number;
  arrayItems: number;
  visits: number;
  readonly maxDepth: number;
}

function snapshotMetadataJsonValue(
  value: unknown,
  depth: number,
  state: MetadataSnapshotState,
): ProviderMetadataJson {
  state.visits += 1;
  if (state.visits > MAX_METADATA_GRAPH_VISITS) throw new TypeError();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError();
    return value;
  }
  if (typeof value === "string") {
    if (!hasCanonicalUnicode(value) ||
      sqliteTextLengthAtMost(value, MAX_METADATA_JSON_CHARS) === null) throw new TypeError();
    return value;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value) || depth > state.maxDepth) {
    throw new TypeError();
  }
  if (state.ancestors.has(value)) throw new TypeError();
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError();
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
        lengthDescriptor.value > MAX_METADATA_ARRAY_ITEMS) throw new TypeError();
      const length = lengthDescriptor.value as number;
      state.arrayItems += length;
      if (state.arrayItems > MAX_METADATA_AGGREGATE_ARRAY_ITEMS) throw new TypeError();
      const keys = Reflect.ownKeys(value);
      if (keys.length !== length + 1 || keys.some((key) => {
        if (key === "length") return false;
        return typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
          Number(key) >= length;
      })) throw new TypeError();
      const snapshot: ProviderMetadataJson[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) throw new TypeError();
        snapshot.push(snapshotMetadataJsonValue(descriptor.value, depth + 1, state));
      }
      return Object.freeze(snapshot);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || !hasCanonicalUnicode(key) ||
      sqliteTextLengthAtMost(key, MAX_METADATA_JSON_CHARS) === null ||
      Buffer.byteLength(key, "utf8") > MAX_METADATA_JSON_BYTES)) {
      throw new TypeError();
    }
    state.recordKeys += keys.length;
    if (state.recordKeys > MAX_METADATA_RECORD_KEYS) throw new TypeError();
    const snapshot: Record<string, ProviderMetadataJson> = Object.create(null) as Record<
      string,
      ProviderMetadataJson
    >;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) throw new TypeError();
      snapshot[key] = snapshotMetadataJsonValue(descriptor.value, depth + 1, state);
    }
    return Object.freeze(snapshot);
  } finally {
    state.ancestors.delete(value);
  }
}

function snapshotMetadataObject(value: unknown, maxDepth: number): ProviderMetadataObject {
  const state: MetadataSnapshotState = {
    ancestors: new Set<object>(),
    recordKeys: 0,
    arrayItems: 0,
    visits: 0,
    maxDepth,
  };
  const snapshot = snapshotMetadataJsonValue(value, 0, state);
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError();
  }
  const canonical = canonicalProviderIndexJson(snapshot);
  if (Buffer.byteLength(canonical, "utf8") > MAX_METADATA_JSON_BYTES) throw new TypeError();
  return snapshot as ProviderMetadataObject;
}

export function normalizeProviderTaskMetaPatch(
  value: ProviderTaskMetaPatch,
  maxMetadataDepthValue: number,
): Readonly<ProviderTaskMetaPatch> {
  try {
    const maxDepth = metadataDepth(maxMetadataDepthValue);
    const input = exactOwnData(value, PATCH_KEYS, true);
    const patch: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      const raw = input[key];
      switch (key) {
        case "favorite":
        case "pinned":
        case "localArchived":
          if (typeof raw !== "boolean") throw new TypeError();
          patch[key] = raw;
          break;
        case "localLabel":
          patch[key] = optionalBoundedText(raw, MAX_LOCAL_LABEL_CHARS);
          break;
        case "tags":
          patch[key] = snapshotTags(raw);
          break;
        case "notes":
          patch[key] = optionalBoundedText(raw, MAX_NOTES_CHARS);
          break;
        case "uiState":
        case "unsupportedLocal":
          patch[key] = snapshotMetadataObject(raw, maxDepth);
          break;
        default:
          throw new TypeError();
      }
    }
    return Object.freeze(patch) as Readonly<ProviderTaskMetaPatch>;
  } catch {
    return fail("INVALID_INPUT");
  }
}

function frozenEmptyObject(): ProviderMetadataObject {
  return Object.freeze(Object.create(null) as ProviderMetadataObject);
}

function defaultMetadata(locator: ProviderTaskLocator): ProviderTaskMeta {
  return Object.freeze({
    locator,
    favorite: false,
    pinned: false,
    localLabel: null,
    tags: Object.freeze([]),
    notes: null,
    localArchived: false,
    uiState: frozenEmptyObject(),
    unsupportedLocal: frozenEmptyObject(),
    updatedAt: null,
  });
}

interface ProviderTaskMetaRow {
  readonly favorite: unknown;
  readonly pinned: unknown;
  readonly local_label: unknown;
  readonly tags_json: unknown;
  readonly notes: unknown;
  readonly local_archived: unknown;
  readonly ui_state_json: unknown;
  readonly unsupported_local_json: unknown;
  readonly updated_at: unknown;
}

function booleanInteger(value: unknown): boolean {
  if (value !== 0 && value !== 1) throw new TypeError();
  return value === 1;
}

function canonicalStoredJson(value: unknown, maxDepth: number): ProviderMetadataObject {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000") ||
    sqliteTextLengthAtMost(value, MAX_METADATA_JSON_CHARS) === null ||
    Buffer.byteLength(value, "utf8") > MAX_METADATA_JSON_BYTES) throw new TypeError();
  const parsed = JSON.parse(value) as unknown;
  const snapshot = snapshotMetadataObject(parsed, maxDepth);
  if (canonicalProviderIndexJson(snapshot) !== value) throw new TypeError();
  return snapshot;
}

function canonicalStoredTags(value: unknown): readonly string[] {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000") ||
    sqliteTextLengthAtMost(value, MAX_METADATA_JSON_CHARS) === null ||
    Buffer.byteLength(value, "utf8") > MAX_METADATA_JSON_BYTES) throw new TypeError();
  const parsed = JSON.parse(value) as unknown;
  const tags = snapshotTags(parsed);
  if (canonicalProviderIndexJson(tags) !== value) throw new TypeError();
  return tags;
}

function decodeMetadataRow(
  row: ProviderTaskMetaRow,
  locator: ProviderTaskLocator,
  maxDepth: number,
): ProviderTaskMeta {
  return Object.freeze({
    locator,
    favorite: booleanInteger(row.favorite),
    pinned: booleanInteger(row.pinned),
    localLabel: optionalBoundedText(row.local_label, MAX_LOCAL_LABEL_CHARS),
    tags: canonicalStoredTags(row.tags_json),
    notes: optionalBoundedText(row.notes, MAX_NOTES_CHARS),
    localArchived: booleanInteger(row.local_archived),
    uiState: canonicalStoredJson(row.ui_state_json, maxDepth),
    unsupportedLocal: canonicalStoredJson(row.unsupported_local_json, maxDepth),
    updatedAt: safeInteger(row.updated_at),
  });
}

function queryMetadataRow(
  db: SqliteDatabase,
  locator: ProviderTaskLocator,
): ProviderTaskMetaRow | undefined {
  return db.prepare(`SELECT favorite, pinned, local_label, tags_json, notes,
    local_archived, ui_state_json, unsupported_local_json, updated_at
    FROM provider_task_meta
    WHERE provider = ? AND home_fingerprint = ? AND native_task_id = ?`)
    .get(locator.provider, locator.homeFingerprint, locator.nativeTaskId) as
    ProviderTaskMetaRow | undefined;
}

export function readProviderTaskMeta(
  db: SqliteDatabase,
  locatorValue: ProviderTaskLocator,
  maxMetadataDepthValue: number,
): ProviderTaskMeta {
  const locator = normalizeLocator(locatorValue);
  let maxDepth: number;
  try {
    maxDepth = metadataDepth(maxMetadataDepthValue);
  } catch {
    return fail("INVALID_INPUT");
  }
  let row: ProviderTaskMetaRow | undefined;
  try {
    row = queryMetadataRow(db, locator);
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row === undefined) return defaultMetadata(locator);
  try {
    return decodeMetadataRow(row, locator, maxDepth);
  } catch {
    return fail("CORRUPT_ROW");
  }
}

let savepointSequence = 0n;

function nextSavepointName(): string {
  savepointSequence += 1n;
  return `devhub_provider_local_${process.pid}_${savepointSequence}_${randomUUID().replaceAll("-", "")}`;
}

function withProviderLocalSavepoint<T>(db: SqliteDatabase, operation: () => T): T {
  let name: string;
  try {
    name = nextSavepointName();
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  let opened = false;
  try {
    db.exec(`SAVEPOINT ${name}`);
    opened = true;
    const result = operation();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    opened = false;
    return result;
  } catch (error) {
    if (opened) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        db.exec(`RELEASE SAVEPOINT ${name}`);
      } catch {
        return fail("DATABASE_UNAVAILABLE");
      }
    }
    if (error instanceof ProviderLocalStateFailure) throw error;
    return fail("DATABASE_UNAVAILABLE");
  }
}

function ownPatchField<K extends keyof ProviderTaskMetaPatch>(
  patch: Readonly<ProviderTaskMetaPatch>,
  key: K,
  fallback: ProviderTaskMeta[K],
): ProviderTaskMetaPatch[K] | ProviderTaskMeta[K] {
  return Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : fallback;
}

export function patchProviderTaskMeta(
  db: SqliteDatabase,
  locatorValue: ProviderTaskLocator,
  patchValue: ProviderTaskMetaPatch,
  updatedAtValue: number,
  maxMetadataDepthValue: number,
): ProviderTaskMeta {
  const locator = normalizeLocator(locatorValue);
  const patch = normalizeProviderTaskMetaPatch(patchValue, maxMetadataDepthValue);
  let updatedAt: number;
  let maxDepth: number;
  try {
    updatedAt = safeInteger(updatedAtValue);
    maxDepth = metadataDepth(maxMetadataDepthValue);
  } catch {
    return fail("INVALID_INPUT");
  }

  return withProviderLocalSavepoint(db, () => {
    const currentRow = queryMetadataRow(db, locator);
    let current: ProviderTaskMeta;
    try {
      current = currentRow === undefined
        ? defaultMetadata(locator)
        : decodeMetadataRow(currentRow, locator, maxDepth);
    } catch {
      return fail("CORRUPT_ROW");
    }

    const favorite = ownPatchField(patch, "favorite", current.favorite) as boolean;
    const pinned = ownPatchField(patch, "pinned", current.pinned) as boolean;
    const localLabel = ownPatchField(patch, "localLabel", current.localLabel) as string | null;
    const tags = ownPatchField(patch, "tags", current.tags) as readonly string[];
    const notes = ownPatchField(patch, "notes", current.notes) as string | null;
    const localArchived = ownPatchField(
      patch,
      "localArchived",
      current.localArchived,
    ) as boolean;
    const uiState = ownPatchField(patch, "uiState", current.uiState) as ProviderMetadataObject;
    const unsupportedLocal = ownPatchField(
      patch,
      "unsupportedLocal",
      current.unsupportedLocal,
    ) as ProviderMetadataObject;
    const tagsJson = canonicalProviderIndexJson(tags);
    const uiStateJson = canonicalProviderIndexJson(uiState);
    const unsupportedLocalJson = canonicalProviderIndexJson(unsupportedLocal);

    try {
      db.prepare(`INSERT INTO provider_task_meta (
        provider, home_fingerprint, native_task_id, favorite, pinned, local_label,
        tags_json, notes, local_archived, ui_state_json, unsupported_local_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (provider, home_fingerprint, native_task_id) DO UPDATE SET
        favorite = excluded.favorite,
        pinned = excluded.pinned,
        local_label = excluded.local_label,
        tags_json = excluded.tags_json,
        notes = excluded.notes,
        local_archived = excluded.local_archived,
        ui_state_json = excluded.ui_state_json,
        unsupported_local_json = excluded.unsupported_local_json,
        updated_at = excluded.updated_at`)
        .run(
          locator.provider,
          locator.homeFingerprint,
          locator.nativeTaskId,
          favorite ? 1 : 0,
          pinned ? 1 : 0,
          localLabel,
          tagsJson,
          notes,
          localArchived ? 1 : 0,
          uiStateJson,
          unsupportedLocalJson,
          updatedAt,
        );
    } catch {
      return fail("DATABASE_UNAVAILABLE");
    }

    const persistedRow = queryMetadataRow(db, locator);
    if (persistedRow === undefined) return fail("CORRUPT_ROW");
    let persisted: ProviderTaskMeta;
    try {
      persisted = decodeMetadataRow(persistedRow, locator, maxDepth);
    } catch {
      return fail("CORRUPT_ROW");
    }
    if (persisted.favorite !== favorite || persisted.pinned !== pinned ||
      persisted.localLabel !== localLabel || persisted.notes !== notes ||
      persisted.localArchived !== localArchived || persisted.updatedAt !== updatedAt ||
      canonicalProviderIndexJson(persisted.tags) !== tagsJson ||
      canonicalProviderIndexJson(persisted.uiState) !== uiStateJson ||
      canonicalProviderIndexJson(persisted.unsupportedLocal) !== unsupportedLocalJson) {
      return fail("CORRUPT_ROW");
    }
    return persisted;
  });
}

const LOWERCASE_DIGEST = /^[0-9a-f]{64}$/u;

interface ProviderForkLinkRow {
  readonly source_provider: unknown;
  readonly source_home_fingerprint: unknown;
  readonly source_native_task_id: unknown;
  readonly target_provider: unknown;
  readonly target_home_fingerprint: unknown;
  readonly target_native_task_id: unknown;
  readonly created_at: unknown;
  readonly transfer_digest: unknown;
}

function locatorFromRow(
  provider: unknown,
  homeFingerprint: unknown,
  nativeTaskId: unknown,
): ProviderTaskLocator {
  return validatedLocator({
    version: 1,
    provider,
    homeFingerprint,
    nativeTaskId,
  } as ProviderTaskLocator);
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !LOWERCASE_DIGEST.test(value)) throw new TypeError();
  return value;
}

function decodeForkLinkRow(row: ProviderForkLinkRow): ProviderForkLink {
  const source = locatorFromRow(
    row.source_provider,
    row.source_home_fingerprint,
    row.source_native_task_id,
  );
  const target = locatorFromRow(
    row.target_provider,
    row.target_home_fingerprint,
    row.target_native_task_id,
  );
  if (serializeTaskLocator(source) === serializeTaskLocator(target)) throw new TypeError();
  return Object.freeze({
    source,
    target,
    createdAt: safeInteger(row.created_at),
    transferDigest: digest(row.transfer_digest),
  });
}

function queryForkLinkRow(
  db: SqliteDatabase,
  source: ProviderTaskLocator,
  target: ProviderTaskLocator,
): ProviderForkLinkRow | undefined {
  return db.prepare(`SELECT
    source_provider, source_home_fingerprint, source_native_task_id,
    target_provider, target_home_fingerprint, target_native_task_id,
    created_at, transfer_digest
    FROM provider_fork_links
    WHERE source_provider = ?
      AND source_home_fingerprint = ?
      AND source_native_task_id = ?
      AND target_provider = ?
      AND target_home_fingerprint = ?
      AND target_native_task_id = ?`)
    .get(
      source.provider,
      source.homeFingerprint,
      source.nativeTaskId,
      target.provider,
      target.homeFingerprint,
      target.nativeTaskId,
    ) as ProviderForkLinkRow | undefined;
}

function sameForkLink(
  link: ProviderForkLink,
  source: ProviderTaskLocator,
  target: ProviderTaskLocator,
  transferDigest: string,
  createdAt: number,
): boolean {
  return serializeTaskLocator(link.source) === serializeTaskLocator(source) &&
    serializeTaskLocator(link.target) === serializeTaskLocator(target) &&
    link.transferDigest === transferDigest && link.createdAt === createdAt;
}

function queryForkDegree(db: SqliteDatabase, locator: ProviderTaskLocator): number {
  const rows = db.prepare(`SELECT 1 AS present
    FROM provider_fork_links
    WHERE (
      source_provider = ?
      AND source_home_fingerprint = ?
      AND source_native_task_id = ?
    ) OR (
      target_provider = ?
      AND target_home_fingerprint = ?
      AND target_native_task_id = ?
    )
    LIMIT ${PROVIDER_FORK_LINKS_PER_LOCATOR_LIMIT + 1}`)
    .all(
      locator.provider,
      locator.homeFingerprint,
      locator.nativeTaskId,
      locator.provider,
      locator.homeFingerprint,
      locator.nativeTaskId,
    );
  return rows.length;
}

export function linkProviderFork(
  db: SqliteDatabase,
  sourceValue: ProviderTaskLocator,
  targetValue: ProviderTaskLocator,
  transferDigestValue: string,
  createdAtValue: number,
): ProviderForkLink {
  const source = normalizeLocator(sourceValue);
  const target = normalizeLocator(targetValue);
  let transferDigest: string;
  let createdAt: number;
  try {
    transferDigest = digest(transferDigestValue);
    createdAt = safeInteger(createdAtValue);
    if (serializeTaskLocator(source) === serializeTaskLocator(target)) throw new TypeError();
  } catch {
    return fail("INVALID_INPUT");
  }

  return withProviderLocalSavepoint(db, () => {
    const existingRow = queryForkLinkRow(db, source, target);
    let existing: ProviderForkLink | null = null;
    try {
      existing = existingRow === undefined ? null : decodeForkLinkRow(existingRow);
    } catch {
      return fail("CORRUPT_ROW");
    }
    if (existing !== null) {
      if (!sameForkLink(existing, source, target, transferDigest, createdAt)) {
        return fail("FORK_CONFLICT");
      }
      return existing;
    }

    const sourceDegree = queryForkDegree(db, source);
    const targetDegree = queryForkDegree(db, target);
    if (sourceDegree >= PROVIDER_FORK_LINKS_PER_LOCATOR_LIMIT ||
      targetDegree >= PROVIDER_FORK_LINKS_PER_LOCATOR_LIMIT) {
      return fail("CAPACITY");
    }

    try {
      db.prepare(`INSERT OR IGNORE INTO provider_fork_links (
        source_provider, source_home_fingerprint, source_native_task_id,
        target_provider, target_home_fingerprint, target_native_task_id,
        created_at, transfer_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          source.provider,
          source.homeFingerprint,
          source.nativeTaskId,
          target.provider,
          target.homeFingerprint,
          target.nativeTaskId,
          createdAt,
          transferDigest,
        );
    } catch {
      return fail("DATABASE_UNAVAILABLE");
    }

    const persistedRow = queryForkLinkRow(db, source, target);
    if (persistedRow === undefined) return fail("CORRUPT_ROW");
    let persisted: ProviderForkLink;
    try {
      persisted = decodeForkLinkRow(persistedRow);
    } catch {
      return fail("CORRUPT_ROW");
    }
    if (!sameForkLink(persisted, source, target, transferDigest, createdAt)) {
      return fail("CORRUPT_ROW");
    }
    if (queryForkDegree(db, source) !== sourceDegree + 1 ||
      queryForkDegree(db, target) !== targetDegree + 1) {
      return fail("CORRUPT_ROW");
    }
    return persisted;
  });
}

function compareAscii(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function listProviderForkLinks(
  db: SqliteDatabase,
  locatorValue: ProviderTaskLocator,
): readonly ProviderForkLink[] {
  const locator = normalizeLocator(locatorValue);
  let rows: ProviderForkLinkRow[];
  try {
    rows = db.prepare(`SELECT
      source_provider, source_home_fingerprint, source_native_task_id,
      target_provider, target_home_fingerprint, target_native_task_id,
      created_at, transfer_digest
      FROM provider_fork_links
      WHERE (
        source_provider = ?
        AND source_home_fingerprint = ?
        AND source_native_task_id = ?
      ) OR (
        target_provider = ?
        AND target_home_fingerprint = ?
        AND target_native_task_id = ?
      )
      LIMIT ${PROVIDER_FORK_LINKS_PER_LOCATOR_LIMIT + 1}`)
      .all(
        locator.provider,
        locator.homeFingerprint,
        locator.nativeTaskId,
        locator.provider,
        locator.homeFingerprint,
        locator.nativeTaskId,
      ) as unknown as ProviderForkLinkRow[];
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (rows.length > PROVIDER_FORK_LINKS_PER_LOCATOR_LIMIT) return fail("CAPACITY");
  let links: ProviderForkLink[];
  try {
    links = rows.map(decodeForkLinkRow);
  } catch {
    return fail("CORRUPT_ROW");
  }
  const ordered = links.map((link) => ({
    link,
    sourceKey: serializeTaskLocator(link.source),
    targetKey: serializeTaskLocator(link.target),
  }));
  ordered.sort((left, right) => (
    left.link.createdAt - right.link.createdAt ||
    compareAscii(left.sourceKey, right.sourceKey) ||
    compareAscii(left.targetKey, right.targetKey)
  ));
  return Object.freeze(ordered.map(({ link }) => link));
}

const LEGACY_PROVENANCE = new Set<LegacySessionProvenance>([
  "imported",
  "missing",
  "ambiguous",
  "foreign-machine",
  "archive-v1-import",
]);

function legacySessionId(value: unknown): string {
  if (typeof value !== "string" || !hasCanonicalUnicode(value)) throw new TypeError();
  const normalized = normalizeProviderNativeId(value, "legacy session id");
  if (normalized !== value) throw new TypeError();
  return normalized;
}

function legacyProvenance(value: unknown): LegacySessionProvenance {
  if (typeof value !== "string" ||
    !LEGACY_PROVENANCE.has(value as LegacySessionProvenance)) throw new TypeError();
  return value as LegacySessionProvenance;
}

interface LegacyProvenanceRow {
  readonly legacy_session_id: unknown;
  readonly provenance: unknown;
  readonly observed_at: unknown;
}

function queryLegacyProvenanceRow(
  db: SqliteDatabase,
  sessionId: string,
): LegacyProvenanceRow | undefined {
  return db.prepare(`SELECT legacy_session_id, provenance, observed_at
    FROM legacy_session_provenance WHERE legacy_session_id = ?`)
    .get(sessionId) as LegacyProvenanceRow | undefined;
}

function decodeLegacyProvenanceRow(row: LegacyProvenanceRow): Readonly<{
  sessionId: string;
  provenance: LegacySessionProvenance;
  observedAt: number;
}> {
  return Object.freeze({
    sessionId: legacySessionId(row.legacy_session_id),
    provenance: legacyProvenance(row.provenance),
    observedAt: safeInteger(row.observed_at),
  });
}

export function classifyLegacySession(
  db: SqliteDatabase,
  sessionIdValue: string,
  provenanceValue: LegacySessionProvenance,
  observedAtValue: number,
): void {
  let sessionId: string;
  let provenance: LegacySessionProvenance;
  let observedAt: number;
  try {
    sessionId = legacySessionId(sessionIdValue);
    provenance = legacyProvenance(provenanceValue);
    observedAt = safeInteger(observedAtValue);
  } catch {
    return fail("INVALID_INPUT");
  }

  withProviderLocalSavepoint(db, () => {
    const existingRow = queryLegacyProvenanceRow(db, sessionId);
    let existing: ReturnType<typeof decodeLegacyProvenanceRow> | null;
    try {
      existing = existingRow === undefined ? null : decodeLegacyProvenanceRow(existingRow);
    } catch {
      return fail("CORRUPT_ROW");
    }
    if (existing !== null) {
      if (existing.sessionId !== sessionId || existing.provenance !== provenance ||
        existing.observedAt !== observedAt) return fail("LEGACY_MAPPING_CONFLICT");
      return;
    }

    try {
      db.prepare(`INSERT OR IGNORE INTO legacy_session_provenance (
        legacy_session_id, provenance, observed_at
      ) VALUES (?, ?, ?)`)
        .run(sessionId, provenance, observedAt);
    } catch {
      return fail("DATABASE_UNAVAILABLE");
    }
    const persistedRow = queryLegacyProvenanceRow(db, sessionId);
    if (persistedRow === undefined) return fail("CORRUPT_ROW");
    let persisted: ReturnType<typeof decodeLegacyProvenanceRow>;
    try {
      persisted = decodeLegacyProvenanceRow(persistedRow);
    } catch {
      return fail("CORRUPT_ROW");
    }
    if (persisted.sessionId !== sessionId || persisted.provenance !== provenance ||
      persisted.observedAt !== observedAt) return fail("CORRUPT_ROW");
  });
}

export interface ProviderRegisteredHomeAuthority {
  readonly provider: ProviderId;
  readonly homeFingerprint: string;
  readonly canonicalHome: string;
  readonly registeredAt: number;
}

function providerId(value: unknown): ProviderId {
  if (value !== "openai" && value !== "anthropic") throw new TypeError();
  return value;
}

function lowercaseFingerprint(value: unknown): string {
  if (typeof value !== "string" || !LOWERCASE_DIGEST.test(value)) throw new TypeError();
  return value;
}

function storedCanonicalHome(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000") ||
    !hasCanonicalUnicode(value) || sqliteTextLengthAtMost(value, 16_384) === null) {
    throw new TypeError();
  }
  return value;
}

function normalizeRegisteredAuthority(value: unknown): ProviderRegisteredHomeAuthority {
  const input = exactOwnData(value, [
    "provider",
    "homeFingerprint",
    "canonicalHome",
    "registeredAt",
  ], true);
  if (Object.keys(input).length !== 4) throw new TypeError();
  return Object.freeze({
    provider: providerId(input.provider),
    homeFingerprint: lowercaseFingerprint(input.homeFingerprint),
    canonicalHome: storedCanonicalHome(input.canonicalHome),
    registeredAt: safeInteger(input.registeredAt),
  });
}

function sameRegisteredAuthority(
  left: ProviderRegisteredHomeAuthority,
  right: ProviderRegisteredHomeAuthority,
): boolean {
  return left.provider === right.provider &&
    left.homeFingerprint === right.homeFingerprint &&
    left.canonicalHome === right.canonicalHome &&
    left.registeredAt === right.registeredAt;
}

interface RegisteredAuthorityRow {
  readonly provider: unknown;
  readonly home_fingerprint: unknown;
  readonly canonical_home: unknown;
  readonly registered_at: unknown;
}

function queryRegisteredAuthorityRow(
  db: SqliteDatabase,
  provider: ProviderId,
  homeFingerprint: string,
): RegisteredAuthorityRow | undefined {
  return db.prepare(`SELECT provider, home_fingerprint, canonical_home, registered_at
    FROM provider_homes WHERE provider = ? AND home_fingerprint = ?`)
    .get(provider, homeFingerprint) as RegisteredAuthorityRow | undefined;
}

function decodeRegisteredAuthorityRow(
  row: RegisteredAuthorityRow,
): ProviderRegisteredHomeAuthority {
  return normalizeRegisteredAuthority({
    provider: row.provider,
    homeFingerprint: row.home_fingerprint,
    canonicalHome: row.canonical_home,
    registeredAt: row.registered_at,
  });
}

interface NormalizedVerifiedLegacyMapping {
  readonly mappingSource: "live-provider-observation";
  readonly verifiedAt: number;
}

function normalizeVerifiedMappingEvidence(value: unknown): NormalizedVerifiedLegacyMapping {
  const input = exactOwnData(value, ["mappingSource", "verifiedAt"], true);
  if (Object.keys(input).length !== 2 || input.mappingSource !== "live-provider-observation") {
    throw new TypeError();
  }
  return Object.freeze({
    mappingSource: "live-provider-observation",
    verifiedAt: safeInteger(input.verifiedAt),
  });
}

interface VerifiedLegacyMappingRow {
  readonly legacy_session_id: unknown;
  readonly provider: unknown;
  readonly home_fingerprint: unknown;
  readonly native_task_id: unknown;
  readonly mapping_source: unknown;
  readonly verified_at: unknown;
}

function decodeVerifiedLegacyMappingRow(
  row: VerifiedLegacyMappingRow,
): Readonly<VerifiedLegacySessionResolution> {
  if (row.mapping_source !== "live-provider-observation") throw new TypeError();
  return Object.freeze({
    sessionId: legacySessionId(row.legacy_session_id),
    locator: locatorFromRow(row.provider, row.home_fingerprint, row.native_task_id),
    mappingSource: "live-provider-observation",
    verifiedAt: safeInteger(row.verified_at),
  });
}

function queryVerifiedMappingBySession(
  db: SqliteDatabase,
  sessionId: string,
): VerifiedLegacyMappingRow | undefined {
  return db.prepare(`SELECT legacy_session_id, provider, home_fingerprint,
    native_task_id, mapping_source, verified_at
    FROM legacy_session_task_map WHERE legacy_session_id = ?`)
    .get(sessionId) as VerifiedLegacyMappingRow | undefined;
}

function queryVerifiedMappingByLocator(
  db: SqliteDatabase,
  locator: ProviderTaskLocator,
): VerifiedLegacyMappingRow | undefined {
  return db.prepare(`SELECT legacy_session_id, provider, home_fingerprint,
    native_task_id, mapping_source, verified_at
    FROM legacy_session_task_map
    WHERE provider = ? AND home_fingerprint = ? AND native_task_id = ?`)
    .get(locator.provider, locator.homeFingerprint, locator.nativeTaskId) as
    VerifiedLegacyMappingRow | undefined;
}

function sameLocator(left: ProviderTaskLocator, right: ProviderTaskLocator): boolean {
  return serializeTaskLocator(left) === serializeTaskLocator(right);
}

export function readVerifiedLegacySessionMapping(
  db: SqliteDatabase,
  sessionIdValue: string,
): Readonly<VerifiedLegacySessionResolution> | null {
  let sessionId: string;
  try {
    sessionId = legacySessionId(sessionIdValue);
  } catch {
    return fail("INVALID_INPUT");
  }

  let row: VerifiedLegacyMappingRow | undefined;
  try {
    row = queryVerifiedMappingBySession(db, sessionId);
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (row === undefined) return null;

  let resolution: Readonly<VerifiedLegacySessionResolution>;
  try {
    resolution = decodeVerifiedLegacyMappingRow(row);
  } catch {
    return fail("CORRUPT_ROW");
  }
  if (resolution.sessionId !== sessionId) return fail("CORRUPT_ROW");

  let authorityRow: RegisteredAuthorityRow | undefined;
  try {
    authorityRow = queryRegisteredAuthorityRow(
      db,
      resolution.locator.provider,
      resolution.locator.homeFingerprint,
    );
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  if (authorityRow !== undefined) {
    let authority: ProviderRegisteredHomeAuthority;
    try {
      authority = decodeRegisteredAuthorityRow(authorityRow);
    } catch {
      return fail("CORRUPT_ROW");
    }
    if (authority.provider !== resolution.locator.provider ||
      authority.homeFingerprint !== resolution.locator.homeFingerprint ||
      hashPersistedProviderHome(authority.provider, authority.canonicalHome) !==
        authority.homeFingerprint ||
      resolution.locator.nativeTaskId.includes(authority.canonicalHome)) {
      return fail("CORRUPT_ROW");
    }
  }
  return resolution;
}

export function mapVerifiedLegacySession(
  db: SqliteDatabase,
  sessionIdValue: string,
  locatorValue: ProviderTaskLocator,
  evidenceValue: VerifiedLegacyMapping,
  authorityValue: ProviderRegisteredHomeAuthority,
  recheckAuthorityValue: () => ProviderRegisteredHomeAuthority | null,
): void {
  let sessionId: string;
  let locator: ProviderTaskLocator;
  let evidence: NormalizedVerifiedLegacyMapping;
  let authority: ProviderRegisteredHomeAuthority;
  let recheckAuthority: () => ProviderRegisteredHomeAuthority | null;
  try {
    sessionId = legacySessionId(sessionIdValue);
    locator = validatedLocator(locatorValue);
    evidence = normalizeVerifiedMappingEvidence(evidenceValue);
    authority = normalizeRegisteredAuthority(authorityValue);
    if (typeof recheckAuthorityValue !== "function" || authority.provider !== locator.provider ||
      authority.homeFingerprint !== locator.homeFingerprint ||
      locator.nativeTaskId.includes(authority.canonicalHome)) throw new TypeError();
    recheckAuthority = recheckAuthorityValue;
  } catch {
    return fail("INVALID_INPUT");
  }

  withProviderLocalSavepoint(db, () => {
    const registeredRow = queryRegisteredAuthorityRow(
      db,
      locator.provider,
      locator.homeFingerprint,
    );
    if (registeredRow === undefined) return fail("UNKNOWN_HOME");
    let registered: ProviderRegisteredHomeAuthority;
    try {
      registered = decodeRegisteredAuthorityRow(registeredRow);
    } catch {
      return fail("CORRUPT_ROW");
    }
    if (!sameRegisteredAuthority(registered, authority)) return fail("UNKNOWN_HOME");

    let recheckedValue: ProviderRegisteredHomeAuthority | null;
    try {
      recheckedValue = recheckAuthority();
    } catch {
      return fail("DATABASE_UNAVAILABLE");
    }
    if (recheckedValue === null) return fail("CORRUPT_ROW");
    let rechecked: ProviderRegisteredHomeAuthority;
    try {
      rechecked = normalizeRegisteredAuthority(recheckedValue);
    } catch {
      return fail("CORRUPT_ROW");
    }
    if (!sameRegisteredAuthority(rechecked, authority)) {
      return fail("CORRUPT_ROW");
    }
    const recheckedRow = queryRegisteredAuthorityRow(
      db,
      locator.provider,
      locator.homeFingerprint,
    );
    if (recheckedRow === undefined) return fail("CORRUPT_ROW");
    try {
      if (!sameRegisteredAuthority(decodeRegisteredAuthorityRow(recheckedRow), authority)) {
        return fail("CORRUPT_ROW");
      }
    } catch (error) {
      if (error instanceof ProviderLocalStateFailure) throw error;
      return fail("CORRUPT_ROW");
    }

    const sessionRow = queryVerifiedMappingBySession(db, sessionId);
    const locatorRow = queryVerifiedMappingByLocator(db, locator);
    let bySession: Readonly<VerifiedLegacySessionResolution> | null;
    let byLocator: Readonly<VerifiedLegacySessionResolution> | null;
    try {
      bySession = sessionRow === undefined ? null : decodeVerifiedLegacyMappingRow(sessionRow);
      byLocator = locatorRow === undefined ? null : decodeVerifiedLegacyMappingRow(locatorRow);
    } catch {
      return fail("CORRUPT_ROW");
    }
    if (bySession !== null || byLocator !== null) {
      if (bySession === null || byLocator === null || bySession.sessionId !== sessionId ||
        byLocator.sessionId !== sessionId || !sameLocator(bySession.locator, locator) ||
        !sameLocator(byLocator.locator, locator)) {
        return fail("LEGACY_MAPPING_CONFLICT");
      }
      return;
    }

    try {
      db.prepare(`INSERT OR IGNORE INTO legacy_session_task_map (
        legacy_session_id, provider, home_fingerprint, native_task_id,
        mapping_source, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          sessionId,
          locator.provider,
          locator.homeFingerprint,
          locator.nativeTaskId,
          evidence.mappingSource,
          evidence.verifiedAt,
        );
    } catch {
      return fail("DATABASE_UNAVAILABLE");
    }

    const persistedRow = queryVerifiedMappingBySession(db, sessionId);
    if (persistedRow === undefined) return fail("CORRUPT_ROW");
    const persistedLocatorRow = queryVerifiedMappingByLocator(db, locator);
    if (persistedLocatorRow === undefined) return fail("CORRUPT_ROW");
    const persistedAuthorityRow = queryRegisteredAuthorityRow(
      db,
      locator.provider,
      locator.homeFingerprint,
    );
    if (persistedAuthorityRow === undefined) return fail("CORRUPT_ROW");
    let persisted: Readonly<VerifiedLegacySessionResolution>;
    try {
      persisted = decodeVerifiedLegacyMappingRow(persistedRow);
      if (decodeVerifiedLegacyMappingRow(persistedLocatorRow).sessionId !== sessionId) {
        return fail("CORRUPT_ROW");
      }
      if (!sameRegisteredAuthority(
        decodeRegisteredAuthorityRow(persistedAuthorityRow),
        authority,
      )) {
        return fail("CORRUPT_ROW");
      }
    } catch (error) {
      if (error instanceof ProviderLocalStateFailure) throw error;
      return fail("CORRUPT_ROW");
    }
    if (persisted.sessionId !== sessionId || !sameLocator(persisted.locator, locator) ||
      persisted.mappingSource !== evidence.mappingSource ||
      persisted.verifiedAt !== evidence.verifiedAt) return fail("CORRUPT_ROW");
  });
}
