# DevHub Aurora — QA findings (aggregated, deduped)

Wave 1 testers: qa-data (Codex), qa-shell (Opus), qa-visual (Fable), qa-resize (Codex), qa-flow (Opus), qa-features (Codex).
Status: qa-data ✅, qa-shell ✅, qa-visual ⏳(requested), qa-resize ⏳, qa-flow ⏳, qa-features ⏳.

## HEADLINE — Nav/IA redundancy (BOTH data+shell confirm; Ronak's complaint)
- [ ] **N1 Too many nav columns.** Browse/session view stacks: icon rail 52 + Sessions inbox 272 + PROJECTS 287 + Browse Sessions 319 = ~930px (73% of 1280) before the transcript (~350px). "Sessions" shown TWICE. (shell#1)
- [ ] **N2 PROJECTS column also on Chat route** (rail+sidebar+projects+launchpad = 611px chrome). (shell#2)
- [ ] **N3 Clicking a session ALWAYS routes to ?tab=browse** (the 4-col view), even from Chat — should open a FOCUSED single-pane chat/transcript. (shell#3)
- [ ] **N4 No working sidebar collapse** — ⌘\ appears unwired, no collapse button found. VERIFY BY HAND (playwright chord delivery flaky). (shell#4)
FIX DIRECTION: the sidebar inbox IS the session nav → drop the ProjectsPane from chat pane + stop routing session-clicks into Browse's 3-pane; open sessions focused (chat or single transcript). Keep Browse as its own explorer tab but don't duplicate.

## DATA CORRECTNESS
- [ ] **D1 (blocker) Budget panel $0.00 vs Dashboard ~$12k MTD** — same month, contradictory; projection off $0 run-rate. (data#1)
- [ ] **D2 Session titles render literal "1"** in Ops grid/board/drive/addpanel (data-level). (data#3)
- [ ] **D3 "Needs you" count mismatch** — sidebar 2 vs Live Ops Board 0. (data#4)
- [ ] D4 Project Detail ~30 rows show "—" cost/tokens despite sessions — spot-check join. (data#11)
- [ ] D5 Project Leaderboard lists "6thSense-capture" twice (path collision on display name). (data#12)

## STATE / LOADING (races)
- [ ] **S1 Dashboard period selector freezes on stale $ figure** after switching, no loading indicator. (data#2)
- [ ] S2 Cost Forecast + Uncommitted Changes render empty/no-skeleton (load race). (data#5)
- [ ] S3 Cold-start ~15-20s blank ("0 sessions", "Loading view…") — no skeleton for first ~20s. (shell#6)
- [ ] S4 Welcome modal re-shows every reload — not persisted? LIKELY playwright fresh-profile artifact; VERIFY markOnboardingSeen writes+reads. (shell#5)

## LAYOUT / POLISH
- [ ] P1 "By Tool" leaves large empty void when left col longer than right. (data#6)
- [ ] P2 Raw `mcp__…` internal identifiers shown — personal-view maybe OK, else friendly-name map. (data#6)
- [ ] P3 Topbar project-spend vs Dashboard window-spend: different scopes, no visual grouping → misread. (data#7)
- [ ] P4 Cost-by-Model donut legend colors too close (4 violets + 2 pinks). (data#8)
- [ ] P5 `<synthetic>` cost formats 3 decimals ($0.111) vs 2 elsewhere. (data#9)
- [ ] P6 Activity heatmap horizontal overflow (718 vs 379), no scroll affordance. (data#10)
- [ ] P7 "+" new-chat no-op on Launchpad, no feedback. (shell#7)
- [ ] P8 Close-last-tab route-dependent (Browse leaves empty pane, not Launchpad). (shell#8)
- [ ] P9 g-chord hint labels always-on clutter? eyeball. (shell#9)

## VERIFIED OK (both)
- No console errors any route; g-chords navigate; inbox tiers/filter/search/footer well-built; light mode holds; responsive at 1000px collapses cleanly (no h-overflow); Grid/Board/Drive load real data; Settings search + sections + permissions work; donut math consistent; model-name tooltip fallback works.

## qa-visual (Fable) — appended
### BLOCKERS
- [ ] **B1 Large transcript CRASHES app to about:blank** (renderer dies; reproduced 2x). Unvirtualized transcript render. Big sessions (~2400 msgs/700M tok). TOP PRIORITY.
- [ ] **B2 Spatial Blueprint bottom half unreachable** — content ~1200-1460px in 648px overflow:hidden container, no scroll/zoom/pan. Row-3 rooms + legend + "OFFICE — PLAN 02" title block invisible. Still clipped at 1680.
- [ ] **B3 Browse collapses at 1280x720** — transcript crushed ~60px (one word/line), composer shrinks to "De scr" sliver + clipped Send, inspector overlaps transcript header. OK at 1680. (relates to composer min-width + N1 columns eating width)
### MAJORS (new/expanded)
- [ ] M1 Spatial: Blueprint (live MOCK FEED, 25 agents/11 rooms, orange, interactive) vs Nameplates (static FIXTURE, 10 agents/8 depts, green/zinc, dead) = TWO different products; toggling switches data source AND palette. Unify data + theme.
- [ ] M2 Three palettes in one app (violet shell / orange blueprint / green nameplates) + dev jargon in UI ("MOCK FEED", "FIXTURE · READ ONLY", "Static FleetSnapshot…"). (Nebula rebrand + blueprint/nameplates retint should fix palette; strip jargon.)
- [ ] M3 Welcome modal renders LIGHT over dark app (theme race at mount) + pops up seconds late over interactive content. (also S4 persistence)
- [ ] M4 Settings off-theme: native OS selects + default-blue native checkbox in glass app; dev copy "Stored for now; full theming lands later"; helper text clipped behind floating Save button. (overlaps D... settings styling)
- [ ] M5 Codex tab = raw debug page (truncated id, one "Verified capabilities:" line, black void, "Waiting for Codex approval requests."). No chrome/styling.
- [ ] M6 Dashboard: ~30s blank skeletons; bottom project table truncates names to 1-2 chars beside empty "—" cols; an empty panel; WINDOW SPEND pink-gradient while sibling stats plain white (inconsistent); Daily Spend chart has NO axis labels. (overlaps S1/S2/D4/P... )
- [ ] M7 (=D1/D3 expanded) Counts contradict on same screen same moment: Ops Grid "1 running" vs Board "0 running/0 waiting" vs sidebar "RUNNING 2/NEEDS YOU 3" vs statusbar "2 running"; Browse Overview "TOTAL TOKENS 0" beside BY MODEL 7835M; "0 sessions" on a 54-session project. DATA JOIN inconsistency across components — needs one source of truth.
- [ ] M8 Transcript renders raw internals as chat: "[queue][queued: enqueue]", "[hook][SessionStart:startup]{json}", full [attachment] JSON dumps; stray empty box by "You" label. (transcript formatting — cluster with B1)
- [ ] M9 (=N-cluster expanded) Secondary text nav "Settings|Live ops|Inbox|Dashboard" duplicates dock icons AND is embedded inside Ops→Board; Inbox click in that nav did NOTHING (dock icon works). Browse = up to 6 vertical zones at 1280.
- [ ] M10 Browse Overview pane clipped at 1280 (3rd stat card cut "ACTIV…", project name "00…").
### MINORS (new)
- [ ] Progress tab "mined 57y ago" (epoch-0 bug); "gen-progress" internal tooling ref. (= the P2/junk class)
- [ ] Topbar not responsive: at 1024 spend pill/counts/gear clipped off-screen; at 1280 open-session tab crowds breadcrumb.
- [ ] Blueprint desk callout micro-type (~7-8px dim mono, borderline illegible at 1x — NO true overlap, reads as overprint).
- [ ] Scheduled jobs: one short job = ~200px near-empty full-width card; "(undocumented)" placeholder; heading-case inconsistency app-wide.
- [ ] Home first load 10-15s spinner; sessions sidebar flashes "No sessions" instead of skeleton.
- [ ] Changed-files trailing slash on a file (".../pending.md/ +22").
- [ ] Inspector shows placeholder junk before any selection (WORKTREE main/SESSION —/CHANGED FILES No changes).
- [ ] Blueprint churns constantly under mock feed (rooms flip VACANT within a minute) — confirm real feed won't.

## qa-flow (Opus) — appended (usability; heavy overlap = strong signal)
- [x-dupe] Confirms B3/N1: reading a past chat UNREADABLE at 1280 (48px transcript sliver between session list + worktree panel). 3 testers now confirm → TOP layout fix.
- [ ] **F1 Onboarding persistence is a REAL code bug** (CONFIRMED, upgrades S4): localStorage only holds `devhub:ui`{tab,projectId} + `devhub:theme` — NO seen-onboarding flag; dismissal is React-memory only → re-shows every reload. FIX: write/read a devhub:onboarded flag (verify markOnboardingSeen actually persists).
- [ ] **F2 Three parallel nav systems** (expands N/M9): icon rail (11 dest) + a context horizontal strip (shows "Settings/Live ops/Inbox/Dashboard" on some views, "Grid/Board/Drive" on Ops) + session tabs. Plus 3 unlabeled search/filter boxes on one screen (sidebar "Filter sessions" / center "Filter sessions" / top "Search ⌘K"). Destinations duplicated in rail AND strip.
- [ ] **F3 "Reconnect to send" dead-end** — new-session composer shows "Reconnect to send. Your draft is saved." but "Reconnect" is NOT a button, no reconnect control, no spinner, no connection indicator. Self-heals in seconds but looks broken meanwhile. (WS backend env caveat — but the state UX is poor; add a real connection indicator + spinner.)
- [ ] **F4 "Open" on a Needs-You session blanks app to about:blank** — no confirmation / new-tab / "opening…" feedback (likely an external deep-link, reads as a crash). Add feedback / handle. (may relate to B1)
- [ ] F5 Money unlabeled/inconsistent in CHROME: top-bar "$10894 project" / sidebar "jul spend $12157" / statusbar "$12157 MTD" / dashboard trio — terse chrome labels, hard to tell apart. (expands P3)
- [ ] F6 Misleading counters: sidebar "336 open" = TOTAL sessions (only 2 running) — "open" wrong word; global "336 sessions" is Claude-only while Home shows "Total Codex 1193" → "sessions" undercounts.
- [x-dupe] Live Ops "0 running" vs statusbar "2 running" (=D3/M7); cards titled "1" (=D2).
- [ ] F7 Three confusing chat entry points in rail: "Chat" / "New OpenAI Chat" / "Codex" + a Claude/Codex sidebar toggle — unclear where to start a normal chat.
- [x-dupe] Icon-rail 2-letter labels (gh/gb/gc…) read as cryptic (= shortcuts, hover-only). (=shell#9)
- [x-dupe] Browse composer clips "De scr/Send" + overlaps last session row at 1280 (=B3).
- [ ] F8 "New task" composer jargon ("Describe the outcome or change…", "Create cross-provider fork") clashes with the "start a chat" mental model onboarding sets up.
GOOD (qa-flow): onboarding content, Dashboard, Inbox, ⌘K search, Spatial blueprint, tabs model, Settings, wide-width transcript, live data updates.

## qa-resize (Codex) — appended (responsive; "everything resizes cleanly" = FALSE for most routes)
- [ ] **R1 (blocker) Icon rail VANISHES below 768px** — no hamburger/drawer fallback. Below 768, Home/Browse/Chat/Spatial become UNREACHABLE (only the 4 secondary-strip views remain). Every route. Repro: 764 vs 768.
- [ ] **R2 (blocker) Chat: Sessions rail + Projects panel render SUPERIMPOSED at 768-1023px** — collapse onto same x, double-exposed/illegible (DOM rects confirm real overlap, not crowding). Broken 768-1023, clean at 1024. Chat unusable in that band.
- [ ] R3 (major) Ghost panel elements bleed through the secondary tab strip at 768-1023 on Dashboard ("Filter sessions" input) + Ops>Board (stray "Codex" tab). Pixel overlap; clicks still land but visibly broken.
- [ ] R4 (major) Settings at 768px: category list floats as overlay on the detail panel while sessions sidebar "Needs You" cards bleed through behind — 3 layers stacked illegibly. (clean at 700 single-col + at 1440.)
- ROOT: the Sessions-rail / Projects-panel / secondary-strip COLLAPSE logic is broken across 768-1023 + nav lost <768. Scoped, not global CSS. Ties into N-cluster + B3 (the ≥1280 crush is the same "columns don't fit" story). NOTE desktop app usually ≥1024 so ≥1024 correctness is priority; <768 at least shouldn't lose nav.
- RESIZES CLEANLY: spatial (best), browse content, ops Grid+Drive, home/dashboard ≥1024. NO document h-scroll anywhere (all breakage = overlap/z-index).

## qa-features (Codex) — appended (features/keyboard/edge)
### BLOCKER
- [ ] **QF1 Close-last-tab leaves stale orphaned "New task" view, not Launchpad.** Real gate bug: a {kind:"new"} chat seed (from startNewChat/"+"→Launch) has no tab, so closeTab (which only clears on activeTabId match) never clears it → orphan persists after all × closed. FIX closeTab to clear the new-chat seed when no tabs remain.
- [ ] **QF2 Launching from "+ New chat" never adds a tab** (DOM .dh-chattab stayed 2). Partly the WS env (ws://localhost:5173/api/ws/session fails → ChatHost never gets a session id → onSessionChange never fires → no tab). Ensure a launched session becomes a tab once it has an id; and make the tab-add not depend solely on a live WS.
### MAJOR
- [ ] **QF3 ⌘1/⌘2 tab-switch shows BLANK** (empty composer "Reconnect to send", inspector reset to no-worktree/—/no-changes) for a session that shows FULL data in Browse. Chat-resume hydrates only from the live WS; Browse uses indexed data. FIX: chat-resume should hydrate transcript+inspector from the indexed session immediately (like Browse), not depend on the WS. (WS failure is env, but the no-fallback-hydration is a real bug.)
- [ ] **QF4 ⌘⇧I "Toggle inspector" keyboard shortcut is DEAD** (palette-click works, keypress does nothing). Wire the ⌘⇧I handler.
### MINOR
- [ ] QF5 Command palette fuzzy too loose ("spatial" matches "Go to Progress").
- [ ] QF6 After "+", both tabs aria-selected=false (a11y — no active tab while ephemeral launch panel up).
- [ ] QF7 Home indefinite-looking spinner several seconds before Overview renders — skeleton better. (=S3/home-load)
- [ ] QF8 (backend, FYI/out-of-UI-scope) Scheduled Jobs "0 automations" → "M5/M1 unreachable — malformed generator output" cron/data error.

### ✅ RESOLVED — NOT bugs (qa-features confirmed working; remove from fix list):
- ⌘\ sidebar collapse WORKS + persists across reload → **N4 was a false negative (playwright chord latency). Sidebar collapse is fine.**
- All g-chords (gh/gb/gc/gu/go/ge/gp/ga/gi) navigate correctly.
- ⌘K search (filters, date chips, highlight, Escape, rapid-toggle) works.
- ⌘⇧P command palette (fuzzy, run, Escape) works.
- Chat tab × per-tab close works (only the LAST-tab case is broken = QF1).
- Live Ops Drive add/remove panels + greying already-added + "X/6 watching" works.
- Settings live search + jump + Save button work.
- Launchpad draft carries into launched session; engine picker clickable.

## ===== WAVE-1 COMPLETE — FIX PLAN (clusters, serial where files overlap; model variety) =====
- **A · SHELL/NAV/RESPONSIVE/TABS** (App.tsx + features/shell/*): nav redundancy (drop ProjectsPane from chat; session-click opens FOCUSED not Browse-3-pane; consolidate the duplicate nav systems/search boxes), 1280 transcript crush (B3), 768-1023 superimposed panels (R2/R3/R4), <768 nav fallback (R1), close-last-tab orphan (QF1), "+"/tab-add (QF2), ⌘⇧I wire (QF4), "Reconnect" indicator (F3), "Open"→about:blank feedback (F4). → implementer FABLE; adversarial Codex+Opus. BIGGEST, do first.
- **B · TRANSCRIPT** (ThreadWorkspace + m6-compose mapMessages): crash/virtualization (B1), raw [hook]/[attachment] formatting (M8), chat-resume hydrate from indexed data (QF3). → CODEX/Sol-high; adversarial Opus+Fable. After A (ChatHost overlap).
- **C · DATA CONSISTENCY** (m6-compose joins + DashboardPane + opsHelpers): budget $0 (D1), "1" titles (D2), count contradictions running/needs-you/tokens/sessions (D3/M7/F6), leaderboard dup (D5), "—" cost/tokens (D4). One source of truth. → CODEX/Sol-high; adversarial Opus+Fable. After A/B.
- **D · SPATIAL** (spatial/* only — DISJOINT, can parallel A): blueprint scroll/zoom (B2), unify two renderers' data+theme (M1), churn. → OPUS; adversarial Codex+Fable.
- **E · THEME/REBRAND** (index.css + FirstRun + Settings + Codex panes + logo): Nebula colors + Deck logo + Welcome retint/persistence/theme-race (F1/M3), Settings off-theme (M4), Codex tab chrome (M5), strip dev-jargon (M2). → FABLE; adversarial Codex+Opus. LAST before merge (retint after structure settles).
- **F · POLISH batch**: donut colors P4, decimals P5, heatmap overflow P6, "By Tool" void P1, mcp__ names P2, topbar spend-scope P3/F5, misleading counters F6, chat-entry-points F7, "New task" jargon F8, progress epoch, cards "1" (=D2), topbar responsive <1024, blueprint callout micro-type, scheduled-jobs sparse, home skeleton QF7, trailing slash, inspector pre-select placeholder, headings-case, palette fuzzy QF5, aria QF6. → mixed. LAST.
Then: re-QA WAVE 2 (rotate models, seeded) → loop until 2 dry rounds → merge → rebuild+swap app.

## ===== WAVE-2 RESULTS — most fixes HELD; remaining for wave-3 =====
VERIFIED FIXED (all 4 testers): Nebula coherent + clay-remap, Deck mark in sidebar/topbar/favicon, welcome dark+persist+gated, theme-toggle persist(mostly), palette fuzz, settings themed, codex chrome, donut colors, nav consolidation (no ProjectsPane on chat, focused session open, B3 gone), spatial fit B2 + renderers unified M1, big-transcript CRASH gone B1, budget==MTD, no "1" titles, leaderboard dedup, decimals, heatmap scroll, mcp prettify, topbar responsive, epoch fixed, running-count agrees.
### WAVE-3 FIX BATCH (remaining):
- [ ] W3-TX (transcript) MAJOR: (a) history AMPUTATED — huge session loads only last ~17 msgs, no "load older", scroll-up loads nothing → 3000+ unreachable; add pagination/load-older. (b) M8 REMAINDER — still renders raw as chat bubbles: `[queue]`,`[hook]{json}`,`[attachment]{json}`, `<task-notification>…</task-notification>` XML, "[Image: original …Multiply coordinates…]" scaling notes → collapse/hide like the others. (c) open transcript at LATEST not top. (d) assistant markdown not rendered (literal `**`). Files: m6-compose mapMessages, ThreadWorkspace, ChatHost/ResponsiveShell/TranscriptPane, Markdown/MessageView.
- [ ] W3-SPATIAL (spatial/* only) MINOR: strip "MOCK FEED"/"FEED MOCK · REV n" jargon; coral status dots (var(--dh-coral)) → indigo to match app; light-mode OFFICE—PLAN-02 title block dark-on-dark invisible; iso.ts:278 hardcoded `0xa78bfa` old-violet literal → token; Nameplates names truncate hard.
- [ ] W3-COUNTS (data) MAJOR+minors: unify "NEEDS YOU" DEFINITION — statusbar+sidebar count STALE sessions as needs-you (2) while Grid/Board bucket stale separately (needs-you 0). Pick ONE definition (needs-you = waiting-for-user only; stale is its own bucket) applied everywhere. + token totals need "B" rollover (format.ts compactNumber: 23405M→23.4B). + MCP prettifier falls back to raw UUID for unknown servers. + "1 sessions" singular grammar. + Daily Spend chart no y-axis labels. + Dashboard "By Tool" empty void beside tall list.
- [ ] W3-SHELL (shell/theme/misc) MAJOR+minors: ⌘\ collapse leaves ~270px DEAD band — `main` stays x=324, doesn't reflow to reclaim width (fix so collapsing gains space). + THEME two-sources desync (Settings select "light" vs app dark; localStorage devhub:theme vs server settings — single source of truth, explicit toggle wins). + OpenAI Chat shows raw dev copy ("DEVHUB_ENABLE_OPENAI_CHAT=1 … Bearer"). + composer "Describe the outcome…/Launch session" task-framing vs "start a chat" (F8). + Browse right-preview shows a composer + inspector-placeholder when no session selected.
### NON-BUG (do NOT act): "DevHub text + Deck logo = half rename" — Deck is the LOGO CONCEPT name, DevHub is the product. Keep "DevHub" wordmark + Deck mark. No rename.
### KNOWN/deferred: cold-start ~30s "Loading view…/0 sessions" on hard reload (S3, server index rebuild — server-side, out of web scope); mock-feed churn (real M1 feed expected steadier); ?tab=codex deep-link routes to Home (rail icon works).
