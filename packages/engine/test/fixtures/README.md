# Transcript line-shape fixtures (golden corpus)

Each `*.json` here is ONE sanitized, synthetic Claude Code transcript *line* — never
real user data. The corpus exercises every shape `normalizeLine` (src/parser.ts) must
tolerate. `fixtures.test.ts` loads each file and asserts the normalized result.

| File | Shape | Expected normalized role / outcome |
| --- | --- | --- |
| `user-text.json` | user line, string content | role `user`, one text block |
| `assistant-text.json` | assistant line + usage | role `assistant`, text block, usage mapped |
| `system-line.json` | system event | role `system`, text block |
| `assistant-thinking.json` | assistant with a thinking block | role `assistant`, thinking + text blocks |
| `assistant-tool-use.json` | assistant tool_use | role `assistant`, tool_use block |
| `user-tool-result.json` | user tool_result | role `user`, tool_result block |
| `attachment-hook.json` | attachment carrying hook output | role `hook` |
| `queue-operation.json` | queued user prompt | role `queue` |
| `summary-legacy.json` | legacy `summary` meta line | normalizes to `null` (pure metadata) |
| `ai-title.json` | `ai-title` meta line | normalizes to `null` (pure metadata) |
| `spilled-tool-result.json` | tool_result referencing a spilled file | role `user`, tool_result block |
| `subagent-line.json` | sidechain (subagent) assistant line | role `assistant`, `isSidechain` true |
| `unknown-type.json` | unknown future `type` | role `meta`, unknown block (no throw) |

Keep these tiny and synthetic. Add a row above when you add a fixture.
