# AGENTS.md — how any agent works in this repo

You are one of several agents (Claude Code + Codex) working the SAME project.
Follow these rules exactly. They exist because agents keep losing context and
redoing each other's work.

## 0. On every fresh chat, in this order (do not skip)
1. Read `tasks/STATUS.md` fully. That is the source of truth, not your memory.
2. Read the RESOLVER doc for the task you're about to touch.
3. Run `git fetch && git worktree list && git branch -a` to see who owns what.
4. If your intended task is already owned in "Active worktrees / WIP branches" —
   pick a different `[SOFTWARE]` task or coordinate. Do NOT duplicate work.

## 1. Parallel by default — never single-thread
- Break the task into independent pieces and dispatch MANY subagents at once,
  one focused job each. Do not do steps serially when they have no dependency.
- Serial work is only allowed when step B literally needs step A's output.
- If you catch yourself doing 4 unrelated things in sequence in one thread, STOP
  and fan them out to subagents instead.

## 2. Branch + commit discipline
- Tested, green work → commit to the shared branch with a clear checkpoint message.
- Untested / in-progress work → push ONLY to `wip/<your-name>` (e.g. `wip/glove-decode`).
  Never push untested code to `main` or shared feature branches.
- A "tested checkpoint" means: the relevant test/check ran and passed, OR (hardware)
  a documented manual verification produced evidence. State which, in the commit body.
- Register your worktree/branch in STATUS.md "Active worktrees" the moment you start,
  and remove it when merged.

## 3. Keep STATUS.md true (same commit as the work)
- When a task moves [ ]→[x], flip it in STATUS.md IN THE SAME COMMIT as the code.
- Update "Last updated", "Progress" count, and "Recent checkpoints".
- Do NOT change the frozen denominator. New scope goes under "Added after freeze".
- If your work changed the plan, update the RESOLVER doc, not STATUS.md's summary line.

## 4. Stop-and-report on human-blocked items (do not loop)
- If a task is tagged [ALEX] / [HARDWARE] / [S3] / [RONAK-GATE], or you discover a
  new blocker mid-task: STOP. Do not retry, do not guess around it, do not burn
  turns looping.
- Move the task to the "Blocked" section of STATUS.md with: what's needed, from whom,
  and the date. Then report to Ronak in one message: "Blocked on X, need Y from Z."
- Then switch to the next available [SOFTWARE] task. Never idle-loop on a blocked item.

## 5. Definition of done for a task
- Code committed to shared branch, tests/verification passed and stated,
  STATUS.md checkbox flipped, RESOLVER doc updated, worktree deregistered.
- If you cannot meet all five, it stays [ ] and you say why.
