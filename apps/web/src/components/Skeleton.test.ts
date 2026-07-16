// @vitest-environment jsdom
import { createElement } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardSkeleton, ListSkeleton, TranscriptSkeleton } from "./Skeleton.js";

/**
 * M8-PERF-A11Y: axe-core's `aria-prohibited-attr` rule flagged
 * `DashboardSkeleton`'s loading container — `aria-label` on a plain `<div>`
 * with no role is not a valid ARIA attribute placement (a div has no implicit
 * role for `aria-label` to name). `TranscriptSkeleton`/`ListSkeleton` share the
 * exact same `aria-busy` + `aria-label`-on-bare-`div` pattern, so they'd fail
 * the identical rule the moment axe covers their surfaces too — fixed all
 * three the same way: `role="status"` (the correct semantic for "a live
 * region announcing loading state"), which makes the existing `aria-label`
 * and `aria-busy` valid and gives assistive tech something to announce.
 */
describe("Skeleton loaders have a valid ARIA role for their aria-label (M8-PERF-A11Y)", () => {
  it("DashboardSkeleton exposes an accessible, named status region", () => {
    const { getByRole } = render(createElement(DashboardSkeleton));
    const status = getByRole("status", { name: "Loading dashboard" });
    expect(status).toHaveAttribute("aria-busy", "true");
  });

  it("TranscriptSkeleton exposes an accessible, named status region", () => {
    const { getByRole } = render(createElement(TranscriptSkeleton));
    const status = getByRole("status", { name: "Loading transcript" });
    expect(status).toHaveAttribute("aria-busy", "true");
  });

  it("ListSkeleton exposes an accessible, named status region", () => {
    const { getByRole } = render(createElement(ListSkeleton));
    const status = getByRole("status", { name: "Loading list" });
    expect(status).toHaveAttribute("aria-busy", "true");
  });
});
