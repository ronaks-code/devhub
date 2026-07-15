import { Fragment, type ReactNode } from "react";
import {
  isSearchCommandsApplied,
  resolveSearchCommandsMode,
  type SearchCommandsMode,
} from "../search/TaskSearchDialog.js";

/**
 * CommandDialog — the separate `Search commands and tasks` palette (M6 slice 7).
 *
 * `component-state-matrix.md` §12 / `surface-inventory.md` `SF-19` / `design-system.md`
 * §7.9 / `design-lock.md` §8. This is Commands ONLY. It is a SEPARATE contract from the
 * `TaskSearchDialog` and is NEVER merged with it: choosing `Search tasks` CLOSES Commands
 * and OPENS Search (it never renders Search inline and never silently invokes another
 * provider). Approved primary actions are `New task`, `Search tasks`, `Toggle inspector`,
 * `Open Settings`, and `Go to Ops`. Provider-specific actions appear only when the runtime
 * capability is valid; a command that would silently invoke another provider is hidden.
 *
 * The keyboard-active row is the ONLY selection here — Commands has no scope/date facets,
 * so its active row can never be confused with Search's scope/date selection. Escape
 * closes the palette and restores focus to the invoker. Footer reads `↑↓ navigate`,
 * `↵ run`, `esc close`.
 *
 * Mounted only behind the default-off `searchCommands` slice flag; flag-off keeps Commands
 * UNMOUNTED exactly as today (the legacy `CommandPalette` is not mounted in `App.tsx`), so
 * the flag-off rollback is a true no-op.
 */

// Re-export the shared slice-flag gate so callers can read it from either dialog module.
// It is a shared flag PREDICATE only — the two dialogs stay separate contracts.
export { isSearchCommandsApplied, resolveSearchCommandsMode };
export type { SearchCommandsMode };

/** What a command does. `open-search` is the Commands→Search transition. */
export type CommandActionKind =
  | "new-task"
  | "open-search"
  | "toggle-inspector"
  | "open-settings"
  | "go-to-ops"
  | "navigate"
  | "action";

export interface CommandAction {
  /** Stable id (React key + option id). */
  id: string;
  /** Visible label. */
  title: string;
  /** What running it does. */
  kind: CommandActionKind;
  /** Optional group, e.g. `Navigate`. */
  group?: string;
  /** Trailing hint, e.g. a shortcut `⌘N` or a current value. */
  shortcut?: string;
  /** Extra match terms, folded into filtering but not displayed. */
  keywords?: string;
  /**
   * A provider-specific action. It is shown ONLY when its runtime capability is valid;
   * a provider-scoped command is never rendered when `capable` is false, so Commands can
   * never silently invoke another provider.
   */
  providerScoped?: boolean;
  /** Runtime capability truth for a `providerScoped` action. */
  capable?: boolean;
}

/** One source for the `T-commands` visible-copy diff. */
export const COMMAND_COPY = Object.freeze({
  /** Accessible dialog title + input label. */
  title: "Search commands and tasks",
  empty: "No commands",
  footer: Object.freeze({
    navigate: "↑↓ navigate",
    run: "↵ run",
    close: "esc close",
  }),
} as const);

/**
 * The approved primary Commands rows. `Search tasks` is the `open-search` transition
 * that closes Commands and opens Search. Shortcuts match the approved `T-commands` set.
 */
export const DEFAULT_COMMANDS: ReadonlyArray<CommandAction> = Object.freeze([
  { id: "new-task", title: "New task", kind: "new-task", shortcut: "⌘N" },
  { id: "search-tasks", title: "Search tasks", kind: "open-search", shortcut: "⌘K" },
  { id: "toggle-inspector", title: "Toggle inspector", kind: "toggle-inspector", shortcut: "⌘⇧I" },
  { id: "open-settings", title: "Open Settings", kind: "open-settings", shortcut: "⌘," },
  { id: "go-to-ops", title: "Go to Ops", kind: "go-to-ops" },
] as const);

/** True for the `Search tasks` action, which transitions into Search rather than merging it. */
export function isSearchTasksAction(action: CommandAction): boolean {
  return action.kind === "open-search";
}

/** The Commands→Search transition contract: close Commands FIRST, then open Search. */
export interface SearchTasksTransition {
  closeCommands: true;
  openSearch: true;
  /** Commands never renders Search inline — it hands off to the separate dialog. */
  merged: false;
}
export function describeSearchTasksTransition(): SearchTasksTransition {
  return { closeCommands: true, openSearch: true, merged: false };
}

/** Escape closes the palette and restores focus to whatever opened it. */
export interface EscapeRestore {
  close: true;
  restoreFocusToInvoker: true;
  /** The element/id that had focus when the palette opened. */
  invoker: string | null;
}
export function describeEscapeRestore(invoker: string | null): EscapeRestore {
  return { close: true, restoreFocusToInvoker: true, invoker };
}

/**
 * Which commands are visible: a `providerScoped` action is dropped unless its runtime
 * `capable` is true, so Commands never offers a row that would silently invoke another
 * provider. Non-provider commands always pass.
 */
export function visibleCommands(
  commands: readonly CommandAction[],
): readonly CommandAction[] {
  return commands.filter((c) => !c.providerScoped || c.capable === true);
}

/**
 * Subsequence fuzzy match (same idea as editor command palettes): every char of the
 * query must appear in order. Returns a rough score (lower = better) or null on no match.
 */
function fuzzyScore(query: string, haystack: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const h = haystack.toLowerCase();
  let qi = 0;
  let score = 0;
  let last = -1;
  for (let hi = 0; hi < h.length && qi < q.length; hi++) {
    if (h[hi] === q[qi]) {
      if (last >= 0) score += hi - last;
      last = hi;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

/** Filter + rank commands (visibility first, then fuzzy), preserving order on ties. */
export function filterCommands(
  commands: readonly CommandAction[],
  query: string,
): readonly CommandAction[] {
  const visible = visibleCommands(commands);
  const term = query.trim();
  if (!term) return visible;
  const scored: Array<{ cmd: CommandAction; score: number; idx: number }> = [];
  visible.forEach((cmd, idx) => {
    const hay = `${cmd.title} ${cmd.group ?? ""} ${cmd.keywords ?? ""}`;
    const score = fuzzyScore(term, hay);
    if (score != null) scored.push({ cmd, score, idx });
  });
  scored.sort((a, b) => a.score - b.score || a.idx - b.idx);
  return scored.map((s) => s.cmd);
}

// --- Presentation --------------------------------------------------------------

const OPTION_ID = (id: string) => `dh-command-${id}`;

export interface CommandDialogProps {
  /** Current query text. */
  query?: string;
  /** Command registry. Default: the approved primary rows. */
  commands?: readonly CommandAction[];
  /** Keyboard-active row (the ONLY selection — no scope/date in Commands). Default 0. */
  activeIndex?: number;
  /** Accessible name. Default `Search commands and tasks`. */
  label?: string;
  /** Run an action. The palette closes itself before the action mutates state. */
  onRun?: (action: CommandAction) => void;
  /** `Search tasks`: close Commands, then open the separate Search dialog. */
  onSearchTasks?: () => void;
}

export function CommandDialog({
  query = "",
  commands = DEFAULT_COMMANDS,
  activeIndex = 0,
  label = COMMAND_COPY.title,
  onRun,
  onSearchTasks,
}: CommandDialogProps): ReactNode {
  const filtered = filterCommands(commands, query);
  const active = Math.min(Math.max(activeIndex, 0), Math.max(filtered.length - 1, 0));

  const handle = (action: CommandAction) => {
    if (isSearchTasksAction(action)) {
      // Never merge: close Commands, then open the separate Search dialog.
      onSearchTasks?.();
      return;
    }
    onRun?.(action);
  };

  return (
    // A SEPARATE command palette (NOT Search). Same elevated surface, no scope/date facets.
    <div
      className="dh-dialog dh-command-dialog"
      data-dh-command-dialog=""
      data-dh-surface=""
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <h2 className="dh-sr-only" data-dh-command-title="">
        {label}
      </h2>

      <div className="dh-dialog-input" data-dh-command-inputrow="">
        <input
          className="dh-dialog-query"
          data-dh-command-input=""
          data-dh-command-autofocus=""
          role="searchbox"
          type="text"
          autoFocus
          value={query}
          readOnly
          aria-label={label}
          aria-controls="dh-command-list"
        />
      </div>

      <div
        className="dh-command-list"
        data-dh-command-list=""
        id="dh-command-list"
        role="listbox"
        aria-label={label}
        aria-activedescendant={filtered[active] ? OPTION_ID(filtered[active].id) : undefined}
      >
        {filtered.length === 0 ? (
          <p className="dh-command-empty" data-dh-command-empty="">
            {COMMAND_COPY.empty}
          </p>
        ) : (
          filtered.map((cmd, i) => {
            const isActive = i === active;
            return (
              <button
                key={cmd.id}
                type="button"
                id={OPTION_ID(cmd.id)}
                className="dh-command-row"
                data-dh-command-row={i}
                data-dh-command-kind={cmd.kind}
                role="option"
                aria-selected={isActive ? "true" : "false"}
                onClick={() => handle(cmd)}
              >
                <span className="dh-command-title" data-dh-command-label="">
                  {cmd.title}
                </span>
                {cmd.group ? (
                  <span className="dh-command-group" data-dh-command-group="">
                    {cmd.group}
                  </span>
                ) : (
                  <Fragment />
                )}
                {cmd.shortcut ? (
                  <span className="dh-command-shortcut" data-dh-command-shortcut="">
                    {cmd.shortcut}
                  </span>
                ) : (
                  <Fragment />
                )}
              </button>
            );
          })
        )}
      </div>

      <div className="dh-dialog-footer" data-dh-command-footer="">
        <span>{COMMAND_COPY.footer.navigate}</span>
        <span>{COMMAND_COPY.footer.run}</span>
        <span>{COMMAND_COPY.footer.close}</span>
      </div>
    </div>
  );
}
