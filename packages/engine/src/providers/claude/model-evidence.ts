import { normalizeProviderNativeId } from "../native-id.js";

export const CLAUDE_MODEL_EVIDENCE_SOURCES = Object.freeze([
  "requested",
  "system-init",
  "stream-message-start",
  "assistant-message",
  "result-model-usage",
  "result-total-usage",
] as const);

export const CLAUDE_MODEL_EVIDENCE_DEFAULT_MAX_OBSERVATIONS = 4_096;
export const CLAUDE_MODEL_EVIDENCE_HARD_MAX_OBSERVATIONS = 4_096;

export type ClaudeModelEvidenceSource =
  (typeof CLAUDE_MODEL_EVIDENCE_SOURCES)[number];
export type ClaudeModelUsageKind = "reported" | "billed";

export interface ClaudeModelUsageEvidence {
  readonly kind: ClaudeModelUsageKind;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly costUsd: number | null;
}

export interface ClaudeModelObservation {
  readonly id: string;
  readonly source: ClaudeModelEvidenceSource;
  readonly sourceEventId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly turnId: string | null;
  readonly occurredAt: string;
  readonly model: string | null;
  readonly usage: Readonly<ClaudeModelUsageEvidence> | null;
}

export interface ClaudeModelEvidenceBySource {
  readonly requested: readonly ClaudeModelObservation[];
  readonly "system-init": readonly ClaudeModelObservation[];
  readonly "stream-message-start": readonly ClaudeModelObservation[];
  readonly "assistant-message": readonly ClaudeModelObservation[];
  readonly "result-model-usage": readonly ClaudeModelObservation[];
  readonly "result-total-usage": readonly ClaudeModelObservation[];
}

export interface ClaudeModelEvidenceSnapshot {
  readonly observations: readonly ClaudeModelObservation[];
  readonly bySource: Readonly<ClaudeModelEvidenceBySource>;
  readonly distinctModels: readonly string[];
  readonly hasDivergence: boolean;
}

export type ClaudeModelEvidenceErrorCode =
  | "CAPACITY"
  | "COLLISION"
  | "FOREIGN_SCOPE"
  | "INVALID_BATCH"
  | "INVALID_OBSERVATION";

/** A value-free error: provider ids, models, timestamps, and usage never appear in text. */
export class ClaudeModelEvidenceError extends Error {
  readonly code: ClaudeModelEvidenceErrorCode;

  constructor(code: ClaudeModelEvidenceErrorCode, message: string) {
    super(message);
    this.name = "ClaudeModelEvidenceError";
    this.code = code;
  }
}

export interface ClaudeModelEvidenceLedgerOptions {
  readonly sessionId: string;
  readonly generation: number;
  readonly maxObservations?: number;
}

const NATIVE_SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SOURCE_SET = new Set<ClaudeModelEvidenceSource>(CLAUDE_MODEL_EVIDENCE_SOURCES);
const INTERNAL_ERRORS = new WeakSet<object>();

const fail = (
  code: ClaudeModelEvidenceErrorCode,
  message: string,
): never => {
  const error = new ClaudeModelEvidenceError(code, message);
  INTERNAL_ERRORS.add(error);
  Object.freeze(error);
  throw error;
};

const rethrowOrInvalid = (error: unknown): never => {
  if (
    error !== null &&
    (typeof error === "object" || typeof error === "function") &&
    INTERNAL_ERRORS.has(error as object)
  ) throw error;
  return fail("INVALID_OBSERVATION", "Claude model observation is invalid");
};

const plainDataRecordUnsafe = (
  value: unknown,
  exactKeys: readonly string[],
): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("INVALID_OBSERVATION", "Claude model observation is invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail("INVALID_OBSERVATION", "Claude model observation is invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== exactKeys.length ||
    keys.some((key) => typeof key !== "string" || !exactKeys.includes(key))
  ) {
    return fail("INVALID_OBSERVATION", "Claude model observation is invalid");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot: Record<string, unknown> = {};
  for (const key of exactKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      return fail("INVALID_OBSERVATION", "Claude model observation is invalid");
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
};

const safeNativeId = (value: unknown): string => {
  try {
    return normalizeProviderNativeId(value, "Claude model evidence id");
  } catch {
    return fail("INVALID_OBSERVATION", "Claude model observation is invalid");
  }
};

const sessionId = (value: unknown): string => {
  const normalized = safeNativeId(value);
  if (!NATIVE_SESSION_UUID.test(normalized)) {
    return fail("INVALID_OBSERVATION", "Claude model observation is invalid");
  }
  return normalized;
};

const positiveGeneration = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return fail("INVALID_OBSERVATION", "Claude model observation is invalid");
  }
  return value;
};

const source = (value: unknown): ClaudeModelEvidenceSource => {
  if (typeof value !== "string" || !SOURCE_SET.has(value as ClaudeModelEvidenceSource)) {
    return fail("INVALID_OBSERVATION", "Claude model observation is invalid");
  }
  return value as ClaudeModelEvidenceSource;
};

const timestamp = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 32) {
    return fail("INVALID_OBSERVATION", "Claude model observation is invalid");
  }
  try {
    if (new Date(value).toISOString() !== value) {
      return fail("INVALID_OBSERVATION", "Claude model observation is invalid");
    }
  } catch {
    return fail("INVALID_OBSERVATION", "Claude model observation is invalid");
  }
  return value;
};

const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail("INVALID_OBSERVATION", "Claude model observation is invalid");
  }
  return value === 0 ? 0 : value;
};

const cost = (value: unknown): number | null => {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fail("INVALID_OBSERVATION", "Claude model observation is invalid");
  }
  return value === 0 ? 0 : value;
};

const usageEvidenceUnsafe = (value: unknown): Readonly<ClaudeModelUsageEvidence> | null => {
  if (value === null) return null;
  const usage = plainDataRecordUnsafe(value, [
    "kind",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheCreationTokens",
    "costUsd",
  ]);
  if (usage.kind !== "reported" && usage.kind !== "billed") {
    return fail("INVALID_OBSERVATION", "Claude model observation is invalid");
  }
  return Object.freeze({
    kind: usage.kind,
    inputTokens: count(usage.inputTokens),
    outputTokens: count(usage.outputTokens),
    cacheReadTokens: count(usage.cacheReadTokens),
    cacheCreationTokens: count(usage.cacheCreationTokens),
    costUsd: cost(usage.costUsd),
  });
};

const buildObservationUnsafe = (value: unknown): Readonly<ClaudeModelObservation> => {
  const input = plainDataRecordUnsafe(value, [
    "id",
    "source",
    "sourceEventId",
    "sessionId",
    "generation",
    "turnId",
    "occurredAt",
    "model",
    "usage",
  ]);
  return Object.freeze({
    id: safeNativeId(input.id),
    source: source(input.source),
    sourceEventId: safeNativeId(input.sourceEventId),
    sessionId: sessionId(input.sessionId),
    generation: positiveGeneration(input.generation),
    turnId: input.turnId === null ? null : safeNativeId(input.turnId),
    occurredAt: timestamp(input.occurredAt),
    model: input.model === null ? null : safeNativeId(input.model),
    usage: usageEvidenceUnsafe(input.usage),
  });
};

export function buildClaudeModelObservation(value: unknown): Readonly<ClaudeModelObservation> {
  try {
    return buildObservationUnsafe(value);
  } catch (error) {
    return rethrowOrInvalid(error);
  }
}

export function buildClaudeRequestedModelObservation(
  value: unknown,
): Readonly<ClaudeModelObservation> {
  try {
    const input = plainDataRecordUnsafe(value, [
      "id",
      "sourceEventId",
      "sessionId",
      "generation",
      "turnId",
      "occurredAt",
      "model",
    ]);
    return buildObservationUnsafe({
      id: input.id,
      source: "requested",
      sourceEventId: input.sourceEventId,
      sessionId: input.sessionId,
      generation: input.generation,
      turnId: input.turnId,
      occurredAt: input.occurredAt,
      model: input.model,
      usage: null,
    });
  } catch (error) {
    return rethrowOrInvalid(error);
  }
}

const strictBatchItems = (value: unknown): readonly unknown[] => {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > CLAUDE_MODEL_EVIDENCE_HARD_MAX_OBSERVATIONS) {
      return fail("INVALID_BATCH", "Claude model evidence batch is invalid");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes("length")) {
      return fail("INVALID_BATCH", "Claude model evidence batch is invalid");
    }
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        return fail("INVALID_BATCH", "Claude model evidence batch is invalid");
      }
      items.push(descriptor.value);
    }
    return items;
  } catch (error) {
    if (
      error !== null &&
      (typeof error === "object" || typeof error === "function") &&
      INTERNAL_ERRORS.has(error as object)
    ) throw error;
    return fail("INVALID_BATCH", "Claude model evidence batch is invalid");
  }
};

const maxObservations = (value: unknown): number => {
  const resolved = value ?? CLAUDE_MODEL_EVIDENCE_DEFAULT_MAX_OBSERVATIONS;
  if (
    typeof resolved !== "number" ||
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > CLAUDE_MODEL_EVIDENCE_HARD_MAX_OBSERVATIONS
  ) {
    throw new RangeError(
      `maxObservations must be a positive safe integer no greater than ${CLAUDE_MODEL_EVIDENCE_HARD_MAX_OBSERVATIONS}`,
    );
  }
  return resolved;
};

export class ClaudeModelEvidenceLedger {
  private readonly sessionIdValue: string;
  private readonly generationValue: number;
  private readonly maxObservationsValue: number;
  private readonly observations: Readonly<ClaudeModelObservation>[] = [];
  private readonly byId = new Map<
    string,
    { readonly observation: Readonly<ClaudeModelObservation>; readonly fingerprint: string }
  >();
  private appending = false;

  constructor(options: ClaudeModelEvidenceLedgerOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("Claude model evidence ledger options are invalid");
    }
    let configuredMax: unknown;
    try {
      this.sessionIdValue = sessionId(options.sessionId);
      this.generationValue = positiveGeneration(options.generation);
      configuredMax = options.maxObservations;
    } catch {
      throw new TypeError("Claude model evidence ledger ownership is invalid");
    }
    this.maxObservationsValue = maxObservations(configuredMax);
  }

  append(batch: unknown): number {
    if (this.appending) {
      return fail("INVALID_BATCH", "Claude model evidence append is already in progress");
    }
    this.appending = true;
    try {
      const items = strictBatchItems(batch);
      const candidates = new Map<
        string,
        { readonly observation: Readonly<ClaudeModelObservation>; readonly fingerprint: string }
      >();
      const orderedNewIds: string[] = [];

      for (const item of items) {
        const built = buildClaudeModelObservation(item);
        if (
          built.sessionId !== this.sessionIdValue ||
          built.generation !== this.generationValue
        ) {
          return fail("FOREIGN_SCOPE", "Claude model evidence belongs to another scope");
        }
        const fingerprint = JSON.stringify(built);
        const existing = this.byId.get(built.id);
        if (existing) {
          if (existing.fingerprint !== fingerprint) {
            return fail("COLLISION", "Claude model evidence id has conflicting observations");
          }
          continue;
        }
        const prior = candidates.get(built.id);
        if (prior) {
          if (prior.fingerprint !== fingerprint) {
            return fail("COLLISION", "Claude model evidence id has conflicting observations");
          }
          continue;
        }
        candidates.set(built.id, { observation: built, fingerprint });
        orderedNewIds.push(built.id);
      }

      if (this.observations.length + orderedNewIds.length > this.maxObservationsValue) {
        return fail("CAPACITY", "Claude model evidence capacity is exhausted");
      }
      for (const id of orderedNewIds) {
        const candidate = candidates.get(id)!;
        this.byId.set(id, candidate);
        this.observations.push(candidate.observation);
      }
      return orderedNewIds.length;
    } finally {
      this.appending = false;
    }
  }

  snapshot(): Readonly<ClaudeModelEvidenceSnapshot> {
    const bySource: Record<ClaudeModelEvidenceSource, Readonly<ClaudeModelObservation>[]> = {
      requested: [],
      "system-init": [],
      "stream-message-start": [],
      "assistant-message": [],
      "result-model-usage": [],
      "result-total-usage": [],
    };
    const distinctModels: string[] = [];
    const knownModels = new Set<string>();
    for (const observation of this.observations) {
      bySource[observation.source].push(observation);
      if (observation.model !== null && !knownModels.has(observation.model)) {
        knownModels.add(observation.model);
        distinctModels.push(observation.model);
      }
    }
    const frozenBySource = Object.freeze({
      requested: Object.freeze([...bySource.requested]),
      "system-init": Object.freeze([...bySource["system-init"]]),
      "stream-message-start": Object.freeze([...bySource["stream-message-start"]]),
      "assistant-message": Object.freeze([...bySource["assistant-message"]]),
      "result-model-usage": Object.freeze([...bySource["result-model-usage"]]),
      "result-total-usage": Object.freeze([...bySource["result-total-usage"]]),
    });
    return Object.freeze({
      observations: Object.freeze([...this.observations]),
      bySource: frozenBySource,
      distinctModels: Object.freeze(distinctModels),
      hasDivergence: distinctModels.length > 1,
    });
  }
}
