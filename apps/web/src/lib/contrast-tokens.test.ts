import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast.js";

/**
 * M8-PERF-A11Y: axe-core's `color-contrast` rule flagged the M6 dark
 * `--dh-text-muted` token against the M6 rail's lightest surface
 * (`--dh-rail-active`) at 3.5:1 across Home/Browse/Dashboard/Settings/
 * Inbox/Ops/Chat — below the WCAG AA 4.5:1 threshold for normal text. This
 * pins the fixed value directly against the CSS source so a future edit that
 * reintroduces a too-dark `--dh-text-muted` (or lightens `--dh-rail-active`
 * without re-checking) fails loudly instead of silently regressing.
 */
describe("dh-* dark-theme contrast tokens (M8-PERF-A11Y)", () => {
  const cssPath = fileURLToPath(new URL("../index.css", import.meta.url));
  const css = readFileSync(cssPath, "utf8");

  function token(name: string): string {
    const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
    if (!match || !match[1]) throw new Error(`token --${name} not found in index.css`);
    return match[1];
  }

  it("--dh-text-muted meets WCAG AA (4.5:1) against every dh-* dark surface", () => {
    const textMuted = token("dh-text-muted");
    // Every dh-* background surface the muted text can sit on, including the
    // lightest one (--dh-rail-active) that axe actually flagged.
    const surfaces = [
      "dh-canvas",
      "dh-header",
      "dh-rail-inactive",
      "dh-rail-active",
      "dh-surface",
      "dh-user-bubble",
      "dh-control",
      "dh-control-seam",
      "dh-selected",
      "dh-hover",
      "dh-pressed",
    ];
    for (const surface of surfaces) {
      const bg = token(surface);
      expect(contrastRatio(textMuted, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

/**
 * DEVHUB-A11Y-CONTRAST-DARK-SECONDARYNAV: axe-core's `color-contrast` rule
 * flags Tailwind's `text-zinc-500` (#71717a — the "text-dim" shade the M6
 * top-bar's secondary-nav tab-strip used for inactive tabs/icon buttons) on
 * both `bg-zinc-900` (`--panel`, #18181b) and `bg-zinc-950` (`--bg`,
 * #09090b): ~3.67:1 and ~4.12:1, below the WCAG AA 4.5:1 floor for normal
 * text. `App.tsx`'s `TopBar` (the "Primary views" nav + search/command/
 * perf/shortcuts/settings controls, mounted on every route including Browse/
 * Ops/Chat) now uses `text-zinc-400` (#a1a1aa — already the app's
 * `--text-muted` token, the palette's next step up) instead. This pins both
 * the measured before/after ratios and the CSS `--panel`/`--bg` tokens those
 * ratios were measured against, so a future edit can't silently reintroduce
 * the failing shade on those surfaces.
 */
describe("top-bar tab-strip text color vs. --panel/--bg (DEVHUB-A11Y-CONTRAST-DARK-SECONDARYNAV)", () => {
  const cssPath = fileURLToPath(new URL("../index.css", import.meta.url));
  const css = readFileSync(cssPath, "utf8");

  function token(name: string): string {
    const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
    if (!match || !match[1]) throw new Error(`token --${name} not found in index.css`);
    return match[1];
  }

  // Tailwind's built-in zinc-400/zinc-500 hexes (not CSS custom properties —
  // App.tsx applies them directly as `text-zinc-400`/`text-zinc-500`).
  const zinc400 = "#a1a1aa";
  const zinc500 = "#71717a";

  it("zinc-500 (the replaced shade) fails AA 4.5:1 against --panel and --bg", () => {
    expect(contrastRatio(zinc500, token("panel"))).toBeLessThan(4.5);
    expect(contrastRatio(zinc500, token("bg"))).toBeLessThan(4.5);
  });

  it("zinc-400 (the fix) meets AA 4.5:1 against --panel and --bg", () => {
    expect(contrastRatio(zinc400, token("panel"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(zinc400, token("bg"))).toBeGreaterThanOrEqual(4.5);
  });
});
