import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROUTE_TABS } from "./lib/router.js";

/**
 * M8-PRESERVATION-MATRIX: cheap automated guard for the M0 surface-inventory route
 * table (`.planning/devhub-codex-parity/surface-inventory.md` section 3, `RT-01`..
 * `RT-09`). `ROUTE_TABS` is the URL-addressable contract (`?tab=...`); this proves
 * `App.tsx`'s tab switch still has a real mount branch for every one of them, so a
 * future edit can never silently drop a preserved route's `tab === "<value>"`
 * dispatch without failing a test — without paying for a full `<App/>` DOM mount
 * (which would need the whole fetch/WebSocket surface mocked). Source-static, not a
 * render: it reads `App.tsx` as text and checks the exact comparison literal exists.
 */
const APP_TSX_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "App.tsx",
);
const appSource = readFileSync(APP_TSX_PATH, "utf8");

// `chat` intentionally has no explicit `tab === "chat"` mount check in App.tsx: it is
// the terminal `else` branch of the tab switch (see the `claudeShellMode === "native"
// ? ... : devhubClaudePane ?? legacyClaudePane` tail), which is why RT-03 stays
// reachable without a redundant literal comparison.
const IMPLICIT_ELSE_TABS = new Set(["chat"]);

describe("M8 preservation matrix — every advertised route still mounts (RT-01..RT-09 + spatial)", () => {
  it("ROUTE_TABS (the URL contract) has exactly the 9 surface-inventory routes plus `spatial`", () => {
    // `spatial` is the post-M8 addition (the "office game" visualizer). The other
    // nine are the frozen M0 surface-inventory routes (RT-01..RT-09); keep this set
    // exact so dropping/renaming any of them still fails loudly.
    expect(new Set(ROUTE_TABS)).toEqual(
      new Set([
        "home",
        "browse",
        "chat",
        "ops",
        "inbox",
        "dashboard",
        "spatial",
        "settings",
        "openai-chat",
        "codex-history",
      ]),
    );
  });

  it.each(ROUTE_TABS.filter((t) => !IMPLICIT_ELSE_TABS.has(t)))(
    "App.tsx's tab switch still has a `tab === \"%s\"` mount branch",
    (tabValue) => {
      expect(appSource).toContain(`tab === "${tabValue}"`);
    },
  );

  it("the chat tab's implicit else-branch dispatch (native/devhub/legacy Claude pane) is still present", () => {
    expect(appSource).toContain('claudeShellMode === "native"');
    expect(appSource).toContain("devhubClaudePane ?? legacyClaudePane");
  });

  it("App.tsx's own `Tab` union type has not drifted from the router's `ROUTE_TABS` contract", () => {
    const match = appSource.match(/type Tab = ([^;]+);/);
    expect(match).not.toBeNull();
    const literalTab = match![1];
    for (const tabValue of ROUTE_TABS) {
      expect(literalTab).toContain(`"${tabValue}"`);
    }
  });
});
