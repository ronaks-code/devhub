Use case: approved-production clarification for the generated cross-provider fork concept
Governing visual sources: `06-cross-provider-fork.png` for the three-stage composition and `chatgpt-devhub-sync3-thread-1800x1130.png` for measured task language. The verbatim ImageGen input is retained in `06-cross-provider-fork-generation-brief.md`; this clarification supersedes its incorrect cross-provider permission term.

Stage 1 — unchanged source: show `OpenAI · Codex`, source native ID `codex: 019f…`, and `Create cross-provider fork`. The source task and history remain byte-for-byte unchanged.

Stage 2 — reviewed handoff preview:

- `Source task` / `OpenAI · Codex`
- `Target provider` / `Anthropic · Claude`
- `Requested model` / `Runtime default`
- `Mode` / `Code`
- `Folder` / `…/active/claude-ui`
- `Permission mode` / `Default`
- `Transferred context`: user messages, goal summary, selected files, reviewed tool outputs
- `Excluded automatically`: secrets and auth, hidden reasoning, approval credentials, unreviewed sensitive tool output

Excluded rows are locked and non-interactive. The preview includes a readable attributed body beginning `Handoff from OpenAI · Codex task codex: 019f…` followed by the reviewed goal/context summary and visible redaction markers. It never includes excluded contents.

Required disclosure: `The source task remains unchanged. A new native task will be created.` and `The resulting link is local to DevHub.` Actions are `Cancel` and `Create fork`.

Stage 3 — new native target: show `Anthropic · Claude`, new ID `claude: a84f…`, the attributed handoff as the first user/context item, `Forked from OpenAI · Codex`, and `Linked by DevHub`. This is a new provider-native task, never a provider switch or same-session continuation.

Production rejection of generated details: do not implement `Permissions / Workspace` for the Claude target; do not render exclusion categories as selectable; do not omit the attributed handoff body.
