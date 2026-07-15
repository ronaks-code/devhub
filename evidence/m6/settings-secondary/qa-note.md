# M6 Task 8 — Settings + secondary utilities QA note (`settingsSecondary` flag, default OFF)

DevHub-own Browser QA of the extracted `SettingsRoute` plus `OpsRoute`/`InboxRoute`/
`DashboardRoute`. Measured against a self-contained `fixture.html` built from the
SHIPPED `index.css` token/`.dh-*` blocks plus the REAL `SettingsRoute`/`OpsRoute`/
`InboxRoute`/`DashboardRoute` SSR markup (rendered by the components via
`renderToStaticMarkup`, not hand-authored). Served on `http://127.0.0.1:5311`,
viewport 1200x2600, dark. Same fixture-measurement method used for M6 Tasks 1-7.

## Fixtures / screenshots

- `fixture.html` — 5 labeled sections: Settings (Appearance/Providers/Budget/
  Permissions field groups, Preferences tab, populated snapshot with a requested-
  but-clamped `Native Codex`), Settings loading (no snapshot yet), Ops (routed
  under Secondary nav, `ops` active), Inbox (routed under Secondary nav, `inbox`
  active), Dashboard (routed under Secondary nav, `dashboard` active, its own
  loading skeleton — never the task canvas).
- `m6-settings-secondary-wide.png` — full-page capture at 1200 wide.

## Live `getBoundingClientRect` / `getComputedStyle` / DOM measurements

| # | Property | Measured | Expected | Result |
| --- | --- | --- | --- | --- |
| 1 | Exactly the four named field groups, in order | `["Appearance","Providers","Budget","Permissions"]` | `design-lock.md` §8 / `component-state-matrix.md` §13 rest rule | Match |
| 2 | Field groups are labelled `<section>`s, never a bordered "card" | `border: 0px none` on `[data-dh-fieldgroup]` | "no generic form cards" (Task 8 DoD) | Match |
| 3 | Ops/Inbox/Dashboard/Settings are each wrapped in ONE `SecondaryNav` landmark with the correct active destination | `5` `nav[aria-label="Secondary"]` (one per rendered frame), active labels `Settings/Settings/Live ops/Inbox/Dashboard` | "Ops/Inbox/Dashboard stay secondary utilities, not task-home cards" | Match |
| 4 | Every preserved workflow tab still reachable | `1` `role="tablist"` in the Settings frame with `10` `role="tab"` entries | preferences/budget/memory/mcp/hooks/webhooks/permissions/agents/skills/plugins all present | Match |
| 5 | Provider-capability `Table` renders real semantic markup, 3 rows | columns `["Feature","Status","Note"]`, `3` `tbody tr` | audited `Table` primitive, never a layout table | Match |
| 6 | Local-vs-synced connection labeling is explicit and distinct | text `"Not saved" + "Not synced — stored only on this device, never sent to the server."` | `component-state-matrix.md` §13 disconnected rule | Match |
| 7 | Connection sub-fields are grouped in a real `<fieldset><legend>` | `1` `fieldset[data-dh-fieldset]`, legend text `Connection` | audited `FieldSet` primitive | Match |
| 8 | Dashboard's own loading state renders under Secondary nav, not as task-canvas chrome | `aria-label="Loading dashboard"` present inside the Dashboard frame's `SecondaryNav` | "Never move dashboard cards into task shell" (`surface-inventory.md` `RT-06`) | Match |
| 9 | No provider/brand logos in the secondary destination list | `0` `<svg>`/`<img>` inside the nav's destination `<ul>` | quiet-text navigation, no decorative chrome | Match |
| 10 | Destructive local-data action is present but its confirmation is NOT rendered until opened | button text `Clear local connection data`; `0` `[data-dh-settings-dialog]` nodes on initial render | `component-state-matrix.md` §13 destructive rule (confirm high-impact operations, but only on demand) | Match |

10 concrete comparison points, all Match. Only benign `@import`/favicon 404s (same
as every prior M6 fixture — `tailwindcss`/`highlight.js`/`katex` unresolved in a
plain static-file server, matching the shipped `index.css`).

## Flag safety

`settingsSecondary` requested-default stays **false**. Flag-off keeps the legacy
`SettingsPane`/`LiveOpsBoard`/`InboxPane`/`DashboardPane` mounted exactly as today
(`resolveSettingsSecondaryMode` returns `legacy` for false/undefined/missing
settings and `isSettingsSecondaryApplied` is true only for an explicit `true`, both
asserted in `SettingsRoute.test.ts` and re-exported/asserted identically from
`OpsRoute.test.ts`/`InboxRoute.test.ts`/`DashboardRoute.test.ts` — one slice, one
gate, not four independent ones). `nativeCodex`/`persistentClaude`/`searchCommands`/
`settingsSecondary` requested-defaults stay false.

## Scope (honest)

This unit delivers: (1) the canonical `SettingsRoute` — accessible `Appearance`/
`Providers`/`Budget`/`Permissions` field groups built from the audited `Tabs`/
`FieldGroup`/`Field`/`FieldSet`/`Select`/`Input`/`Switch`/`Button`/`Alert`/
`Progress`/`Table`/`Dialog` primitive set, reusing `SettingsPane`'s pure state-
machine helpers (`completeDevHubFeatures`, `withNativeCodexPreference`,
`withPersistentClaudePreference`, `settingsUpdatePayload`,
`dirtySettingsUpdatePayload`, `mergeAuthoritativeSettings`,
`deliverSettingsResponse`, `requestSettingsReconciliation`) instead of re-deriving
the same save/reconcile/dirty-field logic a second time, with every preserved
workflow (Budget/Memory/MCP servers/Hooks/Webhooks/Permissions/Agents/Skills/
Plugins, plus the RebuildIndex/IntegrityPanel/ArchiveTransfer maintenance
utilities) mounted UNCHANGED; (2) the shared `SecondaryNav` landmark; (3)
`OpsRoute`/`InboxRoute`/`DashboardRoute` — thin wrappers that route the preserved
`LiveOpsBoard`/`InboxPane`/`DashboardPane` under `SecondaryNav` instead of as
primary task-home tabs, reusing those panes' CONTENT unchanged (not rewritten) so
every current running/triage/analytics behavior stays exactly as shipped; and (4)
a NEW, real, bounded destructive action — clearing the browser-local connection
prefs (`devhub:conn`) via a `Dialog` confirmation that never calls a provider
delete, states the exact affected store, and is reversible — since no equivalent
"cache/database deletion" control existed to route through the audited `Dialog`
primitive otherwise.

Live mounting into `App.tsx`'s primary-tab rail (replacing the current `home`/
`browse`/`settings`/`dashboard`/`ops`/`inbox` sibling tabs with `SecondaryNav`-
routed destinations, wiring real handlers/routing) is a DEFERRED data-wire staged
for the Task 9 `codexStyleShell` cutover, mirroring exactly how Tasks 1-7 left
their live mount as a later data-wire.

Tooling note: `design-lock.md` §7/§11 names the shadcn/Radix toolchain for this
build, but no task in this M6 series (1-8) has installed shadcn/cmdk/Radix
packages — the entire `apps/web` codebase (100+ components, including the legacy
`SettingsPane`/`LiveOpsBoard`/`InboxPane`/`DashboardPane` this slice supersedes for
Settings and routes for Ops/Inbox/Dashboard) uses hand-rolled, ARIA-correct
primitives styled through the shared `cn()` token utility. `apps/web/src/components/
features/settings/settings-ui.tsx` is a hand-rolled implementation of the exact
named primitive set (`Tabs`/`FieldGroup`/`Field`/`FieldSet`/`Select`/`Input`/
`Switch`/`Button`/`Alert`/`Progress`/`Table`/`Dialog`), reusing the EXISTING shared
`nextTabIndex` roving-focus helper from `InspectorDock` rather than re-deriving the
same math a third time. Installing net-new shadcn/cmdk/Radix packages for this
slice alone, while every other M6 surface (and the rest of the app) stays
hand-rolled, would be an inconsistent, higher-risk partial adoption; a full shadcn
migration is an unstarted, larger follow-up out of scope for a single slice.
