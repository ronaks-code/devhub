import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, buttonVariants } from "./button.js";
import { Badge } from "./badge.js";
import { Textarea } from "./textarea.js";
import { cn } from "../../lib/utils.js";

/**
 * Foundation smoke tests for the shadcn/ui primitive layer. These prove the install
 * is wired (Radix `Slot` + `class-variance-authority` + the `cn` merge) and that the
 * primitives render to static markup in the node test env — the same harness the
 * design-locked M6 slices use. Portal-based primitives (dropdown/dialog/tooltip) are
 * exercised in the app build, not here, since their content renders through a portal.
 */

describe("cn (tailwind-merge + clsx)", () => {
  it("joins truthy classes and drops falsy ones", () => {
    expect(cn("a", false && "b", undefined, "c")).toBe("a c");
  });

  it("de-duplicates conflicting tailwind utilities (last wins)", () => {
    expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
  });
});

describe("Button (shadcn + cva)", () => {
  it("renders a real <button> with the default variant utilities", () => {
    const html = renderToStaticMarkup(createElement(Button, {}, "Go"));
    expect(html).toContain("<button");
    expect(html).toContain('data-slot="button"');
    expect(html).toContain("bg-primary");
    expect(html).toContain(">Go</button>");
  });

  it("merges a caller className after the variant classes", () => {
    const html = renderToStaticMarkup(
      createElement(Button, { variant: "ghost", className: "dh-example" }, "x"),
    );
    expect(html).toContain("dh-example");
    expect(html).toContain("hover:bg-accent");
  });

  it("passes through native button props (type, disabled, name)", () => {
    const html = renderToStaticMarkup(
      createElement(Button, { type: "submit", disabled: true, name: "go" }, "x"),
    );
    expect(html).toContain('type="submit"');
    expect(html).toContain("disabled");
    expect(html).toContain('name="go"');
  });

  it("renders the child element when asChild is set (Radix Slot)", () => {
    const html = renderToStaticMarkup(
      createElement(Button, { asChild: true }, createElement("a", { href: "/x" }, "link")),
    );
    expect(html).toContain("<a");
    expect(html).toContain('href="/x"');
    expect(html).not.toContain("<button");
  });

  it("buttonVariants is a pure class-string builder", () => {
    expect(buttonVariants({ variant: "outline", size: "sm" })).toContain("border-input");
    expect(buttonVariants({ variant: "outline", size: "sm" })).toContain("h-8");
  });
});

describe("Badge / Textarea", () => {
  it("Badge renders a span carrying its variant + data-slot", () => {
    const html = renderToStaticMarkup(createElement(Badge, { variant: "secondary" }, "beta"));
    expect(html).toContain("<span");
    expect(html).toContain('data-slot="badge"');
    expect(html).toContain("bg-secondary");
    expect(html).toContain(">beta</span>");
  });

  it("Textarea renders a real <textarea> and forwards id/className", () => {
    const html = renderToStaticMarkup(
      createElement(Textarea, { id: "note", className: "extra" }),
    );
    expect(html).toContain("<textarea");
    expect(html).toContain('id="note"');
    expect(html).toContain('data-slot="textarea"');
    expect(html).toContain("extra");
  });
});
