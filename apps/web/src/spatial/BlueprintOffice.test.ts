// @vitest-environment jsdom

import { createElement } from "react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BlueprintOffice } from "./BlueprintOffice.js";
import { DEPARTMENTS } from "./contract.js";
import type { Agent, Room, WorldState } from "./contract.js";

/**
 * Regression guard for the MAJOR "rooms beyond the viewBox are permanently
 * off-canvas" bug. A tall office (8 departments + 4 projects = 12 rooms ⇒ 4
 * building rows) must render as a FULL-plan sheet inside a SCROLLING stage — the
 * viewBox is the whole plan (never a crop), the rendered sheet is taller than the
 * pane (so it scrolls rather than hides the lower rooms), and every room is in
 * the DOM and thus reachable.
 */

/** Build a deterministic 12-room world: 8 department rooms + 4 project rooms,
 *  each with one working + one idle desk so every row is comfortably tall. */
function buildTallWorld(): WorldState {
  const agents: Agent[] = [];
  const rooms: Room[] = [];
  let n = 0;
  const addPair = (dept: string): string[] => {
    const w: Agent = {
      id: `a${n++}`,
      name: `worker-${n}`,
      dept,
      role: "engineer",
      status: "working",
      assignment: "heads-down on the build",
      reports_to: null,
      project: "",
    };
    const idle: Agent = {
      id: `a${n++}`,
      name: `idle-${n}`,
      dept,
      role: "engineer",
      status: "idle",
      assignment: "",
      reports_to: null,
      project: "",
    };
    agents.push(w, idle);
    return [w.id, idle.id];
  };

  for (const dept of DEPARTMENTS) {
    rooms.push({ id: `dept-${dept}`, kind: "department", dept, project: "", label: `${dept} room`, members: addPair(dept) });
  }
  for (let p = 0; p < 4; p++) {
    rooms.push({
      id: `proj-${p}`,
      kind: "project",
      dept: "",
      project: `Project ${p}`,
      label: `Project ${p}`,
      members: addPair("athena"),
      status: "shipping",
    });
  }
  return { rev: 1, ts: Date.now(), agents, edges: [], rooms };
}

/** A ResizeObserver stub that reports a fixed (short) stage box, so the fit-to-
 *  width scale + scroll math runs deterministically under jsdom (which has no
 *  layout engine). */
function installResizeObserver(w: number, h: number): () => void {
  const prev = (globalThis as Record<string, unknown>).ResizeObserver;
  class FakeRO {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(): void {
      this.cb([{ contentRect: { width: w, height: h } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = FakeRO as unknown;
  return () => {
    (globalThis as Record<string, unknown>).ResizeObserver = prev;
  };
}

describe("BlueprintOffice — tall office reachability", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders all 12 rooms of a 4-row office as an uncropped, scrollable sheet", () => {
    const STAGE_W = 900;
    const STAGE_H = 400;
    const restore = installResizeObserver(STAGE_W, STAGE_H);
    try {
      const { container } = render(createElement(BlueprintOffice, { world: buildTallWorld(), source: "mock" }));

      // Every room is drawn (reachable in the DOM), regardless of floor count.
      expect(container.querySelectorAll('[data-testid="office-room"]')).toHaveLength(12);

      const svg = container.querySelector("svg.dh-blueprint") as SVGSVGElement | null;
      expect(svg).not.toBeNull();

      // The viewBox is the WHOLE plan (origin 0 0), never a cropped window — the
      // core of the fix. Parse the plan height from it.
      const vb = svg!.getAttribute("viewBox")!;
      const [vx, vy, , planH] = vb.split(/\s+/).map(Number);
      expect(vx).toBe(0);
      expect(vy).toBe(0);
      // 4 rows ⇒ a genuinely tall plan.
      expect(planH).toBeGreaterThan(600);

      // The rendered sheet is sized in px to fit the pane WIDTH but is TALLER than
      // the pane, so the stage scrolls to reveal the lower rooms instead of
      // cropping them off-canvas.
      const sheetH = parseFloat(svg!.style.height);
      expect(sheetH).toBeGreaterThan(STAGE_H);

      // The sheet lives inside an overflow-auto scroll container (not the old
      // overflow-hidden crop).
      const scroller = svg!.parentElement as HTMLElement;
      expect(scroller.className).toContain("overflow-auto");
    } finally {
      restore();
    }
  });
});
