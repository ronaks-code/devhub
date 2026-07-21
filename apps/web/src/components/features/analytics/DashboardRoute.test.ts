import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardRoute, isSettingsSecondaryApplied, resolveSettingsSecondaryMode } from "./DashboardRoute.js";

describe("DashboardRoute — the preserved DashboardPane, no duplicate nav strip", () => {
  it("renders the preserved DashboardPane with NO SecondaryNav strip (QA F2/M9)", () => {
    const html = renderToStaticMarkup(createElement(DashboardRoute, {}));
    // The old duplicate "Settings/Live ops/Inbox/Dashboard" text strip is gone —
    // the icon rail is the one owner of those destinations now.
    expect(html).not.toContain("dh-secondary-nav");
    // The preserved DashboardPane's own loading state — never a dashboard grid
    // rendered as if it were the task canvas.
    expect(html).toContain('aria-label="Loading dashboard"');
  });

  it("re-exports the SAME settingsSecondary gate SettingsRoute owns — one slice, not four", () => {
    expect(resolveSettingsSecondaryMode).toBeTypeOf("function");
    expect(isSettingsSecondaryApplied({ settingsSecondary: true })).toBe(true);
    expect(isSettingsSecondaryApplied({ settingsSecondary: false })).toBe(false);
  });
});
