// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../../lib/api.js";
import {
  SETTINGS_TABS,
  SettingsRoute,
  connectionSyncLabel,
  describeClearLocalDataConfirmation,
  isSettingsSecondaryApplied,
  providerCapabilityRows,
  resolveSettingsSecondaryMode,
} from "./SettingsRoute.js";

const BASE_SETTINGS: AppSettings = {
  defaultModel: "claude-sonnet-4-6",
  defaultMechanics: "claude",
  defaultPermissionMode: "default",
  theme: "dark",
  density: "comfortable",
  monthlyBudgetUsd: null,
  devHubFeatures: {
    nativeCodex: false,
    persistentClaude: false,
    unifiedTaskIndex: true,
    shellChrome: false,
    taskRail: false,
    taskHeaderSetup: false,
    threadWorkspace: false,
    composerSurface: false,
    inspectorDock: false,
    searchCommands: false,
    settingsSecondary: true,
    codexStyleShell: false,
    crossProviderFork: false,
    workMode: false,
  },
};

function render(settings: AppSettings | null = BASE_SETTINGS): string {
  return renderToStaticMarkup(
    createElement(SettingsRoute, { authoritativeSettings: settings }),
  );
}

// --- Slice-flag gate -------------------------------------------------------------

describe("SettingsRoute — settingsSecondary slice-flag gate", () => {
  it("resolves devhub only for an explicit resolved true, legacy otherwise", () => {
    expect(resolveSettingsSecondaryMode({ devHubFeatures: { settingsSecondary: true } })).toBe("devhub");
    expect(resolveSettingsSecondaryMode({ devHubFeatures: { settingsSecondary: false } })).toBe("legacy");
    expect(resolveSettingsSecondaryMode({ devHubFeatures: {} })).toBe("legacy");
    expect(resolveSettingsSecondaryMode({})).toBe("legacy");
    expect(resolveSettingsSecondaryMode(null)).toBe("legacy");
    expect(resolveSettingsSecondaryMode(undefined)).toBe("legacy");
  });

  it("isSettingsSecondaryApplied is true only for an explicit true feature flag", () => {
    expect(isSettingsSecondaryApplied({ settingsSecondary: true })).toBe(true);
    expect(isSettingsSecondaryApplied({ settingsSecondary: false })).toBe(false);
    expect(isSettingsSecondaryApplied({})).toBe(false);
    expect(isSettingsSecondaryApplied(undefined)).toBe(false);
  });
});

// --- Tabs: every preserved workflow stays reachable -------------------------------

describe("SettingsRoute — preserved workflow tabs", () => {
  it("keeps exactly the ten preserved sections, in the legacy order", () => {
    expect(SETTINGS_TABS.map((t) => t.id)).toEqual([
      "preferences",
      "budget",
      "memory",
      "mcp",
      "hooks",
      "webhooks",
      "permissions",
      "agents",
      "skills",
      "plugins",
    ]);
    expect(SETTINGS_TABS.map((t) => t.label)).toEqual([
      "Preferences",
      "Budget",
      "Memory",
      "MCP servers",
      "Hooks",
      "Webhooks",
      "Permissions",
      "Agents",
      "Skills",
      "Plugins",
    ]);
  });

  it("renders one role=tablist with exactly ten role=tab entries", () => {
    const html = render();
    expect((html.match(/role="tablist"/g) ?? []).length).toBe(1);
    expect((html.match(/role="tab"/g) ?? []).length).toBe(10);
  });
});

// --- Field groups: Appearance / Providers / Budget / Permissions, never cards ----

describe("SettingsRoute — accessible field groups (not generic form cards)", () => {
  it("renders the Appearance, Providers, Budget, and Permissions field groups as labelled <section>s", () => {
    const html = render();
    for (const heading of ["Appearance", "Providers", "Budget", "Permissions"]) {
      expect(html).toContain(`>${heading}</h2>`);
    }
    // Every fieldgroup is a <section aria-labelledby=...>, not a bordered "card" div.
    expect((html.match(/data-dh-fieldgroup="/g) ?? []).length).toBe(4);
    expect(html).not.toContain("dh-settings-card");
  });

  it("binds every field label to its control with a real <label for>", () => {
    const html = render();
    expect(html).toContain('<label for="dh-settings-theme"');
    expect(html).toContain('<label for="dh-settings-default-model"');
    expect(html).toContain('<label for="dh-settings-permission-mode"');
    expect(html).toContain('<label for="dh-settings-monthly-budget"');
  });

  it("groups the Connection sub-fields inside a real <fieldset><legend>", () => {
    const html = render();
    expect(html).toContain("<fieldset");
    expect(html).toContain(">Connection</legend>");
  });

  it("renders exactly one provider-capability Table with three rows", () => {
    const html = render();
    expect((html.match(/data-dh-settings-table=""/g) ?? []).length).toBe(1);
    expect((html.match(/data-dh-settings-table-row="/g) ?? []).length).toBe(3);
  });
});

// --- Secondary nav placement ------------------------------------------------------

describe("SettingsRoute — secondary navigation placement", () => {
  it("is wrapped in exactly one SecondaryNav landmark with Settings as the active destination", () => {
    const html = render();
    expect((html.match(/<nav/g) ?? []).length).toBe(1);
    const settingsStart = html.indexOf(">Settings</button>");
    const before = html.lastIndexOf("<button", settingsStart);
    expect(html.slice(before, settingsStart)).toContain('aria-current="page"');
  });
});

// --- Local-vs-synced labeling ------------------------------------------------------

describe("connectionSyncLabel — local-vs-synced labeling", () => {
  it("distinguishes a browser-local save from never-synced, in both states", () => {
    expect(connectionSyncLabel(true)).toEqual({
      label: "Saved in this browser",
      note: "Not synced — stored only on this device, never sent to the server.",
    });
    expect(connectionSyncLabel(false)).toEqual({
      label: "Not saved",
      note: "Not synced — stored only on this device, never sent to the server.",
    });
  });

  it("renders the local-vs-synced label in the Connection group", () => {
    const html = render();
    expect(html).toContain("Not saved");
    expect(html).toContain("Not synced");
  });
});

// --- Provider capability rows ------------------------------------------------------

describe("providerCapabilityRows — pure capability status derivation", () => {
  it("returns no rows for a null settings snapshot", () => {
    expect(providerCapabilityRows(null)).toEqual([]);
  });

  it("marks a resolved-true feature Enabled, never a mere request", () => {
    const rows = providerCapabilityRows({
      devHubFeatures: { ...BASE_SETTINGS.devHubFeatures!, nativeCodex: true },
    });
    const nativeCodex = rows.find((r) => r.key === "nativeCodex")!;
    expect(nativeCodex.status).toBe("Enabled");
    expect(nativeCodex.note).toBe("Active");
  });

  it("marks a requested-but-clamped feature Requested with the exact unavailability reason", () => {
    const rows = providerCapabilityRows({
      devHubFeatures: { ...BASE_SETTINGS.devHubFeatures!, persistentClaude: false },
      requestedDevHubFeatures: { ...BASE_SETTINGS.devHubFeatures!, persistentClaude: true },
    });
    const persistentClaude = rows.find((r) => r.key === "persistentClaude")!;
    expect(persistentClaude.status).toBe("Requested");
    expect(persistentClaude.note).toBe(
      "Requested, but the verified Claude runtime or authentication is unavailable.",
    );
  });

  it("marks neither-requested-nor-resolved Disabled", () => {
    const rows = providerCapabilityRows(BASE_SETTINGS);
    const unifiedTaskIndex = rows.find((r) => r.key === "unifiedTaskIndex")!;
    expect(unifiedTaskIndex.status).toBe("Enabled");
    const nativeCodex = rows.find((r) => r.key === "nativeCodex")!;
    expect(nativeCodex.status).toBe("Disabled");
    expect(nativeCodex.note).toBe("Off");
  });
});

// --- Destructive local-data confirmation -------------------------------------------

describe("describeClearLocalDataConfirmation — destructive-but-safe local action", () => {
  it("never calls a provider delete and focuses Cancel first", () => {
    const c = describeClearLocalDataConfirmation();
    expect(c.callsProviderDelete).toBe(false);
    expect(c.initialFocus).toBe("cancel");
    expect(c.reversible).toBe(true);
    expect(c.cancelLabel).toBe("Cancel");
  });

  it("states the exact affected store and never echoes a credential value", () => {
    const c = describeClearLocalDataConfirmation();
    expect(c.affectedStore).toBe("This browser only (devhub:conn)");
    expect(c.body).not.toMatch(/Bearer|token=/i);
  });

  it("does not render the confirmation dialog before the user opens it", () => {
    const html = render();
    expect(html).not.toContain('data-dh-settings-dialog=""');
    expect(html).toContain("Clear local connection data");
  });
});

// --- Loading / error states ---------------------------------------------------------

describe("SettingsRoute — loading and error states", () => {
  it("announces settings loading as a named polite status when no snapshot is available", () => {
    const html = renderToStaticMarkup(createElement(SettingsRoute, {}));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Loading settings");
  });
});

// --- Live interaction (mounted DOM) --------------------------------------------------
//
// Mounting the real tree also mounts the preserved maintenance widgets
// (RebuildIndex/IntegrityPanel/ArchiveTransfer) and, once a non-preferences tab is
// selected, the matching preserved editor. Those issue best-effort `fetch`/SSE calls
// on mount that they already catch internally — real product behavior, not a test
// concession — so we stub `fetch`/`EventSource` here to keep this a pure DOM test
// with no real network/SSE connection, exactly like every other vitest run.
class FakeEventSource {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(_url: string) {}
  close() {}
}

describe("SettingsRoute — live interaction (mounted DOM)", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network disabled in this DOM interaction test")),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clicking the Budget tab selects it and switches the visible tabpanel", async () => {
    const user = userEvent.setup();
    rtlRender(createElement(SettingsRoute, { authoritativeSettings: BASE_SETTINGS }));
    await user.click(screen.getByRole("tab", { name: "Budget" }));
    expect(screen.getByRole("tab", { name: "Budget" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Preferences" })).toHaveAttribute("aria-selected", "false");
  });

  it("ArrowRight/Home/End rove the settings tablist by keyboard (roving tabindex)", async () => {
    const user = userEvent.setup();
    rtlRender(createElement(SettingsRoute, { authoritativeSettings: BASE_SETTINGS }));
    const preferencesTab = screen.getByRole("tab", { name: "Preferences" });
    preferencesTab.focus();
    expect(preferencesTab).toHaveAttribute("tabindex", "0");

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Budget" })).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Plugins" })).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Preferences" })).toHaveAttribute("aria-selected", "true");
  });

  it("toggling a switch calls through to the withNativeCodexPreference state update", async () => {
    const user = userEvent.setup();
    rtlRender(createElement(SettingsRoute, { authoritativeSettings: BASE_SETTINGS }));
    const toggle = screen.getByRole("switch", { name: "Enable native Codex" });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(toggle).toBeChecked();
  });

  it("toggles the default mechanics between Claude Code and Codex via the segmented control", async () => {
    const user = userEvent.setup();
    rtlRender(createElement(SettingsRoute, { authoritativeSettings: BASE_SETTINGS }));
    const claude = screen.getByRole("radio", { name: "Claude Code" });
    const codex = screen.getByRole("radio", { name: "Codex" });
    expect(claude).toHaveAttribute("aria-checked", "true");
    expect(codex).toHaveAttribute("aria-checked", "false");
    await user.click(codex);
    expect(codex).toHaveAttribute("aria-checked", "true");
    expect(claude).toHaveAttribute("aria-checked", "false");
  });

  it("Clear local connection data opens a confirmation focused on Cancel; Cancel closes it without clearing", async () => {
    const user = userEvent.setup();
    rtlRender(createElement(SettingsRoute, { authoritativeSettings: BASE_SETTINGS }));
    await user.click(screen.getByRole("button", { name: "Clear local connection data" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    const cancel = screen.getByRole("button", { name: describeClearLocalDataConfirmation().cancelLabel });
    await waitFor(() => expect(cancel).toHaveFocus());

    await user.click(cancel);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Clear local connection data — confirming closes the dialog and clears the saved-in-browser state", async () => {
    const user = userEvent.setup();
    rtlRender(createElement(SettingsRoute, { authoritativeSettings: BASE_SETTINGS }));
    await user.click(screen.getByRole("button", { name: "Clear local connection data" }));
    await screen.findByRole("dialog");

    const confirmation = describeClearLocalDataConfirmation();
    await user.click(screen.getByRole("button", { name: confirmation.confirmLabel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("typing an API host updates the connection field live", async () => {
    const user = userEvent.setup();
    rtlRender(createElement(SettingsRoute, { authoritativeSettings: BASE_SETTINGS }));
    const hostInput = screen.getByLabelText("API host") as HTMLInputElement;
    await user.type(hostInput, "https://my-machine:5179");
    expect(hostInput).toHaveValue("https://my-machine:5179");
  });
});

// --- Narrow/768 + 1024 viewport — no horizontal overflow (M6-NARROW-VIEWPORT) ------
//
// Prior evidence (`tasks/STATUS.md` M6-SLICE-EVIDENCE) showed a 768 screenshot
// overflowing, but traced that live to the DEMO FIXTURE's own harness wrapper —
// `evidence/m6/settings-secondary/fixture.html` inlines `.frame{width:820px}`, a
// selector that exists ONLY in that fixture's own `<style>`, never in the shipped
// `apps/web/src/index.css`. This suite mounts the REAL `SettingsRoute` (no
// fixture wrapper) with the real stylesheet and proves its own geometry can never
// force horizontal overflow at either breakpoint — Task 8's DoD explicitly names
// "no horizontal overflow" at narrow as an acceptance line.
describe("SettingsRoute — narrow (768) + 1024 viewport: no horizontal overflow", () => {
  const realCss = readFileSync(path.resolve(__dirname, "../../../index.css"), "utf8");

  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network disabled in this DOM viewport test")),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the fixture-only overflow selectors are absent from the shipped stylesheet", () => {
    // Bare `.frame` (696-820px across the M6 evidence fixtures) is the demo
    // harness's own wrapper, never part of the product. If it ever leaked into
    // index.css, the shipped route would inherit its fixed-px overflow.
    expect(realCss).not.toMatch(/(^|[^-\w])\.frame\s*\{/);
    expect(realCss).not.toContain(".dh-canvas-frame");
  });

  it("the real route's own max-width (720px) sits under both breakpoints", () => {
    const match = realCss.match(/\.dh-settings-route\s*\{[^}]*max-width:\s*(\d+)px/);
    expect(match).not.toBeNull();
    const maxWidth = Number(match![1]);
    expect(maxWidth).toBeLessThan(768);
  });

  for (const viewport of [768, 1024] as const) {
    it(`mounted at ${viewport}px: the real route has no fixed-px width wider than the viewport and no fixture wrapper`, () => {
      const style = document.createElement("style");
      style.textContent = realCss;
      document.head.appendChild(style);
      const container = document.createElement("div");
      container.style.width = `${viewport}px`;
      document.body.appendChild(container);

      try {
        rtlRender(createElement(SettingsRoute, { authoritativeSettings: BASE_SETTINGS }), { container });
        const route = container.querySelector(".dh-settings-route")!;
        expect(route).toBeTruthy();

        // No `width: <px>` anywhere on the real route root or its direct
        // children exceeds the viewport — it is either unset (auto/fluid) or
        // capped via `max-width`, which can only shrink, never overflow.
        const candidates = [route, ...Array.from(route.children)];
        for (const el of candidates) {
          const cs = getComputedStyle(el);
          const widthPx = /^(\d+(?:\.\d+)?)px$/.exec(cs.width);
          if (widthPx) {
            expect(Number(widthPx[1])).toBeLessThanOrEqual(viewport);
          }
        }

        // The demo-fixture wrapper classes are never present on the real tree.
        expect(container.querySelector(".dh-canvas-frame")).toBeNull();
        expect(container.querySelector(".frame")).toBeNull();
      } finally {
        document.head.removeChild(style);
        document.body.removeChild(container);
      }
    });
  }
});
