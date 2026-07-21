import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InboxRoute, isSettingsSecondaryApplied, resolveSettingsSecondaryMode } from "./InboxRoute.js";

describe("InboxRoute — the preserved InboxPane, no duplicate nav strip", () => {
  it("renders the preserved InboxPane with NO SecondaryNav strip (QA F2/M9)", () => {
    const html = renderToStaticMarkup(createElement(InboxRoute, {}));
    // The old duplicate "Settings/Live ops/Inbox/Dashboard" text strip is gone —
    // the icon rail is the one owner of those destinations now.
    expect(html).not.toContain("dh-secondary-nav");
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
