import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SECONDARY_DESTINATIONS,
  SecondaryNav,
  isSecondaryDestination,
} from "./SecondaryNav.js";

describe("SecondaryNav — the shared secondary-navigation landmark", () => {
  it("names exactly the four secondary destinations, in order", () => {
    expect(SECONDARY_DESTINATIONS.map((d) => d.id)).toEqual([
      "settings",
      "ops",
      "inbox",
      "dashboard",
    ]);
    expect(SECONDARY_DESTINATIONS.map((d) => d.label)).toEqual([
      "Settings",
      "Live ops",
      "Inbox",
      "Dashboard",
    ]);
  });

  it("isSecondaryDestination accepts only the four ids", () => {
    expect(isSecondaryDestination("settings")).toBe(true);
    expect(isSecondaryDestination("ops")).toBe(true);
    expect(isSecondaryDestination("inbox")).toBe(true);
    expect(isSecondaryDestination("dashboard")).toBe(true);
    expect(isSecondaryDestination("home")).toBe(false);
    expect(isSecondaryDestination("browse")).toBe(false);
  });

  it("renders ONE nav landmark with all four destinations and marks only the active one", () => {
    const html = renderToStaticMarkup(createElement(SecondaryNav, { active: "inbox" }));
    expect((html.match(/<nav/g) ?? []).length).toBe(1);
    expect(html).toContain('aria-label="Secondary"');
    for (const d of SECONDARY_DESTINATIONS) {
      expect(html).toContain(`>${d.label}</button>`);
    }
    // Exactly one destination carries aria-current="page".
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1);
    const inboxStart = html.indexOf(">Inbox</button>");
    const before = html.lastIndexOf("<button", inboxStart);
    expect(html.slice(before, inboxStart)).toContain('aria-current="page"');
  });

  it("renders no aria-current when a destination is not the active one", () => {
    const html = renderToStaticMarkup(createElement(SecondaryNav, { active: "settings" }));
    const settingsStart = html.indexOf(">Settings</button>");
    const before = html.lastIndexOf("<button", settingsStart);
    expect(html.slice(before, settingsStart)).toContain('aria-current="page"');
    const opsStart = html.indexOf(">Live ops</button>");
    const opsBefore = html.lastIndexOf("<button", opsStart);
    expect(html.slice(opsBefore, opsStart)).not.toContain("aria-current");
  });

  it("renders passed children after the destination list", () => {
    const html = renderToStaticMarkup(
      createElement(SecondaryNav, { active: "ops" }, createElement("p", null, "board content")),
    );
    expect(html).toContain("board content");
    expect(html.indexOf("</ul>")).toBeLessThan(html.indexOf("board content"));
  });
});
