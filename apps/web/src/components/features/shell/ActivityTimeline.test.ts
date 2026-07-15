import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_COPY,
  ActivityTimeline,
  PLAN_STATUS_GLYPH,
  type ActivityEntry,
  type PlanModel,
} from "./ActivityTimeline.js";

/** Count non-overlapping occurrences of a substring. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function render(props: Parameters<typeof ActivityTimeline>[0]): string {
  return renderToStaticMarkup(createElement(ActivityTimeline, props));
}

const entries: ActivityEntry[] = [
  { id: "a1", kind: "commentary", label: "Reading the router" },
  { id: "a2", kind: "tool", label: "read_file", detail: "router.ts" },
];

const plan: PlanModel = {
  steps: [
    { id: "p1", label: "Locate the gateway", status: "complete" },
    { id: "p2", label: "Rewire the transport", status: "running" },
    { id: "p3", label: "Add tests", status: "pending" },
    { id: "p4", label: "Old approach", status: "failed" },
  ],
};

describe("ActivityTimeline renders inline compact activity (unframed)", () => {
  it("renders each activity entry as an unframed row, not a card/surface", () => {
    const html = render({ entries });
    expect(html).toContain('data-dh-activity-timeline=""');
    expect(count(html, 'data-dh-activity-row=""')).toBe(2);
    expect(html).toContain(">Reading the router<");
    expect(html).toContain(">read_file<");
    expect(html).toContain(">router.ts<");
    // Activity is normal, unframed work: it carries no surface marker and no card.
    expect(html).not.toContain('data-dh-surface=""');
    expect(html).not.toContain("card");
  });

  it("renders nothing when there is no activity and no plan", () => {
    expect(render({})).toBe("");
    expect(render({ entries: [], plan: null })).toBe("");
    expect(render({ plan: { steps: [] } })).toBe("");
  });

  it("never renders a provider logo (no svg/img)", () => {
    const html = render({ entries, plan });
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<img");
  });

  it("is not a progress dashboard (no dashboard grid/KPI markup)", () => {
    const html = render({ entries, plan });
    expect(html).not.toContain("dashboard");
    expect(html).not.toContain("kpi");
    // The plan is a plain expandable list, not a grid.
    expect(html).toContain('data-dh-plan-steps=""');
  });
});

describe("ActivityTimeline plan disclosure and step statuses", () => {
  it("exposes an expandable plan with the Plan title", () => {
    const html = render({ plan });
    expect(html).toContain('data-dh-plan=""');
    expect(html).toContain('data-dh-plan-toggle=""');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(`>${ACTIVITY_COPY.planLabel}<`);
  });

  it("renders each step with its explicit status and glyph", () => {
    const html = render({ plan });
    expect(count(html, 'data-dh-plan-step=""')).toBe(4);
    expect(html).toContain('data-dh-plan-status="complete"');
    expect(html).toContain('data-dh-plan-status="running"');
    expect(html).toContain('data-dh-plan-status="pending"');
    expect(html).toContain('data-dh-plan-status="failed"');
    // Non-running statuses use quiet glyphs.
    expect(html).toContain(`>${PLAN_STATUS_GLYPH.complete}<`);
    expect(html).toContain(`>${PLAN_STATUS_GLYPH.pending}<`);
    expect(html).toContain(`>${PLAN_STATUS_GLYPH.failed}<`);
  });

  it("marks the running step with a spinner and aria-current=step", () => {
    const html = render({ plan });
    expect(html).toContain('data-dh-plan-spinner=""');
    expect(count(html, 'aria-current="step"')).toBe(1);
    // The single running step carries the spinner; other steps use glyphs.
    expect(count(html, 'data-dh-plan-spinner=""')).toBe(1);
  });

  it("collapses the plan when defaultOpen is false", () => {
    const html = render({ plan: { ...plan, defaultOpen: false } });
    expect(html).toContain('aria-expanded="false"');
    // Collapsed: the steps list is not rendered open.
    expect(html).not.toContain('data-dh-plan-steps=""');
  });

  it("carries an accessible status word for every step", () => {
    const html = render({ plan });
    expect(html).toContain(">Complete<");
    expect(html).toContain(">Running<");
    expect(html).toContain(">Pending<");
    expect(html).toContain(">Failed<");
  });
});
