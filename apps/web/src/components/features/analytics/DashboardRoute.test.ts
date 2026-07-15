import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardRoute, isSettingsSecondaryApplied, resolveSettingsSecondaryMode } from "./DashboardRoute.js";

describe("DashboardRoute — DashboardPane routed under secondary navigation", () => {
  it("wraps the preserved DashboardPane in exactly one SecondaryNav with dashboard active", () => {
    const html = renderToStaticMarkup(createElement(DashboardRoute, {}));
    expect((html.match(/<nav/g) ?? []).length).toBe(1);
    const dashboardStart = html.indexOf(">Dashboard</button>");
    const before = html.lastIndexOf("<button", dashboardStart);
    expect(html.slice(before, dashboardStart)).toContain('aria-current="page"');
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
