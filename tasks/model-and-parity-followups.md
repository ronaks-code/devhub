# DevHub — model + Claude-Code parity follow-ups

Status: **paused** as of 0.1.8 (shipped 2026-07-24). This captures the work that was
queued but not built, so it can be resumed cold. Nothing here is started.

## Context: what shipped in 0.1.8

Model catalog updated to the current lineup for both providers:
- Claude: `claude-sonnet-4-6` (retired) → `claude-sonnet-5`. Opus 4.8 / Haiku 4.5 /
  Fable 5 unchanged.
- OpenAI/Codex: offered set is now the GPT-5.6 family — `gpt-5.6` (Sol, default),
  `gpt-5.6-terra`, `gpt-5.6-luna`. Prior ids (`gpt-5.4*`/`gpt-4.1*`/`o3`/`o4-mini`)
  retained only for back-compat validation of stored sessions; no longer offered.
- `normalizeClaudeModel` added at the `claude --model` launch boundary
  (`packages/engine/src/driver/cli.ts`) so a persisted retired default remaps forward.

Model-id definitions live in these places (keep in sync when adding a model):
- `apps/web/src/lib/models.ts` — the picker catalog (`CLAUDE_MODELS`, `CODEX_MODELS`).
- `packages/engine/src/openai-session.ts` — the `OpenAIModel` union + its default.
- `packages/server/src/routes/openai.ts` — the `MODELS` JSON-schema `enum` allowlist
  (rejects any id not listed — must include a new id or the OpenAI-chat surface 400s).
- `apps/web/src/components/OpenAIPane.tsx` — the dev-only "OpenAI Chat" dropdown.
- `packages/engine/src/pricing.ts` + `apps/web/src/lib/pricing.ts` — cost rows
  (unknown ids fall back to `FALLBACK_PRICING`, so a missing row is harmless).
- Legacy Claude lists (also hardcoded): `apps/web/src/App.tsx`
  (`LAUNCHPAD_CLAUDE_MODELS`), `apps/web/src/components/ChatPane.tsx`,
  `apps/web/src/components/SettingsPane.tsx`. Candidates to collapse into
  `lib/models.ts` to kill the duplication (see item 3).

## 1. Re-validate the stored default model on a mechanics switch (bug)

**Problem:** switching `defaultMechanics` (claude ⇄ codex) changes only the mechanics.
The stored `defaultModel` is not re-checked against the new provider's valid set, so a
Codex id can remain stored while mechanics is Claude. The Settings picker masks it
visually (it shows the provider's first model when the stored id isn't in the list —
`SettingsRoute.tsx` ~L775), but the raw stored value is still what flows to launch:
`App.tsx` ~L1928 → `ChatHost.tsx` ~L368 → `driver/cli.ts` forwards it as
`claude --model <codex-id>`, a wrong-provider request.

**Fix (proposed):** on mechanics change, coerce `defaultModel` to a valid id for the
new provider (e.g. that provider's first `modelsForMechanics()` entry) if the current
value isn't in the new list. Do it at the write in `SettingsRoute` mechanics handler,
and/or defensively at the launch boundary (a `providerFromModel(model) !== mechanics`
guard in `driver/cli.ts` / the codex path). Prefer fixing at the settings write so the
stored value stays coherent; keep the launch-boundary guard as a backstop.

**Verify:** unit test the coercion; e2e — set default to a GPT model, switch to Claude,
start a chat, assert the spawned argv's `--model` is a Claude id.

## 2. Native Codex pane ignores the app-wide default model

**Problem:** the real codex-native path (`App.tsx` ~L2500 →
`components/CodexNativePane.tsx`) initializes its own model field to `""` and
`providerCreateOverrides()` then omits `model`, so selecting a Codex default in Settings
has no effect on native Codex task creation — the user must retype it in the pane.
(The dev-only `OpenAIPane` is separate and not the real path.)

**Fix (proposed):** seed `CodexNativePane`'s model from `settings.defaultModel` when
mechanics is codex (fall back to `CODEX_MODELS[0]` = `gpt-5.6`), and pass it through
`providerCreateOverrides()`. Confirm the Codex CLI accepts the id (`gpt-5.6` family is
available on Codex as of 2026-07-09).

**Verify:** set Codex default = `gpt-5.6-terra`, open a native Codex task, assert the
create call carries that model.

## 3. (cleanup) Collapse duplicate Claude model lists

Four hardcoded copies of the Claude list exist (see Context). Import `CLAUDE_MODELS`
from `lib/models.ts` in `App.tsx` / `ChatPane.tsx` / `SettingsPane.tsx` so there's one
source of truth and the next model bump touches one file. Low risk, do alongside item 1.

## 4. Reasoning-effort selector (feature, was slated for 0.1.8)

The engine already supports `--effort` (low/medium/high/xhigh/max) in
`providers/claude/cli-process.ts`, but no UI surfaces it. Full-stack change:
- Web: an effort control in the Composer/model area; persist per-session + a default in
  Settings; show it on the `ModelBadge` (it already renders `· <Effort>` when passed).
- Server/engine: thread the chosen effort into the turn request → `--effort` arg.
- Verify: assert the spawned argv includes `--effort <value>`.

## 5. Fast-mode toggle (feature)

Expose Claude Code "fast mode" (faster Opus output; `/fast`) as an app toggle if the CLI
exposes a flag/env for it. Investigate the actual CLI switch first; if there's no
non-interactive flag, this may not be wirable and should be dropped.

## 6. Claude-Code parity sweep (audit)

Enumerate Claude Code capabilities and check each is reachable in DevHub: slash commands
(`/clear`, `/model`, `/help` done in 0.1.7; audit the rest), permission modes,
plan mode, MCP management, hooks, background tasks, image paste, `@`-mentions, worktrees.
Produce a gap list, then batch the missing ones. Scope to a fresh spec doc when picked up.

## Verify bar (whole repo)

`pnpm -s typecheck` (5 pkgs) · web ~759 tests · engine ~2251 tests · server ~301 tests ·
`pnpm --filter @devhub/web build`. Adversarial cross-model review on any real change
(Codex can't write devhub — use it read-only for review). Ship = bump the 4 version
fields (`apps/desktop/package.json`, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock` `app`
crate), commit, tag `vX.Y.Z`, push tag (auto-triggers `release.yml`; fall back to
`gh workflow run release.yml --ref vX.Y.Z` if the push trigger doesn't fire). Confirm
`releases/latest/download/latest.json` resolves to the new version with a signature.
