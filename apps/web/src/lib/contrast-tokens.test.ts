import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
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
