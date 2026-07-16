import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * M8-PERF-A11Y: axe-core's `aria-input-field-name` rule flagged the Browse
 * columns' `role="listbox"` containers (both from the shared
 * `useListKeyboardNav` hook, which sets `role: "listbox"` but has no way to
 * carry a label) with no accessible name — a screen reader announced only
 * "listbox" with no indication of which list (Projects vs Sessions). Cheap,
 * source-static (no full `<ProjectsPane/>`/`<SessionsPane/>` DOM mount — both
 * pull in the whole session/project data + callback surface with no existing
 * render harness, same "not cheap" call as the M8 preservation-matrix task):
 * asserts each file's `{...nav.containerProps}` spread is followed by a
 * literal `aria-label` so a future edit can't silently drop it.
 */
describe("Browse listbox containers carry an aria-label (M8-PERF-A11Y)", () => {
  function read(relPath: string): string {
    return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");
  }

  it("ProjectsPane's listbox is labeled \"Projects\"", () => {
    const src = read("./ProjectsPane.tsx");
    const spreadIdx = src.indexOf("{...nav.containerProps}");
    expect(spreadIdx).toBeGreaterThan(-1);
    const after = src.slice(spreadIdx, spreadIdx + 200);
    expect(after).toMatch(/aria-label="Projects"/);
  });

  it("SessionsPane's listbox is labeled \"Sessions\"", () => {
    const src = read("./SessionsPane.tsx");
    const spreadIdx = src.indexOf("{...nav.containerProps}");
    expect(spreadIdx).toBeGreaterThan(-1);
    const after = src.slice(spreadIdx, spreadIdx + 200);
    expect(after).toMatch(/aria-label="Sessions"/);
  });
});
