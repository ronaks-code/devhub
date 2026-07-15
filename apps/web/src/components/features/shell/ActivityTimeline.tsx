import { useId, useState, type ReactNode } from "react";

/**
 * ActivityTimeline — inline compact activity + expandable Plan (M6 slice 4).
 *
 * `design-lock.md` §4 / `component-state-matrix.md` §8: active work lives in the SAME
 * vertical narrative as completed work — it is NEVER a separate progress dashboard.
 * This component renders two things, both inline in the transcript:
 *
 *   1. Compact activity rows (assistant commentary + ordinary tool rows). These are
 *      NORMAL activity, so they are UNFRAMED — no surface/card/pill. (Surfaces are
 *      reserved for requests, user bubbles, compact controls, the composer, and the
 *      inspector; ordinary activity is not one of those.)
 *   2. An expandable Plan disclosure whose steps each carry an explicit status:
 *      pending (empty glyph), running (quiet spinner + `aria-current="step"`),
 *      complete (check), failed (error). Plan steps come ONLY from provider plan
 *      events — this component never synthesizes a step from prose (invariant: a
 *      plan the provider did not emit is absent, not fabricated).
 *
 * It renders no `<svg>`/`<img>` and no dashboard grid/KPI card. Pure presentation
 * over a model; mounted only inside `ThreadWorkspace` behind the `threadWorkspace`
 * slice flag.
 */

/** The closed set of plan-step statuses a provider can report. */
export type PlanStepStatus = "pending" | "running" | "complete" | "failed";

/** Quiet status glyphs. `running` uses a CSS spinner element, not a glyph. */
export const PLAN_STATUS_GLYPH: Readonly<Record<Exclude<PlanStepStatus, "running">, string>> =
  Object.freeze({
    pending: "○",
    complete: "✓",
    failed: "✕",
  });

/** Activity/plan copy. One source for the `T-active` visible-copy diff. */
export const ACTIVITY_COPY = Object.freeze({
  planLabel: "Plan",
  /** Accessible status words, never used to fabricate a step the provider didn't emit. */
  statusPending: "Pending",
  statusRunning: "Running",
  statusComplete: "Complete",
  statusFailed: "Failed",
});

const STATUS_WORD: Readonly<Record<PlanStepStatus, string>> = Object.freeze({
  pending: ACTIVITY_COPY.statusPending,
  running: ACTIVITY_COPY.statusRunning,
  complete: ACTIVITY_COPY.statusComplete,
  failed: ACTIVITY_COPY.statusFailed,
});

export interface PlanStep {
  id: string;
  /** Human step label from a provider plan event. */
  label: string;
  status: PlanStepStatus;
}

export interface PlanModel {
  /** Optional heading; defaults to `Plan`. */
  title?: string;
  /** Provider-emitted steps, in order. */
  steps: PlanStep[];
  /** Expanded by default? A running plan is typically open; a finished one collapsed. */
  defaultOpen?: boolean;
}

/** A single compact activity row: assistant commentary or an ordinary tool row. */
export interface ActivityEntry {
  id: string;
  kind: "commentary" | "tool";
  /** Primary text (e.g. the commentary line or the tool name). */
  label: string;
  /** Optional secondary detail (e.g. a tool argument summary). */
  detail?: string;
}

export interface ActivityTimelineProps {
  /** Compact activity rows, rendered inline and unframed. */
  entries?: ActivityEntry[];
  /** Optional provider-emitted plan. Absent when the provider emitted none. */
  plan?: PlanModel | null;
}

function PlanStepRow({ step }: { step: PlanStep }) {
  const running = step.status === "running";
  return (
    <li
      role="listitem"
      className={`dh-plan-step dh-plan-step--${step.status}`}
      data-dh-plan-step=""
      data-dh-plan-status={step.status}
      // The running step is the current step in the plan sequence.
      aria-current={running ? "step" : undefined}
    >
      {running ? (
        <span className="dh-plan-spinner" data-dh-plan-spinner="" aria-hidden="true" />
      ) : (
        <span className="dh-plan-glyph" aria-hidden="true">
          {PLAN_STATUS_GLYPH[step.status as Exclude<PlanStepStatus, "running">]}
        </span>
      )}
      <span className="dh-plan-step-label">{step.label}</span>
      {/* Status word for assistive tech; the glyph/spinner above is decorative. */}
      <span className="dh-sr-only">{STATUS_WORD[step.status]}</span>
    </li>
  );
}

function PlanDisclosure({ plan }: { plan: PlanModel }) {
  const [open, setOpen] = useState(plan.defaultOpen ?? true);
  const regionId = useId();
  const title = plan.title ?? ACTIVITY_COPY.planLabel;
  return (
    <div className="dh-plan" data-dh-plan="">
      {/* The expand toggle is a compact control (allowed a control affordance), but the
          plan body itself is unframed inline narrative — never a dashboard. */}
      <button
        type="button"
        className="dh-plan-toggle"
        data-dh-plan-toggle=""
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dh-plan-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="dh-plan-title">{title}</span>
      </button>
      {open ? (
        <ol
          id={regionId}
          role="list"
          className="dh-plan-steps"
          data-dh-plan-steps=""
        >
          {plan.steps.map((step) => (
            <PlanStepRow key={step.id} step={step} />
          ))}
        </ol>
      ) : (
        <div id={regionId} hidden />
      )}
    </div>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }): ReactNode {
  return (
    <li
      role="listitem"
      className={`dh-activity-row dh-activity-row--${entry.kind}`}
      data-dh-activity-row=""
      data-dh-activity-kind={entry.kind}
    >
      <span className="dh-activity-label">{entry.label}</span>
      {entry.detail != null ? (
        <span className="dh-activity-detail">{entry.detail}</span>
      ) : null}
    </li>
  );
}

export function ActivityTimeline({ entries, plan }: ActivityTimelineProps) {
  const hasEntries = !!entries && entries.length > 0;
  const hasPlan = !!plan && plan.steps.length > 0;
  if (!hasEntries && !hasPlan) return null;
  return (
    <div className="dh-activity" data-dh-activity-timeline="">
      {hasEntries ? (
        <ul role="list" className="dh-activity-rows" data-dh-activity-rows="">
          {entries!.map((entry) => (
            <ActivityRow key={entry.id} entry={entry} />
          ))}
        </ul>
      ) : null}
      {hasPlan ? <PlanDisclosure plan={plan!} /> : null}
    </div>
  );
}
