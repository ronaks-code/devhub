import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusBar, type StatusBarProps } from "./StatusBar.js";

function render(overrides: Partial<StatusBarProps> = {}): string {
  const props: StatusBarProps = {
    runningCount: 2,
    needsYouCount: 0,
    monthToDateUsd: 1234,
    projectName: "devhub",
    branch: "feat/aurora",
    ...overrides,
  };
  return renderToStaticMarkup(createElement(StatusBar, props));
}

describe("StatusBar (§3.7)", () => {
  it("renders ambient project/branch/running/spend segments from real data", () => {
    const html = render();
    expect(html).toContain(">devhub<");
    expect(html).toContain("⎇ feat/aurora");
    expect(html).toContain("2 running");
    expect(html).toContain("$1234 MTD");
    // Non-interactive → doubles as a window drag region (§4).
    expect(html).toContain("data-tauri-drag-region");
  });

  it("hides the attention banner when nothing needs you", () => {
    expect(render({ needsYouCount: 0 })).not.toContain("need you");
  });

  it("surfaces the attention banner with the oldest age when count > 0", () => {
    const html = render({ needsYouCount: 3, oldestNeedsYouAt: Date.now() - 5 * 60_000 });
    expect(html).toContain('data-dh-attention=""');
    expect(html).toMatch(/⚠ 3 need you — oldest 5m/);
  });

  it("omits segments whose data is absent (no placeholder lies)", () => {
    const html = render({ projectName: undefined, branch: null, monthToDateUsd: undefined });
    expect(html).not.toContain("MTD");
    expect(html).not.toContain("⎇");
    expect(html).not.toContain("undefined");
  });
});
