# M5 Task 9 — pre-cutover gate checks (2026-07-15)

Run on `wip/devhub-background-runner` tip `f4d27fd` (the reviewed base for the staged
cutover). All five Gate-5 checks pass.

## 1. `git diff --check`
Clean working tree; `git diff --check` and `git diff --check HEAD~1 HEAD` both clean.

## 2. Targeted secret scan
`git grep` for AWS keys / `sk-*` / PEM private keys / `ghp_*` / Slack `xox*` across
`packages/**/src`, `apps/web/src`, and `evidence/**`: NO hits in non-test source or in
any evidence artifact. The only matches are synthetic redaction FIXTURES inside
`*.test.ts` (they assert secrets get redacted, e.g. `sk-abcdEFGH1234567890zz`,
`AKIAIOSFODNN7EXAMPLE`, `xoxb-...`) — expected, not real secrets.

## 3. Raw-home fixture / evidence scan
Recursive scan of `evidence/m5/` for real home paths
(`/(Users|home|private|var|tmp)/<user>/(.codex|.claude|codex-home|claude-home)`): none.
NUL-byte scan of evidence JSON/logs: none. (Locator/response/SSE/archive surfaces are
already covered path-free by the per-slice recursive `assertNoHomeOrNul` scans in
`provider-index.test.ts`, `portable.test.ts`, and the T7 web scans.)

## 4. Generated-file check
`git ls-files` shows NO tracked build artifacts (`dist/`, `build/`, `coverage/`,
`.turbo/`, `node_modules/`) and NO emitted `*.js`/`*.d.ts` beside `*.ts` under any `src`.

## 5. Preservation hash / status check
The four user-owned paths are untouched (blob hashes recorded at `f4d27fd`):

| Path                                        | git blob sha |
|---------------------------------------------|--------------|
| `.gitignore`                                | `03479b6` |
| `AGENTS.md`                                  | `28a7929` |
| `apps/web/src/components/ChatPane.tsx`      | `cfecb54` |
| `apps/web/src/components/SlashPalette.tsx`  | `737110f` |

Preservation matrix (`.planning/devhub-codex-parity/preservation-matrix.md`) unchanged;
no feature was silently removed, no persisted meaning changed, and the cutover does not
advertise a capability its runtime cannot execute (applied truth is tied to the
coordinator actually initializing).
