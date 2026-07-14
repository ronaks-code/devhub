Use case: approved-production clarification for Search, commands, Settings, narrow desktop, and PWA
Governing visual sources: `08-command-responsive.png` for command/Settings/responsive composition; `devhub-current-search-results.png` for the existing functional search-results contract; `chatgpt-empty-task-1800x1130.png` for measured Codex shell language. The verbatim ImageGen input is retained in `08-command-responsive-generation-brief.md`.

Search results: preserve the current DevHub behavior as a distinct accessible `Search tasks and messages` dialog, not merely a command. It contains a focused query input, Global/current-project scope, date facets, result rows with task title/project/highlighted snippet, keyboard-selected row, result count/status, `↑↓ navigate`, `↵ open`, and `esc close`. Opening a result navigates to its provider-locked task and highlighted message. Empty, loading, error, and no-result states stay inside this same surface. Retheme its density/tokens to the measured Codex language without changing the search contract.

Command palette: remain separate from Search. Use `Search commands and tasks` only for actions such as `New task`, `Search tasks`, `Toggle inspector`, `Open Settings`, and `Go to Ops`, with visible shortcuts. Selecting `Search tasks` closes Commands and opens the dedicated Search results dialog.

Settings/narrow/PWA: retain the generated concept's proposed Settings field groups, slim or sheet rail, hidden inspector control, and no horizontal overflow. PWA scope is task reading/reply plus `Desktop required for terminal and diff`; it does not imply native mobile, offline, push, background work, permission elevation, or full parity.

Production rejection of generated details: generated Inbox/result copy is not authoritative; Search and Commands must not collapse into one ambiguous palette; responsive behavior remains proposed until viewport/accessibility tests pass.
