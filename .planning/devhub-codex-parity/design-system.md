# DevHub Reference-First Design System

Status: **locked after explicit user approval on 2026-07-13**. This document is the implementation contract for the post-approval DevHub task environment. It does not assert that proposed or capability-gated provider behavior exists.

The visual center of gravity is the installed Codex desktop shell captured at `1800x1130`: a quiet project/task rail, thin task header, open transcript canvas, stable bottom composer, compact inline activity, and a content-height inspector. DevHub additions must look native to that language without pretending to be a first-party provider client.

## 1. Governing sources and conflict resolution

Different source types own different questions. Do not use a generated concept to override a measured capture or a capability document.

### 1.1 Visual hierarchy

1. Explicit user approval and the accepted caveats in `design-approval-package.md`.
2. The four real Codex captures and measurements in `reference-capture-manifest.md` for observed shell, density, placement, and visual behavior.
3. Production clarifications and briefs in `concepts/*-brief.md` for DevHub-only semantics, exact labels, and rejected generated details.
4. This design system for repeated tokens, component anatomy, interaction states, responsive fallbacks, and details that static captures could not expose.
5. The selected generated concepts for composition and family resemblance only.
6. Current DevHub styling as an integration and preservation reference, not as authority over the approved visual direction.

If a concept contains malformed text, an oversized title, a stray `Codex` wordmark, a wrong permission term, a selectable exclusion, a duplicate expiry/cancellation state, or an unapproved card, ignore it and follow the higher source.

### 1.2 Behavioral hierarchy

1. `provider-capability-matrix.md` controls whether a provider action may render as available.
2. `preservation-matrix.md` controls which existing workflows, keyboard paths, routes, and persisted meanings must survive.
3. Production briefs control the DevHub workflow when it is additive and does not conflict with provider truth.
4. Concepts illustrate a workflow but never prove it works.

Every control must be derived from runtime capability state. A visually specified action stays hidden or disabled when its adapter gate is not green. Timeout never authorizes, and a provider identity is never editable after task creation.

### 1.3 Approved concept authority

| Surface | Governing visual source | Production authority and rejection |
|---|---|---|
| Empty existing task | `chatgpt-empty-task-1800x1130.png` | Keep the canvas blank. Concept 1's inset size, overlap, and stray `Codex` wordmark are rejected. |
| New-task setup | `01-new-task-empty-brief.md`, `05-provider-setup-brief.md` | Proposed DevHub UI. Provider locks at creation; provider-specific model and permission labels are mandatory. |
| Active task | `chatgpt-active-goal-1800x1130.png` | Same-thread narrative, compact activity, diff pill, goal strip, stable composer, and stop geometry govern. Concept 2's oversized title does not. |
| Intervention states | `03-intervention-states-correction-brief.md` | Corrected plate governs permission/input/failure/reconnect/expiry. Initial plate governs the independent `Cancelled by you` composition only. |
| Inspector | Real completed-task capture plus `04-inspector-dock-brief.md` | Container is observed. Exact destinations and labels come from the brief; malformed concept tabs are rejected. |
| Cross-provider fork | `06-cross-provider-fork-brief.md` | `Permission mode / Default`, locked exclusions, attributed reviewed/redacted handoff, unchanged source, and a new native target are mandatory. |
| DevHub Work | `07-work-mode-correction-brief.md` | Work is selected, provider identity is fixed, Claude uses `Default`, and no Cowork/background/subagent claim appears. |
| Search and Commands | Current populated DevHub Search capture plus `08-command-responsive-brief.md` | Search remains a distinct functional dialog. Commands may open Search but may not replace it. Generated Inbox copy is non-authoritative. |

## 2. Token architecture

The dark reference palette is locked. Use CSS variables, not raw Tailwind colors in feature components. Raw values below belong only in the global token definition and visual-test fixtures.

### 2.1 Dark semantic tokens

```css
:root,
:root[data-theme="dark"] {
  color-scheme: dark;

  /* Observed shell surfaces */
  --dh-canvas: #181818;
  --dh-header: #181818;
  --dh-rail-inactive: #202020;
  --dh-rail-active: #404040;
  --dh-surface: #2d2d2d;
  --dh-user-bubble: #242424;
  --dh-control: #262626;
  --dh-control-seam: #252525;
  --dh-selected: #313131;

  /* Locked state fallbacks; static captures did not expose all states */
  --dh-hover: #2a2a2a;
  --dh-pressed: #383838;
  --dh-scrim: rgb(0 0 0 / 0.60);

  /* Text */
  --dh-text-strong: #ffffff;
  --dh-text: #dedede;
  --dh-text-muted: #969696;
  --dh-text-disabled: #676767;

  /* Dividers and focus */
  --dh-border-subtle: #2b2b2b;
  --dh-border: #3a3a3a;
  --dh-border-rail: #424242;
  --dh-focus: #8ab4f8;
  --dh-link: #86b9f9;

  /* Status; always pair color with text and/or an icon */
  --dh-success: #4fa66a;
  --dh-warning: #d4a24c;
  --dh-danger: #d95c5c;
  --dh-diff-add: #45a65a;
  --dh-diff-remove: #db5652;

  /* Product brand; never reuse as neutral selection */
  --dh-brand: #d97757;

  /* Provider/elevated-access accents, never provider logos */
  --dh-provider-openai: #6f8f7d;
  --dh-provider-anthropic: #b87356;
  --dh-access-elevated: #d97757;
}
```

`--dh-rail-active` is the observed active-window material result, not a universal flat sidebar fill. Packaged macOS may use the platform material with `#202020` underneath when that reproduces the observed near-`#404040` result. Browser/PWA uses the opaque `#404040` fallback. Inactive windows use `#202020`. Active/inactive state must not cause geometry or text-contrast changes.

The dark canvas is true neutral `#181818`. Do not warm it, cool it, replace it with current zinc-950 `#09090b`, or add gradients/glows.

### 2.2 Shadcn semantic aliases

Shadcn is an accessible Radix substrate; its default visual preset is not the design. The custom approved Radix preset must produce these aliases and no extra visual opinions:

```css
:root,
:root[data-theme="dark"] {
  --background: var(--dh-canvas);
  --foreground: var(--dh-text);
  --card: var(--dh-surface);
  --card-foreground: var(--dh-text);
  --popover: var(--dh-surface);
  --popover-foreground: var(--dh-text);
  --brand: var(--dh-brand);
  --primary: var(--dh-text);
  --primary-foreground: var(--dh-canvas);
  --secondary: var(--dh-control);
  --secondary-foreground: var(--dh-text);
  --muted: var(--dh-user-bubble);
  --muted-foreground: var(--dh-text-muted);
  --accent: var(--dh-selected);
  --accent-foreground: var(--dh-text-strong);
  --destructive: var(--dh-danger);
  --destructive-foreground: var(--dh-text-strong);
  --border: var(--dh-border);
  --input: var(--dh-border-rail);
  --ring: var(--dh-focus);
  --radius: 0.5rem;

  --sidebar: var(--dh-rail-inactive);
  --sidebar-foreground: var(--dh-text);
  --sidebar-primary: var(--dh-selected);
  --sidebar-primary-foreground: var(--dh-text-strong);
  --sidebar-accent: var(--dh-hover);
  --sidebar-accent-foreground: var(--dh-text);
  --sidebar-border: var(--dh-border-rail);
  --sidebar-ring: var(--dh-focus);
}
```

Tailwind v4 exposes these through `@theme inline` aliases such as `--color-background: var(--background)`. Do not duplicate literal palettes in components and do not add manual `dark:` color overrides.

### 2.3 Current-token collision resolution

The current `apps/web/src/index.css` defines `--bg`, `--panel`, `--border`, `--text`, and a clay-valued `--accent`. Shadcn uses `--accent` for a neutral hover/selection surface, so applying shadcn variables unchanged would silently turn neutral selections clay.

| Collision | Locked resolution |
|---|---|
| Existing `--accent: #d97757` vs shadcn `--accent` | Preserve clay first as the product semantic `--dh-brand`/`--brand` (and, where meaning is truly elevated access, `--dh-access-elevated`); keep the distinct Anthropic provider fallback at `--dh-provider-anthropic`. Migrate every legacy `var(--accent)` consumer by meaning before assigning neutral shadcn `--accent: var(--dh-selected)`. Shadcn `--primary` intentionally remains the neutral high-contrast action treatment. |
| Existing `--bg`, `--panel`, `--text` | Keep as temporary aliases to `--dh-canvas`, `--dh-surface`, and `--dh-text` while consumers migrate. They may not remain independent sources of truth. |
| Existing `--border` | Move the literal to `--dh-border`, then alias shadcn `--border` to it. Audit all existing `var(--border)` consumers before the change. |
| Tailwind zinc utilities | Existing routes may retain them behind the compatibility path. New task-shell code uses semantic classes only. Replace route-by-route; do not global-remap zinc to fake fidelity. |
| `apps/web/src/components/ui.tsx` | This legacy compatibility facade is not overwritten. Shadcn files live in `apps/web/src/components/ui/` and use explicit subpath imports. The file and directory may coexist during migration. |
| Legacy `Badge` | Migrate semantic badges to `@/components/ui/badge`; do not turn ordinary metadata into badges. Existing facade export remains until callers migrate. |
| Legacy `Spinner` | Migrate to the registry spinner or a thin DevHub `ProgressSpinner` variant using the same essential-motion rule. |
| Legacy `IconButton` | Replace with `Button size="icon"` plus a locked compact variant; keep accessible labels and `data-icon`. |
| Legacy `EmptyState` | Replace only where content is actually needed with shadcn `Empty`. The observed empty task must remain blank. |
| Existing `cn()` | Reuse `apps/web/src/lib/utils.ts`; the custom preset must point to it and must not create a second merge helper. |

The real initialization contract is Vite, React 19, TypeScript, Tailwind v4, `rsc:false`, Radix base, Lucide icons, `@/* -> ./src/*`, and `pnpm`. The custom preset and complete disposable diff must be audited before any real-workspace `init`. No named visual preset, page block, overwrite, reinstall, or bulk add is approved.

### 2.4 Light theme preservation

The approved references lock dark mode only. Current light-mode behavior remains a preservation requirement, not a concept-derived visual claim. During migration, retain true white/neutral values (`#fafafa` canvas, `#ffffff` surface, zinc-neutral text/borders) and never introduce cream. Shadcn light aliases must be scoped under `[data-theme="light"]`; they may not mutate the locked dark values. Light mode requires a separate M8 visual and contrast audit before cutover.

## 3. Geometry and layout

All measurements are logical CSS pixels derived from the exact `3600x2260` content rectangle at 2x backing scale.

### 3.1 Wide reference constants

```css
:root {
  --dh-window-reference-width: 1800px;
  --dh-window-reference-height: 1130px;
  --dh-rail-width: 273px;
  --dh-rail-collapsed-width: 48px; /* proposed narrow fallback */
  --dh-header-height: 46px;
  --dh-transcript-width: 736px;
  --dh-composer-width: 736px;
  --dh-composer-height: 98px;
  --dh-inspector-width: 300px;
  --dh-inspector-lane-width: 316px;
  --dh-shell-gutter: 16px;
  --dh-composer-bottom: 16px;
}
```

At `1800x1130`:

| Surface | Locked geometry |
|---|---|
| Rail | `x=0..272`, width `273`. One-pixel separator at `x=272`. |
| Header | `x=273..1799`, `y=1..45`, height `45`; one-pixel divider at `y=46`. Treat the shell row as `46px` including divider. |
| Task body | `x=273..1799`, `y=47..1128`, open `#181818` canvas. |
| Conversation stage | `x=273..1483`, width `1211`; it stays stable while the inspector occupies the right lane. |
| Transcript/composer | `x=510..1245`, width `736`, centered within the conversation stage. |
| Composer | `(510,1016)`, `736x98`, `16px` bottom gutter, radius `21px` (allowed implementation range `20–22px`, use `21px`). |
| Inspector | `x=1484`, width `300`, top `59`, right gutter `16`, radius `16px`; height is content-driven. |
| Selected task row | `(8,489)`, `256x30`, radius `9px`. All rail rows use this geometry. |
| User bubble | right edge `x=1245`, max width `566`, observed heights `60` and `82`, radius `12px`. |
| Diff summary | `(789,939)`, `178x33`, fully rounded. |
| Goal strip | `(531,982)`, `694x34`, inset `21px` from each transcript edge; radius `17px`. |

The inspector lane is `300px + 16px` right gutter. The conversation stage therefore ends exactly where the inspector begins. Hiding the inspector at wide width does not move the transcript/composer; this prevents task-to-task horizontal drift. At narrow tiers the reserved lane is removed and the transcript recenters.

### 3.2 Vertical behavior

- The header never grows for provider, mode, branch, or status. Truncate the task title before overflow actions.
- Transcript scrolling owns the space between header and composer. Use `24px` top padding and enough dynamic bottom scroll padding to keep the final item visible above composer, diff, goal, and blocking-request rows.
- The composer is bottom-anchored inside the task body. Content growth up to the approved textarea maximum grows upward; its default/resting box remains `98px`.
- Send, queue, and stop share one action slot and never change outer composer geometry. If queue and stop both need controls, they occupy pre-reserved footer/action space rather than widening the composer.
- The diff summary is centered above the goal strip. Neither becomes a permanent dashboard widget.
- Goal/Outcome is `694x34` at rest. Expanded details use an overlay/disclosure or inspector destination; they do not turn the bottom strip into the oversized surface shown in concept 7.
- The inspector begins `12px` below the body start (`y=59`) and ends at its content. Reference heights are `199px` sparse/empty, `282px` completed, and `396px` active. Do not force these heights; reproduce them by compact row anatomy.

### 3.3 Container model

- The transcript is open canvas. Assistant prose, commentary, plan rows, tool rows, errors, and citations are not wrapped in chat cards.
- Only user messages use the raised `--dh-user-bubble` surface.
- The inspector is one surface with sections and separators, not a stack of cards.
- Rail groups are open lists. The selected row is one low-contrast rounded rectangle.
- Dialogs/popovers are reserved for global commands, Search, setup, review, and menus. Provider requests stay inline.
- Cards are allowed only where a real bounded object requires one (for example, the compact goal strip). Do not convert lists, transcript blocks, settings groups, or inspector rows into a bento grid.

## 4. Spacing, radii, borders, and elevation

### 4.1 Spacing scale

Use a 4px base with optical 2px and 6px exceptions for dense chrome.

| Token | Value | Primary use |
|---|---:|---|
| `--space-0_5` | `2px` | Icon optical adjustment, adjacent rail rows. |
| `--space-1` | `4px` | Inline icon/text micro-gap. |
| `--space-1_5` | `6px` | Dense controls, metadata. |
| `--space-2` | `8px` | Rail row inset, compact row gap. |
| `--space-2_5` | `10px` | Control horizontal padding. |
| `--space-3` | `12px` | User bubble/field padding. |
| `--space-4` | `16px` | Shell gutter, inspector padding, header padding. |
| `--space-5` | `20px` | Goal inset, paragraph rhythm. |
| `--space-6` | `24px` | Transcript top padding, section break. |
| `--space-8` | `32px` | Major narrative separation only. |

Use `gap`, never `space-x-*`/`space-y-*`. Similar controls share component variants rather than one-off padding overrides.

### 4.2 Radius scale

| Token | Value | Use |
|---|---:|---|
| `--radius-control` | `6px` | Small buttons, fields, keyboard hints. |
| `--radius-row` | `9px` | Selected/hovered rail and list rows. |
| `--radius-bubble` | `12px` | User bubbles and compact inline request surfaces. |
| `--radius-dialog` | `12px` | Command/Search dialogs. |
| `--radius-inspector` | `16px` | Inspector, setup popover, review sheet. |
| `--radius-goal` | `17px` | 34px goal strip. |
| `--radius-composer` | `21px` | 98px stable composer. |
| `--radius-pill` | `999px` | Diff summary, circular action containers. |

Do not apply the global shadcn radius uniformly. Each DevHub component variant owns the appropriate semantic radius.

### 4.3 Borders and elevation

| Level | Treatment |
|---|---|
| Canvas/open list | No border or shadow. |
| Shell divider | `1px solid --dh-border-subtle`; rail separator uses observed `--dh-border-rail`. |
| User bubble/control | No visible border at rest; selected/focused state supplies outline. |
| Composer/inspector | `1px solid rgb(255 255 255 / 0.04)` only when needed to preserve edge; no glow. |
| Popover/dialog | `1px solid --dh-border`, `0 16px 48px rgb(0 0 0 / 0.45)`. |
| Compact floating pill | `0 6px 18px rgb(0 0 0 / 0.20)` maximum. |

The captured shell is restrained. Do not add colored shadows, glass cards, glossy gradients, inner highlights, or elevation to ordinary transcript content.

## 5. Typography

Use the native system stack; do not download or bundle a display font.

```css
--font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
--font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
```

Static screenshots do not expose exact font metadata. The following is the locked implementation fallback and must be verified against native-size browser captures.

### 5.1 Chrome typography

| Style | Size / line | Weight | Use |
|---|---|---:|---|
| Brand | `18 / 22px` | `600` | Plain `DevHub` wordmark only. |
| Task header | `13 / 18px` | `600` | Current task title; one line, truncated. |
| Rail row | `13 / 18px` | `400`; selected `500` | Projects/tasks/navigation. |
| Control | `12 / 16px` | `500` | Buttons, tabs, composer footer, inspector rows. |
| Chrome label | `11 / 15px` | `500` | Section labels, runtime identity, field labels. |
| Metadata | `11 / 15px` | `400` | Time, counts, unavailable text, shortcuts. |
| Micro | `10 / 14px` | `500` | Keyboard hints and only genuinely secondary diagnostics. |

Do not use uppercase/tracking-heavy labels for the primary task shell. Provider identity is quiet text, never a badge: `OpenAI · Codex` or `Anthropic · Claude`.

### 5.2 Content typography

| Style | Size / line | Weight | Use |
|---|---|---:|---|
| Body | `14 / 21px` | `400` | Assistant prose and user text. |
| Body strong | `14 / 21px` | `600` | Markdown emphasis and table headings. |
| Narrative section | `15 / 21px` | `600` | `Plan`, `Outcome`, compact content headings. |
| Compact activity | `13 / 18px` | `400` | Tool and status rows. |
| Code | `12.5 / 18px` | `400` mono | Inline blocks, diff, terminal. |
| Table | `13 / 19px` | `400`; header `600` | Dense transcript tables. |

Production task surfaces have no marketing/display type. A task heading must not exceed `20px`; concept-presentation captions and generated oversized titles are not product typography.

### 5.3 Text rules

- Keep assistant prose measure at `736px`; paragraph text may use the full column.
- Preserve Markdown/GFM/KaTeX/code rendering. Inline code uses a subtle `--dh-control` background and `4px` radius.
- Use tabular numbers for time, token counts, progress, diff counts, and queue position.
- Truncate rail/header/path labels with an accessible full value via title/tooltip; never shrink below the locked scale to fit.
- Placeholder text is not a label. Composer, search, and setup controls require accessible names.

## 6. Icon system

Lucide React is the locked source because it is already installed and matches the captured rounded monochrome outline language. Do not mix icon families.

| Context | Optical size | Stroke |
|---|---:|---:|
| Rail/group row | `14px` | `1.5px` |
| Metadata/tool row | `12–14px` | `1.5px` |
| Standard control | `16px` | `1.5px` |
| Composer action | `16px` inside a `30px` target | `1.5px` |
| Status spinner | `12–14px` | `1.5–2px` |

Rules:

- Use rounded caps/joins and `currentColor`. Fill only semantically filled marks such as the stop square, selected radio/check, or a documented status marker.
- Product/provider identity is text only. No OpenAI, Codex, Anthropic, or Claude logos; no imitation first-party glyph.
- No emoji icons, avatar circles, decorative illustrations, or oversized empty-state marks in the task canvas.
- A text-labeled icon is `aria-hidden`. An icon-only control has an exact `aria-label` and Tooltip; no title-only accessibility.
- Icons inside shadcn Button use `data-icon="inline-start"` or `data-icon="inline-end"`; component CSS owns size.
- Use `size-*` when a standalone icon container has equal dimensions. Do not swap metaphors between states.
- Spinner motion communicates real work. It must have adjacent status text or an accessible label and may not be the only indicator of active state.

Required inventory includes: new task/edit, search, scheduled/clock, plugins, pull request/branch, folder/project, settings, overflow, inspector toggle, send arrow, stop square, queue, attachment/add, chevron/disclosure, check, radio, warning/error, retry, reconnect/status, diff/files/terminal/browser/artifact, copy/link, and provider-neutral task status. Add an icon only when the corresponding action exists.

## 7. Component families

### 7.1 App shell and rail

`DevHubShell` owns the `273px / flexible stage / 316px inspector lane` wide layout and the `46px` main header. It does not own provider data or transcript state.

`TaskRail` is an open list:

- wordmark, search, primary destinations, Projects, Tasks, and bottom Settings;
- row `256x30` at an `8px` rail inset, `9px` radius, `8px` vertical/icon inset, and one-line text;
- selected state `--dh-selected`, strong text, `aria-current="page"`; running additionally shows a quiet spinner without replacing selected styling;
- hover `--dh-hover`; pressed `--dh-pressed`; focus uses the global ring;
- no nested cards, badges for ordinary counts, or colored provider sections;
- task/provider status may use a trailing 6px semantic dot plus text/tooltip; never color alone.

Ops, Inbox, Dashboard, and Settings remain reachable secondary utilities. They do not occupy dashboard tiles in the task canvas.

### 7.2 Header

`TaskHeader` is one `46px` row with `16px` horizontal padding. Left side: optional 14px folder/task icon, truncated title, overflow. Quiet provider identity may appear near the title when space permits; otherwise it moves into the composer/inspector and remains accessible. Right side: only shell/inspector/window actions required by the current task.

Do not show project analytics, editable provider selectors, model pickers, or permission pickers in the header. No title wrapping.

### 7.3 Transcript and messages

`TaskTranscript` is a semantic narrative list in a `736px` max column:

- assistant prose/commentary: unframed, left-aligned, `14/21`;
- user message: right-aligned, max `566px`, `--dh-user-bubble`, `12px` radius, `12px 14px` padding;
- activity row: unframed `13/18`, 14px icon, muted text, optional short result; multiple native events may group only when provider IDs/order remain inspectable;
- plan: heading plus compact rows with check/running/pending state; no dashboard progress panel;
- tool detail expands inline or in the relevant inspector destination without replacing the narrative row;
- errors/reconnect/expiry/cancellation remain in transcript order and preserve prior content;
- unknown provider events render a compact diagnostic disclosure rather than disappearing.

Use semantic articles/sections and stable native event keys. Streaming appends to the existing assistant item; it does not create a bubble for every delta. The transcript has one polite live region for summarized updates, not token-by-token screen-reader announcements.

### 7.4 Composer

`Composer` is `736x98`, `--dh-surface`, `21px` radius, fixed `16px` above the bottom at wide reference size. Anatomy:

1. Flexible prompt textarea with accessible label and a single-line resting height; maximum growth is `160px`, upward.
2. Footer left: attach/add, fixed provider identity, mode/goal, and provider-native permission label.
3. Footer right: requested/actual model disclosure when applicable, then one `30px` circular action slot.

States:

| State | Action slot | Other behavior |
|---|---|---|
| Empty/idle | Disabled send arrow | Disabled state is visually distinct and announced. |
| Draft/idle | Enabled send arrow | Enter sends; Shift+Enter newline. |
| Streaming | Stop square in the same slot | Native interrupt only when verified. Queue may use a reserved adjacent compact action; geometry remains stable. |
| Blocking request | Send disabled | Inline request owns response; provider/task remain fixed. |
| Cancelled/completed | Resting send state restored | No stale failure/approval action remains. |
| Capability degraded | Available controls remain; unavailable controls are hidden/disabled with reason | Never silently substitute raw chat or an unsandboxed command. |

Provider/model/mode/permission controls are compact text controls, not decorative pills. The Claude model diagnostic must distinguish `Requested`, `Session reported`, and `Response used` when they diverge.

### 7.5 Goal, Outcome, and diff summary

- `DiffSummary`: `33px` high, content-width (reference `178px`), fully rounded `--dh-control`; green/red counts remain sparse and pair signs with text.
- `GoalStrip`: `694x34` at reference width, `17px` radius, `--dh-control`, with the observed lower `--dh-control-seam`. Label, outcome text, elapsed/progress, and compact actions share one line.
- `OutcomeStrip` is the Work-mode semantic variant of GoalStrip. It does not imply background execution.
- Expanded progress/deliverables belong in inspector/disclosure, not a second bottom dashboard.

### 7.6 Inspector

`InspectorDock` is one `300px` content-height surface with `16px` radius, `16px` internal padding, and compact section separators. A persistent compact `Environment` summary region precedes the tablist and owns backed environment/repository/subagent/source rows such as branch, Changes/Local, pull-request status, Subagents, and Sources. It is not a tab and does not disappear when the selected destination changes. The five selectable destinations remain exact: `Diff`, `Files`, `Terminal`, `Browser`, `Artifacts`.

- Use Radix/shadcn Tabs with every trigger inside TabsList and one selected destination.
- Keep the Environment summary outside `TabsContent`; only the one selected destination panel below it renders. Omit unbacked summary rows instead of synthesizing status.
- Tab text uses `11/15`, one line. At 300px all five may fit; if localization does not, horizontally scroll the tab list or use a documented overflow menu—never truncate to malformed labels.
- Diff/terminal use mono only inside content. Terminal is provider-emitted output; never invent an automatic unsandboxed prompt.
- Browser and Artifacts show honest `Not available for this task`/`No artifacts` states when gated.
- Sections use rows and separators, not subcards.
- When content exceeds the available body, cap at `calc(100dvh - 75px)` and scroll inside the content area while keeping tabs visible.

Below the wide inspector breakpoint, a labeled header control opens the same content in an accessible right Sheet. The Sheet has a title, focus trap, Escape close, and focus restoration. Availability still follows runtime capability.

### 7.7 Intervention family

Provider intervention is inline, never AlertDialog:

- `PermissionRequest`: title, tool/action, target/path, reason, bounded actions. `Allow`, `Deny`, and `Cancel` remain disabled with `Unavailable until runtime support is verified` until the adapter gate passes. No `Always allow`.
- `InputRequest`: question, 2–7 options via ToggleGroup/RadioGroup, disabled `Send response` until capability and a valid choice exist.
- `SafeRetry`: specific operation (`Read failed`), manual `Retry`, and explicit `Safe to retry`. Never auto-retry uncertain mutation.
- `Reconnect`: `Reconnecting…`, `Check task status`, and `Cancel`; preserve transcript and task ID.
- `Expired`: exact `Request expired — no action taken`; no approval action.
- `Cancelled`: independent `Cancelled by you` state and restored composer; never reuse expiry copy.

Use a restrained `--dh-control` or `--dh-surface` boundary only when grouping is required. Warning/danger colors are secondary accents, not full-card fills. Announce a newly blocking request once; do not repeatedly steal focus.

### 7.8 Setup and provider controls

`TaskSetup` is a compact Popover anchored to the composer provider control on desktop, width `420px`, radius `16px`, max height `min(720px, calc(100dvh - 32px))`. On phone/PWA it becomes a titled Dialog/Drawer.

Field order: `Provider`, `Model`, `Mode`, `Project`, `Folder`, provider-native permission field, then `Create task`. Use FieldGroup/Field, Select, and ToggleGroup rather than custom form rows.

- Provider rows are text-only with quiet semantic dots.
- Exact disclosure: `Provider is fixed after creation. Fork to another provider to continue there.`
- Existing task surfaces never expose a provider picker.
- OpenAI uses its verified model/reasoning and permission vocabulary.
- Claude model selection remains unavailable until verified; show diagnostic divergence without pretending it is a normal model picker. Claude remains selectable as a provider when its creation capability is green.
- The observed empty existing task remains blank; setup appears only after explicit New task intent.

### 7.9 Search, Commands, menus, and review overlays

`TaskSearchDialog` and `CommandDialog` are separate Radix Dialog + Command compositions:

- width `min(672px, calc(100vw - 32px))`, `12px` radius, max body height `55dvh`, top at `12dvh` on desktop;
- scrim `--dh-scrim`; optional backdrop blur is capped at `8px` and disabled under reduced motion/performance constraints;
- input row `44px`, result/action rows `36px`, selected row `--dh-selected`;
- footer exposes keyboard instructions; every Dialog/Sheet has a Title, visually hidden only when the visible field already supplies the heading context;
- focus traps inside and returns to the opener after close.

Search keeps query, global/current-project scope, date facets, highlighted result rows, keyboard selection, result count/status, and `↑↓ navigate`, `↵ open`, `esc close`. Opening a result navigates to its provider-locked task and highlighted message.

Commands contains actions such as `New task`, `Search tasks`, `Toggle inspector`, `Open Settings`, and `Go to Ops`. `Search tasks` closes Commands and opens Search. Menus/popovers share the same surface/radius/elevation but size to content.

`CrossProviderForkReview` is a titled review Dialog at every viewport, not a Sheet, provider switcher, or transfer animation. It becomes a single-column Dialog on narrow screens. It shows unchanged source, locked exclusions, readable attributed/redacted handoff, target-native settings, local-link disclosure, and Cancel/Create. Creation is unavailable until the M7 redaction/native-session gate is green.

### 7.10 Control anatomy

| Control | Desktop size | Narrow/PWA size | Notes |
|---|---:|---:|---|
| Rail row | `30px` high | `44px` in touch sheet | `9px` radius. |
| Compact icon button | `30x30` | `44x44` | `6px` radius unless circular action. |
| Composer action | `30x30` | `40x40` minimum | Circular; stable send/stop slot. |
| Button small | `30px` high | `40px` | `10px` horizontal padding. |
| Button standard | `36px` high | `44px` | Primary review/setup actions. |
| Input/select | `36px` high | `44px` | Visible label; `6px` radius. |
| ToggleGroup item | `32px` high | `44px` | Used for Code/Work and small option sets. |

Component styling belongs in variants/tokens. `className` is for layout only. Use `cn()` for conditional layout classes, semantic variants for color/type, and `gap-*` for spacing.

## 8. Responsive contract

The exact wide reference is observed; narrow/PWA behavior is an approved DevHub proposal and must be validated in browser, desktop, and packaged-app tests.

| Tier | Width | Shell behavior |
|---|---:|---|
| Reference wide | `>=1440px` | `273px` full rail, `46px` header, `736px` transcript/composer, visible `300px` inspector when applicable. Transcript position stays stable if inspector hides. |
| Compact desktop | `1024–1439px` | Full `273px` rail by default; inspector hidden behind explicit control; transcript width is `min(736px, calc(100vw - 305px))`. No horizontal page overflow. |
| Narrow desktop/browser | `768–1023px` | `48px` icon rail with accessible labels/tooltips; full rail opens as a `273px` Sheet. One-pane browse drill-down is preserved. Inspector is a Sheet. |
| PWA/phone | `<768px` | No permanent rail. Compact `44px` header/back navigation, one task pane, `12px` side gutters, read/reply composer, touch targets. Secondary capabilities disclose desktop requirements. |

Additional rules:

- Tauri remains operable at its current `920x600` minimum. At that size use the narrow icon rail, no permanent inspector, and a flexible transcript.
- At `<1024px`, existing Browse remains one pane at a time with explicit Projects -> Sessions -> Transcript navigation and focus-preserving Back.
- The composer is `calc(100% - 24px)` on phone and stays bottom anchored using safe-area insets: `max(12px, env(safe-area-inset-bottom))`.
- Code, tables, terminal, and diff own horizontal scrolling; the page/shell never does.
- Settings uses simple field groups and a slim/sheet rail. Do not compress labels below the type scale.
- PWA scope is reading, reply, and safe navigation. Show exact disclosure `Desktop required for terminal and diff` where relevant. Do not imply native mobile, offline, push, background work, elevated permission, or full parity.
- Full-rail manual collapse may be added, but the state must persist per shell, preserve keyboard access, and never hide the only route to a feature.

Required responsive fixtures: `1800x1130`, `1440x900`, `1280x720`, `1024x768`, packaged `920x600`, `768x1024`, and `390x844`. Verify zoom at 200% without loss of task controls.

## 9. Motion and reduced motion

The captures are static; no first-party timing, reversal, or easing was observed. These are locked DevHub fallbacks within the approved `120–220ms` band.

```css
--dh-motion-fast: 120ms;
--dh-motion-standard: 160ms;
--dh-motion-panel: 220ms;
--dh-ease-standard: cubic-bezier(0.2, 0, 0, 1);
--dh-ease-exit: cubic-bezier(0.4, 0, 1, 1);
```

| Event | Motion |
|---|---|
| Hover/focus/pressed color | `120ms` color/background/border only. |
| Popover/menu/dialog enter | `160ms`, opacity plus at most `4px` translate. |
| Popover/menu/dialog exit | `120ms` opacity; focus restores after close. |
| Rail/inspector Sheet | `220ms` transform; reversible without content reflow. |
| Transcript append | No entrance animation; native content appears in order. |
| Send -> stop swap | No container animation or geometry change; icon crossfade optional `120ms`. |
| Goal/diff strip | No bouncing/pulsing; state change may crossfade `160ms`. |
| Essential spinner | `800ms linear infinite`; paired with status text. |

No spring, bounce, glow pulse, typing dots, scroll-jacking, celebratory effect, or animated provider transfer is allowed.

Preserve the current `useReducedMotion` three-state preference (`auto`, `on`, `off`) and `data-reduce-motion="true"` integration while migrating the storage key through the preservation plan. Under reduced motion:

- decorative transforms, fades, caret blink, shimmer, backdrop blur transition, and smooth scrolling become immediate;
- panel/dialog state changes retain focus management but no visible travel;
- an essential spinner rotates at `800ms` only when reduced motion is off; under reduced motion it becomes a static status icon, while adjacent text and `aria-busy` carry the same meaning;
- no behavior depends on `transitionend` timing without a zero-motion-safe path.

Motion status remains **proposed/unobserved** until M8 captures start/mid/end, interruption/reversal, and reduced-motion frames.

## 10. Accessibility and interaction states

### 10.1 Focus and keyboard

- Use a `2px` `--dh-focus` focus-visible outline/ring with `2px` separation from the control edge. It must remain visible against canvas, surface, selected, warning, and destructive states.
- Do not remove focus outlines without the replacement above. Pointer click may omit the ring; keyboard focus may not.
- Dialog, Sheet, Popover menus, Command, Select, Tabs, ToggleGroup, and RadioGroup use Radix keyboard/focus behavior. Every overlay restores focus to its opener.
- Preserve global shortcuts and list/transcript/composer paths in `preservation-matrix.md`; conditional approval shortcuts render only when the provider can answer the request.
- Escape closes the top overlay first, cancels a non-destructive transient state second, and never silently discards a running provider turn.

### 10.2 State styling

| State | Visual and semantic treatment |
|---|---|
| Hover | `--dh-hover`; no movement or new border. |
| Selected/current | `--dh-selected`, strong text, `aria-current`/`aria-selected`; never color alone. |
| Pressed | `--dh-pressed`, `aria-pressed` where applicable. |
| Focused | 2px focus ring; selected fill remains visible underneath. |
| Disabled | `--dh-text-disabled`, no pointer action, native `disabled`/`aria-disabled`, explanation when capability-gated. Essential meaning may not rely on low-contrast text alone. |
| Loading/running | Quiet spinner plus status copy and `aria-busy`. Controls that remain safe stay operable. |
| Success | `--dh-success` plus check/text. Do not use a full green card. |
| Warning | `--dh-warning` plus warning text/icon. |
| Error/destructive | `--dh-danger` plus specific copy and recovery action where safe. |
| Expired | Neutral terminal state with exact no-action copy; never styled like success/approval. |
| Provider unavailable | Neutral disabled control plus reason; do not substitute another provider. |

Target WCAG 2.2 AA: 4.5:1 normal text, 3:1 large text and essential UI boundaries. Disabled decoration is exempt only when the same information is available in accessible text. Do not use `--dh-text-disabled` for required instructions.

### 10.3 Semantics and announcements

- Shell has one main landmark, named navigation, and skip link.
- Each task item exposes provider, title, running state, and native/local archive distinction in accessible text.
- Transcript items retain role, order, and timestamp semantics. Tool detail controls expose expanded state.
- Streaming uses a throttled polite live-region summary; permission/input requests use a one-time assertive announcement without automatically moving focus.
- Icon-only controls have labels; truncation has accessible full text; form errors use `data-invalid` on Field and `aria-invalid` on the control.
- Dialog, Sheet, and Drawer always include Title. Inputs use labels; placeholders are hints only.
- Minimum desktop target is `30px` for captured compact chrome and at least `44px` for touch/PWA. Ensure 24px minimum target spacing where compact desktop controls are adjacent.
- In forced-colors/high-contrast modes, preserve outlines, current selection, checked state, and stop/send distinction without relying on fills.

## 11. Shadcn/Radix component map

Use existing/registry primitives before custom markup, but apply DevHub variants rather than default shadcn visuals.

| DevHub need | Substrate |
|---|---|
| Action/icon action | Button with locked `compact`, `standard`, `icon`, `composer`, and destructive variants. |
| Setup/settings fields | FieldGroup + Field + Input/Select; InputGroup for controls inside inputs. |
| Code/Work and 2–7 options | ToggleGroup or RadioGroup. |
| Inspector destinations | Tabs + ScrollArea + Separator. |
| Commands/Search | Command inside Dialog; two separate dialog instances/contracts. |
| Narrow rail/inspector | Sheet with Title and focus restoration. |
| Provider/setup menu | Popover or Select; titled Dialog/Drawer on phone. |
| Menus/context actions | DropdownMenu/ContextMenu with items inside groups. |
| Empty/unavailable | Empty for real empty content; Alert for bounded capability disclosure. Never add an Empty to the observed blank task canvas. |
| Loading | Spinner/Skeleton; no decorative skeleton in active transcript. |
| Toast | Sonner; it does not replace inline task errors. |
| Tooltip | Tooltip for icon-only controls and truncated chrome, not essential instructions. |

Custom components remain necessary for DevHubShell, TaskRail, TaskTranscript, user bubbles, activity rows, Composer, GoalStrip, DiffSummary, InspectorDock, provider events, and cross-provider review. They compose Radix/shadcn primitives rather than recreating focus traps, selection groups, or dialogs.

Before using any registry component in production, run the project-package-runner shadcn docs command, inspect the installed source, preserve `base: radix`, use Lucide from project context, and preview updates with `--dry-run`/`--diff`. Never overwrite local components without explicit approval.

## 12. Explicitly unresolved or unobserved

These items are honest gaps, not permission to improvise first-party behavior.

| Item | Locked fallback now | Required proof before claim/cutover |
|---|---|---|
| Exact SF font metadata | System stack and scales in section 5. | Native-size computed-style and screenshot comparison. |
| Hover, pressed, focus ring | Tokens/states in sections 2 and 10. | Keyboard/pointer/forced-colors visual tests. |
| Rail vibrancy/material | Active `#404040`, inactive `#202020`; packaged material allowed only if it matches. | Active/inactive packaged captures. |
| Motion/easing/reversal | `120/160/220ms` DevHub fallbacks. | Normal/reduced start-mid-end captures. |
| Global pre-task setup | Explicit Popover/Dialog after New task intent. | M6 workflow and accessibility tests. |
| Expanded Plan | Compact inline rows in transcript. | Provider fixture and visual test; no progress dashboard. |
| Approval/input/reconnect/expiry/cancel visuals | Inline intervention family, capability-gated. | Provider adapter lifecycle fixtures and stale/timeout tests. |
| Inspector destination contents | Exact five destinations and honest unavailable states. | Per-provider capability/runtime fixtures. |
| Claude model selection | Requested/session/actual diagnostics; selector disabled. | Version-specific model convergence proof. |
| Claude raw controls, fork continuation, post-interrupt resume | Hidden/disabled. | M4 live selected-CLI parity. |
| Cross-provider fork | Review UI specified but disabled. | M7 redaction, native target, provenance, and immutability gates. |
| Work background/subagent execution | Not shown or claimed. | Provider-specific proof; Work remains outcome/deliverable mode. |
| Search visual restyle | Existing functional Search contract with new tokens. | Populated/loading/empty/error keyboard and screenshot suite. |
| Narrow/PWA behavior | Breakpoints and disclosures in section 8. | Browser, packaged desktop, zoom, touch, and screen-reader tests. |
| Light mode | Existing neutral light palette preserved. | Separate M8 fidelity/contrast review. |
| Native mobile/offline/push/full parity | Explicitly excluded. | New user approval and implementation plan would be required. |

None of these gaps blocks M2's non-visual adapter seam. They do block enabling or advertising their corresponding control.

## 13. Fidelity and cutover gates

Before any task-shell slice replaces its legacy path:

1. Capture the implementation at `1800x1130` and compare it at original detail with the governing real capture and selected concept/brief.
2. Verify rail `273`, header `46`, transcript/composer `736`, composer `736x98` with `16px` bottom gutter, inspector `300` with `16px` right gutter, selected row `256x30`, and open canvas `#181818` from computed geometry/pixel sampling.
3. Audit chrome and content typography separately, including controls, rail, inspector, Markdown, table, mono, and status rows.
4. Run a visible-copy diff against the allowed-copy contract; generated malformed or invented strings fail.
5. Verify icon family, metaphor, stroke, size, fill, alignment, labels, selected/disabled/focus states.
6. Exercise idle, draft, streaming, stop, queue, cancelled, failure, reconnect, expired, blocked request, degraded capability, and restored-composer states using provider fixtures that do not over-claim live support.
7. Test Search and Commands as distinct focus-trapped workflows; test focus restoration and all preserved shortcuts.
8. Test all responsive fixtures in section 8 with no shell overflow and correct inspector/rail disclosure.
9. Test reduced motion, 200% zoom, keyboard-only, screen reader announcements, contrast, and forced colors.
10. Confirm no default shadcn visual preset, nested card grid, provider logo, cream tint, gradient/glow, marketing copy, or unsandboxed terminal affordance entered the implementation.

Functional QA cannot substitute for concept-to-render fidelity QA. Final M6/M8 signoff requires `view_image` inspection of both the governing reference and latest browser/packaged screenshot, plus a written mismatch ledger with every material issue fixed or explicitly approved.
