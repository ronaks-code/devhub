import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { DevHubFeatureFlags } from "@devhub/engine/providers";

/**
 * TaskRail — the Codex-style rail as an OPEN LIST (M6 slice 2).
 *
 * `design-lock.md` §4 "Rail hierarchy is an open list": task rows are flat list
 * items grouped under quiet section headings, NOT nested cards. The selected row is
 * the measured compact 256x30 fill at an 8-unit rail inset (`SHELL_GEOMETRY`), and
 * its height never changes when a quiet active spinner appears. Every row carries
 * provider identity as quiet text — visible suffix (`Codex`/`Claude`) plus the full
 * `OpenAI · Codex` / `Anthropic · Claude` in its accessible name — and NEVER a
 * generated provider logo (no `<svg>`/`<img>` is rendered here).
 *
 * The component is pure presentation over a `TaskRailModel`; it renders the rail
 * CONTENT only (the enclosing `<nav>` landmark belongs to the shell/AppShell rail
 * slot, so no duplicate navigation landmark is introduced). It is mounted only
 * behind the default-off `taskRail` slice flag; flag-off keeps the legacy rail.
 */

/** Provider identity is a closed set — the two shipping native runtimes. */
export type RailProvider = "openai" | "anthropic";

export interface ProviderIdentity {
  provider: RailProvider;
  /** Organization label, e.g. `OpenAI`. */
  org: string;
  /** Product label, e.g. `Codex`. */
  product: string;
  /** Quiet visible suffix rendered on the row (`Codex` / `Claude`). */
  suffix: string;
  /** Full identity used in the row's accessible name (`OpenAI · Codex`). */
  accessibleName: string;
}

/**
 * Map a provider to its quiet-text identity. This is the ONLY source of the visible
 * suffix and accessible name; provider identity is quiet but never absent, and never
 * a logo (invariant 1 / design-lock §3). No provider wordmark ever becomes the brand.
 */
export function providerIdentity(provider: RailProvider): ProviderIdentity {
  return provider === "openai"
    ? { provider, org: "OpenAI", product: "Codex", suffix: "Codex", accessibleName: "OpenAI · Codex" }
    : { provider, org: "Anthropic", product: "Claude", suffix: "Claude", accessibleName: "Anthropic · Claude" };
}

/** Rail copy. Kept in one place so the `T-rail` visible-copy diff has a single source. */
export const TASK_RAIL_COPY = Object.freeze({
  newTask: "New task",
  noTasks: "No tasks",
  /** DevHub-local archive is always labeled local; it is never native deletion (invariant). */
  archiveLocal: "Archive in DevHub",
});

/** The DevHub-local archive label. Never equated with native deletion (design-lock §5). */
export const ARCHIVE_LOCAL_LABEL = TASK_RAIL_COPY.archiveLocal;

/**
 * The measured selected-row fill and rail inset, transcribed from
 * `reference-capture-manifest.md` ("256x30 selected row at 8 inset"). Mirrors the
 * matching fields on the shell's `SHELL_GEOMETRY` so tests assert one source.
 */
export const TASK_RAIL_GEOMETRY = Object.freeze({
  selectedRowWidth: 256,
  selectedRowHeight: 30,
  railInset: 8,
} as const);

export interface TaskRailTask {
  /** Stable identifier; sanitized before it reaches any rendered key/attribute. */
  id: string;
  /** Human task title (accessible + visible). */
  title: string;
  /** Immutable-after-creation provider identity (design-lock invariant 1). */
  provider: RailProvider;
  /** When true, a quiet spinner appears without changing the row height. */
  active?: boolean;
}

export interface TaskRailSection {
  id: string;
  /** Quiet grouping heading (e.g. `Today`). */
  label: string;
  tasks: TaskRailTask[];
}

export interface TaskRailDestination {
  id: string;
  label: string;
  /** Secondary destinations appear ONLY when reachable; they are never rendered inert. */
  reachable?: boolean;
  /** Marks the current destination (`aria-current="page"`). */
  current?: boolean;
}

export interface TaskRailModel {
  sections: TaskRailSection[];
  destinations: TaskRailDestination[];
}

export interface TaskRailProps {
  model: TaskRailModel;
  /** Id of the currently selected task, if any. */
  selectedTaskId?: string | null;
  /**
   * A single provider's runtime failure. Only THAT provider's rows are marked failed;
   * other-provider rows are never marked failed (design-lock: failure isolation).
   */
  failedProvider?: RailProvider | null;
  onNewTask?: () => void;
  onSelectTask?: (id: string) => void;
  onSelectDestination?: (id: string) => void;
}

/**
 * Strip anything that must never appear in a rendered key/attribute: NUL and control
 * characters, and path separators (so a raw filesystem home like `/Users/x/.codex/…`
 * can never leak into the DOM as a key/id). Path-free by construction.
 */
export function sanitizeRailKey(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]/g, "-")
    .slice(0, 128);
}

/**
 * Pure roving-focus index math for Arrow/J/K/Home/End. Returns the current index for
 * any other key. Used both by the live keydown handler and unit tests.
 */
export function nextRovingIndex(key: string, current: number, count: number): number {
  if (count <= 0) return -1;
  switch (key) {
    case "ArrowDown":
    case "j":
    case "J":
      return (current + 1) % count;
    case "ArrowUp":
    case "k":
    case "K":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return current;
  }
}

/** Flatten sections into the single roving order (top-to-bottom). */
function flattenTasks(model: TaskRailModel): TaskRailTask[] {
  return model.sections.flatMap((section) => section.tasks);
}

interface TaskRowProps {
  task: TaskRailTask;
  selected: boolean;
  failed: boolean;
  /** True for the single roving-tabbable row (tabIndex 0); others are -1. */
  roving: boolean;
  onSelect?: (id: string) => void;
  registerRef: (el: HTMLButtonElement | null) => void;
}

function TaskRow({ task, selected, failed, roving, onSelect, registerRef }: TaskRowProps) {
  const identity = providerIdentity(task.provider);
  const safeKey = sanitizeRailKey(task.id);
  return (
    <li
      role="listitem"
      className={selected ? "dh-task-row dh-task-row--selected" : "dh-task-row"}
      data-dh-task-row=""
      data-dh-selected={selected ? "" : undefined}
      data-dh-task-failed={failed ? "" : undefined}
      data-dh-provider={task.provider}
      data-dh-row-width={selected ? TASK_RAIL_GEOMETRY.selectedRowWidth : undefined}
      data-dh-row-height={TASK_RAIL_GEOMETRY.selectedRowHeight}
      aria-current={selected ? "page" : undefined}
    >
      <button
        ref={registerRef}
        type="button"
        className="dh-task-open"
        data-dh-task-open=""
        data-dh-task-key={safeKey}
        tabIndex={roving ? 0 : -1}
        onClick={() => onSelect?.(task.id)}
      >
        <span className="dh-task-title">{task.title}</span>
        {/* Provider identity: quiet visible suffix + full identity in the accessible
            name. Never a logo. */}
        <span className="dh-task-provider" data-dh-provider-label="" aria-hidden="true">
          {identity.suffix}
        </span>
        <span className="dh-sr-only">{identity.accessibleName}</span>
        {task.active ? (
          <span className="dh-task-spinner" data-dh-active="" aria-hidden="true" />
        ) : null}
        {task.active ? <span className="dh-sr-only">Working</span> : null}
        {failed ? <span className="dh-sr-only">Failed</span> : null}
      </button>
      {/* Overflow actions: always in the tab order (reachable without hover). */}
      <button
        type="button"
        className="dh-task-actions"
        data-dh-task-actions=""
        tabIndex={0}
        aria-haspopup="menu"
        aria-label={`Actions for ${task.title}`}
      >
        <span aria-hidden="true">⋯</span>
      </button>
    </li>
  );
}

export function TaskRail({
  model,
  selectedTaskId,
  failedProvider,
  onNewTask,
  onSelectTask,
  onSelectDestination,
}: TaskRailProps) {
  const flat = flattenTasks(model);
  const selectedIndex = flat.findIndex((t) => t.id === selectedTaskId);
  const [rovingIndex, setRovingIndex] = useState(selectedIndex >= 0 ? selectedIndex : 0);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const activeRoving = rovingIndex >= 0 && rovingIndex < flat.length ? rovingIndex : 0;

  const onListKeyDown = useCallback(
    (event: KeyboardEvent<HTMLUListElement>) => {
      const count = rowRefs.current.length;
      if (count === 0) return;
      if (event.key === "Enter") {
        const task = flat[activeRoving];
        if (task) {
          event.preventDefault();
          onSelectTask?.(task.id);
        }
        return;
      }
      const next = nextRovingIndex(event.key, activeRoving, count);
      if (next === activeRoving) return;
      event.preventDefault();
      setRovingIndex(next);
      rowRefs.current[next]?.focus();
    },
    [activeRoving, flat, onSelectTask],
  );

  const reachableDestinations = model.destinations.filter((d) => d.reachable !== false);
  const hasTasks = flat.length > 0;
  let rowIndex = -1;

  return (
    <div className="dh-tasklist-root" data-dh-taskrail="">
      <div className="dh-tasklist-actions">
        <button
          type="button"
          className="dh-newtask"
          data-dh-new-task=""
          onClick={() => onNewTask?.()}
        >
          {TASK_RAIL_COPY.newTask}
        </button>
      </div>

      <ul
        role="list"
        className="dh-tasklist"
        data-dh-open-list=""
        onKeyDown={onListKeyDown}
      >
        {hasTasks ? (
          model.sections.map((section): ReactNode =>
            section.tasks.length === 0 ? null : (
              <li key={sanitizeRailKey(section.id)} role="presentation" className="dh-tasklist-group">
                <div className="dh-tasklist-heading" data-dh-section-heading="">
                  {section.label}
                </div>
                <ul role="list" className="dh-tasklist-rows">
                  {section.tasks.map((task) => {
                    rowIndex += 1;
                    const idx = rowIndex;
                    return (
                      <TaskRow
                        key={sanitizeRailKey(task.id)}
                        task={task}
                        selected={task.id === selectedTaskId}
                        failed={!!failedProvider && task.provider === failedProvider}
                        roving={idx === activeRoving}
                        onSelect={onSelectTask}
                        registerRef={(el) => {
                          rowRefs.current[idx] = el;
                        }}
                      />
                    );
                  })}
                </ul>
              </li>
            ),
          )
        ) : (
          <li className="dh-tasklist-empty" data-dh-empty="" role="listitem">
            {TASK_RAIL_COPY.noTasks}
          </li>
        )}
      </ul>

      {reachableDestinations.length > 0 ? (
        <ul role="list" className="dh-rail-destinations" data-dh-destinations="">
          {reachableDestinations.map((dest) => (
            <li key={sanitizeRailKey(dest.id)} role="listitem" className="dh-rail-dest-item">
              <button
                type="button"
                className="dh-rail-dest"
                data-dh-destination=""
                aria-current={dest.current ? "page" : undefined}
                onClick={() => onSelectDestination?.(dest.id)}
              >
                {dest.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export type TaskRailMode = "devhub" | "legacy";

/**
 * Slice-flag gate. Mirrors `resolveShellChromeMode`: TaskRail mounts only for a
 * server-resolved true `taskRail`; anything else (false / undefined / missing
 * settings) keeps the legacy rail — the immediate, non-destructive rollback surface.
 */
export function resolveTaskRailMode(
  settings: { devHubFeatures?: Partial<DevHubFeatureFlags> } | null | undefined,
): TaskRailMode {
  return settings?.devHubFeatures?.taskRail === true ? "devhub" : "legacy";
}

/** True only when the task-rail slice flag is applied. */
export function isTaskRailApplied(
  features: Partial<DevHubFeatureFlags> | undefined,
): boolean {
  return features?.taskRail === true;
}
