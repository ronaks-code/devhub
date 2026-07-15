import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Alert,
  Button,
  Dialog,
  Field,
  FieldGroup,
  FieldSet,
  Input,
  Progress,
  Select,
  Switch,
  Table,
  TabPanel,
  Tabs,
  fieldDescribedBy,
} from "./settings-ui.js";
import { nextTabIndex } from "../inspectors/InspectorDock.js";

describe("settings-ui primitives — audited hand-rolled shadcn-named set", () => {
  it("Tabs renders one roving-tabstop tablist reusing the shared nextTabIndex math", () => {
    const html = renderToStaticMarkup(
      createElement(Tabs, {
        id: "t",
        label: "Sections",
        tabs: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
        active: "b",
        onSelect: () => {},
      }),
    );
    expect((html.match(/role="tab"/g) ?? []).length).toBe(3);
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(1);
    expect(html).toContain('aria-selected="true"');
    // The roving math itself is the shared InspectorDock helper, not re-derived.
    expect(nextTabIndex("ArrowRight", 1, 3)).toBe(2);
    expect(nextTabIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(nextTabIndex("Home", 2, 3)).toBe(0);
    expect(nextTabIndex("End", 0, 3)).toBe(2);
  });

  it("TabPanel labels itself by the matching tab and stays keyboard-reachable", () => {
    const html = renderToStaticMarkup(
      createElement(TabPanel, { id: "t", tabId: "a" }, createElement("p", null, "body")),
    );
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-labelledby="t-a"');
    expect(html).toContain('tabindex="0"');
  });

  it("FieldGroup is a labelled <section>, never a generic bordered card", () => {
    const html = renderToStaticMarkup(
      createElement(FieldGroup, { id: "g", heading: "Providers" }, createElement("p", null, "x")),
    );
    expect(html).toMatch(/^<section/);
    expect(html).toContain('aria-labelledby="g-heading"');
    expect(html).toContain(">Providers</h2>");
  });

  it("FieldSet renders a real <fieldset><legend>", () => {
    const html = renderToStaticMarkup(createElement(FieldSet, { legend: "Connection" }, createElement("p", null, "x")));
    expect(html).toMatch(/^<fieldset/);
    expect(html).toContain(">Connection</legend>");
  });

  it("Field binds a real <label for> and renders hint/error ids fieldDescribedBy can reference", () => {
    const html = renderToStaticMarkup(
      createElement(Field, { id: "f", label: "Host", hint: "hint text", error: "bad value" }, createElement("input", { id: "f" })),
    );
    expect(html).toContain('<label for="f"');
    expect(html).toContain('id="f-hint"');
    expect(html).toContain('id="f-error"');
    expect(html).toContain('role="alert"');
    expect(fieldDescribedBy("f", { hint: "hint text" })).toBe("f-hint");
    expect(fieldDescribedBy("f", { hint: "hint text", error: "bad" })).toBe("f-hint f-error");
    expect(fieldDescribedBy("f", {})).toBeUndefined();
  });

  it("Select/Input/Switch wire aria-describedby through to the control", () => {
    const select = renderToStaticMarkup(
      createElement(Select, { id: "s", value: "a", options: [{ value: "a", label: "A" }], describedBy: "s-hint", onChange: () => {} }),
    );
    expect(select).toContain('aria-describedby="s-hint"');
    const input = renderToStaticMarkup(
      createElement(Input, { id: "i", value: "v", describedBy: "i-hint", onChange: () => {} }),
    );
    expect(input).toContain('aria-describedby="i-hint"');
    const switchHtml = renderToStaticMarkup(
      createElement(Switch, { id: "sw", label: "Enable", checked: true, describedBy: "sw-hint", onChange: () => {} }),
    );
    expect(switchHtml).toContain('role="switch"');
    expect(switchHtml).toContain('aria-describedby="sw-hint"');
  });

  it("Button never submits by default and Alert/Progress carry the right ARIA roles", () => {
    const button = renderToStaticMarkup(createElement(Button, {}, "Save"));
    expect(button).toContain('type="button"');
    const alert = renderToStaticMarkup(createElement(Alert, {}, "err"));
    expect(alert).toContain('role="alert"');
    const progress = renderToStaticMarkup(createElement(Progress, { label: "Saving" }));
    expect(progress).toContain('role="progressbar"');
    expect(progress).toContain('aria-label="Saving"');
  });

  it("Table renders a real semantic table with a screen-reader caption", () => {
    const html = renderToStaticMarkup(
      createElement(Table, {
        caption: "Provider status",
        columns: ["Feature", "Status"],
        rows: [{ key: "a", cells: ["Native Codex", "Enabled"] }],
      }),
    );
    expect(html).toMatch(/^<table/);
    expect(html).toContain("<caption");
    expect(html).toContain('scope="col"');
    expect(html).toContain('data-dh-settings-table-row="a"');
  });

  it("Dialog renders one aria-modal role=dialog panel labelled by its title", () => {
    const html = renderToStaticMarkup(
      createElement(
        Dialog,
        { titleId: "d-title", title: "Clear local connection data?", footer: createElement("span", null, "footer") },
        createElement("p", null, "body"),
      ),
    );
    expect((html.match(/role="dialog"/g) ?? []).length).toBe(1);
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="d-title"');
    expect(html).toContain(">Clear local connection data?</h2>");
  });
});
