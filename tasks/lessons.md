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
