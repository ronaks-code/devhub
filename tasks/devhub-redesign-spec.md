# DevHub Redesign Spec — "Aurora Cockpit"

**Status:** SOURCE OF TRUTH for the redesign build. 2026-07-20.
**Scope:** visual + structural redesign. Keep ALL existing functionality and data wiring. No feature rewrites. Small, coherent diffs.
**Goal #1:** kill the "two apps glued together" feel. One shell, one token system, one visual language: warm purple-charcoal, tasteful glassmorphism, t3.chat-clean legibility.

Mockup references live at `/Users/ronak/.claude/jobs/977ae4f4/tmp/devhub-gallery/<aspect>/opt-N.html` (static HTML; open in a browser). Owner-picked options are cited per section. When this spec and a mockup disagree, this spec wins.

---

## ⚠ CORRECTIONS — verified against the real code during Phase 1 (these OVERRIDE the sections below)
The original data inventory was partly wrong. All Phase-2 agents + reviewers MUST honor these:
1. **`ActivityTimeline.tsx` is NOT dead — do NOT delete it.** `ThreadWorkspace.tsx:227` imports and renders it. Ignore §2.2.3 / §5's delete instruction.
2. **`SessionSummary` has NO `provider` and NO `status` field** (§3.1 was wrong). It has: `title`, `gitBranch` (nullable), `lastTimestamp`, `costUsd`, `model`, `usage`, `projectId` (NOT `projectName`). Legacy sessions are implicitly `provider=anthropic` via `LEGACY_SESSION_PROVIDER`; native Codex sessions are a SEPARATE `CodexSession` type, not in the `sessions` array. Derive provider/status from these sources — never render an invented field.
3. **App.tsx does NOT poll `running`/`stats` at root.** Status groups (Running/Needs review/Idle), needsYou/running pills, and the budget spend-meter require joining `api.running()` / `useStatsPolling`, which Phase 1 adds as a NEW app-root poll. Phase-2 leaf routes consume that; do not add a second competing poll. Any element whose data source is absent must not render (no placeholder lies).

---

## 0. Diagnosis (why it feels like two apps)

Verified against the code (not guessed):

1. **Two chrome generations coexist at runtime.** `App.tsx` (2369 lines) always mounts `AppShell` (`components/features/shell/AppShell.tsx`), which switches between a `legacy` inline chrome (old TopBar + `w-44` rail) and the newer `DevHubShell` based on `settings.devHubFeatures.shellChrome`. All flags default `true` (`packages/engine/src/providers/feature-flags.ts:82-144`), so **DevHubShell IS the live default** — but until `/api/settings` resolves, `settings` is `null` and every `resolve*Mode()` returns `"legacy"`, so users see the old chrome flash on every launch, then it swaps. That flash alone reads as "two apps."
2. **Two token systems.** Legacy zinc/clay tokens (`--bg: #09090b`, `--accent: #d97757`) vs the M6 `--dh-*` neutral-gray palette (`--dh-canvas: #181818`). Legacy panes (Browse internals, dialogs, toasts) render zinc; DevHub chrome renders gray. Neither is the purple-charcoal the owner loves.
3. **Per-view chrome drift.** Dashboard/Ops/Inbox/Settings each wrap themselves in `SecondaryNav`; Chat has its own header; Browse has `ResponsiveShell`'s 3-pane layout. Spacing, headers, and status affordances differ per view.

**Non-problem:** `ResponsiveShell.tsx` is NOT a competing app shell. It is the Browse tab's inner 3-column layout (projects/sessions/transcript), mounted *inside* DevHubShell at `App.tsx:2043`. It stays (restyled).

---

## 1. Design System

### 1.1 Token strategy — retint, don't rename

The elegant move: **feature components already consume `var(--dh-*)` and legacy components consume `var(--bg)`/`var(--panel)`/etc.** We change the *values* of both layers to the same purple-charcoal palette and add a new glass layer. Every surface in the app — including rollback-path legacy components — retints in one file. No component hunt.

All changes below happen in `apps/web/src/index.css`.

#### A. New palette values for EXISTING tokens (dark, `:root, :root[data-theme="dark"]`)

Legacy semantic layer (lines ~28-58) — **change values, keep names**:

```css
--bg: #131017;            /* was #09090b (zinc-950) — deep purple-charcoal void */
--panel: #1a1521;         /* was #18181b — warm panel */
--panel-soft: rgba(26, 21, 33, 0.5);
--elevated: #241d30;      /* was #27272a — hover/raised */
--border: #2a2337;        /* was #27272a */
--border-soft: rgba(42, 35, 55, 0.8);
--text: #ece7f4;          /* was #f4f4f5 — warm ink */
--text-muted: #a99fbb;
--text-dim: #6f6583;
--text-faint: #554c68;
--accent: #a78bfa;        /* was clay #d97757 — violet is now the brand accent */
--accent-hover: #8b6cf0;
--accent-fg: #17121f;     /* dark text on violet */
--accent-soft: rgba(167, 139, 250, 0.14);
--danger: #ff6b5e;
--warning: #f0b25e;
--success: #4fd6a4;
```

Keep `--color-clay-*` defined (a few components reference clay directly) but treat clay as **deprecated**; new code never uses it.

DevHub `--dh-*` layer (lines ~70-115) — **change values, keep names**:

```css
--dh-canvas: #151119;          /* was #181818 */
--dh-header: rgba(26, 21, 34, 0.6);   /* was #181818 — header is now translucent glass */
--dh-rail-inactive: #14101a;   /* was #202020 — icon rail, darkest chrome */
--dh-rail-active: rgba(167, 139, 250, 0.13);  /* was #404040 */
--dh-surface: #1e1927;         /* was #2d2d2d */
--dh-user-bubble: #221a2f;     /* was #242424 (gradient overlay comes from --dh-chat-*, §1.4) */
--dh-control: #191420;         /* was #262626 — inset input/control wells */
--dh-control-seam: #251e33;    /* was #252525 */
--dh-selected: #282239;        /* was #313131 */
--dh-hover: #221c2f;           /* was #2a2a2a */
--dh-pressed: #2e2540;         /* was #383838 */
--dh-scrim: rgb(10 6 18 / 0.65);
--dh-text-strong: #f5f2fa;
--dh-text: #ded7ec;
--dh-text-muted: #a99fbb;      /* keep >= 4.5:1 on all dh surfaces (M8 a11y rule stands) */
--dh-text-disabled: #6b6182;
--dh-border-subtle: #262031;
--dh-border: #342c47;
--dh-border-rail: #2c2439;
--dh-focus: #a78bfa;           /* was #8ab4f8 blue — violet focus ring */
--dh-link: #b9a2ff;            /* was #86b9f9 */
--dh-success: #4fd6a4;
--dh-warning: #f0b25e;
--dh-danger: #ff6b5e;
--dh-diff-add: #4fd6a4;
--dh-diff-remove: #f2708c;
--dh-brand: #a78bfa;           /* was clay #d97757 */
--dh-provider-openai: #4fd6a4; /* mint — Codex/OpenAI identity */
--dh-provider-anthropic: #ff7f6e; /* coral — Claude identity */
--dh-access-elevated: #f0b25e;
```

Contrast rule (carried over from M8): status/provider color is never the only signal — always pair with text or an icon. `--dh-text-muted` must stay ≥ 4.5:1 on every dh surface (the values above pass; verify with axe after landing).

#### B. NEW glass + accent tokens (add a new block after the dh layer)

```css
:root, :root[data-theme="dark"] {
  /* Aurora backdrop — the ambient wash behind main surfaces */
  --dh-aurora:
    radial-gradient(900px 600px at 12% -10%, rgba(139, 108, 240, 0.20), transparent 60%),
    radial-gradient(700px 500px at 95% 8%, rgba(244, 114, 140, 0.09), transparent 55%),
    radial-gradient(1000px 800px at 50% 115%, rgba(139, 108, 240, 0.12), transparent 60%),
    linear-gradient(160deg, #181322 0%, #14101a 45%, #171223 100%);
  /* Quieter wash for chrome-adjacent routes (dashboard/ops/settings) */
  --dh-aurora-soft:
    radial-gradient(1100px 600px at 78% -10%, rgba(139, 92, 246, 0.14), transparent 62%),
    radial-gradient(900px 540px at -8% 108%, rgba(244, 114, 182, 0.07), transparent 60%),
    linear-gradient(168deg, #191424 0%, #15111c 52%, #171226 100%);

  /* Glass recipe — chrome grade (sidebar, top bar, status bar, nav) */
  --dh-glass-chrome-bg: rgba(26, 20, 36, 0.55);
  --dh-glass-chrome-blur: 20px;
  /* Glass recipe — surface grade (cards, panels, inspector) */
  --dh-glass-bg: rgba(38, 30, 52, 0.45);
  --dh-glass-blur: 20px;
  /* Glass recipe — vibrant grade (chat panes, composer, hero cards) */
  --dh-glass-hi-bg: rgba(44, 34, 62, 0.60);
  --dh-glass-hi-blur: 28px;

  --dh-glass-border: rgba(167, 139, 250, 0.14);
  --dh-glass-border-hi: rgba(167, 139, 250, 0.28);
  --dh-glass-highlight: inset 0 1px 0 rgba(255, 255, 255, 0.05);
  --dh-glass-shadow: 0 16px 48px rgba(10, 6, 18, 0.5);
  --dh-glass-shadow-float: 0 20px 50px rgba(8, 5, 16, 0.65);

  /* Warm accent pair (Claude-coral + rose) used for gradients & live states */
  --dh-coral: #ff7f6e;
  --dh-rose: #f2708c;
  --dh-violet: #a78bfa;
  --dh-violet-deep: #8b6cf0;
  --dh-grad-brand: linear-gradient(135deg, var(--dh-violet-deep), var(--dh-rose));
  --dh-grad-warm: linear-gradient(135deg, var(--dh-coral), var(--dh-rose));

  /* Chat-surface vibrancy (see §3.3) */
  --dh-chat-user-bubble: linear-gradient(140deg, rgba(139,108,240,.24), rgba(244,114,140,.14));
  --dh-chat-user-border: rgba(167, 139, 250, 0.30);
  --dh-chat-ai-bubble: rgba(255, 255, 255, 0.028);
}
```

**The canonical glass recipe** (write it as utility classes in index.css; components use the classes, not raw values):

```css
.glass-chrome {  /* sidebar, top bar, status bar */
  background: var(--dh-glass-chrome-bg);
  backdrop-filter: blur(var(--dh-glass-chrome-blur)) saturate(1.2);
  border: 1px solid var(--dh-glass-border);
  box-shadow: var(--dh-glass-shadow), var(--dh-glass-highlight);
}
.glass-card {    /* dashboard cards, ops tiles, settings tables, inspector */
  background: var(--dh-glass-bg);
  backdrop-filter: blur(var(--dh-glass-blur)) saturate(1.25);
  border: 1px solid var(--dh-glass-border);
  border-radius: var(--dh-radius-inspector); /* 16px */
  box-shadow: 0 18px 46px -18px rgba(0,0,0,.55), var(--dh-glass-highlight);
}
.glass-hi {      /* chat panes, floating composer */
  background: var(--dh-glass-hi-bg);
  backdrop-filter: blur(var(--dh-glass-hi-blur)) saturate(1.4);
  border: 1px solid var(--dh-glass-border-hi);
  box-shadow: var(--dh-glass-shadow-float), inset 0 1px 0 rgba(255,255,255,.07);
}
```

Performance guard: `backdrop-filter` layers are capped at **the 3 shell chrome pieces + visible cards**. Never nest glass inside glass more than one level. Respect the existing `useReducedMotion`/perf preference: when perf-reduced is on, swap `backdrop-filter` for solid `--dh-surface` via a `[data-perf="reduced"]` rule.

#### C. Light theme (`:root[data-theme="light"]`, replaces the zinc-light blocks at ~578/633/671)

Lavender paper, same structure. Keep `color-scheme: light`, keep the `useTheme` mechanism (`data-theme` attr + `.dark` class) untouched.

```css
--bg: #f4f2f9;  --panel: #ffffff;  --elevated: #ece8f5;
--border: #ddd6ec; --text: #241e31; --text-muted: #5f5675; --text-dim: #8b81a3;
--accent: #7c5cf0; --accent-hover: #6a4ae0; --accent-fg: #ffffff;
--dh-canvas: #f4f2f9; --dh-surface: #ffffff; --dh-control: #edeaf6;
--dh-text-strong: #17121f; --dh-text: #2c2540; --dh-text-muted: #5f5675;
--dh-border: #d8d0e8; --dh-focus: #7c5cf0; --dh-link: #6a4ae0;
--dh-coral: #e8604d; --dh-rose: #d94f74; --dh-violet: #7c5cf0; --dh-violet-deep: #6a4ae0;
--dh-glass-chrome-bg: rgba(255, 255, 255, 0.62);
--dh-glass-bg: rgba(255, 255, 255, 0.55);
--dh-glass-hi-bg: rgba(255, 255, 255, 0.72);
--dh-glass-border: rgba(124, 92, 240, 0.14);
--dh-glass-border-hi: rgba(124, 92, 240, 0.26);
--dh-glass-shadow: 0 16px 48px rgba(60, 40, 110, 0.10);
--dh-aurora:
  radial-gradient(900px 600px at 12% -10%, rgba(124, 92, 240, 0.10), transparent 60%),
  radial-gradient(700px 500px at 95% 8%, rgba(217, 79, 116, 0.05), transparent 55%),
  linear-gradient(160deg, #f7f5fc 0%, #f2eff8 100%);
```

Status colors darken for contrast on light: success `#0e9f6e`, warning `#b07617`, danger `#dc3d2f`, provider-anthropic `#e8604d`, provider-openai `#0e9f6e`.

#### D. Typography scale

Sans: `-apple-system, "SF Pro Text", Inter, system-ui, sans-serif` (body). Mono: keep existing `--font-mono`. Define as tokens + use consistently:

| Token | Size / weight | Use |
|---|---|---|
| `--dh-font-h1` | 17px / 680, letter-spacing -0.01em | route titles ("Usage & Cost", session title) |
| `--dh-font-h2` | 13px / 650 | card/panel headings |
| `--dh-font-body` | 13.5px / 400, line-height 1.65 | chat prose, descriptions |
| `--dh-font-ui` | 12.5px / 500 | nav items, buttons, rows |
| `--dh-font-sub` | 11px / 500 | metadata sublines |
| `--dh-font-label` | 10px / 700, letter-spacing .1em, uppercase | group headers ("RUNNING", "WORKTREES") |
| `--dh-font-mono-ui` | 10.5px mono | paths, branches, costs, timestamps |
| `--dh-font-kpi` | 31px mono / 600, letter-spacing -1px (hero 38px) | dashboard KPIs |

Numbers everywhere get `font-variant-numeric: tabular-nums`.

#### E. Spacing, radii, borders, states

- Spacing: 4px base scale — 4/8/12/16/20/24. Shell gutter stays `--dh-shell-gutter: 16px`. Rows: 8-10px vertical padding (this is the "dialed down" density — NOT the 4.5px of the raw opt-2 mockup).
- Radii: reuse the existing `--dh-radius-*` scale verbatim (control 6, row 9, bubble 12, dialog 12, inspector/card 16, composer 21, pill 999). It matches the mockups almost exactly; do not invent a second scale.
- `kbd` chip (global style): mono 9.5px, `background: rgba(255,255,255,.04)`, `border: 1px solid var(--dh-border)`, `border-bottom-width: 2px`, radius 4px, padding 1px 5px, color `--dh-text-muted`.
- **Hover:** `background: var(--dh-hover)`; on glass, `background: rgba(255,255,255,.03)` + border to `--dh-glass-border-hi`. Transitions 120ms ease, transform-free except cards (`translateY(-1px)` allowed).
- **Focus:** `outline: 2px solid var(--dh-focus); outline-offset: 2px` on all interactives (keyboard only, `:focus-visible`). Inputs: border-color `--dh-focus` + `box-shadow: 0 0 0 3px rgba(167,139,250,.12)`.
- **Selected row:** background `--dh-selected`, 2px left border in `--dh-coral` (see sidebar rows).
- **Status dots:** 6px circle. running `--dh-success` + `box-shadow: 0 0 6px rgba(79,214,164,.8)` + 1.7s opacity pulse; waiting `--dh-warning`; idle `#493f5e`; failed `--dh-danger` + glow. One shared component: `StatusDot` (new, `components/ui/`).
- **Provider chips:** mono 8.5px/700 uppercase pill, 1.5px 6px padding, radius 4px. Claude: text `#ffab9d` on `rgba(255,127,110,.14)`. Codex/OpenAI: text `#8fe6bf` on `rgba(79,214,164,.12)`. One shared component: `ProviderChip`.

### 1.2 Iconography

Keep lucide-react (already a dependency, already used in App.tsx). 15-16px stroke icons in chrome, `stroke-width: 2`.

---

## 2. Layout Architecture — the unified shell

### 2.1 The frame

```
┌──────────┬───────────────────────────────────────────────┐
│          │  TopBar (44px): ⛬ traffic-light inset (macOS) │
│ Sidebar  │  breadcrumb · CHAT TABS · status pills · ⌘K   │ ← drag region
│ (full    ├───────────────────────────────────────────────┤
│ height)  │                                               │
│          │   Main surface (route content, aurora bg)     │
│ rail 52  │                                               │
│ +        │                                               │
│ panel    ├───────────────────────────────────────────────┤
│ 272      │  StatusBar (26px, ambient stats)              │
└──────────┴───────────────────────────────────────────────┘
```

- **Sidebar spans full height on the left** and holds precedence: the top bar starts at the sidebar's right edge (base: `topbar/opt-2.html`, tabs from `topbar/opt-5.html`, constraint per owner).
- The sidebar = icon **rail** (52px) + **panel** (272px, collapsible to rail-only). Both are one `.glass-chrome` piece with a single right border.
- Status bar runs under the main surface only (not under the sidebar), 26px, mono.
- Main surface background: `var(--dh-aurora)` on Chat/Launchpad, `var(--dh-aurora-soft)` on Dashboard/Ops/Settings/Spatial/Browse. The wash is painted ONCE on the shell content container, not per-card.

### 2.2 Shell conflict resolution (the structural decision)

**Keep:** `AppShell` → `DevHubShell` path, `TaskRail` (rebuilt), `SecondaryNav`, `ChatHost`/`ThreadWorkspace`/`Composer`/`TaskHeader`, `InspectorDock`, `ResponsiveShell` (as Browse's inner layout only).

**Retire (in this order, small diffs):**
1. `resolveShellChromeMode(null)` and all `resolve*Mode(null)` returning `"legacy"` → change the null-settings fallback to `"devhub"` in `DevHubShell.tsx:223-227` (and sibling resolvers). This kills the legacy first-paint flash. The stored-`false` rollback still works.
2. `AppShell`'s `mode === "legacy"` inline chrome branch (`AppShell.tsx:43-79`): keep the branch for one release (rollback safety per feature-flag design), but it inherits the new tokens so even rollback looks coherent. Delete the branch + the legacy rail markup in `App.tsx:1846-1937` in a follow-up once the redesign has soaked for a week.
3. `components/features/shell/ActivityTimeline.tsx` is dead (no non-test importer) — delete it and its test.

**Routing stays exactly as-is:** `lib/router.ts` `useUrlRouter` + the `Tab` union. No react-router migration. The rail and tabs simply call the same `setTab`/`openSession` handlers App.tsx already owns.

### 2.3 Component tree (target)

```
App.tsx (state owner — unchanged responsibilities)
└─ AppShell (mode always "devhub" after step 2.2.1)
   └─ DevHubShell                     [.glass frame, aurora background]
      ├─ Sidebar                      [NEW composition, features/shell/Sidebar.tsx]
      │  ├─ RailNav                   [rebuilt TaskRail rail: logo, nav icons+kbd, spend ring, avatar]
      │  ├─ SessionPanel              [rebuilt TaskRail panel: filter, groups, rows, worktrees]
      │  └─ PanelFooter               [provider segment, model line, spend meter]
      ├─ TopBar                       [NEW, features/shell/TopBar.tsx — breadcrumb, ChatTabs, status pills]
      │  └─ ChatTabs                  [NEW, features/shell/ChatTabs.tsx]
      ├─ <main> route content (existing dispatch in App.tsx:1943-2210)
      │  ├─ ChatHost → TaskHeader + ThreadWorkspace + Composer (+ InspectorDock)
      │  ├─ Launchpad                 [NEW empty state, features/shell/Launchpad.tsx]
      │  ├─ ResponsiveShell (Browse)  [restyled only]
      │  ├─ DashboardRoute → DashboardPane (restyled widgets)
      │  ├─ OpsRoute → LiveOpsBoard / MultiSessionGrid (restyled)
      │  ├─ SpatialHub → BlueprintOffice [NEW renderer] (Pixi OfficeVisualizer kept behind toggle)
      │  ├─ SettingsRoute (+ SecondaryNav, restyled)
      │  └─ Inbox / Automations / Progress / native panes (token-inherit only)
      └─ StatusBar                    [NEW, features/shell/StatusBar.tsx]
```

Overlays (SearchPalette, CommandDialog, ShortcutOverlay, Toasts, FirstRun, SessionCompare, WorkModeSurface) stay mounted where they are; they get `.glass-hi` treatment.

---

## 3. Per-Aspect Specs

### 3.1 Sidebar — glass cockpit, dialed-down density
Base: `sidebar/opt-2.html` (rail + dense panel) softened toward t3.chat legibility; keyboard sidecar from `sidebar/opt-5.html`. Files: rebuild inside `features/shell/TaskRail.tsx` (or split into `Sidebar.tsx` + children; keep the exported `resolveTaskRailMode` contract so App.tsx wiring is untouched).

**Rail (52px, `--dh-rail-inactive`, right border `--dh-border-rail`):**
- Logo mark 26px, radius 8px, `--dh-grad-brand`, top.
- Nav icon buttons 36px, radius 9px: Home, Sessions (Browse), Live Ops, Office (spatial), Usage (dashboard), Inbox (unread badge — count from existing inbox data), Automations, Progress. Bottom cluster: spend ring, Settings, avatar/auth (LogoutButton lives in a popover on the avatar).
- Active state: icon color `--dh-coral`, background `rgba(255,127,110,.10)`, plus a 2.5px left gradient bar (`--dh-grad-warm`).
- **Keyboard sidecar (from opt-5):** under each icon, a mono 8px chord hint (`g s`, `g o`, `g u`, …). Hints render only when the panel is collapsed OR on rail hover; a dashed `?` chip at rail bottom opens the existing `ShortcutOverlay`. Wire `g`-chords into the existing keyboard handling in App.tsx (the shortcut system already exists; add the `g` prefix map).
- Badge: 13px rose pill, top-right of icon, 2px `--dh-rail-inactive` ring.

**Panel (272px, glass):**
- Header row (38px): `SESSIONS` label (`--dh-font-label`) + count (`6 open`, mono, muted) + `+` new-session button (opens Launchpad).
- Filter input (28px, `--dh-control` well, radius 7px) with `/` kbd hint — binds to the existing session filter state.
- Filter chips row: `All · Running · Review · Claude · Codex` (9.5px/600, pill). Active chip: coral text, `rgba(255,124,104,.08)` bg, coral 35% border.
- **Session groups** (collapsible): `Running`, `Needs review` (waiting/needsYou), `Idle/Recent` — grouping derives from joining `sessions: SessionSummary[]` with `api.running()` status by `sessionId`. Group header: `--dh-font-label` + count.
- **Session row** (the legibility contract — two lines, never truncate to one):
  - Line 1: `StatusDot` + title (12.5px/550, ellipsis).
  - Line 2 (mono 10px, muted): `{projectName} · ⎇ {gitBranch}` + right-aligned relative time (`lastTimestamp`).
  - Right: `ProviderChip` (CLD/CDX from `SessionSummary.model`/provider) — cost badge only on hover (from `costUsd`).
  - Padding 8px 12px; selected = `--dh-selected` bg + 2px coral left border; row numbers 1-9 as kbd chips appear while the panel has focus (jump shortcut, from opt-5).
- **Worktrees group** (below sessions): rows `⎇ {branch}` + dirty/clean state (`+3 ~1` amber / `✓ clean` mint) from the existing git/worktree API (`WorktreePanel`/`GitPanel` data). Read-only rows; click opens the owning session.
- **Footer** (top border): provider segment control (Claude/Codex — the existing defaultMechanics toggle), model line (`model opus-4.8 · thinking high ▾` — opens existing model picker), spend meter: `jul spend $X / $cap` + 3px gradient bar (violet→rose) from `stats.budget` (`monthToDateUsd`, `monthlyBudgetUsd`, `pct`).

Data note: the current `TaskRailTask` is `{id,title,provider,active}`. Extend `buildTaskRailSections` (App.tsx:1557) to also pass `status`, `projectName`, `gitBranch`, `lastTimestamp`, `costUsd` — all already present on `SessionSummary` / joinable from `api.running()`. This is wiring existing data, not new features.

Collapse behavior: `⌘\` toggles panel; collapsed = rail only (52px), tooltips take over labels. Persist in localStorage.

### 3.2 Top Bar — breadcrumb + status + multi-chat tabs
Base: `topbar/opt-2.html`; tabs + drag mechanics from `topbar/opt-5.html`. New file `features/shell/TopBar.tsx` replacing the current TopBar section of App.tsx (keep the same props; it already receives tab, theme, progress, counts, recents — see App.tsx:1780-1834).

Height 44px, `.glass-chrome` with bottom border `--dh-glass-border`. Sits **only to the right of the sidebar**. Layout, left→right:

1. **Traffic-light inset** (Tauri/macOS only): 78px left padding reserved when `window.__TAURI__` is present. In the browser build, no inset.
2. **Breadcrumb** (min width 0, shrinks first): `⬦ {workspace} / {projectName}` — segments are buttons (project switcher). The session leaf does NOT repeat here; the active tab carries it. Branch chip (`⎇ wt/...`, mono 11px, violet tint) appears only when the active session has one.
3. **ChatTabs** (the Conductor-style multi-chat): see below.
4. **Right cluster:** running pill (`● 2 running`, mint tint, from `api.running()`), needs-you pill (`1 needs review`, amber, from `needsYou` count; hidden at 0), spend chip (`July $10.2k`, mono, from `stats.budget`), `⌘K` icon button (opens existing CommandDialog), theme toggle (existing ThemeSwitcher), Work Mode toggle when available.

**ChatTabs spec:**
- A tab = an open chat session in this window. Shape: `{ sessionId, title, provider, status }`. Rendered 34px tall, radius 9px 9px 0 0, max-width 230px: `StatusDot` + title (ellipsis) + `ProviderChip` + `×` close (visible on hover/active).
- Active tab: `--dh-canvas` background (fuses with the surface below), inset violet top glow (`box-shadow: 0 -1px 0 rgba(170,143,243,.25) inset`). Inactive: transparent, hover `rgba(170,143,243,.06)`.
- `+` button → **Launchpad** (§3.3b) in a new tab.
- State: `openTabs: string[]` + `activeTabId` lives in App.tsx alongside the existing `sessionId` route state; selecting a tab calls the existing open-session path (`?session=` router param). Persist `openTabs` per-project in localStorage. Opening a session from the sidebar/browse focuses an existing tab or appends one. Closing the last tab shows Launchpad.
- Keyboard: `⌘1..9` selects tab N; `⌘W` closes (Tauri build only — browsers reserve it; use `⌘⇧W` on web).
- Overflow: tabs shrink to min 120px, then scroll horizontally (no wrapping); breadcrumb collapses to the workspace dot first.

### 3.3 Chat / Session — vibrant aurora glass
Base: `chat/opt-1.html` (Aurora Glass); structure maps onto existing `ChatHost` → `TaskHeader` + `ThreadWorkspace` + `Composer` + `InspectorDock`. **No diff views in the primary surface** (owner: doesn't care about diffs). **Worktree/session state must be visible.**

Chat is the ONE place the purple gets loud: full `--dh-aurora` backdrop; panes are `.glass-hi`.

- **Session header** (TaskHeader, 52px): title (h1 14px/650) + chips (radius pill, mono 11px): `⎇ {branch-or-worktree}` chip (violet tint; **if running in a worktree, prefix `wt/` and tint stronger + tooltip with worktree path**; if not, plain branch), `{projectName}` chip, model chip (`opus-4.8 · high`), session cost chip (`$4.87`, from SessionCostBadge data). Right: live pill — `● agent running` (coral tint, pulsing) / `waiting on you` (amber) / idle (none), derived from the session's run state (same source ThreadWorkspace already uses for request items).
- **Transcript** (ThreadWorkspace, keeps `--dh-transcript-width: 736px` column):
  - User bubble: `--dh-chat-user-bubble` gradient, border `--dh-chat-user-border`, radius `15px 15px 5px 15px`, right-aligned, max `--dh-user-bubble-max`.
  - Assistant bubble: `--dh-chat-ai-bubble` on glass, border `--dh-glass-border`, radius `5px 15px 15px 15px`, body 13.5px/1.65 in `#ded7ec`.
  - Who-line: 20px avatar tile (AI: `--dh-grad-warm`; user: dark violet), name + model in mono 10px muted (`Claude · claude-opus-4-8 · thinking: high` — from `NormalizedMessage.model` / session).
  - Inline code: violet tint (`rgba(167,139,250,.13)` bg, `#cbb8ff` text). Code blocks keep highlight.js, on `rgba(16,11,24,.5)` wells.
  - **Tool cards** (ToolCard/ToolGroup + tools/*): compact bar style — 16px icon tile (violet tint), mono label (`Bash · pytest …`), right status (`✓ 40 passed · 38.2s`, mint). Collapsed by default showing the one-line result; expandable. Edit cards show the file path + `+N −M` counts ONLY (no diff hunks inline — the full diff stays available in the existing expandable body for when it's wanted, but never auto-expanded).
  - Approval/permission cards (PermissionCard, CodexApprovalCard, request items): amber-tinted glass banner with action buttons — the highest-contrast element on the surface.
- **Composer** (floating, from opt-1): absolutely positioned 18px from bottom of the chat column, `.glass-hi`, radius 16px. Contents: input (13.5px, min-height 40px), bottom bar: provider segment (Claude/Codex), model pill, `⌘K commands` hint, gradient **Send** button (`--dh-grad-brand`, white text, radius 10px). Focus-within: border `--dh-glass-border-hi` + violet ring. Transcript gets `padding-bottom: 130px` so content never hides under it.
- **InspectorDock** (right, 300px, `.glass-card`): repurpose to **session state, not diffs**. Sections:
  1. `WORKTREE` card: `⎇ wt/eye2-hotplug` (mono 12px, violet), `from main @ 9f3c2ea · {project}`, `+38 −12 · 2 files · 1 ahead` (from existing GitPanel/ChatWorktreePanel data). If no worktree: `⎇ main · no worktree` quiet state.
  2. `SESSION`: model, permission mode, token usage meter (TokenMeter — `usage` from SessionSummary), cost, started/duration.
  3. Changed-files list (names + `+/-` counts only; click opens in editor via existing OpenInEditor).
  - Toggle with `⌘I` (existing inspectorDock flag mechanics unchanged).

#### 3.3b Launchpad (new-session empty state)
Base: `chat/opt-5.html`, best-ideas basis. New `features/shell/Launchpad.tsx`, shown for a `+` tab or empty chat route. Center column, max 680px:

1. Brand orb (44px, `--dh-grad-brand`, soft glow) + `Start a session` (21px/700) + subline `Pick an engine, point it at a worktree, describe the job. {N} agents already running.` (N from `api.running()`).
2. **Provider cards** (2-up grid, radio behavior): Claude / Codex. Each: mark tile, name, model select (from settings `defaultModel` / codex model), stats line with REAL data: `this month ${byProviderSpend}` (aggregate `stats.byModel` by provider) — omit any stat we don't have rather than inventing (no fake "median turn").
3. **Hero composer** (`.glass-hi`, radius 16): task description input; bottom row: worktree picker chip (`⌥ new worktree from {project}/main ▾` — existing worktree-create flow from ChatWorktreePanel), `@ attach` (existing MentionPicker), `/` commands hint, gradient `Launch session ⌘↵`.
4. **Worktree strip**: existing worktrees as chips (`⎇ wt/... · +38 −12` / `clean`) — pick one to reuse.
5. **Starter row** (2×2 quiet cards): built from REAL recents — `Resume {last idle session}`, `Second opinion: hand {last session} to {other provider}` (existing crossProviderFork), `Open Codex history`, `Browse sessions`. No invented CI/status claims.

### 3.4 Settings — query-deck search + IDE-rail nav
Base: combine `settings/opt-5.html` (Query Deck) + `settings/opt-2.html` (IDE Rail). Files: `features/settings/SettingsRoute.tsx` (+ SecondaryNav). Keep every existing section and save semantics; this is a re-skin + a search affordance.

- **Left nav = existing SecondaryNav**, restyled: 224px, grouped (`AGENTS`: Appearance→"Appearance", Providers→"Providers & models", Permissions; `CONFIG`: Memory/CLAUDE.md, MCP servers, Hooks, Webhooks, Skills, Agents, Plugins; `DATA`: Budget, Index/Integrity, Archive). Active item: violet gradient wash + 2px inset violet bar. Footer (mono 10px): app version + config path.
- **Query header** (from Query Deck, spans content top): `Settings` h1 + a search box (`.glass-card`, violet focus ring, `/` binds) that **filters setting rows across ALL sections live** (flat filter over row labels/descriptions; hits grouped under section headers with a hairline). Filter chips under it = the SecondaryNav groups (click = scroll/jump).
- **Rows** (from IDE Rail): tables (`.glass-card`, radius 12) of 3-column grid rows — `label+description | context line (mono, muted; real facts like current values/paths) | control`. Controls: segmented buttons (violet active), toggles (violet on-state), selects (mono, control-well), steppers. Row hover `rgba(255,255,255,.018)`; focused row: violet inset bar.
- Budget section keeps the spend meter row: split bar (violet Claude / mint Codex) + `$X / $cap` from `BudgetStatus`.
- **Save semantics unchanged** (settings apply as they do today). No pending-changes tray in v1 — it changes behavior, and the owner won't live in Settings. If a field is async, show the existing toast on success.

### 3.5 Spatial Office — the Blueprint
Base: `spatial/opt-5.html` (Blueprint — owner favorite) + glass callouts/room fills from `spatial/opt-1.html` (Glasshouse) + click-to-inspect from `spatial/opt-2.html` (Console Floor). Files: `apps/web/src/spatial/` — add a new `BlueprintOffice.tsx` DOM/SVG renderer beside the Pixi `OfficeVisualizer`; a small toggle in SpatialHub picks renderer (`blueprint` default, `iso` = old Pixi, kept for rollback). Data contract stays `spatial/contract.ts` `WorldState` over the existing WS snapshot/delta client.

**Scene structure (SVG, viewBox ~1240×640, centered, max-height fit):**
- Outer wall + room partitions: 1.6px stroke in `--draft: #8d7fc0` at 85% opacity; secondary walls 1px at 35%; blueprint ruler ticks (A/B/C, 1/2) in the margins; door arcs; dashed corridor lines. Room fill `rgba(141,127,192,.045)`; glass sheen from Glasshouse: rooms get a faint `linear-gradient(160deg, rgba(220,205,245,.06), transparent 45%)`.
- **Rooms = departments** from `contract.ts DEPARTMENTS` (8 OpenClaw teams: athena, vulcan, apollo, thoth, talos, vesta, argus, hermes). Layout: precomputed grid template (2 rows), room size weighted by member count. Room label: uppercase mono 13px letterspaced; sub-label `{DEPT} · {occupied}/{desks} DESKS`. A room with any `working` agent gets the "active" treatment: coral-tinted wall stroke + coral label.
- **Desks = agents** (one desk rect 64×34 + chair arc per agent in the room; empty desks drawn for headroom). Desk states: free (outline), held (filled `rgba(141,127,192,.22)`), hot/working (coral fill + coral agent dot + expanding pulse ring animation).
- **Callouts** (HTML absolutely positioned over the SVG, connected by dashed leader lines): glass chips (`rgba(24,19,32,.88)`, blur 6px, radius 8). Per-desk content — THE INFO CONTRACT:
  - Line 1: `AGENT NAME` (11.5px/700) + `PROVIDER·MODEL` (8.5px letterspaced; coral for Claude, blue-violet for Codex).
  - Line 2: status — `● ACTIVE · {runtime} · ${cost}` (coral) / `◌ QUEUED` (amber) / `⏸ BLOCKED` (amber, reason) / `✓ DONE` (mint).
  - Line 3: current ticket/task (`assignment`, 10.5px warm ink).
  - Line 4 (mono, muted): `{worktree/branch} · +adds −dels` when known.
  - Line 5 (mono): last-action line (`pytest test_reconnect — 12s ▮` with blinking caret when working).
  - Working agents get the full callout; idle/reserved agents get the 2-line compact form. Callouts never overlap: only the working agents + hovered desk show expanded.
- **Corner stamp** (title block, bottom-right): `OFFICE — PLAN 02` / project / `AGENTS {n} · {active} ACTIVE` / `WORKTREES {n} · {dirty} DIRTY` / rev date. Legend bottom-left: ACTIVE / RESERVED / FREE DESK swatches + `SCALE 1:AGENT`.
- **Click a desk** → right inspector slide-over (Console Floor): agent kv table (dept, role, reports_to, project, status, assignment), live log well if available, action row (`Open session`, `Nudge`, `Reassign` — wire only the ones that have real handlers today; others don't render).
- Keyboard: `h/l` cycle rooms, `j/k` desks, `⏎` open inspector, `z` zoom-to-room (CSS transform scale on the board).

**Data honesty — contract extension required:** `Agent` today = `{id,name,dept,role,status,assignment,reports_to,project}`. Add OPTIONAL fields to `spatial/contract.ts`: `model?: string`, `provider?: "anthropic"|"openai"`, `costUsd?: number`, `tokens?: number`, `startedAt?: string`, `lastAction?: string`, `worktree?: string`, `diff?: {add:number,del:number}`. The mock feed (`mockFeed.ts`) populates all; the M1 OpenClaw adapter (`stateClient.ts`/`fleetSnapshot.ts`) fills what it truly has. **Callout lines render only when the field exists — no placeholder lies.** This additive change keeps snapshot/delta compatibility.

### 3.6 Dashboard — Prism Glass, spend front and center
Base: `dashboard/opt-1.html` (Prism Glass). Files: `features/analytics/DashboardRoute.tsx` + `components/DashboardPane.tsx` + `components/dashboard/*`. All data already exists via `useStatsPolling` → `Stats`, `BudgetStatus`, `DailyUsage[]`, `ToolStat[]`. Re-layout + re-skin; keep every widget.

- **Page head:** `Usage & Cost` h1 + existing `PeriodSelector` restyled as glass segmented controls (`Project` scope + `Window`). **Every card carries a scope-tag pill** (`JULY MTD · ALL PROJECTS`) so numbers can't be misread — this is the Prism Glass signature; scope text derives from the actual selected period/project.
- **KPI row (3 glass cards, `1.25fr 1fr 1fr`):**
  1. HERO: window spend — 38px gradient-text number (from `stats.totalCostUsd` scoped to period), meta line (`{sessions} sessions · ▲/▼ vs prior window` — compute prior-window delta from rollups; omit if the window has no prior data), **budget burn bar**: `{monthlyBudgetUsd}` track, `{monthToDateUsd} used · {pct}%` (BudgetStatus), fill gradient violet→coral, amber/red tint at `alert: warn/over`.
  2. Month-to-date spend + `pacing ${projectedUsd} by {month end}` (BudgetStatus.projectedUsd — the existing CostForecast logic).
  3. All-time: `${total} · {totalSessions} sessions · {totalProjects} projects`.
- **Mid grid (`1fr 330px`):**
  - **Daily spend area chart** (ActivityChart rebuilt on rollups `DailyUsage.costUsd`): single violet area+line with gradient fill, peak marker + dashed rule, mono axis labels. (Rollups are not split by provider — do NOT draw a fake two-provider chart. If/when per-provider rollups land, add the coral series.)
  - **Cost by model donut** (stats.byModel): conic-gradient donut, center = window total; legend rows `swatch · model · provider · $amt · pct`. Palette order: violet `#a78bfa`, pink `#f0abfc`, coral `#fb7185`, mint `#5eead4`, then muted violets.
- **Row 3:** Project leaderboard (topProjects: name, sessions, tokens, cost — horizontal bar per row, violet) | Top spenders (existing TopSpenders: session title, project·worktree mono, model + provider dot, right-aligned cost, `⏎ open session`).
- **Row 4:** CalendarHeatmap + HourHeatmap (restyle: violet ramp on charcoal) | ToolAnalytics (tool name, count, error rate — error rate > 0 in rose) | DirtyRepos (compact list, amber counts).
- Density rule: cards are dense inside but the grid keeps 14px gaps and every card has one h2 + one scope tag — scan order is row by row.

### 3.7 Live Ops — Glass Grid + Attention Board
Base: `liveops/opt-1.html` (Glass Grid) + `liveops/opt-3.html` (Attention Board). Files: `features/ops/OpsRoute.tsx`, `components/LiveOpsBoard.tsx`, `components/MultiSessionGrid.tsx`. The existing `board/grid` toggle (App.tsx:1991) maps to: **Grid = glass grid** (default), **Board = attention board**. Data: `RunningSession[]` from `api.running()` joined with the session index (`SessionSummary`) on `sessionId` for cost/tokens/title.

- **Page head:** `Live Ops` h1 + meta `{n} sessions · {running} running · {waiting} waiting on you · {failed} stale` + filter chips (All / Claude / Codex / Needs me).
- **Glass grid** (3-up, `repeat(auto-fill, minmax(340px, 1fr))`):
  - Card = `.glass-card` with a 3px status edge-light on the left (violet gradient = busy, coral-red = dead/stale, none = idle) + status glow shadow.
  - Header: `StatusDot` + task title (13.5px/600; `name ?? title ?? cwd basename`) + subline `({project} · {status} {duration} — from startedAt/updatedAt)` + `ProviderChip`.
  - Middle: status banner instead of fake terminal tails (RunningSession has no output stream):
    - `needsYou` → amber banner: `⏸ {waitingFor}` + `Open` button.
    - `stale` → red banner: `✗ stale — busy but silent since {statusUpdatedAt}` + `Open` button.
    - busy → quiet mono line: `{model} · {entrypoint} · updated {ago}`.
    - idle/done → muted `finished — awaiting review`.
  - Footer: `⌥ {cwd basename or branch}` mono + right cluster: cost (`${costUsd}` from joined SessionSummary, when indexed) + duration.
  - Click card → opens the session as a chat tab.
- **Attention Board** (the "what needs my eyes" signal): 4 columns `Needs you (amber-tinted col) · Running · Stale/Failed (red-tinted col) · Recently finished`. Cards are the compact form of the grid card (title, provider, branch, cost, one status line, action buttons `Open`/`Dismiss`). Column headers: dot + uppercase label + count pill + kbd hint. Sorting: oldest-waiting first in Needs-you; the status bar (shell-level) shows `⚠ {n} need you — oldest {age}` whenever the count > 0, on every route.
- Status derivation stays in `statusStyle`/existing helpers — restyle, don't re-derive.

### 3.8 Browse / remaining views
Not owner-picked aspects, but they must not read as the old app:
- **Browse (ResponsiveShell):** keep the 3-pane behavior; restyle panes to glass panels with the standard row anatomy (§3.1 rows), TaskHeader on top of the transcript, and the `--dh-aurora-soft` wash.
- **Inbox, Automations, Progress, native Codex/OpenAI panes:** token-inherit pass only (they already consume dh-*/legacy tokens, which now resolve to the new palette). Manual QA sweep for hard-coded zinc/gray classnames (`bg-zinc-*`, `text-zinc-*`) — replace with token equivalents where they appear in these files. No structural change.

---

## 4. Window-drag fix (Tauri)

Current state (verified): `apps/desktop/src-tauri/tauri.conf.json:12-25` uses `"titleBarStyle": "Overlay"`; the web app contains **zero** `data-tauri-drag-region` markup, so there's no draggable chrome.

Spec:
1. **TopBar is the drag region.** Put `data-tauri-drag-region` on the TopBar root AND on its non-interactive children (breadcrumb wrapper spans, the flexible spacer, the tabs-zone gaps). Tauri checks the attribute on the *event target*, not ancestors — so bare text/filler elements need it too, while buttons/tabs/inputs simply don't get it (they're automatically non-draggable). Double-click on a drag region = maximize toggle (Tauri default; leave enabled).
2. **Sidebar header strip** (logo row, top 52px of the rail + panel header) also gets `data-tauri-drag-region`, since the sidebar occupies the window's top-left corner where users instinctively grab. Traffic lights render over it (Overlay style) — add `padding-top: 6px` and keep the top 38px of the sidebar free of interactive targets on macOS Tauri (`platform === 'darwin'` check via `navigator.userAgent` or Tauri API; in the plain web build no inset is applied).
3. **Status bar**: also a drag region (non-interactive segments only).
4. Keep `titleBarStyle: "Overlay"`; do NOT set `decorations: false` (we want native traffic lights + resize edges). Optionally add `"trafficLightPosition": { "x": 14, "y": 14 }` in tauri.conf so the lights center in the 44px bar height — cosmetic, test on macOS before keeping.
5. The drag-region attribute is inert in the browser build — safe to ship unconditionally.

---

## 5. Build Order (for the engineering wave)

Rule: **Phase 1 is serial (one owner)** — it touches the shared hot files. Phases 2a-2d are parallel — they touch disjoint feature directories and consume only the Phase-1 tokens/classes. Nobody but Phase 1 edits `index.css`, `App.tsx`, or `features/shell/*`.

**Phase 1 — Foundation (ONE engineer/agent, serial):**
1. `index.css`: retint legacy + dh token values (§1.1A), add glass/aurora/typography tokens + `.glass-*` utilities (§1.1B/D), replace light-theme block (§1.1C), perf-reduced fallback.
2. Shell: null-settings fallback → devhub (`DevHubShell.tsx` + sibling resolvers); delete `ActivityTimeline.tsx`.
3. Sidebar rebuild (`features/shell/TaskRail.tsx` → Sidebar composition, §3.1) + enriched `buildTaskRailSections` in App.tsx.
4. TopBar + ChatTabs + StatusBar (`features/shell/TopBar.tsx`, `ChatTabs.tsx`, `StatusBar.tsx`) + tab state in App.tsx + drag regions (§4).
5. Chat surface: ThreadWorkspace/Composer/TaskHeader/InspectorDock glass treatment + Launchpad (§3.3, §3.3b).
6. Shared primitives: `StatusDot`, `ProviderChip`, `kbd` style in `components/ui/`.
- Touches: `apps/web/src/index.css`, `apps/web/src/App.tsx`, `apps/web/src/components/features/shell/*`, `components/features/inspectors/InspectorDock.tsx`, `components/ui/*`. Existing shell tests (`AppShell.test.ts`, `TaskRail.test.ts`, `DevHubShell.test.ts`, App.* cutover tests) must be updated in the same diffs.

**Phase 2 (parallel, after Phase 1 merges):**
- **2a Dashboard** — `features/analytics/*`, `components/DashboardPane.tsx`, `components/dashboard/*` (§3.6).
- **2b Live Ops** — `features/ops/*`, `components/LiveOpsBoard.tsx`, `components/MultiSessionGrid.tsx` (§3.7).
- **2c Spatial** — `apps/web/src/spatial/*` only: contract extension (additive optional fields), `BlueprintOffice.tsx`, renderer toggle (§3.5). Mock feed update included.
- **2d Settings** — `features/settings/*` + `components/config/*` styling (§3.4).
- Shared-file contention watchlist: `SecondaryNav.tsx` is used by 2a/2b/2d — it is restyled in **Phase 1 step 4** (it's shell chrome); Phase 2 agents consume it read-only. `components/ui/*` primitives: Phase 1 owns; Phase 2 may add new files but not edit existing ones.

**Phase 3 — sweep + retire:**
- Browse/ResponsiveShell restyle, Inbox/Automations/Progress/native-pane zinc-classname sweep (§3.8).
- Tauri conf tweak + on-device drag QA (M5 desktop build).
- After a week of soak: delete the AppShell legacy chrome branch + legacy rail markup (§2.2).

**Verification bar (every phase):** `pnpm dev` boots both apps; existing test suites pass (`App.*.test.ts` are behavior tests — update assertions, don't delete); no route loses a control that exists today; light + dark themes both render (toggle via ThemeSwitcher); axe contrast pass on the new palette; drag works in the desktop build.

---

## 6. What NOT to do

- No react-router migration, no state-management rewrite, no API changes (except the additive spatial contract fields).
- No new features hiding in the redesign (the only net-new behaviors sanctioned: chat tabs, launchpad composition, blueprint renderer, settings search filter, `g`-chord/number-jump shortcuts — all shell-level, all specced above).
- No diff-forward UI anywhere in chat. No fake data: every field named in this spec maps to a verified source (§ references in the inventory); if a source is null, the element does not render.
- No clay-orange accents in new code; no pure-gray surfaces; no unbordered glass (glass ALWAYS has its 1px violet-tint border + top highlight, or it reads as mud).
- Don't stack backdrop-filters; don't animate blur; don't pulse anything except status dots and the live pill.
