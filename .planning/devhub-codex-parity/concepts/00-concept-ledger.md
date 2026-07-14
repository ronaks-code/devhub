# DevHub Reference-Derived Concept Ledger

All concepts use `gpt-image-1.5`, sequential generation, high quality, and high input fidelity against the named current-build screenshot. Images are design references only; shipped UI remains code-native.

Global invariants:

- Preserve the measured 1800x1130 dark macOS shell: 273-wide rail, 46-high header, open `#181818` canvas, 736-wide transcript/composer column, 736x98 bottom composer, and 300-wide content-height inspector with 16 outer gutter.
- Brand the product `DevHub`. Provider identity is text only: `OpenAI · Codex` or `Anthropic · Claude`; no generated provider logos and no claim of first-party status.
- Assistant prose and activity remain unframed in the transcript. Only user messages use compact right-aligned bubbles.
- No dashboard grids, KPI cards, marketing headings, gradients, glows, cream whites, avatars, decorative pills, default shadcn styling, emoji icons, or generic IDE chrome.
- Use SF-like neutral system typography, restrained monochrome outline icons, one-pixel dividers, sparse accent color, stable composer geometry, and intentional negative space.
- Unobserved or provider-gated behavior is identified in each brief. The concept is a proposal, not evidence that the first-party app implements it.

| # | Output | Governing capture | Primary classification |
|---|---|---|---|
| 1 | `01-new-task-empty.png` | `chatgpt-empty-task-1800x1130.png` | measured shell + proposed DevHub provider-neutral setup |
| 2 | `02-active-plan-tools.png` | `chatgpt-active-goal-1800x1130.png` | observed active narrative + proposed provider identity |
| 3 | `03-intervention-states.png` | `chatgpt-active-goal-1800x1130.png` | measured shell + proposed capability-gated requests/errors |
| 4 | `04-inspector-dock.png` | `chatgpt-current-1800x1130.png` | observed inspector container + proposed inspector destinations |
| 5 | `05-provider-setup.png` | `chatgpt-empty-task-1800x1130.png` | proposed provider-aware setup with verified capability differences |
| 6 | `06-cross-provider-fork.png` | `chatgpt-devhub-sync3-thread-1800x1130.png` | proposed DevHub-only fork preview and additive link |
| 7 | `07-work-mode.png` | `chatgpt-active-goal-1800x1130.png` | proposed DevHub Work mode, explicitly not Cowork interoperability |
| 8 | `08-command-responsive.png` | `chatgpt-empty-task-1800x1130.png` | proposed command/search/settings and narrow browser/PWA behavior |

No initial concept may be regenerated unless it is one of the two allowed targeted corrections and the discrepancy is recorded here.

## Generation record

- Provider/model: OpenAI Image API, `gpt-image-1.5`.
- Operation: `edit`, one governing image per call.
- Settings: `1536x1024`, `quality=high`, `input_fidelity=high`, PNG, prompt augmentation disabled.
- Execution: strictly sequential. Eight initial calls and two targeted-correction calls; no retries.
- Credential handling: `OPENAI_API_KEY` was loaded into each process environment from the existing local Claude settings file and was never written to a brief, command artifact, image, or ledger.
- Exact invocation shape for every row below:

  `OPENAI_API_KEY="$key" ~/.local/bin/uv run --with openai --with pillow python /Users/ronak/.codex/skills/imagegen/scripts/image_gen.py edit --model gpt-image-1.5 --image <input> --prompt-file <brief> --size 1536x1024 --quality high --input-fidelity high --output-format png --out <output> --no-augment`

| Call | Input image | Exact brief | Output | SHA-256 |
|---|---|---|---|---|
| initial 1 | `reference-captures/chatgpt-empty-task-1800x1130.png` | `01-new-task-empty-brief.md` | `01-new-task-empty.png` | `527a842e6f37b80c261a6af88b2651809f7f7b8f8e49613ad0a1ae17208862a2` |
| initial 2 | `reference-captures/chatgpt-active-goal-1800x1130.png` | `02-active-plan-tools-brief.md` | `02-active-plan-tools.png` | `71cbf27fb0384f0a8594b887ad13e5cf939f48cb713742ad79f6a888cc4e5309` |
| initial 3 | `reference-captures/chatgpt-active-goal-1800x1130.png` | `03-intervention-states-brief.md` | `03-intervention-states.png` | `c1fa704dfc3dfddac69dfc3b1b17d8500cee28515bcbd002e10dcfd0c20dd870` |
| initial 4 | `reference-captures/chatgpt-current-1800x1130.png` | `04-inspector-dock-brief.md` | `04-inspector-dock.png` | `085d45b40d89e94337e9e8422c7e4076c0eaf6b42e15b61cfd9f25e74be44d17` |
| initial 5 | `reference-captures/chatgpt-empty-task-1800x1130.png` | `05-provider-setup-brief.md` | `05-provider-setup.png` | `78570b78c45d58336a960a9a0d4fad0948e3aa3065b9e1ec84e74722921178cd` |
| initial 6 | `reference-captures/chatgpt-devhub-sync3-thread-1800x1130.png` | `06-cross-provider-fork-generation-brief.md` | `06-cross-provider-fork.png` | `f1d84c7baa986aa9c86a806fa82bd54c5d3ac71e05dba17237095b993060642c` |
| initial 7 | `reference-captures/chatgpt-active-goal-1800x1130.png` | `07-work-mode-brief.md` | `07-work-mode.png` | `2587ca1c4e88fe21aae23b37933b570a9e3b5bd95c715e28ab61f58e1873e122` |
| initial 8 | `reference-captures/chatgpt-empty-task-1800x1130.png` | `08-command-responsive-generation-brief.md` | `08-command-responsive.png` | `ff990f1c65ee221316686b705149ed45e5d6b8aee89b9404334f218a4eab17b7` |
| correction 1 | `03-intervention-states.png` | `03-intervention-states-correction-brief.md` | `03-intervention-states-corrected.png` | `02c74d91a8d48122d5bf86d0cd45480230db5305b6c89aa51485ae158e92a2ef` |
| correction 2 | `07-work-mode.png` | `07-work-mode-correction-brief.md` | `07-work-mode-corrected.png` | `c45f6e54781b3a5fefc62dc7d00756f53554c3733d453c81b079ee6290107936` |

All ten ImageGen PNGs were opened at original detail with `view_image`; every file is 1536x1024. Initial calls 6 and 8 originally used prompt files with the shorter `-brief.md` names. After the staff approval review found semantic omissions, their verbatim generation prompt content was preserved under the `-generation-brief.md` names, while the shorter names became explicit production clarifications. No additional ImageGen call was made.

## Selected set and inspection notes

| # | Selected artifact | Inspection result | Material caveat retained for approval |
|---|---|---|---|
| 1 | `01-new-task-empty.png` | Keeps the measured empty canvas, rail, stable composer, and compact inspector; adds a proposed setup inset. | Rail wordmark says Codex while the header says DevHub, and the generated inset is larger than the intended production composer. The brief and measured capture govern implementation. |
| 2 | `02-active-plan-tools.png` | Clearly communicates active narrative, plan progress, native activity rows, diff summary, goal strip, and stop control. | Some generated rail/body labels drift and the title is oversized. These are not approved copy or geometry. |
| 3 | `03-intervention-states-corrected.png` plus the cancellation tile in `03-intervention-states.png` | Corrected plate governs explicit capability gating, disabled unverified permission/input actions, allow/deny/cancel, safe-read retry, reconnect cancel, and non-approving expiry. The initial plate's bottom-right tile separately governs readable `Cancelled by you` plus restored composer. | The corrected plate accidentally repeats expiry inside its cancellation specimen, so that tile is rejected. Production renders expiry and cancellation as independent states and uses the readable initial cancellation tile only for cancellation composition. |
| 4 | `04-inspector-dock.png` | Covers Diff, Files, Terminal, Browser, and Artifacts as one coordinated 300-unit inspector family. | Several generated tab labels/selections are malformed. The five named destinations in `04-inspector-dock-brief.md` govern production; contents remain proposed/capability-gated. |
| 5 | `05-provider-setup.png` | Strong provider-locked setup with model, mode, project, folder, permissions, and explicit Claude requested/session/actual mismatch treatment. | This is a DevHub-only setup proposal, not an observed Codex new-task screen. Provider-specific permission vocabularies must not be normalized by label alone. |
| 6 | `06-cross-provider-fork.png` + `06-cross-provider-fork-brief.md` production clarification | Unchanged source -> reviewed handoff -> new linked native target; exclusions and local DevHub linkage are explicit. | Generated `Workspace` is rejected for the Claude target, exclusions must be locked, and an attributed reviewed/redacted handoff body is required. The corrected production brief governs; the flow remains disabled until the M7 redaction/native-session gate passes. |
| 7 | `07-work-mode-corrected.png` | Work is selected; DevHub/Claude identity, folder scope, Claude `Default` permission mode, progress, outcome, and deliverables are visible. | A few non-critical rail strings remain malformed. Work is a DevHub product mode, never Cowork, and cannot imply unverified background/subagent execution. |
| 8 | `08-command-responsive.png` + `reference-captures/devhub-current-search-results.png` + `08-command-responsive-brief.md` | Generated concept covers Commands, Ops/Inbox, Settings, collapsed/narrow navigation, and a one-pane PWA task view. The real current DevHub capture supplies the missing populated Search-results contract, kept separate from Commands. | Some generated utility copy is malformed. Codex Search visuals and responsive/PWA behavior remain unobserved; production preserves current Search behavior, rethemes it to measured shell tokens, and validates responsive states against actual supported surfaces. |

The two correction slots are exhausted. The Search preservation capture and production clarifications are not additional generated concepts or corrections. Any production ambiguity is resolved by the governing real capture first, then the selected production clarification/brief, then the design lock—not by regenerating another concept.
