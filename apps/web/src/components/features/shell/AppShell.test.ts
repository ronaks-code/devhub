import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell } from "./AppShell.js";

const SLOTS = {
  header: createElement("div", { "data-slot": "header" }, "HEADER"),
  rail: createElement("span", { "data-slot": "rail" }, "RAIL"),
  children: createElement("p", { "data-slot": "main" }, "MAIN"),
} as const;

function render(mode: "legacy" | "devhub"): string {
  return renderToStaticMarkup(
    createElement(AppShell, {
      mode,
      header: SLOTS.header,
      rail: SLOTS.rail,
      children: SLOTS.children,
    }),
  );
}

describe("AppShell flag-off preservation (shellChrome default false)", () => {
  const html = render("legacy");

  it("renders the current chrome unchanged, byte-for-byte", () => {
    // Skip link — same href + copy as today.
    expect(html).toContain('href="#main-content"');
    expect(html).toContain("Skip to main content");
    expect(html).toContain("focus:bg-clay-500");
    // Header slot (TopBar in production) is rendered in place.
    expect(html).toContain("HEADER");
    // The primary-navigation rail keeps its exact legacy landmark + classes.
    expect(html).toContain('aria-label="Primary navigation"');
    expect(html).toContain("w-44");
    expect(html).toContain("border-zinc-800/80");
    expect(html).toContain("RAIL");
    // The #main-content main landmark + flexible content column are unchanged.
    expect(html).toContain('id="main-content"');
    expect(html).toContain('role="main"');
    expect(html).toContain("MAIN");
  });

  it("does NOT instantiate DevHubShell under flag-off", () => {
    expect(html).not.toContain("data-dh-shell");
    expect(html).not.toContain('class="dh-rail"');
    expect(html).not.toContain('data-dh-brand=""');
    expect(html).not.toContain('href="#dh-main"');
  });
});

describe("AppShell flag-on mounts DevHubShell (shellChrome true)", () => {
  const html = render("devhub");

  it("renders the DevHubShell frame with the same slots", () => {
    expect(html).toContain("data-dh-shell");
    expect(html).toContain('class="dh-rail"');
    expect(html).toContain(">DevHub<");
    expect(html).toContain('href="#dh-main"');
    // Slots flow into the new frame.
    expect(html).toContain("HEADER");
    expect(html).toContain("RAIL");
    expect(html).toContain("MAIN");
  });

  it("drops the legacy chrome markers so no duplicate structure remains", () => {
    expect(html).not.toContain('id="main-content"');
    expect(html).not.toContain("w-44");
    expect(html).not.toContain("focus:bg-clay-500");
  });
});
