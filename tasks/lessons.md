# Reusable Lessons

## 2026-07-14 - Validate coordinator authority before side effects

- Normalize the entire configured-home list before sampling a clock or registering the first home. Canonicalize aliases, reject malformed Unicode/SQLite bounds, deduplicate, sort, and freeze first so a late invalid entry cannot leave partial initialization authority.
- Check trap-free proxy identity before operations such as `Array.isArray` that can throw on revoked proxies. Exact own-data validation must reject accessors and explicit `undefined` without executing caller code.
- An exported concrete coordinator must not make its constructor a factory bypass. Require a module-private construction capability, retain the normalized dependencies for later slices, and guard initialization reentrancy before invoking the injected clock.
- `instanceof` is not instance authority because `Object.create(Class.prototype)` passes. Brand real registry/store construction in module-owned weak sets and have factories validate that unforgeable membership after rejecting proxies.
- A module-owned weak set is still bypassable when the factory reaches it through an exported writable class static. Capture the predicate through an internal module import binding, and test hostile static monkeypatching cannot replace the authority check.
- Give configured authority lists a dedicated admission cap before canonicalization. Reusing a large runtime task cap can turn startup normalization into attacker-controlled synchronous path work.
- A one-timestamp initialization contract spans retryable store failures. Retain the first valid timestamp until initialization succeeds so partial idempotent registrations and later retries cannot acquire mixed authority times.

## 2026-07-14 - Match authority validation cost to the mutation decision

- A CAS witness does not need to reconstruct every byte it fences. For atomic cache deletion, validate the bounded task summary needed to derive reviewed authority, validate and retain the exact bounded receipt plus aggregate child censuses, and let data-version/total-change fences detect replacement without decoding the transcript.
- Never reuse a full read path merely because it is already trusted when the caller needs only bounded metadata. Export a narrow point-row decoder and keep full child validation on user-visible reads and writers that actually preserve or return those children.
- Resource-bound tests should interpose at the SQL materialization boundary and cover both token issuance and commit revalidation. Permit bounded COUNT and point-row witnesses, but fail on child `.all()` or streaming so a future helper substitution cannot silently restore amplification.

## 2026-07-14 - Fence asynchronous observations with one-shot store authority

- A provider result is not current authority merely because its locator still matches. Capture peer `data_version`, same-connection `total_changes()`, scope sync state, every-generation target census, exact active task/receipt rows, and reconciliation state before the provider await, then recapture all of it inside the owned writer transaction before selecting a branch.
- Keep observation capabilities opaque and instance-bound: a frozen property-free object held only in a per-store `WeakMap` gives clone, foreign-store, drop, and replay refusal without serializing authority or exposing it through the provider API barrel.
- Prepare token-backed provider values from captured canonical-home authority without filesystem or database lookup. Invalid provider payloads may retain the token, but once a commit is admitted, consume it before `BEGIN`; drift, corruption, busy storage, trigger suppression, or capacity failure must never make a late result replayable.
- Treat authoritative missing as one atomic cache-and-latch transition. Delete every cache generation, prove exact bigint changes and zero residual rows, preserve durable and foreign authority, and make only the exact already-missing plus empty-cache branch a zero-write idempotent return.

## 2026-07-14 - Preserve optional-field semantics during trusted reconstruction

- Exact descriptor validation must distinguish an absent field, an accessor, and an own data field whose value is `undefined`. Public constructors may intentionally represent optional authority with the third form.
- Accept only the documented optional value or exact invoked authority, then reconstruct with the invoked provider. This preserves compatibility without allowing foreign values or raw-object reuse.
- Pair registry tests with the HTTP projection whenever a typed error's optional fields affect status or fallback-provider behavior.

## 2026-07-14 - Reconstruct typed failures from exact invoked authority

- A non-proxy object can inherit an exported error prototype without running its constructor, and a real instance can replace its classification fields with accessors. `instanceof` plus proxy rejection is therefore not a trust boundary.
- Snapshot only the bounded own data descriptors needed for the classified kind and validate them against the exact invoked provider, home, and capability. Never invoke accessors, and never reuse the source error's message or cause.
- Even valid typed failures should be reconstructed fresh after validation. Invalid shapes collapse to one fixed generic adapter failure, while exact legitimate kinds preserve only their safe class and invoked-authority fields.

## 2026-07-14 - Detect proxies before guarded instanceof classification

- Catching prototype traps is insufficient: a proxy can successfully spoof a trusted class prototype and enter a raw-rethrow branch. Use Node's trap-free proxy detector on object and function inputs before every `instanceof` classification.
- Reject all adapter-thrown proxies at the registry boundary, including revoked proxies and proxies over otherwise legitimate exported errors. Only ordinary non-proxy typed errors retain exact identity.
- An earlier descriptor test may become a zero-call proof after a stronger outer boundary lands. Update it to assert the hostile proxy never reaches prototype-sensitive field or descriptor logic.

## 2026-07-14 - Guard typed classification before field snapshotting

- `instanceof` is executable behavior for proxies because prototype lookup can trap or fail after revocation. Put the entire typed-error classification chain behind one catch boundary before reading descriptors or fields.
- Do not retain a hostile prototype trap as the public adapter failure cause. Collapse it to a stable classification and create a fresh value-free internal TypeError so raw trap text, causes, task IDs, and paths cannot cross the registry boundary.
- Keep successful classification and field validation separate: first return a stable error kind, then permit only the operation kind to enter the bounded own-data-descriptor snapshot.

## 2026-07-14 - Snapshot typed error fields before classification

- An exported error class proves only its prototype, not stable field values. Treat adapter-thrown instances as hostile: capture the exact own data descriptors needed for classification, reject accessors and descriptor failures, validate each captured value once, and never reread the source object after control flow begins.
- Lifecycle exceptions cannot outrank persisted authority. When a helper reports absence, consult the durable in-memory persistence/reconciliation state before allowing an initialized or new-task shortcut.
- Keep hostile-error containment value-free. A malformed typed error becomes the registry's generic adapter failure and must never project its task, native ID, working directory, raw message, or cause.

## 2026-07-14 - Classify native absence only from exact provider evidence

- A provider-native missing classification must come from one exact non-mutation evidence shape: an official helper's `null` or the documented remote error class/code/message/data tuple. Fuzzy message matching, mutation errors, malformed success, and transport failures retain their existing conservative classifications.
- Absence before persistence and disappearance after persistence are different authority states. The former may be safely reported as missing; the latter must retain reconciliation semantics so a stale observation cannot erase durable history.
- Project missing errors through one value-free code/message at registry, server, and browser boundaries. Strip provider detail and causes, forbid task projections, and test the public HTTP body and browser allowlists independently.

## 2026-07-14 - Bootstrap the durable status board before implementation

- A fresh goal chat must create and commit `tasks/STATUS.md` plus the root `AGENTS.md` before starting milestone work when the restart playbook requires them.
- Treat `tasks/STATUS.md` as the skimmable source of truth: keep the frozen denominator, tag every remaining item by blocker type, register active worktrees, and update it in the same commit as the work it describes.
- When a newer explicit instruction makes a formerly protected untracked coordination file commit-owned, limit that override to the named file and keep all other protected user paths untouched.

## 2026-07-14 - Keep blocked proof lanes parked and report one fixed denominator

- When the user parks a provider-budget-blocked proof lane, remove it from the active queue instead of repeatedly polling or spending turns restating the blocker; redirect all available work to the named unblocked milestone.
- Report program progress only against the fixed M0-M8 hard-gate denominator: count a milestone only after its completion gate passes, and do not substitute a per-milestone percentage.
- Promote a coherent tested and independently reviewed checkpoint promptly. Do not hold multiple green slices uncommitted merely to make a later integration commit larger.

## 2026-07-13 - Credential discovery before declaring an auth blocker

- An absent process/login-shell variable and a provider CLI's default OAuth status do not prove that no API credential exists locally.
- Before declaring a provider-auth blocker, search likely ignored `.env` and secret-loader files by variable name only, inspect presence/shape without printing values, and verify the candidate in an isolated provider config.
- Keep credential discovery separate from credential use: never source arbitrary files, never echo a secret, and persist only redacted auth method/provider evidence.

## 2026-07-13 - Attribute crash dialogs before changing the active task

- When the user reports a recurring local process crash, first identify the executable, parent process, architecture, and owning app from live process/crash evidence; do not assume the active task caused it.
- Once the active implementation is proven unrelated, state that boundary plainly and avoid launching the affected runtime. For this DevHub program, keep build and QA automation on the repository's Node/TypeScript toolchain and do not invoke Python.
- Treat another app's failing daemon as a separate incident unless fixing it is explicitly placed in scope; preserving forward progress is more useful than perturbing an unrelated process tree.

## 2026-07-13 - Commit verified checkpoints in a shared dirty worktree

- Preserve unrelated dirty files, but do not use a dirty worktree as a reason to avoid all commits after the user has authorized them.
- Stage only owned goal files and commit at coherent, tested milestone checkpoints; never bundle unrelated pre-existing edits for convenience.
- Do not snapshot a known-red intermediate state merely to increase commit frequency. Recoverability comes from scoped green commits with explicit gate evidence.

## 2026-07-13 - Queue shared heavy work instead of grab-or-skip

- A shared one-job resource lock needs an explicit FIFO intent queue, not opportunistic `mkdir` attempts that silently defer work.
- Register the task name and enqueue timestamp, wait without busy-spinning, report the measured wait, acquire only when load and memory thresholds pass, and release automatically on success, failure, or interruption.
- Never remove an unattributed lock or kill another task's process. Inspect and report ownership first, and test queue ordering plus failure cleanup as part of the coordination primitive's own QA.

## 2026-07-13 - Pin queue-wrapper code for the lifetime of every waiter

- A queued shell may outlive multiple wrapper deployments, so a mutable canonical script is unsafe even when each replacement is syntactically valid: the waiter can resume against mixed source and fail before launching its command.
- Keep the canonical entrypoint as a stable launcher that resolves one immutable, owner-only implementation path and immediately `exec`s it. Publish upgrades as new versioned files and atomically switch only the launcher pointer; never edit a published implementation.
- Before changing the canonical launcher or pointer, prove there is no production owner, waiter, or wrapper process. The release gate must queue a waiter on version A, atomically select version B while it waits, and prove the A waiter still runs/releases while the next invocation uses B.

## 2026-07-13 - Parallelize independent lanes without weakening gates

- Split work by real file/schema/resource dependencies. Read-only architecture, staging-scope audit, and independent review can run concurrently while one lane owns the current worktree and heavy-job queue.
- Keep same-revision certification serial when its order matters: integration gate, interactive evidence capture, then checkpoint. A single global heavy slot is a resource dependency, not a reason to serialize unrelated lightweight work.
- Use separate worktrees and narrowly scoped agents for independent writers; match agent count and reasoning effort to the work instead of fanning out by default.

## 2026-07-13 - Preserve append-only coordination history across wrapper upgrades

- An audit-schema migration must never rewrite or normalize the existing JSONL in place, even when old events used the wrong keys. Preserve historical bytes and make only future events conform to the exact schema.
- Freeze admission first, hold every old/new coordination lock continuously through migration, and prove the original audit prefix byte-for-byte before releasing the new implementation.
- Treat a successful cutover command as provisional until an independent post-release witness verifies canonical status, one lifecycle smoke, exact appended events, ledgers, locks, and zero active residue.

## 2026-07-13 - Keep resource coordination quiet and executable-path explicit

- Routine resource polling should write the requested status artifact without generating frequent UI cards. Keep the hourly snapshot and delete noisy heartbeat automations when the user asks.
- A hardened wrapper may intentionally replace `PATH`; commands run through it must use reviewed absolute tool paths or an explicit minimal PATH rather than assuming the interactive shell environment.
- If a queued launch fails before doing work, release the slot, record the failure honestly, diagnose once, and retry only with the root cause corrected.

## 2026-07-13 - Pin historical migration slots without blocking future appends

- A schema-version invariant must pin the required migration at its historical index while allowing later migration steps; equality with the current migration count makes the next additive version unloadable.
- When a database already claims the exact version that introduced a critical schema, validate that schema before skipping the migration loop. Validate inside the introducing migration for older databases, but do not apply the old exact-shape validator to unknown newer versions.
- Keep schema goldens independent from the generated DDL, including explicit index table, column order, direction, and partial predicate, so a shared source cannot make implementation and tests drift together.
- For claimed-version tamper coverage, start from a valid schema with sentinel data, remove one critical object, and prove validation emits only its constant error while preserving the version, data, and missing-object state instead of silently healing it.

## 2026-07-13 - Validate ownership before provider-event normalization

- Provider-event normalization is a safety projection, not an authorization boundary: it may turn mismatched provider/task/request identity into a benign diagnostic.
- Before projection or persistence, snapshot raw own-data descriptors and independently prove the top-level provider/key plus nested request and request-resolved identity keys match the method, payload, registered home, and stage scope.
- Keep canonical JSON and cached turn/item/replay key formats in the identity module with strict reciprocal helpers; persistence codecs should reuse those helpers instead of duplicating security-sensitive grammars.

## 2026-07-13 - Enforce persistence limits on final representations and package surfaces

- A source-string bound does not prove the encoded cache key or canonical persisted envelope fits its database constraint. Enforce limits on the final base64url/JSON representation at the last pure boundary before SQL, and test the exact accepted and first rejected values with multibyte input.
- Distinguish a fixed malformed-value bound from configured aggregate capacity: an oversized single persisted value is `INVALID_INPUT`, while configured turn/event-count exhaustion is `CAPACITY`.
- Runtime barrel checks cannot detect leaked TypeScript-only carriers. Pair selective exports with a compiler fixture whose `@ts-expect-error` assertions fail if raw-home or backend preparation symbols reappear.
- JSON-RPC numeric IDs are signed safe integers. Do not reuse nonnegative counters for request/approval identity validation; prove negative safe-integer round trips independently.

## 2026-07-13 - Snapshot hostile event graphs once before any semantic read

- A shallow ownership snapshot does not close a nested accessor/proxy or time-of-check/time-of-use gap. Reject Node proxies before reflective traps, recursively copy only bounded own data descriptors, reject cycles/exotics/sparse arrays/symbols, and feed the same frozen snapshot to ownership, projection, item-key, and replay-key logic.
- Projection safety and persistence validity are separate boundaries. A write must pass the exact normalized persisted-event union used by the read decoder; otherwise a writer can create a row its own reader later classifies as corrupt.
- Raw provider-home exclusion applies to every persisted summary, revision, and turn scalar, not only task/event locators. Fail closed on an exact home occurrence and keep cwd as the sole component-aware redaction exception.

## 2026-07-13 - Match SQLite text semantics without aggregate allocation

- SQLite `length(TEXT)` counts Unicode code points, while JavaScript `string.length` counts UTF-16 code units. Validate surrogate pairing and count with an early-exit scan before any UTF-8 allocation; use final ASCII/base64 length only where the persisted representation is guaranteed ASCII.
- Snapshot fingerprints can preserve an exact canonical fixed-array contract without constructing one aggregate JSON string. Stream delimiters and canonical scalar encodings into the hash, including `event_json` as an outer quoted/escaped JSON string, and keep a bounded aggregate-reference golden to prove byte equivalence.

## 2026-07-13 - Bound projection expansion before cloning or replacement

- An input-size bound is not an output-size bound: a root provider home such as `/` can turn one input character into the full redaction marker, and the private injective escape can double sentinel content. Compute exact readable and injective Unicode-code-point lengths before clone or materialization, cap their aggregate, then use a bounded single-pass replacement.
- Persistence should consume one internal projection bundle from the same deep-frozen raw event snapshot. Re-running public projection, item-key, and replay-key helpers repeats normalization/cloning and creates both amplification and time-of-check/time-of-use risk.
- Keep the internal bundle out of the provider barrel with an explicit identity export list plus runtime and negative TypeScript assertions; internal-by-comment is not an API boundary.

## 2026-07-13 - Capacity and error provenance must be unforgeable

- Read a dense array's own data length descriptor once, enforce its configured cap before `Reflect.ownKeys` or element descriptors, and reuse that captured value. This makes huge sparse inputs cheap and prevents changing-length proxy tricks when combined with proxy-first rejection.
- Never use `instanceof` to passthrough an exported error class across an untrusted input boundary. A caller can throw any public code from a proxy trap; map all such failures to `INVALID_INPUT` and reserve `CAPACITY` for an unexported lexical sentinel raised only by internal cardinality checks.
- Hash/receipt helpers that accept trusted prepared carriers should stay module-private. Exposing them creates a second hostile-input API that must otherwise duplicate every descriptor, depth, and capacity defense.

## 2026-07-13 - Bound canonical output in both database characters and owned bytes

- A SQLite character limit does not bound UTF-8 ownership, and a source-string limit does not bound JSON escape expansion. Preflight the exact canonical representation with separate Unicode-code-point and UTF-8-byte counters before emitting chunks.
- A recursive alias DAG can remain acyclic while causing exponential work. Enforce depth and total visit caps independently, and track only the current ancestor set so benign aliases remain legal without enabling unbounded expansion.
- For an aggregate persistence budget, cache final representation metrics by original object identity. A repeated alias that would cross the remaining budget can then fail before snapshotting, projection, hashing, or materializing another copy.
- A canonical fingerprint proves bytes have not changed; it does not prove those bytes still satisfy the writer's security projection. Read decoding must receive the registered-home context and recheck home exclusion, redaction fixed points, native identifiers, and semantic nonempty fields manually.

## 2026-07-14 - Derive traversal caps from declared container maxima

- A traversal budget counts the root as well as its children. If an API declares a maximum dense array length, its visit cap must allow at least `maximum items + 1` or the advertised boundary is unreachable.
- Prove coupled limits at their exact intersection, not only independently: accept the declared maximum with a fixed output length/hash, then reject the first-over input before expensive enumeration.

## 2026-07-14 - Test the replacement boundary, not the removed mechanism

- Replacing `structuredClone` with a descriptor-only snapshot makes a `structuredClone` spy permanently green and therefore useless. A trusted-path regression must observe the new mechanism directly, such as asserting zero descriptor reads on an ignored nested object.
- Recursive hostile-graph tests must cover each distinct rejection branch: cycles, symbol keys, exotic prototypes, proxies, accessors, sparse/oversized arrays, and every aggregate budget. One representative oversized graph does not certify unrelated branches.
- A type-valid test helper must still be in lexical scope. When a RED fixture itself fails, repair and rerun the fixture before treating its output as product evidence.

## 2026-07-14 - Classify persisted text before applying secret policy

- Display text and semantic identity text need different sink policies. Redact legitimate free text before persistence, but reject model/status/fingerprint values unless secret redaction is a fixed point so their exact meaning cannot silently change.
- Apply raw-home exclusion before redaction, then revalidate the redacted display output against the same Unicode, NUL, and final-size bound; redaction itself can change representation length.
- To certify a removed allocation boundary, extract the real pure transform into an internal non-barrel module and wrap that import in tests. Pair zero-call overflow assertions with a benign positive control, and avoid mutable observer setters that add reentrancy or denial-of-service surface.

## 2026-07-14 - Keep filesystem canonicalization outside owned database transactions

- Snapshot and fully canonicalize caller paths before `BEGIN`; transaction-time conflict checks should decode stored paths only enough to compare their exact bounded text with that already-canonical snapshot.
- A pre-BEGIN callback can invalidate an earlier authority read. When dependent state intentionally has no foreign key, recheck the exact bounded authority tuple after acquiring the writer transaction and before the first mutation.
- Do not re-run `realpath` merely to decode an idempotent or conflicting row while holding a SQLite writer lock. Exact equality inherits the prevalidated input; inequality is a conflict, not an invitation to perform filesystem work.
- Prove callback ordering with a delegated-real instrumented boundary that records transaction state. This catches accidental filesystem, clock, or token callbacks under the writer lock without replacing the real SQLite behavior.

## 2026-07-14 - Separate reconciliation history from acknowledgement truth

- A historical reviewed fingerprint is the baseline that detected drift, not the target an acknowledgement must reproduce. Clear only when the caller's new reviewed value equals freshly observed native state and that fresh value still equals the latch's stored native fingerprint.
- Preserve exact CAS without freezing the stale baseline semantically: fence the previously read nullable reviewed value, native value, required bit, and latch revision in SQL, then replace both fingerprints with the acknowledged fresh native value.

## 2026-07-14 - Verify persisted authority after triggerable writes

- A successful SQLite statement execution does not prove its intended row survives: `RAISE(IGNORE)` can suppress an insert and AFTER triggers can delete or rewrite it. Treat the exact post-write row as the authority, not the attempted statement or change count.
- Reread and bounded-decode the full intended authority tuple before commit. A missing or mismatched row must abort the owned transaction so trigger side effects cannot escape with a false-success response.

## 2026-07-14 - Reconcile implementation against the current frozen contract

- A previously reviewed checkpoint can still encode an older plan revision. Before extending it, compare every existing public signature and lifecycle assumption with the current frozen source of truth rather than inheriting prior review prose.
- Provider locators are durable path-free metadata identities, so reconciliation must remain readable and mutable after a home is removed; home registration is optional validation context, not reconciliation authority.
- Return the exact post-write reconciliation row for require/ack CAS operations, and reread it inside the owned transaction. Nullable equal acknowledgement pairs represent authoritative deletion/invalid state and must not be rejected merely because an older latch stored a non-null native fingerprint.

## 2026-07-14 - Preserve allocation tombstones across additive schema versions

- An active generation plus nullable staging generation cannot remember an aborted allocation, so deriving the next generation from visible cache state permits ABA reuse.
- Preserve the historical migration byte-for-byte and append a monotonic allocation watermark in a new version. Abort, conflict cleanup, promotion, and cache clearing retain that watermark; only a successful begin/takeover advances it.
- A reviewed migration is not complete while its frozen plan still names the old version as latest. Update DDL sketches, lifecycle invariants, overflow behavior, and migration gates before handing the next checkpoint to another implementer.

## 2026-07-14 - Distinguish domain refusal from suppressed SQLite writes

- A missing `RETURNING` row is not automatically the method's domain error. Prove capacity and CAS preconditions first; inside the owned writer transaction, an otherwise impossible missing row indicates trigger suppression or persisted-state corruption.
- Add real BEFORE `RAISE(IGNORE)` tests as well as AFTER delete/rewrite tests. The former certifies suppression classification, while the latter certifies exact post-write authority and rollback.

## 2026-07-14 - Fence stage identity against both state and cache

- A monotonic epoch row is necessary but not sufficient when cache generations are not foreign-keyed to sync state. Before allocating, fail closed if missing/idle sync authority would let cache at or beyond the visible allocation boundary survive into a reused identity.
- Lease renewal must be monotonic across process/config restarts. A shorter newly configured lease may advance the heartbeat but must preserve a later existing expiry rather than shortening ownership.
- Snapshot scope/handle inputs and provider-home authority before callbacks, recheck the exact stored home inside the owned transaction without filesystem work, then reread the complete sync row after every write. Trigger suppression, deletion, or rewriting is corruption, not successful ownership.

## 2026-07-14 - Prove scope isolation and every SQL mutation branch

- Composite-key SQL is not fully certified by single-scope tests. Reuse the same generation, token, and native task ID in two homes, snapshot the untouched scope's sync/cache/durable rows, and compare them byte-for-byte after destructive recovery operations.
- An INSERT trigger matrix does not certify an UPSERT/UPDATE branch. Exercise idle allocation and expired takeover separately with BEFORE-ignore, AFTER-delete, and AFTER-rewrite triggers.
- When recovery deletes staged cache before updating ownership, every induced UPDATE failure must prove transaction rollback restores both the exact sync row and the abandoned cache rows.

## 2026-07-14 - Scope reentrancy guards to the shared mutable connection

- An instance-local guard does not protect a shared SQLite handle: a callback can construct or retain a second store over the same object and mutate while the outer store believes it has exclusive sequencing.
- Key mutation guard state by the exact connection object in a module-private `WeakMap`, and release it in `finally`. This shares authority without retaining closed connections or coupling independent handles.
- Reentrancy tests must use two store instances, snapshot cache and durable state as well as sync authority, assert exact callback counts and stable outer error mapping, then prove both post-failure release and cross-database independence.

## 2026-07-14 - Verify staged writes as exact generation replacements

- Verifying only the requested task rowset does not catch a hostile trigger that writes the requested row and injects a sibling task. Snapshot the bounded generation census and target-task census before mutation, derive the exact post-replacement census, and require that delta before commit.
- Capacity is a property of the final deduplicated generation, not the incoming payload in isolation. Enforce it after replacement inside the owned transaction so rollback restores both cache and lease authority.
- When extracting internal SQL helpers, preserve their stable failure identity through the transaction owner as well as the public boundary. Otherwise a domain `CAPACITY` or `CORRUPT_ROW` can be accidentally flattened into `DATABASE_UNAVAILABLE` during rollback.

## 2026-07-14 - Keep cache proof bounded and provenance internal

- A public error class cannot prove failure provenance because hostile caller code can construct it. Convert preparation to a private discriminated result at the codec/store boundary, and translate that result into the store's unforgeable internal failure before callbacks or SQL.
- Min/max/count does not prove ordinal uniqueness: compensated duplicates such as `[0,0,2]` satisfy all three. Require the distinct-ordinal count to equal the total row count as an independent invariant.
- Promotion is a replacement boundary, so retirement must remove every other same-scope generation, including corrupt future rows. Postcheck `generation <> promoted`, and test a trigger that recreates a deleted future row plus exact cross-scope rollback.
- Census and existence checks must not materialize staged child rows. Use SQL COUNT/EXISTS and arithmetic deltas; enumerate only one incoming-bounded snapshot rowset with an extra sentinel row to detect stored expansion.
- When summary hash fields match a complete staged snapshot, rewriting only the task observation splits task and receipt authority. Renew the lease while preserving the entire snapshot subtree byte-for-byte.

## 2026-07-14 - Treat active cache reads and destruction as integrity boundaries

- Decode active snapshots from an aggregate task census, then fetch each child table with exactly one bounded sentinel row. Recompute writer-equivalent event, receipt, and snapshot identities before returning any part of the task.
- A count-only census cannot detect same-count sibling rewrites. For triggerable SQLite mutations, combine exact target/sync postconditions with a guarded-connection bigint `total_changes()` delta; for broad scopes, keyset-decode one authority row at a time rather than materializing an unbounded `.all()` result.
- Decode persisted CWD and its redaction bit as one authority pair. Feeding a stored redacted `NULL` back through the writer's input projection erases provenance and falsely classifies a valid cache row as corrupt.
- Stable cache pagination belongs in parameterized SQL: join only the current active generation, order timestamps NULL-last, bind the complete deterministic identity tuple, and fetch only `limit + 1` rows before issuing the next cursor.
- Invalidation and rebuildable-cache clearing are all-generation operations. Count before mutation, postcheck every affected cache table and sync row inside the owned transaction, preserve the monotonic generation epoch and durable tables, and keep callback-free read/keyset SQL in a private non-barrel module.
- A non-null preflight token remains mandatory authority even if concurrent state changes remove the active sync or recompute a different mutation branch inside the writer. Reject sync-null drift before any early return, then validate version, sync, census, and raw-row witnesses before branch selection or any write; never let control-flow drift bypass the fence.

## 2026-07-14 - Reclassify authority loss after a successful preflight

- The same low-level missing-authority result has different meaning across a preflight boundary: initial absence is `UNKNOWN_HOME`, but absence or mismatch after the facade captured valid authority is concurrent drift and must fail `CORRUPT_ROW`.
- Keep the translation at the facade context that owns the preflight, and accept only the primitive's private tagged failure provenance. Do not weaken the primitive's direct semantics or trust caller-shaped error codes.

## 2026-07-14 - Keep legacy mapping reads on verified authority

- A verified mapping lookup must query only the current mapping authority. Provenance is immutable history, not a fallback mapping source, and a missing provider-home registration does not invalidate an otherwise verified orphan mapping.
- When current registered-home authority exists, a native task ID that embeds the canonical home is corrupt persisted data. Reject it without returning the path-bearing locator or consulting the filesystem.
- Never trust a syntactically valid persisted canonical home as fingerprint authority. Recompute the pure provider/home fingerprint first; otherwise a decoy home can make the raw-home exclusion check validate the wrong string.
- A negative fixture must reach the branch it claims to prove. Pair intact-authority rejection with a positive control using the same valid registered home so a new earlier guard cannot silently make the intended privacy check untested.
# 2026-07-20 - Test generic task creation at the rendered provider boundary

- A pure route resolver can stay green while the selected provider renders a read-only surface. Exercise the real UI entry point and assert the provider's create form or fresh composer is mounted.
- Never pass a zero-argument command callback directly as a React click handler; wrap it so a `SyntheticEvent` cannot become an accidental runtime override.
- Every provider must consume the same new-session remount signal, including under default-on feature-flag combinations that otherwise route through read-only setup/index surfaces.
