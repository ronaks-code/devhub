# Reusable Lessons

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
