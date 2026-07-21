import { useId } from "react";

/**
 * WorkModePanel — M7-WORKMODE-WIRING (concept 07,
 * `.planning/devhub-codex-parity/concepts/07-work-mode-corrected.png`, correction
 * brief `07-work-mode-correction-brief.md`).
 *
 * Work mode is a DISTINCT DevHub product mode from Code mode — the existing live,
 * turn-by-turn conversational surface everywhere else in the app. It is never
 * "Cowork", and this panel never implies background or subagent execution: it
 * renders a real `WorkModeTask` (fetched server-side from the flag-gated
 * `/api/work-mode` routes, which re-check the flag themselves) as a bounded unit
 * of work with its own identity, folder scope, permission mode, progress, outcome,
 * and deliverables — exactly the fields the brief calls out, nothing invented.
 *
 * Per the brief's constraints: Work is shown selected and Code unselected in the
 * compact mode selector (no provider picker is ever rendered — the identity is
 * FIXED text, "Anthropic · Claude"); the permission field is labelled
 * "Permission mode" (never "Permissions"/"Workspace"); there are no logos, no new
 * dashboard layout, no watermark.
 *
 * Gate: `enabled` is the resolved `workMode` feature flag. `false` renders
 * NOTHING — no mode selector, no panel, nothing reachable. This is the ONLY gate;
 * the server independently re-checks the same flag on every request this
 * component's data comes from, so a stale/forged client flag can never surface
 * real Work-mode data even if this prop were somehow wrong.
 */

export const WORK_MODE_COPY = Object.freeze({
  modeLabelCode: "Code",
  modeLabelWork: "Work",
  identityLabel: "Anthropic · Claude",
  taskModeLabel: "DevHub Work",
  workScopeHeading: "Work scope",
  folderScopeLabel: "Folder scope",
  permissionModeLabel: "Permission mode",
  permissionModeDefaultValue: "Default",
  deliverablesHeading: "Deliverables",
  outcomeHeading: "Outcome",
} as const);

export type WorkModeDeliverableStatus = "ready" | "in-progress" | "pending";

export const WORK_MODE_DELIVERABLE_STATUS_LABEL: Readonly<Record<WorkModeDeliverableStatus, string>> =
  Object.freeze({
    ready: "Ready",
    "in-progress": "In progress",
    pending: "Pending",
  });

export interface WorkModeDeliverableView {
  readonly id: string;
  readonly label: string;
  readonly status: WorkModeDeliverableStatus;
}

export interface WorkModeOutcomeView {
  readonly summary: string;
  readonly current: number;
  readonly total: number;
}

/** The rendering-only view model for one Work-mode task — a projection of the real
 * server-side `WorkModeTask`, never a standalone client-invented shape. */
export interface WorkModeTaskView {
  readonly title: string;
  readonly folderScope: string;
  readonly outcome: WorkModeOutcomeView;
  readonly deliverables: readonly WorkModeDeliverableView[];
}

export interface WorkModePanelProps {
  /** The resolved `workMode` feature flag. `false` hides this panel entirely. */
  enabled: boolean;
  task: WorkModeTaskView | null;
  /** Return to the normal Code surface. */
  onDismiss?: () => void;
  className?: string;
}

/** Renders nothing when `enabled` is false OR there is no task to show — Work mode
 * never fabricates placeholder task content when it has no real backing task. */
export function WorkModePanel({ enabled, task, onDismiss, className }: WorkModePanelProps) {
  const headingId = useId();
  if (!enabled || !task) return null;

  const progressPercent = task.outcome.total > 0
    ? Math.round((task.outcome.current / task.outcome.total) * 100)
    : 0;

  return (
    <section
      aria-labelledby={headingId}
      data-work-mode-panel=""
      className={className ?? "rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-200"}
    >
      <div className="flex items-center gap-2" role="tablist" aria-label="Task mode">
        <button
          type="button"
          role="tab"
          aria-selected="false"
          data-work-mode-tab="code"
          onClick={onDismiss}
          className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-400"
        >
          {WORK_MODE_COPY.modeLabelCode}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected="true"
          data-work-mode-tab="work"
          className="rounded-md border border-clay-500 bg-clay-500/10 px-3 py-1 text-xs font-medium text-clay-200"
        >
          {WORK_MODE_COPY.modeLabelWork}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-baseline gap-2">
        <h2 id={headingId} className="text-base font-semibold text-zinc-50" data-work-mode-title="">
          {task.title}
        </h2>
        <span className="text-xs text-zinc-500" data-work-mode-identity="">
          {WORK_MODE_COPY.identityLabel}
        </span>
        <span className="text-xs text-zinc-500" data-work-mode-task-label="">
          {WORK_MODE_COPY.taskModeLabel}
        </span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="text-xs font-medium text-zinc-400">{WORK_MODE_COPY.workScopeHeading}</h3>
          <dl className="mt-2 space-y-1.5 text-xs">
            <div className="flex justify-between gap-2">
              {/* shrink-0 + nowrap: the label never wraps against a long path;
                  min-w-0 lets the dd actually truncate inside the flex row. */}
              <dt className="shrink-0 whitespace-nowrap text-zinc-500">{WORK_MODE_COPY.folderScopeLabel}</dt>
              <dd className="min-w-0 truncate text-zinc-200" data-work-mode-folder-scope="" title={task.folderScope}>
                {task.folderScope}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-zinc-500">{WORK_MODE_COPY.permissionModeLabel}</dt>
              <dd className="text-zinc-200" data-work-mode-permission-mode="">
                {WORK_MODE_COPY.permissionModeDefaultValue}
              </dd>
            </div>
          </dl>

          <h3 className="mt-4 text-xs font-medium text-zinc-400">{WORK_MODE_COPY.deliverablesHeading}</h3>
          {/* Bounded: a long deliverable list scrolls inside the panel instead of
              growing it past the viewport bottom. */}
          <ul className="mt-2 max-h-56 space-y-1.5 overflow-y-auto text-xs" data-work-mode-deliverables="">
            {task.deliverables.map((deliverable) => (
              <li key={deliverable.id} className="flex justify-between gap-2" data-work-mode-deliverable={deliverable.id}>
                <span className="text-zinc-200">{deliverable.label}</span>
                <span
                  data-work-mode-deliverable-status={deliverable.status}
                  className={
                    deliverable.status === "ready"
                      ? "text-emerald-400"
                      : deliverable.status === "in-progress"
                        ? "text-amber-300"
                        : "text-zinc-500"
                  }
                >
                  {WORK_MODE_DELIVERABLE_STATUS_LABEL[deliverable.status]}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="text-xs font-medium text-zinc-400">{WORK_MODE_COPY.outcomeHeading}</h3>
          <p className="mt-2 text-xs text-zinc-200" data-work-mode-outcome-summary="">
            {task.outcome.summary}{" "}
            <span data-work-mode-outcome-fraction="">
              {task.outcome.current}/{task.outcome.total}
            </span>
          </p>
          <div
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800"
            role="progressbar"
            aria-label={`${WORK_MODE_COPY.outcomeHeading}: ${task.outcome.summary}`}
            aria-valuenow={progressPercent}
            aria-valuemin={0}
            aria-valuemax={100}
            data-work-mode-progress=""
          >
            <div className="h-full rounded-full bg-blue-500" style={{ width: `${progressPercent}%` }} />
          </div>
        </div>
      </div>
    </section>
  );
}
