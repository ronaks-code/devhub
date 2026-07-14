# M5 Unified Provider Task/Index Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: use subagent-driven-development. Execute one task at a time with test-first implementation, specification review, then code-quality review. Do not combine the two review stages.

**Goal:** Give DevHub one collision-proof, provider-locked task index whose transcript data is explicitly rebuildable cache, whose local metadata is additive only, and whose rollout can be disabled without changing either provider's native sessions.

**Architecture:** Keep `NativeTaskKey` as the runtime authority because adapters and writer leases need the canonical provider home, but derive a versioned path-free `ProviderTaskLocator` for public persistence, URLs, and browser storage. A backend-only provider-home registry resolves those locators without exposing paths to the browser. Add an additive SQLite v14 cache/meta/synchronization schema and a `ProviderTaskIndexStore` on the existing engine connection. A server-side index coordinator stages and promotes complete provider censuses, observes provider reads, rebuilds from provider APIs, and guards existing-task mutations with the already-proven writer lease plus exact native revision rereads. `unifiedTaskIndex` chooses the new read path; the existing provider routes remain the rollback path. Provider transcript/event rows never enter the portable authority bundle and can be deleted/rebuilt without touching native data.

**Tech stack:** TypeScript, Node 24 `node:sqlite`, Fastify, React 19, Vitest 2, existing provider adapters/registry, existing `NativeTaskWriterLeaseStore`.

**Operating constraints:** Work from a detached worktree rooted at the reviewed planning commit and cherry-pick tested commits onto `campaign/auto-improve`; do not create a milestone branch. Never touch the four user-owned paths listed in `tasks/todo.md`. No Python. Use at most two Vitest workers. Queue full package/repository gates through `/Users/ronak/.codex/bin/ronak-codex-heavy-queue` with `RONAK_CODEX_CHAT=devhub`; targeted tests do not take the heavy slot.

---

## Frozen decisions and invariants

1. Native provider storage remains authoritative. No M5 code writes, edits, deletes, or fabricates provider transcript files.
2. A runtime key is `(provider, canonicalHome, nativeTaskId)`. A public persisted locator is `(provider, homeFingerprint, nativeTaskId)` and never contains the raw home path. The backend may retain the canonical home only in `provider_homes` so it can resolve the fingerprint for real provider calls; raw homes never enter new browser responses, URLs, cache identities, or portable v2.
3. Turn and event cache keys extend the locator with `nativeTurnId`, `nativeItemId`, and a stable replay key. An event without a provider item ID receives a deterministic `synthetic:v1:<ordinal>:<digest>` item ID. Multiple deltas/events for the same real native item remain distinct through `replayKey`; exact replay of the same normalized event is a no-op, while the same replay key with a different fingerprint latches reconciliation and refuses overwrite.
4. Replay is transactional replacement for one exact task snapshot. Replaying the same snapshot is byte-for-byte/id-count idempotent; a changed snapshot removes stale child rows before inserting current rows.
5. `provider_task_cache`, `provider_turn_cache`, `provider_event_cache`, and replay receipts are rebuildable cache. `provider_task_meta`, `provider_fork_links`, verified legacy mappings/provenance, and durable reconciliation latches are DevHub-owned state and are never cascade-deleted with cache invalidation.
6. Additive provider metadata is limited to favorite/pinned, local label, tags, notes, local-only archive state, provider-fork links, bounded UI state, and bounded explicitly-local unsupported metadata. Every such field is named as local state and cannot shadow provider title/status/model/native archive state.
7. Existing-task writes require: acquire the task writer lease, reread native state, compare the exact reviewed revision, confirm the lease reread, start the fenced mutation, invalidate/reread the cache, then release. Any mismatch or uncertain outcome fails closed with reconciliation required.
8. The already-reviewed Claude adapter remains the reference lease/revision implementation. M5 must not weaken, duplicate, or wrap it with a second competing lease. Codex receives equivalent adapter-level ownership/fencing.
9. The v14 migration is additive and idempotent. Rollback means an older build can ignore the new tables and continue using legacy routes/settings; it does not mean destructive down-migration.
10. Legacy `sessionId` rows are never guessed into a provider/home. Only an authoritative one-to-one provider observation creates `legacy_session_task_map`; imported, missing, ambiguous, or foreign-machine rows remain explicitly unresolved in `legacy_session_provenance`.
11. Compatibility reads legacy `claude-ui` URL/storage/env/archive/webhook identifiers and writes the DevHub form. The legacy default data directory is retained until the M8 cutover migrates it safely.
12. `nativeCodex` and `persistentClaude` remain false because their raw live gates are separately blocked. `unifiedTaskIndex` may become available/default-on only after every M5 migration, rebuild, rollback, lease, and compatibility gate passes.

## Task 1: Versioned provider locator and event identity

**Files**

- Create `packages/engine/src/provider-index/identity.ts`
- Create `packages/engine/test/provider-index/identity.test.ts`
- Modify `packages/engine/src/providers/index.ts`

**Contract**

```ts
export interface ProviderTaskLocator {
  readonly version: 1;
  readonly provider: ProviderId;
  readonly homeFingerprint: string;
  readonly nativeTaskId: string;
}

export function homeFingerprint(provider: ProviderId, canonicalHome: string): string;
export function taskLocator(key: NativeTaskKey): Readonly<ProviderTaskLocator>;
export function serializeTaskLocator(locator: ProviderTaskLocator): string;
export function parseTaskLocator(value: string): Readonly<ProviderTaskLocator>;
export function assertLocatorMatchesKey(locator: ProviderTaskLocator, key: NativeTaskKey): void;
export function cachedTurnKey(nativeTurnId: string | null): string;
export function cachedEventItemId(event: ProviderEvent, ordinal: number): string;
export function providerEventReplayKey(event: ProviderEvent, ordinal: number): string;
export function projectIndexedProviderEvent(event: ProviderEvent): IndexedProviderEvent;
```

- Fingerprint input is exactly `devhub-home:v1\0<provider>\0<canonicalHome>` and output is lowercase SHA-256 hex.
- Serialization is a stable `pt1.` envelope with base64url components; it is bounded, reversible for provider/native task ID, strict about canonical encodings, and contains neither the home path nor NUL bytes.
- Provider IDs, fingerprints, native IDs, ordinals, sizes, Unicode, malformed base64url, extra components, and prototype/throwing inputs fail closed.
- `IndexedProviderEvent` replaces every nested `NativeTaskKey`/request identity with the path-free locator form before JSON persistence or browser serialization; it is impossible for `event_json` to retain `key.home`.
- Every nullable native turn/item identity receives a tagged non-null encoding: `native:v1:<canonical-base64url>` for a supplied ID and `none:v1` or `synthetic:v1:<ordinal>:<digest>` for absence. No SQLite key column is nullable, so SQLite's multiple-`NULL` uniqueness behavior cannot admit duplicates.
- Synthetic event IDs and replay keys hash that canonical projected event, including provider/task/turn/item/request identity, occurredAt, event type, normalized content, and ordinal. Actual item IDs never substitute for replay keys because one item may emit multiple deltas.

**TDD gate**

1. Write tests for provider isolation, realpath/symlink equivalence, stability across restarts, path non-disclosure, native-ID round trip, malformed encodings, and actual-vs-synthetic item IDs.
2. Run `pnpm --filter @devhub/engine exec vitest run test/provider-index/identity.test.ts --maxWorkers=2` and observe red.
3. Implement only the contract above; rerun to green.
4. Run engine typecheck and `git diff --check`.

## Task 2: Additive v14 schema and store primitives

**Files**

- Modify `packages/engine/src/migrations.ts`
- Modify `packages/engine/src/index-db.ts`
- Modify `packages/engine/src/provider-index/identity.ts`
- Create `packages/engine/src/provider-index/schema.ts`
- Create `packages/engine/src/provider-index/store.ts`
- Create `packages/engine/src/provider-index/store-types.ts`
- Create `packages/engine/src/provider-index/store-codec.ts`
- Create `packages/engine/src/provider-index/cursor.ts`
- Create `packages/engine/test/provider-index/migration.test.ts`
- Create `packages/engine/test/provider-index/store.test.ts`
- Create `packages/engine/test/provider-index/cursor.test.ts`

**Schema**

```sql
provider_homes(
  provider, home_fingerprint, canonical_home, registered_at,
  PRIMARY KEY(provider, home_fingerprint),
  UNIQUE(provider, canonical_home)
)
provider_sync_state(
  provider, home_fingerprint, active_generation, staging_generation,
  staging_owner_token, staging_heartbeat_at, staging_expires_at,
  state, provider_version, last_completed_at,
  PRIMARY KEY(provider, home_fingerprint)
)
provider_task_cache(
  provider, home_fingerprint, native_task_id,
  title, cwd, cwd_redacted, model, status, created_at, updated_at, archived, source,
  revision_updated_at, revision_status, revision_last_turn_id,
  revision_last_turn_status, revision_last_item_id, revision_fingerprint,
  cache_generation, observed_at,
  PRIMARY KEY(provider, home_fingerprint, native_task_id, cache_generation)
)
provider_turn_cache(
  provider, home_fingerprint, native_task_id, cache_generation, native_turn_key,
  status, started_at, completed_at, ordinal,
  PRIMARY KEY(provider, home_fingerprint, native_task_id, cache_generation, native_turn_key)
)
provider_event_cache(
  provider, home_fingerprint, native_task_id, cache_generation,
  native_turn_key, native_item_key,
  replay_key, ordinal, event_fingerprint, event_json,
  PRIMARY KEY(provider, home_fingerprint, native_task_id, cache_generation,
              native_turn_key, native_item_key, replay_key)
)
provider_replay_receipts(
  provider, home_fingerprint, native_task_id, cache_generation, replay_key,
  snapshot_fingerprint, event_count, observed_at,
  PRIMARY KEY(provider, home_fingerprint, native_task_id, cache_generation, replay_key)
)
provider_task_meta(
  provider, home_fingerprint, native_task_id,
  favorite, pinned, local_label, tags_json, notes, local_archived,
  ui_state_json, unsupported_local_json, updated_at,
  PRIMARY KEY(provider, home_fingerprint, native_task_id)
)
provider_fork_links(
  source_provider, source_home_fingerprint, source_native_task_id,
  target_provider, target_home_fingerprint, target_native_task_id,
  created_at, transfer_digest,
  PRIMARY KEY(source_provider, source_home_fingerprint, source_native_task_id,
              target_provider, target_home_fingerprint, target_native_task_id)
)
legacy_session_task_map(
  legacy_session_id PRIMARY KEY,
  provider, home_fingerprint, native_task_id,
  mapping_source, verified_at,
  UNIQUE(provider, home_fingerprint, native_task_id)
)
legacy_session_provenance(
  legacy_session_id PRIMARY KEY,
  provenance, observed_at
)
provider_reconciliation_state(
  provider, home_fingerprint, native_task_id,
  required, latch_revision, reviewed_fingerprint, native_fingerprint,
  writer_epoch, reason, updated_at,
  PRIMARY KEY(provider, home_fingerprint, native_task_id)
)
```

- `provider_homes` is backend-only; only its fingerprint crosses the new HTTP/browser/archive boundary. Deleting a registered home is explicit and `RESTRICT`ed while scoped state exists.
- Every cache/turn/event/receipt primary and foreign key includes `cache_generation`. Sync state permits only one token-owned staging generation with a bounded heartbeat/expiry and promotes it to active in one transaction after a complete census. Reads join only `provider_sync_state.active_generation`; an interrupted staging generation is never visible.
- Child cache tables use generation-inclusive composite foreign keys with `ON DELETE CASCADE` only to the exact `provider_task_cache` generation; replay receipts are cache and clear with that exact generation.
- Add generation-inclusive unique indexes for `(task locator, cache_generation, turn ordinal)`, `(task locator, cache_generation, event ordinal)`, and `(task locator, cache_generation)` on replay receipts. They make turn/event ordinals unique within one task snapshot and permit at most one receipt per fully snapshotted task; promotion additionally proves contiguity and per-receipt counts.
- Metadata/fork/reconciliation/legacy tables intentionally have no cascading cache foreign key.
- Constraints enforce known providers, 64-character lowercase fingerprints, nonempty bounded IDs, boolean favorite, nonnegative safe timestamps/generations, valid nullable archive encoding, and bounded JSON text.
- Fresh schema and v13-to-v14 migration create the same shape. Migration runs in the existing per-version transaction and never rewrites legacy tables.
- Existing rows are not auto-mapped during migration. Correct mapping requires live provider/home evidence; v1 imports are recorded as unresolved provenance.

**Frozen store-boundary decisions**

- Every fully snapshotted task has exactly one receipt in its exact cache generation; a summary-only task has none. Turn ordinals are exactly `0..turnCount-1`. Event ordinals are exactly `0..eventCount-1` and global across the task: preserve native turn order, then event order within each turn. `event_fingerprint` is lowercase SHA-256 of `devhub-provider-event-cache:v1\0<replay_key>\0<canonical persisted-event JSON>`; including the injective replay key keeps readable-redaction collisions distinct while remaining path-free.
- `snapshot_fingerprint` is lowercase SHA-256 of `devhub-provider-snapshot:v1\0<canonical fixed-array payload>`. That payload is exactly `[1, serializedLocator, summary, turns]`, where `serializedLocator` is `serializeTaskLocator(locator)`. `summary` is `[title,persistedCwd,cwdRedacted,model,status,createdAt,updatedAt,archived,source,revision]`; `revision` is either `null` or `[updatedAt,status,lastTurnId,lastTurnStatus,lastItemId,fingerprint]`. Each turn is `[nativeTurnKey,status,startedAt,completedAt,turnOrdinal,events]`. Each event is `[globalOrdinal,nativeItemKey,replayKey,eventFingerprint,canonicalPersistedEventJson]`. Cache generation, observed/registered times, receipt key, local metadata, the raw registered provider-home value, and every home-contained cwd value are excluded; an allowed canonical project cwd outside that home remains `persistedCwd`. The replay key supplies the private injective distinction between literal redaction-marker content and provider-home content; add a fixed golden proving those snapshots hash differently.
- The receipt `replay_key` is `snapshot:v1:<digest>`, where the digest hashes `devhub-provider-snapshot-revision:v1\0<serialized locator>\0<revision basis>` as exact UTF-8. Source, not optional-field presence, chooses the basis. A `native` snapshot requires a validated revision and uses exactly `native:<revision.fingerprint>`; a missing/invalid revision fails `INVALID_INPUT` without writes. `legacy-history` and `degraded-fallback` always use exactly `fallback:<snapshot_fingerprint>`, even if an optional revision object is present, and therefore never claim same-native-revision conflict. Reusing one receipt key with a different snapshot fingerprint atomically aborts the stage and increments the durable reconciliation latch; a changed receipt key transactionally replaces stale children and the prior receipt.
- `promoteStage` takes an exact completion claim `{completedAt,providerVersion,taskCount,turnCount,eventCount,snapshotCount,receiptCount}`. In the ownership transaction it verifies the unexpired stage and all five SQL counts against the configured bounds: total tasks, turns, events, distinct receipt-owning tasks, and total receipts. It requires `0 <= snapshotCount <= taskCount`, `receiptCount === snapshotCount`, exactly one receipt for every snapshotted task, each receipt's `event_count` to equal that task's exact event-row count, contiguous turn/event ordinals, and no turn/event rows for summary-only tasks before switching the active generation. The verified call is the completion marker; a crash before commit leaves staging invisible, and a crash after commit leaves the complete generation active.
- `store-codec.ts` decodes persisted JSON only to `IndexedProviderEvent`; it never reconstructs a native `ProviderEvent`, and `identity.ts` remains the sole native projection/key owner. Slice 1 therefore extracts/exports `canonicalProviderIndexJson`, `parseCachedTurnKey`, `parseCachedEventItemKey`, `parseProviderEventReplayKey`, `indexedProviderEventItemId`, and `indexedProviderEventTurnId`; these reuse the existing recursive sorted-key canonical JSON and key/projection semantics. Store-codec consumes them rather than duplicating formats. A turn row must decode to a non-null canonical native turn ID. Every event's provider/locator and non-null turn ID must match its containing task/turn row. The codec validates exact union fields, canonical JSON/UTF-8, native item ownership where readable, synthetic/replay tag plus ordinal prefixes, and recomputes `event_fingerprint` from the opaque replay key plus canonical persisted event. Opaque digest suffixes are bound through the snapshot fingerprint rather than reverse-engineered from readable redaction. Any row/JSON/key/fingerprint/ordinal mismatch fails the entire read with value-free `CORRUPT_ROW`.
- A task `cwd` that equals or descends from the registered provider home is replaced with `NULL` before cache persistence and sets `cwd_redacted=1`; an originally-null cwd stores `cwd_redacted=0`. No second copy of the canonical provider home exists outside `provider_homes`. Other canonical project cwd values remain backend cache data and may be returned under the existing authenticated policy. Snapshot fingerprint input uses `(persistedCwd,cwdRedacted)`, never the raw provider home.
- Every summary/snapshot write proves the method key, payload key, stage scope, resolved registered home, nested event/request locators, and provider all describe the same native task before opening a transaction. A non-null cwd must be bounded, absolute, NUL-free, and is canonicalized by resolving the deepest existing ancestor with `realpath` before reattaching any missing suffix. Containment uses `path.relative` component boundaries, never string-prefix matching: equal/child/root-home and missing descendants through symlinks redact; prefix siblings do not. Any mismatch fails `INVALID_INPUT` without writes, while persisted/readback ownership mismatch fails `CORRUPT_ROW`.
- The default stage lease is `30_000 ms`, configurable only within `1_000..300_000 ms`. Default/hard maxima are: tasks per generation `100_000/1_000_000`, turns per generation `1_000_000/2_000_000`, events per task `100_000/1_000_000`, events per generation `5_000_000/10_000_000`, and metadata depth `16/32`. The constructor snapshots exact own data options and type-checks injected clock/token functions without invoking them. Each public operation captures the clock at most once and the token factory only for `beginStage`, exactly once, before opening a transaction; no callback runs inside SQL. Reentrant mutation from either callback fails with its corresponding value-free `CLOCK_FAILURE`/`TOKEN_FAILURE`. The captured clock must be a nonnegative safe integer and `now + stageLeaseMs` must remain safe or the operation fails `CLOCK_FAILURE` without writes; tokens are canonical bounded nonempty text. That clock is the sole source for stage heartbeat/expiry and staged-row `observed_at`; callers cannot supply or extend lease time.
- `ProviderTaskIndexStore` shares the existing `DatabaseSync` connection. Cache, stage, lease, replay, and reconciliation mutations require ownership of a top-level `BEGIN IMMEDIATE`; they reject a caller-owned outer transaction before changing state. Replay conflict commits the stage abort plus reconciliation latch, then throws only after that commit. Metadata/fork/legacy-import helpers may use a uniquely named `SAVEPOINT` inside the caller's transaction because they have no committed-failure path. Every error is a stable, path/value-free `ProviderIndexStoreError`; parsed cursor positions are attacker-controlled query inputs, never authority, and are used only through parameterized scope-constrained SQL.
- Store error codes are exactly `INVALID_INPUT`, `CORRUPT_ROW`, `DATABASE_UNAVAILABLE`, `CLOCK_FAILURE`, `TOKEN_FAILURE`, `CAPACITY`, `UNKNOWN_HOME`, `HOME_CONFLICT`, `STAGE_BUSY`, `STAGE_LOST`, `STAGE_EXPIRED`, `STAGE_INCOMPLETE`, `REPLAY_CONFLICT`, `FORK_CONFLICT`, `LEGACY_MAPPING_CONFLICT`, and `RECONCILIATION_CAS_MISMATCH`. SQLite/provider/token/clock exception text is never reflected.

**Store API**

```ts
type ParsedCachedEventItemKey =
  | Readonly<{ kind: "native"; nativeItemId: string }>
  | Readonly<{ kind: "synthetic"; nativeItemId: null }>;

function canonicalProviderIndexJson(value: unknown): string;
function parseCachedTurnKey(value: unknown): string | null;
function parseCachedEventItemKey(
  value: unknown,
  expectedOrdinal: number,
): ParsedCachedEventItemKey;
function parseProviderEventReplayKey(value: unknown, expectedOrdinal: number): string;
function indexedProviderEventItemId(event: IndexedProviderEvent): string | null;
function indexedProviderEventTurnId(event: IndexedProviderEvent): string | null;

interface ProviderIndexStoreOptions {
  readonly stageLeaseMs?: number;
  readonly maxTasksPerGeneration?: number;
  readonly maxTurnsPerGeneration?: number;
  readonly maxEventsPerTask?: number;
  readonly maxEventsPerGeneration?: number;
  readonly maxMetadataDepth?: number;
  readonly now?: () => number;
  readonly tokenFactory?: () => string;
}

interface ProviderIndexCompletion {
  readonly completedAt: number;
  readonly providerVersion: string | null;
  readonly taskCount: number;
  readonly turnCount: number;
  readonly eventCount: number;
  readonly snapshotCount: number;
  readonly receiptCount: number;
}

interface ProviderHomeScope {
  readonly provider: ProviderId;
  readonly homeFingerprint: string;
}

interface ProviderHomeRegistration extends ProviderHomeScope {
  readonly registeredAt: number;
}

interface ProviderIndexPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

// Omitted clear scope means every provider; null fingerprint means every home
// for the required provider.
interface ProviderIndexScope {
  readonly provider: ProviderId;
  readonly homeFingerprint: string | null;
}

interface ProviderCacheClearResult {
  readonly taskCount: number;
  readonly turnCount: number;
  readonly eventCount: number;
  readonly receiptCount: number;
}

type ProviderMetadataJson =
  | null | boolean | number | string
  | readonly ProviderMetadataJson[]
  | ProviderMetadataObject;

interface ProviderMetadataObject {
  readonly [key: string]: ProviderMetadataJson;
}

interface ProviderTaskMeta {
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

interface ProviderTaskMetaPatch {
  readonly favorite?: boolean;
  readonly pinned?: boolean;
  readonly localLabel?: string | null;
  readonly tags?: readonly string[];
  readonly notes?: string | null;
  readonly localArchived?: boolean;
  readonly uiState?: ProviderMetadataObject;
  readonly unsupportedLocal?: ProviderMetadataObject;
}

interface ProviderForkLink {
  readonly source: ProviderTaskLocator;
  readonly target: ProviderTaskLocator;
  readonly createdAt: number;
  readonly transferDigest: string;
}

type LegacySessionProvenance =
  | "imported"
  | "missing"
  | "ambiguous"
  | "foreign-machine"
  | "archive-v1-import";

interface VerifiedLegacyMapping {
  readonly mappingSource: "live-provider-observation";
  readonly verifiedAt: number;
}

type ProviderReconciliationReason =
  | "REPLAY_CONFLICT"
  | "NATIVE_REVISION_MISMATCH"
  | "NATIVE_TASK_MISSING"
  | "WRITER_LEASE_LOST"
  | "MUTATION_OUTCOME_UNCERTAIN"
  | "PROCESS_GENERATION_CHANGED"
  | "NATIVE_STATE_INVALID";

interface ReconciliationLatchInput {
  readonly reviewedFingerprint: string | null;
  readonly nativeFingerprint: string | null;
  readonly writerEpoch: number;
  readonly reason: ProviderReconciliationReason;
}

interface ProviderReconciliationState {
  readonly locator: ProviderTaskLocator;
  readonly required: boolean;
  readonly latchRevision: number;
  readonly reviewedFingerprint: string | null;
  readonly nativeFingerprint: string | null;
  readonly writerEpoch: number;
  readonly reason: ProviderReconciliationReason | null;
  readonly updatedAt: number | null;
}

interface IndexedProviderTaskSummary {
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

interface IndexedProviderTurn {
  readonly id: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly ordinal: number;
  readonly events: readonly IndexedProviderEvent[];
}

interface IndexedProviderTask extends IndexedProviderTaskSummary {
  readonly turns: readonly IndexedProviderTurn[];
}

interface ProviderIndexStage extends ProviderHomeScope {
  readonly generation: number;
  readonly ownerToken: string;
}

interface ProviderIndexPromotion extends ProviderHomeScope {
  readonly previousGeneration: number;
  readonly activeGeneration: number;
  readonly completedAt: number;
  readonly taskCount: number;
  readonly turnCount: number;
  readonly eventCount: number;
  readonly snapshotCount: number;
}

type ProviderIndexStoreErrorCode =
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

class ProviderIndexStoreError extends Error {
  readonly code: ProviderIndexStoreErrorCode;
}

class ProviderTaskIndexStore {
  constructor(db: DatabaseSync, options?: ProviderIndexStoreOptions);
  registerHome(key: Pick<NativeTaskKey, "provider" | "home">, registeredAt: number): ProviderHomeRegistration;
  resolveHome(provider: ProviderId, homeFingerprint: string): string | null;
  beginStage(scope: ProviderHomeScope): ProviderIndexStage;
  heartbeatStage(stage: ProviderIndexStage): boolean;
  stageSummary(stage: ProviderIndexStage, key: NativeTaskKey, summary: NativeTaskSummary): void;
  stageSnapshot(stage: ProviderIndexStage, key: NativeTaskKey, task: NativeTask): void;
  promoteStage(stage: ProviderIndexStage, completion: ProviderIndexCompletion): ProviderIndexPromotion;
  abortStage(stage: ProviderIndexStage): void;
  replaceActiveSummary(key: NativeTaskKey, summary: NativeTaskSummary, observedAt: number): IndexedProviderTaskSummary | null;
  replaceActiveSnapshot(key: NativeTaskKey, task: NativeTask, observedAt: number): IndexedProviderTask | null;
  list(options: ProviderIndexListOptions): ProviderIndexPage<IndexedProviderTaskSummary>;
  read(locator: ProviderTaskLocator): IndexedProviderTask | null;
  invalidate(locator: ProviderTaskLocator): boolean;
  clearRebuildableCache(scope?: ProviderIndexScope): ProviderCacheClearResult;
  getMeta(locator: ProviderTaskLocator): ProviderTaskMeta;
  patchMeta(locator: ProviderTaskLocator, patch: ProviderTaskMetaPatch): ProviderTaskMeta;
  linkFork(source: ProviderTaskLocator, target: ProviderTaskLocator, digest: string, createdAt: number): ProviderForkLink;
  listForkLinks(locator: ProviderTaskLocator): readonly ProviderForkLink[];
  classifyLegacySession(sessionId: string, provenance: LegacySessionProvenance, observedAt: number): void;
  mapVerifiedLegacySession(sessionId: string, locator: ProviderTaskLocator, evidence: VerifiedLegacyMapping): void;
  getReconciliation(locator: ProviderTaskLocator): ProviderReconciliationState;
  requireReconciliation(locator: ProviderTaskLocator, input: ReconciliationLatchInput): ProviderReconciliationState;
  acknowledgeReconciliation(
    locator: ProviderTaskLocator,
    expectedLatchRevision: number,
    reviewedFingerprint: string | null,
    observedNativeFingerprint: string | null,
  ): ProviderReconciliationState;
}
```

- Slice 1 is the pure identity/config/snapshot-codec slice: it implements only the six identity helpers, frozen store types/config/error normalization, path-safe summary/snapshot preparation, and strict persisted-event decoding. It does not open SQLite or invent later store types beyond the declarations above. The four parser/canonicalization failures use fixed value-free `TypeError` messages: `provider index canonical JSON is invalid`, `cached turn key is invalid`, `cached event item key is invalid`, and `provider event replay key is invalid`.
- `registerHome` never returns `canonicalHome`. Re-registering the same derived provider/fingerprint/home is idempotent and returns the stored `registeredAt`; any fingerprint/home uniqueness disagreement fails `HOME_CONFLICT`. All locators remain usable as orphan metadata identities after home removal.
- Omitted `clearRebuildableCache` scope means every provider; an explicit scope requires a provider and uses `homeFingerprint:null` for all its homes. Clear returns exact deleted task/turn/event/receipt counts, resets active/staging sync visibility in scope, and preserves registered homes plus every metadata/fork/legacy/reconciliation row.
- `getMeta` returns a recursively frozen synthesized default `{favorite:false,pinned:false,localLabel:null,tags:[],notes:null,localArchived:false,uiState:{},unsupportedLocal:{},updatedAt:null}` without inserting. Patch requires at least one own field, rejects own `undefined`/accessors/extras/exotic prototypes, replaces rather than deep-merges supplied arrays/objects, and uses the injected clock. Tags are dense, unique, ordered, nonempty bounded strings. Metadata JSON is finite/prototype-safe, recursively frozen, root-record-only for `uiState`/`unsupportedLocal`, at most 32 aggregate record keys across the full graph, and at most 64 KiB canonical UTF-8 per JSON column.
- Fork links allow orphan and cross-provider locators, reject exact self-links, and require a lowercase 64-hex digest plus safe timestamp. Same endpoints plus identical row are idempotent; differing digest/time fails `FORK_CONFLICT`. Listing returns both incoming and outgoing links ordered exactly by `createdAt ASC`, serialized source locator ASC, then serialized target locator ASC.
- Unresolved legacy provenance is the exact value-free enum above and never creates, deletes, or overwrites a verified map. First classification is immutable: exact replay is idempotent and a different classification fails `LEGACY_MAPPING_CONFLICT`. The Task 3 coordinator, not the SQLite store, owns authoritative native observation and may call `mapVerifiedLegacySession` only after proving a currently registered one-to-one live match; `VerifiedLegacyMapping` records that attestation, while the store validates its exact shape, registration, and uniqueness. Exact session-to-locator replay is idempotent; either-side remap fails `LEGACY_MAPPING_CONFLICT`. Mapping/provenance may coexist as history and survive cache/home lifecycle; only the verified map is lookup authority.
- Absent reconciliation returns a frozen default with `required:false`, revision/epoch `0`, and null fingerprints/reason/updatedAt. Every require is one upsert that increments `latchRevision` even for identical input, uses the injected time, rejects overflow as `CAPACITY`, and returns the exact committed state/CAS token. Ack accepts nullable reviewed/native fingerprints so an authoritative deletion or invalid-state observation can be resolved; it succeeds only when required plus expected revision and both nullable fingerprints exactly match. Success sets `required:false`, clears `reason`, preserves the same latch revision/writer epoch and exact fingerprints, updates `updatedAt` once, and returns that committed row. Any newer same-value relatch fails `RECONCILIATION_CAS_MISMATCH`. Reconciliation survives every cache clear.
- `stageSnapshot` validates exact stage ownership, projects all nested keys to locators, normalizes browser-safe JSON, and writes only the staging generation. Equal replay key/equal fingerprint is a no-op; equal replay key/different fingerprint aborts the stage and durably latches reconciliation.
- `beginStage` is an atomic recovery boundary. With no stage it allocates a strictly newer generation and random owner token. With an unexpired foreign stage it returns `STAGE_BUSY`. With an expired non-active stage it deletes only that abandoned generation, clears its token, and allocates the successor in the same transaction. Every stage write/heartbeat verifies token+generation and monotonically extends the bounded expiry; a lost/expired token aborts the coordinator.
- `promoteStage` verifies the unexpired stage token, scope, exact completion counts, provider version, and row bounds, then changes `active_generation` in one transaction before retiring older generations. `abortStage` deletes only the exact token-owned unpromoted generation. `list`/`read` never query staging rows.
- `replaceActiveSnapshot` is permitted only when that home already has a complete active generation; it atomically replaces one task inside that generation after an authoritative point read. Before first full promotion it returns `null` and exposes no partial cache.
- `replaceActiveSummary` has the same active-generation prerequisite and atomically upserts only task-summary columns while preserving every existing turn/event/receipt child. It returns `null` before the first complete promotion.
- Every call to `requireReconciliation` atomically increments a bounded monotonic `latch_revision`, even when the native fingerprint/reason is unchanged. `acknowledgeReconciliation` is an atomic compare-and-swap: the row must still be required and match the exact expected latch revision plus native/reviewed fingerprints. It never clears a newer same-fingerprint relatch.
- `list` enforces limit `1..200`, the Task 5 stable order/scope, and the canonical size-bounded `pi1.` cursor in SQL; it never loads the full table and paginates in memory.
- Metadata JSON is schema-checked, prototype-safe, at most 32 keys/64 KiB, and contains only JSON primitives/arrays/records.
- `list` labels each row `cacheDetail:"summary"|"snapshot"` from the unique receipt. `read` may return a summary-only task with `turns:[]` and `cacheDetail:"summary"`; that never claims an empty native transcript. Coordinator/full-task reads treat summary-only as a cache miss and reread natively. Only an explicitly degraded summary projection may consume it without a native read.
- All returned values are immutable snapshots.

**TDD gate**

- Prove v13 upgrade, fresh v14 equivalence, rerun idempotency, rollback on injected DDL failure, unchanged v13 bytes/rows, provider/home/task collision isolation, multiple deltas for one item, null event turn/item fields inside a real containing turn, contiguous cross-turn global ordinals, duplicate/gap/compensated-total corruption, injective raw-home-versus-literal-marker snapshot hashing, revisionless-native rejection, native-revision conflict and fallback replacement, replay idempotency/committed conflict latching, stale-child removal, cwd containment plus originally-null distinction, staging invisibility, exact post-dedupe completion and per-receipt count mismatch, live-stage busy refusal, hard-crash/reopen expired-stage atomic cleanup and successor promotion, lost heartbeat/token refusal, caller-owned transaction refusal, clock/token/value-free error mappings, transaction rollback, cache deletion preserving metadata/forks/latches, verified-only legacy mapping, independent mutations of event JSON/fingerprint/ordinal/turn/item/replay identity, corrupt-row fail-closed behavior, and every configured/default/hard bound.
- Targeted migration/store tests, engine typecheck, and diff hygiene must pass.

## Task 3: Provider index coordinator, rebuild, dedupe, and rollback read path

**Files**

- Create `packages/engine/src/provider-index/coordinator.ts`
- Create `packages/engine/test/provider-index/coordinator.test.ts`
- Modify `packages/engine/src/index-db.ts`
- Modify `packages/engine/src/index.ts`
- Modify `packages/engine/src/providers/index.ts`

**Contract**

- `ProviderTaskIndexCoordinator` accepts a `ProviderRegistry`, `ProviderTaskIndexStore`, and explicit clock; it never opens native files.
- Coordinator startup registers each runtime provider/home in the backend-only home registry; public results contain locators, never canonical homes.
- `observeListPage` calls `replaceActiveSummary` for an already-promoted home, atomically updating summary fields without erasing previously cached turns/events/receipts. Before initial promotion it does not expose page fragments.
- `observeTask` replaces a complete `includeTurns=true` snapshot; a summary-only observation updates task fields but preserves children.
- `rebuild({provider, home})` calls `beginStage`, maintains the stage heartbeat while paging the native provider to exhaustion with bounded page/task/time limits, and deduplicates locators in a bounded map. `taskCount` is the unique post-dedupe census size; per-locator snapshot counts replace earlier counts rather than accumulate on replay; `turnCount`/`eventCount` are the sums of those final canonical snapshots; `snapshotCount` is the number of distinct fully snapshotted locators and equals `receiptCount`. It writes only through `stageSummary`/`stageSnapshot`, passes those exact five counts to `promoteStage`, and refuses promotion when the store's SQL counts differ. Promotion atomically selects the new generation and invalidates only older cache generations in that exact provider/home scope.
- A failed/aborted rebuild calls `abortStage`, retains the previous complete active generation, and never publishes a partial generation or deletes metadata. All list/read SQL joins `provider_sync_state.active_generation`; there is no fallback query that can see staging rows.
- `readThrough` returns an authoritative native observation when available and only returns cache with explicit `freshness:"cache"` when the caller permits degraded cache reads. A cached full-task request requires `cacheDetail:"snapshot"`; `cacheDetail:"summary"` is eligible only for an explicitly requested summary projection and never fabricates an empty transcript.
- Legacy `sessionId` lookup falls back through `legacy_session_task_map` only after exact native verification. An unresolved provenance row stays on the legacy path and can never be promoted by matching ID alone.
- A verified unified task that disappears natively is marked deleted, has rebuildable cache cleared, and cannot fall back to the gzip archive. Unified tasks stop creating new gzip transcript archives; legacy unresolved sessions retain their existing compatibility behavior until M8 cleanup.
- Flag-off routing does not instantiate or call the coordinator read path. Dual writes/observations are allowed because they are additive cache; rollback immediately restores legacy direct reads.

**TDD gate**

- Fake adapters prove pagination dedupe, overlapping pages, duplicate items, changed revisions, mid-rebuild failure, provider deletion, foreign-scope isolation, zero-task rebuild, cache fallback labeling, verified-vs-unresolved legacy mapping, native deletion without gzip resurrection, and zero native mutations during rebuild.
- Prove clearing the entire DevHub DB leaves fake native snapshots unchanged and a fresh DB rebuilds byte-equivalent indexed tasks.

## Task 4: Provider writer lease and durable external-mutation parity

**Files**

- Modify `packages/engine/src/providers/codex/native-adapter.ts`
- Modify `packages/engine/src/providers/claude/native-adapter.ts`
- Create `packages/engine/src/providers/reconciliation-store.ts`
- Modify `packages/server/src/native-codex-runtime.ts`
- Modify `packages/server/src/native-claude-runtime.ts` only if needed to share the existing lease-store factory without changing Claude semantics
- Create or extend `packages/engine/test/providers/codex-native-adapter.test.ts`
- Create `packages/server/test/native-codex-runtime.test.ts` if absent

**Safety design**

- Inject the existing `NativeTaskWriterLeaseStore` interface into `CodexNativeAdapter`; do not create a second lease around Claude.
- Define a narrow `ProviderReconciliationStore` interface over `provider_reconciliation_state` and inject it into both production adapters. A store read/write failure fails closed and makes the unified runtime unavailable; no in-memory success may outrun a required durable latch.
- Codex tracks a bounded per-task last-observed native revision and explicit reconciliation latch. Claude retains its already-reviewed in-memory/reentrancy behavior but mirrors required/acknowledged state durably and restores a required latch before accepting any post-restart mutation.
- Persist only the minimum restart-safe latch/fingerprint/writer epoch/reason; clearing rebuildable cache must not clear a required reconciliation. Never persist prompts, events, approvals, or secrets in the latch table.
- Existing-task `resume`, `fork`, `send`, `steer`, `interrupt`, approval/input `respond`, `archive`, and `rename` acquire or reuse the exact task's adapter-owned lease, reread exact native revision, compare it with the last reviewed revision, call `confirmReread`, and start the mutation only via `runFencedWrite`. `respond` additionally rejects stale request/generation identity before dispatch; uncertain post-dispatch outcomes latch reconciliation and never replay the response.
- A missing reviewed revision requires an authoritative read before mutation. A changed/deleted task, lost lease, unconfirmed mutation outcome, process generation change, or thrown parser latches reconciliation and never retries the mutation.
- `acknowledgeReconciliation` rereads exact native state, then uses the store CAS with the status-returned `latchRevision` and reviewed/native fingerprint. Durable clear occurs before in-memory clear; a crash between them remains conservatively latched in the live process, while a newer same-fingerprint durable latch can never be cleared. Start of a brand-new task is not keyed until the provider returns its native ID; partial-start semantics remain unchanged.
- Use the same `native-task-writer-leases.sqlite` path and ownership rules as Claude without double-acquiring a task in one call path.

**Adversarial TDD gate**

- Two adapters/processes racing one key; Codex/Claude same-ID isolation; expired takeover; ABA epoch; external revision between view and write; deletion; stale approval request/generation; crash/timeout before and after native send/respond; no response replay after uncertainty; lease heartbeat loss; callback reentrancy; hostile clocks; generation restart; both providers restarting with a durable latch; crash during latch/ack CAS ordering; same-fingerprint relatch increment/newer-latch CAS refusal; durable-store failure; cache deletion while latched; acknowledgement mismatch; and exact success path.
- Run the focused Codex and existing Claude lease suites together to prove no regression. This task receives max reasoning and independent adversarial review.

## Task 5: Authenticated indexed routes and feature-controlled integration

**Files**

- Create `packages/server/src/routes/provider-index.ts`
- Create `packages/server/test/provider-index.test.ts`
- Modify `packages/server/src/app.ts`
- Modify `packages/server/src/routes/provider-tasks.ts`
- Modify `apps/web/src/lib/provider-api.ts`
- Extend relevant server/web provider API tests

**Public boundary**

- Homes are registered only by trusted server startup: installed-runtime discovery, explicit `BuildOptions`, or server-side `DEVHUB_*_HOME`/legacy env aliases. There is no browser endpoint that accepts a raw home. If no trusted home is registered, the provider is unavailable rather than asking the browser for a filesystem path.
- `PublicProviderHome` is exactly `{provider, homeFingerprint, status, capabilities}`. `PublicIndexedTaskSummary/Task/Event/RequestIdentity` replace all native keys with locators and omit canonical home. Cached `cwd` is returned only when it is neither equal to nor inside the canonical provider home; otherwise public `cwd` is `null` with `cwdRedacted:true`.
- Error DTOs contain stable value-free codes; logs, validation errors, SSE frames, diagnostics, and cache/route JSON never interpolate canonical homes. Tests recursively scan every success/error/log/SSE surface for registered-home bytes.

**Route matrix**

| Method/path | Request | Response | Capability / gate |
|---|---|---|---|
| `GET /api/provider-index/homes` | none | `PublicProviderHome[]` | read auth; stable provider/fingerprint order |
| `GET /api/provider-index/tasks` | query `provider?`, `homeFingerprint?`, `cursor?`, `limit=1..200`, `includeArchived?` | `{items:PublicIndexedTaskSummary[],nextCursor}` | `list`; cache active generation only |
| `GET /api/provider-index/tasks/:locator` | query `freshness=native|cache` (default native) | `{task,freshness,reconciliation}` | `read`; cache mode explicitly degraded |
| `POST /api/provider-index/tasks` | `{provider,homeFingerprint,cwd,input?,model?,mode?,permissionMode?}` | `PublicIndexedTask` | `start`; mutation auth |
| `POST /api/provider-index/tasks/:locator/resume` | bounded overrides | `PublicIndexedTask` | `resume`; fenced mutation |
| `POST /api/provider-index/tasks/:locator/fork` | `{lastTurnId?}` | `{source,target,link}` | `fork`; fenced mutation |
| `POST /api/provider-index/tasks/:locator/send` | `UserInput` | path-free `NativeTurnRef` | `send`; fenced mutation |
| `POST /api/provider-index/tasks/:locator/steer` | `{expectedTurnId,input}` | `204` | `steer`; fenced mutation |
| `POST /api/provider-index/tasks/:locator/interrupt` | `{turnId}` | `204` | `interrupt`; fenced mutation |
| `POST /api/provider-index/tasks/:locator/respond` | path-free response identity + exact decision/answers | `204` | response-kind capability; stale-generation rejection; fenced mutation |
| `POST /api/provider-index/tasks/:locator/archive` | none | `204` | `archive`; fenced mutation |
| `POST /api/provider-index/tasks/:locator/rename` | `{name}` | `204` | `rename`; fenced mutation |
| `GET /api/provider-index/tasks/:locator/events` | `Last-Event-ID?` header | locator-only SSE | `subscribe`; auth before stream |
| `GET /api/provider-index/tasks/:locator/reconciliation` | none | durable path-free latch/status | `read`; authenticated |
| `POST /api/provider-index/tasks/:locator/reconciliation/ack` | `{latchRevision,reviewedFingerprint:string|null}` | new latch/status | authoritative reread (nullable when deletion is the reviewed outcome) + exact store CAS; mutation auth |
| `PATCH /api/provider-index/tasks/:locator/meta` | additive `ProviderTaskMetaPatch` only | `ProviderTaskMeta` | mutation auth; no provider write |
| `POST /api/provider-index/rebuild` | `{provider,homeFingerprint}` | `{activeGeneration,taskCount,eventCount}` | `list+read`; single-flight mutation auth |

- List order is exactly `updatedAt DESC NULL LAST, provider ASC, homeFingerprint ASC, nativeTaskId ASC`. The opaque canonical `pi1.` cursor carries the full last sort tuple plus exact scope and is size-bounded/canonical-encoding checked; changing scope with a cursor is rejected. Repeated pages neither skip nor duplicate stable rows.
- SSE makes no cross-connection replay claim and closes the snapshot/subscribe race explicitly: authenticate, subscribe first into a bounded event/byte buffer, take the authoritative path-free task plus pending-request snapshot, emit it with a fresh random stream epoch, drain buffered events in captured order while dropping replay keys/request identities already represented in the snapshot, then atomically switch that same sink to live delivery. Any buffer overflow or subscription/read failure emits a value-free `resync-required` terminal and closes; it never silently drops. Every `Last-Event-ID` (valid, stale, foreign, or malformed) still takes this full subscribe-buffer-snapshot-drain path, and no prior-connection event is replayed or inferred. Existing request-ledger, unsubscribe, cancellation, and backpressure behavior remains unchanged.
- Browser response identities contain the locator plus the existing generation/turn/request/item/approval fields; the server reconstructs and revalidates the native identity before dispatch.
- All new mutations/control/rebuild/meta/ack routes require a configured bearer token plus trusted origin and never accept query-string tokens. Read/list/SSE routes honor the existing configured-token auth and origin policy. Unknown fingerprint, locator/provider mismatch, capability absence, stale request, reconciliation latch, and uncertain mutation fail with stable non-path-bearing codes.
- Existing provider list/read/start/resume/fork/mutation routes observe successful results into the cache or invalidate uncertain rows. Their response shapes and behavior remain byte-compatible when `unifiedTaskIndex` is false.

**Flag behavior**

- `availableDevHubFeatures.unifiedTaskIndex` becomes true only when the store/coordinator initialized successfully.
- A stored/requested false uses the legacy read path instantly without schema rollback.
- When requested/applied true, the web provider client uses only the locator façade; when false, it uses the existing direct provider routes unchanged. Do not default the flag on in this task; Task 9 performs that single cutover after all M5 gates.

## Task 6: Portable archive v2 authority correction

**Files**

- Modify `packages/engine/src/portable.ts`
- Modify `packages/engine/test/portable.test.ts`
- Modify `packages/server/src/routes/portable.ts`
- Modify `packages/server/test/app.test.ts`

**Format**

- Preserve `LegacyArchiveBundleV1` import support for `kind:"claude-ui-archive", schemaVersion:1`.
- Default export becomes `DevHubArchiveBundleV2` with `kind:"devhub-archive", schemaVersion:2`. It contains additive legacy metadata, provider task locators/meta/fork links, saved views, and permission-audit data, but no provider task cache rows, mirrored message text, raw home paths, provider transcript paths, credentials, or hidden reasoning.
- Provide an explicit `format=legacy-v1` export option solely for rollback to an older reader; label it through `X-DevHub-Archive-Authority: legacy-rebuildable-cache` and keep its existing envelope/row byte shape. It exports only unresolved legacy v13 corpus: any `sessionId` with a verified unified mapping is excluded, and an explicit selection containing one is rejected. It is never the default and can never export unified provider cache.
- Import v2 restores only additive metadata/links and never creates a task cache row. Because home fingerprints are machine-specific, provider metadata imports as orphaned locators unless the caller supplies an explicit validated source-fingerprint-to-local-home mapping; import never guesses from the current provider home.
- Import v1 preserves the current legacy restore behavior for backwards compatibility but records every restored row as `archive-v1-import`/unresolved provenance. Such rows never claim native ownership or overwrite a verified live mapping.
- Both formats remain bounded, schema-validated, idempotent, transactional, and secret-clean.

```ts
export interface ArchiveHomeMapping {
  readonly provider: ProviderId;
  readonly sourceHomeFingerprint: string;
  readonly targetHomeFingerprint: string;
}

export interface ImportArchiveOptions {
  strictVersion?: boolean;
  allowLegacyV1?: boolean; // defaults true for compatibility; all v1 rows quarantine
  homeMappings?: readonly ArchiveHomeMapping[];
}

export interface ImportArchiveResult {
  sessions: number;
  meta: number;
  textRows: number;
  savedViews: number;
  audit: number;
  orphanProviderMeta: number;
  mappedProviderMeta: number;
  forkLinks: number;
  conflicts: number;
}
```

- Each source `(provider,fingerprint)` may map to at most one registered target of the same provider. Duplicate identical mappings collapse; conflicting duplicates, unknown targets, provider changes, malformed fingerprints, and mapping cycles are rejected before writes.
- Many source homes may target one local home only if their complete mapped locator sets are collision-free. Same target locator plus byte-identical metadata/link is idempotent; differing content is a counted conflict and aborts the entire import transaction—no last-writer-wins merge.
- Orphan metadata retains the source locator and can be remapped later; it is not attached to a runtime key and does not appear as a native task.

**TDD gate**

- Golden v1 reader compatibility, default-v2 no-content/no-path assertions, v2 round trip, exact option/result counts, explicit cross-machine mapping, duplicate/conflicting/many-to-one mapping, orphan import without mapping, v1 explicit legacy-only export and mapped-row rejection, v1 quarantine/no-live-overwrite, mixed provider collision isolation, discriminator/version mismatch, corrupt/bomb-like input bounds, idempotency, and transaction rollback.

## Task 7: URL and browser-storage compatibility migration

**Files**

- Create `apps/web/src/lib/compat-storage.ts`
- Create `apps/web/src/lib/compat-storage.test.ts`
- Modify `apps/web/src/lib/router.ts` and `router.test.ts`
- Modify all web hooks/components that currently own a `claude-ui:*` or `claude-ui-token` key
- Modify `apps/web/src/components/CodexNativePane.tsx` and focused tests without touching the user-owned `ChatPane.tsx` or `SlashPalette.tsx`

**Contract**

- New localStorage keys use `devhub:*` (token: `devhub-token`). Reads try the DevHub key first, then the exact legacy key. Successful legacy reads are copied to the DevHub key without deleting or rewriting the legacy value. Writes target only the DevHub key; storage exceptions remain non-fatal.
- Provider-owned drafts, recents, bookmarks, API calls, and UI selection use serialized provider task locators; no key, provider URL, or provider API response contains a raw home path or NUL separator. Legacy direct-provider APIs remain available only behind the flag-off rollback path.
- With `unifiedTaskIndex` requested/applied, provider setup selects only from `PublicProviderHome` entries discovered by the server; it never renders or asks the browser to submit a filesystem home. With the flag explicitly false, the preserved legacy setup/direct-route behavior remains the rollback surface.
- New URLs use `providerTask=<serialized locator>` plus the existing tab/project/session fields. Parsing accepts legacy URLs unchanged, rejects malformed locators without throwing, and emits stable parameter order.
- Back/forward navigation, SSR, quota/private mode, corrupt JSON, token auth, and provider collision tests remain green.

## Task 8: Environment, data-path, webhook, and naming aliases

**Files**

- Create `packages/engine/src/compat-identifiers.ts` and tests
- Modify `packages/engine/src/paths.ts`, `config/mcp-test.ts`, driver env readers, and worker toggles
- Modify `packages/server/src/app.ts`, attachment paths, native runtime env readers/scrubbers, and tests
- Modify `packages/engine/src/webhooks.ts` and tests

**Contract**

- Prefer `DEVHUB_*` environment variables; accept the exact `CLAUDE_UI_*` alias when the DevHub form is absent. Conflicting values use the DevHub value and emit only a value-free diagnostic.
- Keep the existing legacy default data directory in M5. `DEVHUB_DATA` and `CLAUDE_UI_DATA` resolve through one function; M8 owns the on-disk directory migration.
- Child-provider environment scrubbing removes both namespaces except the explicitly selected provider auth/operational allowlist. No secret value enters logs or tests.
- Add `payloadVersion:1|2` to webhook config. Existing/legacy configs default to v1 and retain byte-compatible `source:"claude-ui"` payloads. New v2 configs emit `source:"devhub"`, `schemaVersion:2`, and opaque provider locators with no raw home; they may include `sourceAliases:["claude-ui"]` for receiver migration. One subscription emits exactly one selected version, never duplicate v1+v2 delivery.
- Internal package/app IDs that are not persistence identities may be renamed mechanically only when tests prove no compatibility effect; visible app/bundle/repo rename stays M8.

## Task 9: Failure drills, final review, and flag cutover

**Files**

- Modify `packages/engine/src/providers/feature-flags.ts` only after every gate below passes
- Update `.planning/devhub-codex-parity/implementation-plan.md`, `risk-register.md`, `synchronization-contract.md`, `tasks/todo.md`, and add `evidence/m5/` artifacts

**Required pre-cutover gates**

1. Targeted identity, migration, store, coordinator, Codex lease, archive, server route, web routing/storage, env, and webhook tests pass with at most two workers.
2. Induced failures pass: v13 migration interruption, DB busy/write failure, duplicate/conflicting replay with null/repeated turn/item IDs, partial staging generation plus hard-crash/expired-owner takeover, cache corruption, failed rebuild, native deletion without gzip resurrection, unresolved legacy collision, external mutation, stale/uncertain `respond`, durable latch restart/same-fingerprint relatch/CAS race, lease loss, provider restart, flag rollback, invalid/unknown-fingerprint locator, cursor scope abuse, SSE events injected before/during/after snapshot plus overflow and stale/foreign/malformed reconnect IDs, v1 quarantine import, v2 orphan/mapped collision import, v2 secret/path scan, and full DevHub-storage deletion/rebuild.
3. Fresh independent specification review finds no missing M5 requirement.
4. Fresh independent adversarial review finds no open P1/P2 and no unaccepted P3.
5. `git diff --check`, targeted secret scan, raw-home fixture scan, generated-file check, and preservation hash/status check pass before changing the default.

**Cutover**

- Set `DEFAULT_DEVHUB_FEATURE_FLAGS.unifiedTaskIndex` to true and make the server report it available/applied only after the gates above.
- Preserve an explicit stored false as the immediate rollback switch.
- Rerun the focused flag/settings/routes/rollback tests after the one-line default change, then create the dedicated cutover commit. A failure restores the default false before any broader gate.
- On that exact enabled commit, run fresh full engine/server/web tests, typechecks, builds, TUI smoke, and desktop packaging through the shared heavy queue with forced cache bypass. Any failure gets a repair commit and the entire exact-tip gate repeats.
- On the exact full-gate-passing enabled commit, Browser plus Computer Use must prove legacy deep links/storage migration, path-free provider setup/selection, reload, explicit stored-false rollback, and wide/768px layouts. Capture screenshots and interaction traces under `evidence/m5/`; stop all QA servers immediately afterward.
- Run the final independent exact-tip review plus full secret scan, recursive raw-home-byte scan of every locator/response/SSE/archive evidence artifact, generated-file check, `git diff --check`, clean owned-path status, and preservation hash/status check. Do not push before this post-cutover certification.
- Keep `nativeCodex=false` and `persistentClaude=false`; document their unchanged live-proof blockers.

## Commit and review sequence

1. `feat(engine): add provider task locator identity` — Task 1 focused tests/typecheck pass.
2. `feat(engine): add rebuildable provider task index` — Tasks 2-3 focused tests/typecheck pass.
3. `fix(codex): fence native task mutations` — Task 4 adversarial tests plus Claude lease regression pass.
4. `feat(server): expose provider task index safely` — Task 5 server/engine integration tests pass.
5. `fix(archive): separate metadata from provider cache` — Task 6 compatibility and authority tests pass.
6. `refactor: migrate DevHub compatibility identifiers` — Tasks 7-8 web/engine/server focused tests pass.
7. `feat: enable verified unified task index` — Task 9 full milestone gates/evidence/review pass.

Every commit must exclude `.gitignore`, `apps/web/src/components/ChatPane.tsx`, `apps/web/src/components/SlashPalette.tsx`, and `AGENTS.md`; verify the staged path list before committing. Do not push until the exact branch tip passes its own complete integration gates.
