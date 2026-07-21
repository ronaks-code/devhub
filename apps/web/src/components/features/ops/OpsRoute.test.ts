import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpsRoute, isSettingsSecondaryApplied, resolveSettingsSecondaryMode } from "./OpsRoute.js";

describe("OpsRoute — the preserved LiveOpsBoard, no duplicate nav strip", () => {
  it("renders the LiveOpsBoard (Attention Board) with NO SecondaryNav strip (QA F2/M9)", () => {
    // Aurora Cockpit §3.7: empty running list (not null) renders the board's
    // empty state, and a provided onRefresh renders the Refresh control.
    const html = renderToStaticMarkup(
      createElement(OpsRoute, { running: [], onRefresh: () => {} }),
    );
    // The old duplicate "Settings/Live ops/Inbox/Dashboard" text strip is gone —
    // the icon rail is the one owner of those destinations now (it was even
    // embedded under Ops→Board's own Grid/Board/Drive toggle).
    expect(html).not.toContain("dh-secondary-nav");
    // The redesigned board's heading + refresh control render.
    expect(html).toContain("Live Ops");
    expect(html).toContain("Refresh");
  });

  it("re-exports the SAME settingsSecondary gate SettingsRoute owns — one slice, not four", () => {
    expect(resolveSettingsSecondaryMode).toBeTypeOf("function");
    expect(isSettingsSecondaryApplied({ settingsSecondary: true })).toBe(true);
    expect(isSettingsSecondaryApplied({ settingsSecondary: false })).toBe(false);
  });
});
