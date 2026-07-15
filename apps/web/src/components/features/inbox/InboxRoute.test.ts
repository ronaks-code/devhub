import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InboxRoute, isSettingsSecondaryApplied, resolveSettingsSecondaryMode } from "./InboxRoute.js";

describe("InboxRoute — InboxPane routed under secondary navigation", () => {
  it("wraps the preserved InboxPane in exactly one SecondaryNav with inbox active", () => {
    const html = renderToStaticMarkup(createElement(InboxRoute, {}));
    expect((html.match(/<nav/g) ?? []).length).toBe(1);
    const inboxStart = html.indexOf(">Inbox</button>");
    const before = html.lastIndexOf("<button", inboxStart);
    expect(html.slice(before, inboxStart)).toContain('aria-current="page"');
    // The preserved InboxPane heading/description copy is unchanged.
    expect(html).toContain("Inbox");
    expect(html).toContain("Recent sessions that");
    expect(html).toContain("not archived");
  });

  it("re-exports the SAME settingsSecondary gate SettingsRoute owns — one slice, not four", () => {
    expect(resolveSettingsSecondaryMode).toBeTypeOf("function");
    expect(isSettingsSecondaryApplied({ settingsSecondary: true })).toBe(true);
    expect(isSettingsSecondaryApplied({ settingsSecondary: false })).toBe(false);
  });
});
