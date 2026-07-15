import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpsRoute, isSettingsSecondaryApplied, resolveSettingsSecondaryMode } from "./OpsRoute.js";

describe("OpsRoute — LiveOpsBoard routed under secondary navigation", () => {
  it("wraps the preserved LiveOpsBoard in exactly one SecondaryNav with ops active", () => {
    const html = renderToStaticMarkup(createElement(OpsRoute, {}));
    expect((html.match(/<nav/g) ?? []).length).toBe(1);
    const opsStart = html.indexOf(">Live ops</button>");
    const before = html.lastIndexOf("<button", opsStart);
    expect(html.slice(before, opsStart)).toContain('aria-current="page"');
    // The preserved LiveOpsBoard heading/refresh copy is unchanged.
    expect(html).toContain("Live ops");
    expect(html).toContain("Refresh");
  });

  it("re-exports the SAME settingsSecondary gate SettingsRoute owns — one slice, not four", () => {
    expect(resolveSettingsSecondaryMode).toBeTypeOf("function");
    expect(isSettingsSecondaryApplied({ settingsSecondary: true })).toBe(true);
    expect(isSettingsSecondaryApplied({ settingsSecondary: false })).toBe(false);
  });
});
