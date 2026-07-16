// @vitest-environment jsdom
import { createElement } from "react";
import { render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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

describe("SecondaryNav — live interaction (mounted DOM)", () => {
  it("clicking a non-active destination invokes onNavigate with its id", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    rtlRender(createElement(SecondaryNav, { active: "settings", onNavigate }));
    await user.click(screen.getByText("Dashboard"));
    expect(onNavigate).toHaveBeenCalledWith("dashboard");
  });

  it("Tab reaches each destination link in order and Enter activates the focused one", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    rtlRender(createElement(SecondaryNav, { active: "settings", onNavigate }));
    await user.tab();
    expect(screen.getByText("Settings")).toHaveFocus();
    await user.tab();
    expect(screen.getByText("Live ops")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onNavigate).toHaveBeenCalledWith("ops");
  });

  it("does not throw when onNavigate is omitted (optional handler)", async () => {
    const user = userEvent.setup();
    rtlRender(createElement(SecondaryNav, { active: "inbox" }));
    await user.click(screen.getByText("Inbox"));
  });
});
