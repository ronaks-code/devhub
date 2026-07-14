import type { IndexedProviderEvent, ProviderTaskLocator } from "./identity.js";
import type {
  NativeRevision,
  NativeTaskSource,
  ProviderId,
} from "../providers/types.js";

export const PROVIDER_INDEX_STORE_DEFAULTS = Object.freeze({
  stageLeaseMs: 30_000,
  maxTasksPerGeneration: 100_000,
  maxTurnsPerGeneration: 1_000_000,
  maxEventsPerTask: 100_000,
  maxEventsPerGeneration: 5_000_000,
  maxMetadataDepth: 16,
});

export const PROVIDER_INDEX_STORE_HARD_LIMITS = Object.freeze({
  stageLeaseMs: Object.freeze({ min: 1_000, max: 300_000 }),
  maxTasksPerGeneration: 1_000_000,
  maxTurnsPerGeneration: 2_000_000,
  maxEventsPerTask: 1_000_000,
  maxEventsPerGeneration: 10_000_000,
  maxMetadataDepth: 32,
});

export type ProviderIndexStoreErrorCode =
  | "INVALID_INPUT"
  | "CORRUPT_ROW"
  | "DATABASE_UNAVAILABLE"
  | "CLOCK_FAILURE"
  | "TOKEN_FAILURE"
  | "CAPACITY"
  | "UNKNOWN_HOME"
  | "HOME_CONFLICT"
  | "STAGE_BUSY"
  | "STAGE_LOST"
  | "STAGE_EXPIRED"
  | "STAGE_INCOMPLETE"
  | "REPLAY_CONFLICT"
  | "FORK_CONFLICT"
  | "LEGACY_MAPPING_CONFLICT"
  | "RECONCILIATION_CAS_MISMATCH";

const ERROR_MESSAGES: Readonly<Record<ProviderIndexStoreErrorCode, string>> = Object.freeze({
  INVALID_INPUT: "provider index store input is invalid",
  CORRUPT_ROW: "provider index store row is corrupt",
  DATABASE_UNAVAILABLE: "provider index database is unavailable",
  CLOCK_FAILURE: "provider index clock failed",
  TOKEN_FAILURE: "provider index token generation failed",
  CAPACITY: "provider index capacity was exceeded",
  UNKNOWN_HOME: "provider index home is unknown",
  HOME_CONFLICT: "provider index home conflicts with existing state",
  STAGE_BUSY: "provider index stage is busy",
  STAGE_LOST: "provider index stage ownership was lost",
  STAGE_EXPIRED: "provider index stage expired",
  STAGE_INCOMPLETE: "provider index stage is incomplete",
  REPLAY_CONFLICT: "provider index replay conflict",
  FORK_CONFLICT: "provider index fork conflict",
  LEGACY_MAPPING_CONFLICT: "provider index legacy mapping conflict",
  RECONCILIATION_CAS_MISMATCH: "provider index reconciliation state changed",
});

export class ProviderIndexStoreError extends Error {
  readonly code: ProviderIndexStoreErrorCode;

  constructor(code: ProviderIndexStoreErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ProviderIndexStoreError";
    this.code = code;
  }
}

export interface ProviderIndexStoreOptions {
  readonly stageLeaseMs?: number;
  readonly maxTasksPerGeneration?: number;
  readonly maxTurnsPerGeneration?: number;
  readonly maxEventsPerTask?: number;
  readonly maxEventsPerGeneration?: number;
  readonly maxMetadataDepth?: number;
  readonly now?: () => number;
  readonly tokenFactory?: () => string;
}

export interface NormalizedProviderIndexStoreConfig {
  readonly stageLeaseMs: number;
  readonly maxTasksPerGeneration: number;
  readonly maxTurnsPerGeneration: number;
  readonly maxEventsPerTask: number;
  readonly maxEventsPerGeneration: number;
  readonly maxMetadataDepth: number;
  /** Fixed internal safety reserve; not caller-configurable through ProviderIndexStoreOptions. */
  readonly maxEventJsonBytesPerTask: number;
  readonly now: () => number;
  readonly tokenFactory: () => string;
}

export interface ProviderIndexCompletion {
  readonly completedAt: number;
  readonly providerVersion: string | null;
  readonly taskCount: number;
  readonly turnCount: number;
  readonly eventCount: number;
  readonly snapshotCount: number;
  readonly receiptCount: number;
}

export interface ProviderHomeScope {
  readonly provider: ProviderId;
  readonly homeFingerprint: string;
}

export interface ProviderHomeRegistration extends ProviderHomeScope {
  readonly registeredAt: number;
}

export interface ProviderIndexPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** Null fingerprint selects every home for the required provider. */
export interface ProviderIndexScope {
  readonly provider: ProviderId;
  readonly homeFingerprint: string | null;
}

export interface ProviderCacheClearResult {
  readonly taskCount: number;
  readonly turnCount: number;
  readonly eventCount: number;
  readonly receiptCount: number;
}

export type ProviderMetadataJson =
  | null
  | boolean
  | number
  | string
  | readonly ProviderMetadataJson[]
  | ProviderMetadataObject;

export interface ProviderMetadataObject {
  readonly [key: string]: ProviderMetadataJson;
}

export interface ProviderTaskMeta {
  readonly locator: ProviderTaskLocator;
  readonly favorite: boolean;
  readonly pinned: boolean;
  readonly localLabel: string | null;
  readonly tags: readonly string[];
  readonly notes: string | null;
  readonly localArchived: boolean;
  readonly uiState: ProviderMetadataObject;
  readonly unsupportedLocal: ProviderMetadataObject;
  readonly updatedAt: number | null;
}

export interface ProviderTaskMetaPatch {
  readonly favorite?: boolean;
  readonly pinned?: boolean;
  readonly localLabel?: string | null;
  readonly tags?: readonly string[];
  readonly notes?: string | null;
  readonly localArchived?: boolean;
  readonly uiState?: ProviderMetadataObject;
  readonly unsupportedLocal?: ProviderMetadataObject;
}

export interface ProviderForkLink {
  readonly source: ProviderTaskLocator;
  readonly target: ProviderTaskLocator;
  readonly createdAt: number;
  readonly transferDigest: string;
}

export type LegacySessionProvenance =
  | "imported"
  | "missing"
  | "ambiguous"
  | "foreign-machine"
  | "archive-v1-import";

export interface VerifiedLegacyMapping {
  readonly mappingSource: "live-provider-observation";
  readonly verifiedAt: number;
}

export type ProviderReconciliationReason =
  | "REPLAY_CONFLICT"
  | "NATIVE_REVISION_MISMATCH"
  | "NATIVE_TASK_MISSING"
  | "WRITER_LEASE_LOST"
  | "MUTATION_OUTCOME_UNCERTAIN"
  | "PROCESS_GENERATION_CHANGED"
  | "NATIVE_STATE_INVALID";

export interface ReconciliationLatchInput {
  readonly reviewedFingerprint: string | null;
  readonly nativeFingerprint: string | null;
  readonly writerEpoch: number;
  readonly reason: ProviderReconciliationReason;
}

export interface ProviderReconciliationState {
  readonly locator: ProviderTaskLocator;
  readonly required: boolean;
  readonly latchRevision: number;
  readonly reviewedFingerprint: string | null;
  readonly nativeFingerprint: string | null;
  readonly writerEpoch: number;
  readonly reason: ProviderReconciliationReason | null;
  readonly updatedAt: number | null;
}

export interface ProviderReconciliationStore {
  getReconciliation(locator: ProviderTaskLocator): ProviderReconciliationState;
  requireReconciliation(
    locator: ProviderTaskLocator,
    input: ReconciliationLatchInput,
  ): ProviderReconciliationState;
  acknowledgeReconciliation(
    locator: ProviderTaskLocator,
    expectedLatchRevision: number,
    reviewedFingerprint: string | null,
    observedNativeFingerprint: string | null,
  ): ProviderReconciliationState;
}

export interface ProviderIndexRegisteredHome extends ProviderHomeScope {
  readonly canonicalHome: string;
}

export interface IndexedProviderTaskSummary {
  readonly locator: ProviderTaskLocator;
  readonly title: string;
  readonly cwd: string | null;
  readonly cwdRedacted: boolean;
  readonly model: string | null;
  readonly status: string;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly archived: boolean | null;
  readonly source: NativeTaskSource;
  readonly revision: Readonly<NativeRevision> | null;
  readonly cacheDetail: "summary" | "snapshot";
  readonly cacheGeneration: number;
  readonly observedAt: number;
}

export interface IndexedProviderTurn {
  readonly id: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly ordinal: number;
  readonly events: readonly IndexedProviderEvent[];
}

export interface IndexedProviderTask extends IndexedProviderTaskSummary {
  readonly turns: readonly IndexedProviderTurn[];
}

export interface ProviderIndexStage extends ProviderHomeScope {
  readonly generation: number;
  readonly ownerToken: string;
}

export interface ProviderIndexPromotion extends ProviderHomeScope {
  readonly previousGeneration: number;
  readonly activeGeneration: number;
  readonly completedAt: number;
  readonly taskCount: number;
  readonly turnCount: number;
  readonly eventCount: number;
  readonly snapshotCount: number;
}

export interface PreparedProviderTaskSummary {
  readonly locator: ProviderTaskLocator;
  readonly title: string;
  readonly cwd: string | null;
  readonly cwdRedacted: boolean;
  readonly model: string | null;
  readonly status: string;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly archived: boolean | null;
  readonly source: NativeTaskSource;
  readonly revision: Readonly<NativeRevision> | null;
}

export interface PreparedProviderEvent {
  readonly nativeTurnKey: string;
  readonly nativeItemKey: string;
  readonly replayKey: string;
  readonly ordinal: number;
  readonly eventFingerprint: string;
  readonly eventJson: string;
  readonly event: IndexedProviderEvent;
}

export interface PreparedProviderTurn {
  readonly nativeTurnKey: string;
  readonly id: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly ordinal: number;
  readonly events: readonly PreparedProviderEvent[];
}

export interface PreparedProviderTaskSnapshot extends PreparedProviderTaskSummary {
  readonly turns: readonly PreparedProviderTurn[];
  readonly eventCount: number;
  readonly snapshotFingerprint: string;
  readonly receiptKey: string;
}

export interface ProviderEventCacheRow {
  readonly provider: unknown;
  readonly home_fingerprint: unknown;
  readonly native_task_id: unknown;
  readonly native_turn_key: unknown;
  readonly native_item_key: unknown;
  readonly replay_key: unknown;
  readonly ordinal: unknown;
  readonly event_fingerprint: unknown;
  readonly event_json: unknown;
}
