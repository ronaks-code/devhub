# Shared heavy-wrapper cutover evidence

Date: 2026-07-13

Scope: the Mac-wide FIFO coordination wrapper shared by DevHub, Hermes, Capture, and Nerve. This is operational evidence for the QA gates; it is not a DevHub product feature.

## Reviewed artifacts

- Canonical stable launcher after cutover: SHA-256 `72d21eb32b47c7be8fa3807d34b74aa4b1e58e169d221e42fe63abbf2819c8af`, mode `0500`.
- Selected immutable D implementation: SHA-256 `ce43d9efad1049d8208ef1bfcab18e9c98f26aab202c3829c8d1219e66c230f7`, mode `0500`.
- Maintenance implementation: SHA-256 `b09ea1d4d26670578667faac0b5dd756920a3618998a4c270fa0ff9dc87b89af`, mode `0500`.
- One-shot lock-holding migration supervisor: SHA-256 `ae86fbd07625b45b8a5a1261ef0a445c347bce460a34ef4ee9a86892b4735fad`, mode `0500` when executed. Its exact bytes are retained for audit as non-executable `evidence/ops/ronak-codex-heavy-cutover-20260713d.sh` (repository mode `0644`); it is a historical one-shot artifact and must not be reused.

The final D review returned GO with no P1/P2 finding. One P3 remains: an extreme SIGKILL window can leave harmless token-specific observation residue, but it cannot wedge FIFO, duplicate audit events, or damage completed archives.

## Cutover procedure and proof

1. Admissions were atomically frozen on the reviewed maintenance implementation. A canonical run probe returned `75`; owner and queue were empty.
2. One supervisor continuously held the legacy registration, kernel, audit, and new state locks while it repeated process/FD/artifact drain checks, installed the reviewed launcher, created `completed-events` mode `0700`, migrated `next-sequence` to mode `0600` without changing inode `90241108` or content `7\n`, and created the audit counter mode `0600` seeded above every historical timestamp.
3. The supervisor proved the pre-cutover audit inode `91350682`, size `10,168`, and SHA-256 `ba1789ca86dae05653e587bfc71360df94b9e69392261467a2af10125c7a5b34` unchanged before making pointer-to-D its final mutation.
4. Canonical D status reported ready. The unique smoke `devhub-wrapper-cutover-smoke-20260713d` waited `377 ms`, ran `/usr/bin/true`, and exited `0`.
5. The original `10,168`-byte audit prefix remained byte-identical. Exactly three new exact-key events were appended in `waiting` -> `running` -> `done` order. The audit checkpoint was `86` valid lines: `71` exact-schema and `15` preserved historical extended events.
6. The completed ledger and release archive were bound to the smoke token/task/sequence/timestamps. Owner, waiters, temporary artifacts, wrapper PIDs, and open FDs were absent; all four locks were simultaneously available nonblocking.
7. An independent post-cutover witness returned explicit canonical GO, after which Capture, Nerve, and Hermes were told to use only the canonical launcher with an explicit `RONAK_CODEX_CHAT`.

## Historical incident

The superseded H implementation had previously rewritten the then-current JSONL during a normalization migration. The pre-rewrite original bytes were not retained and cannot be reconstructed. The D cutover did not rewrite or normalize the surviving history: it preserves the historical extended lines and makes only future events conform to exact `{ts,chat,task,status}` shape.

On any future structural migration failure, admission must remain frozen on maintenance; do not roll back to H or invoke immutable implementations directly.
