# DevHub Frontend Polish Batch → v0.1.6

Master spec for the frontend improvements Ronak batched. Implemented via subagents
(Claude general-purpose — Codex can't write under `01-code/`), 2:1 adversarial review,
then verify + hot-swap + ship as 0.1.6. All changes are web-layer (hot-swappable) unless
noted.

## Items

1. **Settings not scrollable** — DONE (fix written). `.dh-settings-route` now `flex:1 +
   min-height:0 + overflow-y:auto + align-content:start` so it fills the pane and scrolls
   internally (sticky nav preserved).

2. **Chat content flush to the left wall / no spacing (unprofessional).** Root cause:
   `.dh-thread-workspace { align-items: flex-start }` pins the transcript + composer to
   the left. Center them (or `mx-auto` the max-width columns) and add horizontal
   breathing room so the conversation sits in a comfortable centered column.

3. **General UI spacing polish.** A pass over padding/margins/gaps across the chat +
   shell so it reads professional (consistent rhythm, not cramped).

4. **Queued messages + other Claude message states.** Audit what the live chat renders
   today (present: assistant/user/tool_use/thinking/streaming/interrupt/permission-
   request). ADD a **queued-messages** affordance (messages typed while a turn is running
   — show them stacked/pending with the ability to cancel), and any other missing
   Claude-Code live states. Confirm parity with what Claude Code shows.

5. **Slash `/` commands don't appear when typing in the chat.** Infra EXISTS
   (`SlashPalette.filterCommands`, Composer `picker:"slash"`). Fix: figure out why it
   doesn't show in the chat Ronak actually uses — either the used chat path renders a
   different composer, or the command registry is empty. Make `/` show commands/skills.

6. **`@` file mentions don't appear.** Infra EXISTS (`MentionPicker.detectMention`). Same
   fix: make `@` show a file/type picker in the live chat.

7. **Model display in the composer is useless ("anthropic claude").** Replace with:
   the **provider logo** (Anthropic mark / OpenAI mark based on the model's provider) +
   a **clean model name** ("Opus 4.8 high", "Fable 5 high", "GPT-5.6 …", etc.). Locations:
   the composer bottom chip AND the sidebar footer (`dh-footer-model`).

8. **Folder control** works but should look cooler — adopt a proper **icon library**
   (lucide is already a dep) for a polished folder/nav icon treatment.

9. **"Work"/worktrees button (top bar) — unclear + slow.** Ronak doesn't know what it
   is, and clicking it takes a long time to load. Clarify its purpose (git worktree
   management), make it obviously labeled, and fix/defer the slow load (likely a blocking
   git/worktree fetch — make it lazy/async with a loading state, or hide if not useful).

10. **Session categorization / "stalled" status feels off.** The buckets (Stale/Running/
    Needs-you/etc.) and the "stalled" label read oddly. Re-examine the categorization
    logic + labels so statuses are accurate and intuitive.

11. **BUG: clicking a bottom-right notification makes random columns appear.** Investigate
    — the deep-link likely lands in a multi-column/compare view or triggers stray panels.
    Should just open the referenced session cleanly.

12. **New chat is slow to open** (and chats are local, so it shouldn't be). Investigate
    the chat-open path (native runtime spawn? transcript load? layout thrash?) and make it
    fast — preload/warm the chat surface so clicking is near-instant.

## Constraints / process
- Implement with Claude subagents (parallel, scoped so they don't collide on files).
- Every real change gets 2 different-model adversarial reviewers per 1 implementer.
- Verify: `pnpm -s typecheck` + web (`~754`) + engine (`~2249`) + `web build`, all green.
- Hot-swap into the installed app for Ronak to eyeball before shipping.
- Ship: bump to 0.1.6, tag, release (auto-update delivers it).
