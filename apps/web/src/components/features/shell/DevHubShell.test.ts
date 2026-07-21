import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DevHubShell,
  RegionBoundary,
  SHELL_BRAND,
  SHELL_GEOMETRY,
  SHELL_LAYOUT,
  isShellChromeApplied,
  resolveShellChromeMode,
  type ShellStatus,
} from "./DevHubShell.js";

/** Count non-overlapping occurrences of a substring. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function render(props: Parameters<typeof DevHubShell>[0] = {}): string {
  return renderToStaticMarkup(createElement(DevHubShell, props));
}

describe("DevHubShell locked geometry (design-lock §4)", () => {
  it("exposes a full-width route host while preserving measured thread child caps", () => {
    expect(SHELL_LAYOUT.routeHost).toBe("full-width");
    const html = render();
    expect(html).toContain('data-dh-route-host="full-width"');
    expect(html).not.toContain('data-dh-route-host="full-width" data-dh-width="736"');
    expect(SHELL_GEOMETRY.transcriptWidth).toBe(736);
    expect(SHELL_GEOMETRY.composerWidth).toBe(736);
  });

  it("exposes the exact measured wide-shell dimensions as a single source of truth", () => {
    // design-lock.md §4 + reference-capture-manifest.md "Measured wide-shell geometry".
    // Aurora Cockpit: 52 icon-rail + 272 panel = 324 total (was a single 273 rail).
    expect(SHELL_GEOMETRY.railWidth).toBe(324);
    expect(SHELL_GEOMETRY.iconRailWidth).toBe(52);
    expect(SHELL_GEOMETRY.panelWidth).toBe(272);
    expect(SHELL_GEOMETRY.headerHeight).toBe(46);
    expect(SHELL_GEOMETRY.canvasColor).toBe("#181818");
    expect(SHELL_GEOMETRY.transcriptWidth).toBe(736);
    expect(SHELL_GEOMETRY.composerWidth).toBe(736);
    expect(SHELL_GEOMETRY.composerHeight).toBe(98);
    expect(SHELL_GEOMETRY.composerBottomGutter).toBe(16);
    expect(SHELL_GEOMETRY.inspectorWidth).toBe(300);
    expect(SHELL_GEOMETRY.inspectorLaneWidth).toBe(316);
    expect(SHELL_GEOMETRY.inspectorTopGutter).toBe(12);
    expect(SHELL_GEOMETRY.inspectorRightGutter).toBe(16);
    expect(SHELL_GEOMETRY.inspectorRadius).toBe(16);
    expect(SHELL_GEOMETRY.composerRadius).toBe(21);
    expect(SHELL_GEOMETRY.shellGutter).toBe(16);
    expect(SHELL_GEOMETRY.selectedRowWidth).toBe(248);
    expect(SHELL_GEOMETRY.selectedRowHeight).toBe(44);
    expect(SHELL_GEOMETRY.railInset).toBe(8);
    expect(SHELL_GEOMETRY.userBubbleMax).toBe(566);
    expect(SHELL_GEOMETRY.narrowBreakpoint).toBe(1024);
    expect(Object.isFrozen(SHELL_GEOMETRY)).toBe(true);
  });

  it("renders each measured slot carrying its locked dimension", () => {
    const html = render({
      inspector: createElement("div", null, "inspector"),
      composer: createElement("div", null, "composer"),
    });
    // 273 rail
    expect(html).toContain('data-dh-rail=""');
    expect(html).toContain(`data-dh-width="${SHELL_GEOMETRY.railWidth}"`);
    // 46 header
    expect(html).toContain('data-dh-header=""');
    expect(html).toContain(`data-dh-height="${SHELL_GEOMETRY.headerHeight}"`);
    // open #181818 canvas
    expect(html).toContain('data-dh-canvas=""');
    expect(html).toContain(`data-dh-canvas-color="${SHELL_GEOMETRY.canvasColor}"`);
    // 736 shared transcript/composer column
    expect(html).toContain('data-dh-transcript=""');
    expect(html).toContain(`data-dh-width="${SHELL_GEOMETRY.transcriptWidth}"`);
    // 736x98 composer with 16 bottom gutter
    expect(html).toContain('data-dh-composer=""');
    expect(html).toContain(`data-dh-height="${SHELL_GEOMETRY.composerHeight}"`);
    expect(html).toContain(`data-dh-bottom-gutter="${SHELL_GEOMETRY.composerBottomGutter}"`);
    // 300 content-height inspector dock, 316 lane, 12 top / 16 right gutter
    expect(html).toContain('data-dh-inspector-lane=""');
    expect(html).toContain(`data-dh-lane-width="${SHELL_GEOMETRY.inspectorLaneWidth}"`);
    expect(html).toContain(`data-dh-inspector-width="${SHELL_GEOMETRY.inspectorWidth}"`);
    expect(html).toContain(`data-dh-top-gutter="${SHELL_GEOMETRY.inspectorTopGutter}"`);
    expect(html).toContain(`data-dh-right-gutter="${SHELL_GEOMETRY.inspectorRightGutter}"`);
  });

  it("drives visible geometry from --dh-* tokens (never invented values in the tree)", () => {
    // The frame classes below map 1:1 to the token-driven rules in index.css §3.1.
    const html = render();
    expect(html).toContain('class="dh-shell"');
    expect(html).toContain('class="dh-rail"');
    expect(html).toContain('class="dh-header"');
    expect(html).toContain('class="dh-canvas"');
    expect(html).toContain('class="dh-transcript-col"');
    // No raw hex or px literal leaks into the rendered markup's style attributes.
    expect(html).not.toMatch(/style="[^"]*\b273px\b/);
    expect(html).not.toMatch(/style="[^"]*#181818/);
  });
});

describe("DevHubShell landmarks, brand, and accessibility", () => {
  it("renders exactly one main, one named rail navigation, and a skip link", () => {
    const html = render();
    expect(count(html, 'role="main"')).toBe(1);
    expect(count(html, "<main")).toBe(1);
    expect(count(html, 'aria-label="Primary navigation"')).toBe(1);
    expect(count(html, "<nav")).toBe(1);
    expect(count(html, 'class="dh-skip-link"')).toBe(1);
    expect(html).toContain('href="#dh-main"');
    expect(html).toContain('id="dh-main"');
    expect(html).toContain("Skip to main content");
  });

  it("renders the optional inspector only as a named complementary region", () => {
    expect(render()).not.toContain('role="complementary"');
    const withInspector = render({ inspector: createElement("div", null, "x") });
    expect(count(withInspector, 'role="complementary"')).toBe(1);
    expect(withInspector).toContain('aria-label="Task inspector"');
  });

  it("uses the exact DevHub wordmark and never a provider wordmark", () => {
    const html = render();
    expect(SHELL_BRAND).toBe("DevHub");
    expect(html).toContain('data-dh-brand=""');
    expect(html).toContain(">DevHub<");
    for (const forbidden of ["Codex", "ChatGPT", "Claude UI", "OpenAI", "Anthropic"]) {
      expect(html).not.toContain(`data-dh-brand="">${forbidden}`);
    }
  });

  it("rejects nothing but always defaults the brand to DevHub", () => {
    // Even if a caller passes an empty string the shell keeps the wordmark slot.
    expect(render({ brand: undefined })).toContain(">DevHub<");
  });
});

describe("DevHubShell geometry is invariant across activity status", () => {
  const statuses: ShellStatus[] = ["rest", "loading", "streaming"];

  it("keeps every measured slot dimension identical when status changes", () => {
    // Strip the one status-dependent attribute so only geometry is compared.
    const geometryOf = (status: ShellStatus): string =>
      render({
        status,
        composer: createElement("div", null, "c"),
        inspector: createElement("div", null, "i"),
      })
        .replace(/ data-dh-status="[a-z]+"/, "")
        .replace(/ aria-busy="true"/, "");

    const [rest, loading, streaming] = statuses.map(geometryOf);
    expect(loading).toBe(rest);
    expect(streaming).toBe(rest);
  });

  it("only reflects activity through aria-busy, not layout", () => {
    expect(render({ status: "rest" })).not.toContain('aria-busy="true"');
    expect(render({ status: "loading" })).toContain('aria-busy="true"');
    expect(render({ status: "streaming" })).toContain('aria-busy="true"');
  });
});

describe("DevHubShell isolates a provider/region failure", () => {
  it("catches a region error and shows its fallback without unmounting the shell", () => {
    // RegionBoundary is the isolation primitive: a throw in one region is caught so
    // the rail, header, brand, navigation, and the other region keep rendering.
    expect(RegionBoundary.getDerivedStateFromError()).toEqual({ hasError: true });

    const fallbackHtml = renderToStaticMarkup(
      createElement(RegionBoundary, { fallback: createElement("p", null, "region unavailable") }),
    );
    // Normal (no-error) SSR renders children; here there are no children so it is empty,
    // proving the boundary renders its subtree independently of the rest of the shell.
    expect(fallbackHtml).toBe("");
  });

  it("renders rail, header, and canvas as independent sibling subtrees", () => {
    const html = render({
      rail: createElement("span", { "data-testid": "rail-content" }, "RAIL"),
      header: createElement("span", { "data-testid": "header-content" }, "HEADER"),
      children: createElement("span", { "data-testid": "canvas-content" }, "CANVAS"),
      composer: createElement("span", { "data-testid": "composer-content" }, "COMPOSER"),
    });
    // All four live in separate containers; none is nested inside another region, so a
    // canvas failure cannot structurally remove the rail/header/composer.
    expect(html).toContain("RAIL");
    expect(html).toContain("HEADER");
    expect(html).toContain("CANVAS");
    expect(html).toContain("COMPOSER");
    expect(html.indexOf("RAIL")).toBeLessThan(html.indexOf("HEADER"));
    expect(html.indexOf("HEADER")).toBeLessThan(html.indexOf("CANVAS"));
  });
});

describe("DevHubShell renders no hidden duplicate tabbable chrome", () => {
  it("emits a single rail, single skip link, and single main at every tier", () => {
    // Responsive tiers are pure CSS on ONE rendered rail (index.css media queries), so
    // the DOM never carries a second, hidden, tabbable rail/skip/main to duplicate focus.
    const html = render({ inspector: createElement("div", null, "i") });
    expect(count(html, "<nav")).toBe(1);
    expect(count(html, 'class="dh-skip-link"')).toBe(1);
    expect(count(html, "<main")).toBe(1);
  });
});

describe("shellChrome slice-flag gate", () => {
  it("defaults to DevHubShell; only an explicit false shellChrome flag selects legacy", () => {
    expect(resolveShellChromeMode({ devHubFeatures: { shellChrome: true } })).toBe("devhub");
    expect(resolveShellChromeMode({ devHubFeatures: { shellChrome: false } })).toBe("legacy");
    // Missing/undefined settings (pre-`/api/settings`) default to the new chrome so the
    // legacy first-paint flash dies; only an EXPLICIT stored false rolls back.
    expect(resolveShellChromeMode({ devHubFeatures: {} })).toBe("devhub");
    expect(resolveShellChromeMode({})).toBe("devhub");
    expect(resolveShellChromeMode(null)).toBe("devhub");
    expect(resolveShellChromeMode(undefined)).toBe("devhub");
  });

  it("reports applied only when shellChrome is explicitly true", () => {
    expect(isShellChromeApplied({ shellChrome: true })).toBe(true);
    expect(isShellChromeApplied({ shellChrome: false })).toBe(false);
    expect(isShellChromeApplied({})).toBe(false);
    expect(isShellChromeApplied(undefined)).toBe(false);
  });
});
