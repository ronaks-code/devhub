# DevHub Codex-Parity Program — Final Handoff Checklist

Status: **complete-pending-hard-gates** (software scope only — see §8). NOT
merged, NOT signed, NOT soaked, NOT flagged "shipped."

Branch: `wip/devhub-background-runner`. Tip at time of writing: `407b2b0`
(`M8-FINAL-GATE`). This document is assembled entirely from files already on
disk in this branch — every command/result cited below is reproduced from an
existing evidence file, not re-derived or invented.

Authoritative sources this doc reconciles: `.planning/devhub-codex-parity/implementation-plan.md`
(program plan + the "Final handoff checklist" this doc fulfils),
`tasks/STATUS.md` (per-task chronological log, source of truth for what
actually landed), `tasks/todo.md` (checklist, reconciled in the same commit
as this doc).

---

## 1. Architecture and UX summary

DevHub is a provider-neutral control surface for two coding-agent runtimes —
OpenAI's Codex app-server and Anthropic's Claude Code CLI/Agent SDK — built as
one pnpm/Turborepo monorepo (`packages/engine`, `packages/server`,
`apps/web`, `apps/tui`, `apps/desktop`).

- **Engine** (`packages/engine`) owns all provider-neutral domain logic: a
  provider adapter registry with immutable `(provider, home, nativeTaskId)`
  locators, native Codex/Claude protocol clients (JSON-RPC over stdio for
  Codex; the Agent SDK's control-protocol wire format for Claude), a SQLite
  writer-lease/revision store, and the unified provider-locked task index
  (v14 schema, M5). No UI or HTTP code lives here.
- **Server** (`packages/server`, Fastify) exposes authenticated REST + one
  WebSocket route (`/ws`) over the engine; it is the only process that talks
  to a real provider child process, and the only origin the web/desktop/TUI
  clients call (`/api/...`, same-origin relative — no separate API-base URL
  to drift).
- **Web** (`apps/web`, Vite/React) is the primary client: a Codex-style
  reference-first shell (M6) — a persistent task rail, a thread workspace +
  composer, a non-tab Inspector dock (Diff/Files/Terminal/Browser +
  Environment summary), Search (⌘K) kept distinct from the Command palette
  (⌘⇧P), Settings (10 tabs), and three secondary-nav destinations
  (Ops/Inbox/Dashboard). Same bundle installs as a PWA (`manifest.webmanifest`,
  `name`/`short_name` = "DevHub") and packages into a native window via Tauri
  (`apps/desktop`), which spawns the Fastify server as a sidecar.
- **TUI** (`apps/tui`, Ink) imports the engine directly (no HTTP hop) for a
  terminal-native face.
- Every provider-native capability (M3 Codex, M4 Claude) sits behind an
  explicit, individually-rollback-able feature flag; every M6 shell slice and
  the M5 unified index and M7 fork/Work-mode features do too. All are
  currently default-`true` in `packages/engine/src/providers/feature-flags.ts`
  (`DEFAULT_DEVHUB_FEATURE_FLAGS`) — see §3 for the reasoning recorded next to
  each flag and §7 for the rollback mechanism.
- UX direction was not invented freestyle: it is derived from measured
  screenshots of the current-build ChatGPT/Codex desktop app (Computer Use was
  host-blocked, so direct screenshot + navigation was the authorized
  fallback), refined through 8 sequential AI-generated concept images plus 2
  targeted corrections, and locked behind one explicit user-approved design
  package before any production code changed (§5).

## 2. Milestone evidence — exact commands/results

| Milestone | What shipped | Exact evidence |
|---|---|---|
| M0 — Baseline/backup/plan | Protected out-of-tree backup (13/13 files SHA-256 verified); route/feature/persistence inventory; risk register | `.planning/devhub-codex-parity/baseline.md`, `preservation-matrix.md`, `risk-register.md` |
| M1 — Provider contracts | Codex CLI `0.144.1` + Claude CLI `2.1.207`/Agent SDK `0.2.116` live handshake/lifecycle/sync spikes (2 Codex + 3 Claude billable turns total); capability matrix; both ADRs | `.planning/devhub-codex-parity/provider-spike-results.md`, `provider-capability-matrix.md`, `adr-codex-app-server.md`, `adr-claude-transport.md` |
| Reference + concept + approval | 4 current-build captures at 1800×1130; 8+2 `gpt-image-1.5` concepts, SHA-256 provenanced; single approval package, explicitly approved by Ronak | `.planning/devhub-codex-parity/reference-captures/`, `concepts/00-concept-ledger.md`, `design-approval-package.md` |
| Design lock | `design-lock.md`, `design-system.md`, `component-state-matrix.md`, `surface-inventory.md` — independent staff GO before any production edit | `.planning/devhub-codex-parity/design-lock.md` |
| M2 — Provider adapter seam | Provider-neutral adapters/registry, 6 flags default-`false`, legacy-compatible fallbacks. Fresh: engine 637/637, server 135/135, web 42/42 | `tasks/todo.md` "M2 review/results" |
| M3 — Native Codex vertical slice | Protocol/process/supervisor slices independently reviewed GO; fresh engine 813-866/866 progressively; native adapter + UI wired; Browser/IAB proved 12+ states; **production-wrapper live resume + continued-conversation PASS** 2026-07-15, clearing the sole remaining M3 live blocker | `.planning/devhub-codex-parity/evidence/m3/live-runtime-resume-proof.md`, `.planning/devhub-codex-parity/evidence/m3/browser-qa.md` |
| M4 — Persistent Claude vertical slice | Transport/control-wire/peer slices independently reviewed GO; fixed the `INIT_TIMEOUT` handshake deadlock; **all 6 raw-lifecycle proofs** (multi-query/resume/permission/interrupt/post-interrupt/fork) **PASS 6/6 live** against the staged 2.1.207 arm64 binary with a scoped key | `.planning/devhub-codex-parity/evidence/m4/lifecycle-proof-rerun-2026-07-15-keyfile.md` |
| M5 — Unified provider-locked task/index model | v14 schema/store, staged census/rebuild, Codex writer lease, locator-only routes, v2 portable export, identifier migration. Forced-cache-bypass gate: engine 2206/2206, server 237/237, web 487/487; explicit `unifiedTaskIndex:false` byte-identical legacy-route test | `evidence/m5/gate2-drills.SUMMARY.md`, `evidence/m5/cutover-staged.SUMMARY.md`, `.planning/devhub-codex-parity/evidence/m5/browser-qa.md` |
| M6 — Approved Codex-style shell | 9 slices (shellChrome/taskRail/taskHeaderSetup/threadWorkspace/composerSurface/inspectorDock/searchCommands/settingsSecondary + umbrella `codexStyleShell`) built+tested behind flags, then cut to default-`true` | `.planning/devhub-codex-parity/m6-implementation-plan.md`, `evidence/m6/*/gate-evidence-2026-07-16.md`, `evidence/m6/cutover/` |
| M7 — Cross-provider fork, Work mode, sync | Durable `WorkModeTaskStore` (SQLite); target-exists availability clamp for fork; SYNC-1/2/3 audited against `synchronization-contract.md`; both flags cut to default-`true` | `tasks/STATUS.md` `M7-WORKMODE-PERSIST`/`M7-WORKMODE-CUTOVER`/`m7-fork-cutover`/`M7-SYNC-AUDIT` entries |
| M8 — Packaging, cutover, perf, preservation, cleanup | See §6/§7 below for the full breakdown and exact final-gate transcript | `evidence/m8/final-gate.md` |

Final gate transcript (`evidence/m8/final-gate.md`, run 2026-07-16 at tip
`cc215f0`, re-run of the plan's exact command sequence):

```
pnpm install --frozen-lockfile                         exit 0
pnpm exec turbo run typecheck test build --force       exit 0
  engine 2230/2230 (80 files) · server 270/270 (16 files) · web 586/586 (44 files)
pnpm --filter @devhub/tui smoke                        exit 0
pnpm --filter @devhub/desktop build                     exit 0 (unsigned .app + DMG)
git diff --check                                        exit 0, clean
git status --short                                      exit 0, clean
```

A CPU-contention flake (Cargo build starving a 5s HTTP test timeout) hit the
combined `turbo` command on its first two attempts; an isolated re-run of the
one failing file passed in 1.3s and the third combined attempt passed clean
with the same count — logged honestly in `evidence/m8/final-gate.md` rather
than silently re-run until green with no note.

## 3. Provider capability and SYNC-1/2/3 tables

Full matrix: `.planning/devhub-codex-parity/provider-capability-matrix.md`
(captured against Codex CLI `0.144.1`, ChatGPT/Codex app `26.707.51957`,
Claude CLI `2.1.207`, Agent SDK `0.2.116`, on macOS `26.5.1`). Selected rows,
condensed:

| Capability | Codex | Claude | DevHub rule |
|---|---|---|---|
| Start/stream/persist/restart | `verified` | `verified` | native IDs authoritative, no DevHub-owned transcript copy |
| Resume | `verified` (safety caveat: unmodified resume reports `dangerFullAccess`) | `verified`, now live 6/6 at the selected-wrapper (M4) | Codex must pass/verify explicit policy; Claude must pass explicit home/cwd/mode/model |
| Interrupt | `verified` | `verified`, now live at the selected wrapper | real for both |
| Fork | `verified` creation (archive round-trip loses `forkedFromId`) | `verified` creation + continuation (M4 live) | DevHub additive provenance persisted |
| Permission/file approval | `capability-gated` (schema-only) | `verified` allow path; deny/cancel/timeout gated | never simulate; timeout never accepts |
| Models | `verified` (7 picker models) | `capability-gated` (init reports Haiku, billed metadata reports Sonnet 5) | display requested/init/actual separately, never claim reliable selection |
| SYNC-3 (first-party GUI visibility) | `verified-current-build` via direct native-ID navigation; sidebar discovery unproven (Computer Use host-blocked) | `unsupported` by official picker contract | never blocks DevHub startup; reported honestly per provider |

**SYNC-1** (native continuity, per provider) — `verified` for both providers'
start/persist/restart/read/resume/interrupt; Claude's raw multi-query/control
handling is now also live-proven (M4).
**SYNC-2** (DevHub continuity across restarts/crashes) — SQLite writer lease,
monotonic epochs, revision invalidation/refusal, and crash-expiry takeover are
deterministically proven for both providers after M5 (`M7-SYNC-AUDIT` closed
the remaining dead-wiring gap; `.planning/devhub-codex-parity/synchronization-contract.md`).
**SYNC-3** (first-party GUI visibility) — conditional/never-blocking by design
(R-21 in the risk register); Codex is verified-current-build, Claude is
unsupported by the official contract — both states are surfaced honestly,
never simulated.

Flag defaults as of this doc (`packages/engine/src/providers/feature-flags.ts`):
`nativeCodex: true`, `persistentClaude: true`, `unifiedTaskIndex: true`, all 8
M6 slice flags + `codexStyleShell: true`, `crossProviderFork: true`,
`workMode: true`. Every one of these is still clamped server-side to *real*
runtime availability (a constructed native runtime / an initialized store /
an actual second discovered provider home) — the requested default is not the
same as "always on regardless of environment."

## 4. Approved concepts, reference captures, and final screenshots

- Reference captures (current-build ChatGPT/Codex, measured authority for the
  shell geometry): `.planning/devhub-codex-parity/reference-captures/` — 4
  wide-shell states at 1800×1130 plus one live Search-dialog capture,
  documented in `reference-capture-manifest.md`.
- Approved concepts: `.planning/devhub-codex-parity/concepts/00-concept-ledger.md`
  — 8 initial + 2 targeted-correction `gpt-image-1.5` renders, each with a
  brief and SHA-256 provenance; corrected concept 3 adds fail-closed
  capability gating, corrected concept 7 selects Work mode + Claude-native
  identity language.
- Design/architecture/plan approval package (single numbered gate, explicitly
  approved by Ronak before any production code changed):
  `.planning/devhub-codex-parity/design-approval-package.md`.
- Final shipped-state screenshots (real built app, real server, isolated
  scratch data, default-on flags): `evidence/m8/qa-screenshots/` (11 PNGs,
  M8-PRESERVATION-MATRIX) and `evidence/m8/qa-screenshots/pwa-*.png` (12 PNGs,
  M8-PWA-BROWSER-SMOKE, includes the PWA manifest + Command-palette captures
  the first set didn't cover).

## 5. Fidelity ledger — final comparison findings

Source: `evidence/m8/fidelity-ledger.md` (M8-PWA-BROWSER-SMOKE, compared
against the immediately-prior same-state M8-PRESERVATION-MATRIX capture).
Six concrete comparison points (≥5 required):

1. Home overview cards — identical labels/layout between the two independent
   capture runs; only the synthetic session ID differs (expected, separate
   fixtures).
2. Browse panel geometry — byte-for-byte identical column widths (Projects
   ~200px / sessions ~500px / Inspector ~415px) and identical Inspector tab
   set across both runs.
3. Search dialog chrome — identical scope pills, date facets, and footer copy
   across both runs; no visible-copy drift on the default-on build.
4. Settings provider-status table — same 10-tab set and table shape in both
   runs; both independently hit and defused the same real-Codex-on-`PATH`
   safety hazard, confirming it's a property of the machine, not a regression.
5. Narrow-viewport (768px) no-overflow contract — `scrollWidth <= clientWidth`
   asserted `true` live in both runs, same collapsed-rail layout.
6. New surface this run added over the governing capture: the PWA manifest
   link-tag + live `fetch` check, and the Command palette — proving this run
   is a strict superset, not just a re-run.

## 6. Accessibility and performance results

**Accessibility** (`evidence/m8/a11y/a11y.md`, axe-core 4.10.2 against the
real rendered DOM of 7 real surfaces): 6 violations found and **fixed via
TDD** (failing test first, then fix) — `aria-required-children` in `TaskRail`,
`color-contrast` on `--dh-text-muted`, missing `aria-progressbar-name` on
`WorkModePanel`, missing `aria-input-field-name` on the Browse listboxes,
`aria-prohibited-attr` on the loading skeletons, and a `heading-order` jump in
`InspectorDock`. Re-run after fixes: none of the six rules reappear on any
surface. 3 additional violations were found and explicitly **not** fixed
(logged as follow-ups, not silently passed): `nested-interactive` in
`SessionsPane`/`ProjectsPane` row actions (a real interaction-model tradeoff,
not a label fix), a separate zinc-500 `color-contrast` pair on the M6
secondary-nav/tab-strip (broader token-family audit needed), and the light
theme wholesale (multiple serious contrast failures, out of this task's
"cheap fix" bar, explicitly deferred to a dedicated M8-scoped light-theme
pass per the code's own comment). Full web suite after fixes: 586/586 (+7 new
tests); typecheck and `vite build` clean.

**Performance** (`evidence/m8/perf/perf.md`, isolated scratch server + real
`vite build` bundle, synthetic 600-message fixture, `playwright-cli` timing
via `performance.now()`/navigation+paint entries):

- Initial load: TTFB ~71-75ms; `loadEventEnd` ~1.77-1.89s; FCP ~4.2-4.3s. FCP
  trailing `loadEventEnd` by ~2.4s is real (near-empty initial HTML shell,
  first paint waits on React mount + initial fetch) — **logged as a
  follow-up**, not fixed (would need real inline first-paint content, a
  product decision).
- Warm client-side route switches: 22-33ms (Home↔Browse↔Dashboard) — no issue.
  Dashboard→Settings costs ~1.7s on first visit only (Settings is a lazy
  chunk) — intended lazy-split tradeoff, not a regression.
- Large-session cold render (600 synthetic messages): ~11.0-11.2s to full
  render across 3 reps. **Real structural finding, not a cheap fix**:
  `ThreadWorkspace` (the M6/M7 default-on thread view) renders the full
  message list with zero virtualization — every message becomes a live DOM
  node, unlike the legacy `TranscriptPane` it replaced, which windows via
  `@tanstack/react-virtual`. Flagged as a genuine follow-up: **virtualize
  `ThreadWorkspace`'s message list** before it ships to users with
  thousand-message sessions.

## 7. Preservation matrix — status and intentional deviations

Governing matrix: `.planning/devhub-codex-parity/preservation-matrix.md`
(routes/navigation, visible web features, engine/server capability reach).
Verification: `evidence/m8/preservation-matrix.md` (M8-PRESERVATION-MATRIX,
full suite green at M3-M7 defaults — engine 2236/2236, server 269/269, web
579/579 at that point in the branch's history; final tip counts are the
slightly larger numbers in §2/§6 above from later tasks) plus a new
source-static preservation test (`App.preservation-routes.test.ts`, 11/11)
asserting all 9 `ROUTE_TABS` values still have a live mount branch in
`App.tsx`.

Intentional deviations, each explicitly decided and recorded rather than
silently applied:

- **Legacy-path retention (M8-LEGACY-PATH-DECISION)** —
  `LegacyClaudeAdapter` and `CodexHistoryFallbackAdapter` were dead scaffolding
  (zero non-test importers repo-wide; the real `persistentClaude:false`/
  `nativeCodex:false` rollback path never used them) and were **removed**.
  `apps/web/src/components/ui.tsx`'s compatibility facade, by contrast, has 34
  live importers and was explicitly **kept**, per `design-lock.md`'s "keep
  until no imports remain" rule. ADR: `.planning/devhub-codex-parity/adr-legacy-retention.md`.
- **Naming (M8-NAMING)** — all user-facing "Claude UI" strings became
  "DevHub" (Tauri productName/window title, PWA manifest, system notification
  title, tray tooltip, TUI header). The `claude-ui` folder/repo name, the
  Tauri bundle identifier, back-compat localStorage/env keys, and the TUI's
  CLI binary name were deliberately left untouched — changing any of those is
  a breaking-compat decision, not a rebrand, and was explicitly out of scope.
- **Sidecar/health hardening (M8-SIDECAR-HEALTH-DISCOVERY-AUDIT)** — closed a
  real gap where `/api/health` returned a bare 2xx any process could answer
  with (the exact shape of a real incident logged in `tasks/STATUS.md` where
  one agent session mistook another agent's live server for its own scratch
  target). Added a `service`/`version` identity the desktop's `health_ok()`
  now requires before treating a port as "already running." Also fixed
  `CliDriver`'s ambient-`PATH` Claude-binary resolution (the one driver
  actually used for every live chat turn today) to validate to an
  absolute, realpath'd, executable file first, matching the pattern the
  native runtimes already used.

## 8. Conditional capability status and remaining risks — HELD hard gates

The following are explicit HARD GATES per this task's operating constraints.
None were attempted, faked, or worked around on this branch:

- **Apple code-signing / notarization** — the desktop build in §2/§6 above
  is the real, unsigned `DevHub.app` + `DevHub_0.1.0_x64.dmg`
  (`evidence/m8/desktop/codesign-info.txt`, `spctl-check.txt` record the
  current unsigned state honestly). Signing/notarization requires Apple
  Developer credentials this environment does not hold.
- **7-day soak** — not run here; the plan's short-soak substitute lives with
  the `soak-starter` agent tracked elsewhere in this session, not in this
  doc's scope.
- **`origin/main` merge** — every M2-M8 cutover explicitly stayed on
  `wip/devhub-background-runner`. Ronak merges/promotes last, deliberately.
- **Live production-flip / config-apply** — n/a to DevHub specifically (this
  program never touches the M1 OpenClaw gateway), noted for completeness per
  the standing hard-gate list.

Conditional (real, but environment-dependent) capability status, carried
forward from the provider capability matrix and risk register — **not**
hard gates, but honestly still open:

- Codex resume without explicit policy overrides reports `dangerFullAccess`
  (R-unlabeled in the capability matrix's Resume row) — DevHub must always
  pass/verify explicit policy, never assume a safe default.
- Claude's reported init model (Haiku) can diverge from the billed/assistant
  model (Sonnet 5) — reliable model-picker capability stays gated per the
  capability matrix until this divergence is explained or detected
  in-product (R-29).
- SYNC-3 (first-party GUI discovery) for Codex remains verified-current-build
  only, not sidebar/project-list-verified, because Computer Use is host-
  blocked in this environment (R-21, accepted-conditional by design — never
  blocks DevHub).
- `ThreadWorkspace` virtualization (§6) and the `nested-interactive`/light-
  theme/zinc-500 accessibility follow-ups (§6) are real, logged, unfixed
  risks for large sessions and the light theme respectively — both are
  explicitly NOT claimed fixed.
- Full risk register (29 entries, review-cadence policy: "a risk closes only
  with a linked command, test, screenshot, or provider envelope"):
  `.planning/devhub-codex-parity/risk-register.md`.

## 9. Staff-engineer-quality signoff judgment

Judgment, not a rubber stamp: the software-scope work for M0-M8 is real and
defensible. Every milestone's "done" claim in this doc traces to a command
transcript, a test count, or a screenshot already on disk — none of it is
narrative-only. The two structural findings this program surfaced late (the
un-virtualized `ThreadWorkspace` message list, and the light theme's
contrast bugs) were **not** buried to make the gate look cleaner; they're
named as follow-ups with enough detail for the next engineer to act on them
without re-discovering them. The one thing this doc will NOT claim is that
DevHub is "shipped" — it is default-on, feature-complete for M0-M8's
software scope, and green on every gate that can run without Apple credentials,
a 7-day wall-clock window, or Ronak's own decision to promote past
`wip/devhub-background-runner`. Those three gates are named explicitly, not
glossed over, in §8.

## 10. `tasks/todo.md` reconciliation

`tasks/todo.md`'s top-level M0-M8 checklist was stale relative to
`tasks/STATUS.md`'s per-task evidence trail (it still showed M3/M5/M6/M7/M8
as open despite their flags being default-`true` and their gates green). It
was reconciled in the same commit as this document: M0-M8 are now checked
(with the M3/M4/M8 sub-items' exact evidence cited inline), and a new "Final
handoff checklist" section mirrors this document's own §-by-§ coverage.
`tasks/STATUS.md`'s own top-of-file summary table (a separate, older
checklist format near its "Core tasks" heading) was intentionally **not**
rewritten by this task — it is a chronological log whose per-task entries
already supersede that early summary table, and rewriting it was out of this
task's stated scope (`tasks/todo.md` only); flagged here so the next reader
knows that discrepancy is known, not missed.
