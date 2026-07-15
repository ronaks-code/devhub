# M5 Task 9 gate-2 induced-failure drill suite — evidence summary

- Task: `m5-t9-drills`
- Branch: `wip/devhub-background-runner`
- Date: 2026-07-15
- Workers: 2 (`--maxWorkers=2`)
- Runner: `evidence/m5/run-gate2-drills.sh`
- Map: `evidence/m5/gate2-drills.manifest.json` (every gate-2 item -> the test(s) that induce it)

## Result — all green

| Suite  | Files | Tests | Passed | Failed |
|--------|------:|------:|-------:|-------:|
| engine |    18 |   806 |    806 |      0 |
| server |     2 |   105 |    105 |      0 |
| total  |    20 |   911 |    911 |      0 |

Machine-readable evidence: `engine-drills.json`, `server-drills.json`.
Human logs: `engine-drills.log`, `server-drills.log`.

## Flags held (unchanged)

`nativeCodex=false`, `persistentClaude=false`, `unifiedTaskIndex=false`. No provider
process is spawned by any drill — the native runtimes are never enabled.

## Full gate-2 list coverage

Every gate-2 induced-failure line item is mapped to concrete, passing drills in the
manifest:

1. v13 migration interruption
2. DB busy / write failure
3. duplicate/conflicting replay with null & repeated turn/item IDs
4. partial staging generation + hard-crash & expired-owner takeover
5. cache corruption
6. failed rebuild
7. native deletion without gzip resurrection
8. unresolved legacy collision
9. external mutation
10. stale/uncertain respond
11. durable latch restart + same-fingerprint relatch + CAS race
12. lease loss
13. provider restart
14. flag rollback (stored false -> instant legacy path, no schema down-migration)
15. invalid/unknown-fingerprint locator
16. cursor scope abuse
17. SSE events injected before/during/after snapshot + overflow + stale/foreign/malformed reconnect IDs
18. v1 quarantine import
19. v2 orphan & mapped-collision import
20. v2 secret/path scan
21. full DevHub-storage deletion + byte-equivalent rebuild

## New consolidated drill file

`packages/engine/test/provider-index/gate2-drills.test.ts` (10 tests) reproduces the
cross-cutting properties directly against the real engine APIs: v13 migration
recovery, flag-rollback no-down-migration, DB-busy fail-closed + recovery,
invalid/unknown-fingerprint locator rejection, cursor scope abuse, and a path-free
fingerprint sanity check. The rest of the corpus is the RED-first adversarial suites
built across the M5 slices.

## Reproduce

```
bash evidence/m5/run-gate2-drills.sh
```
