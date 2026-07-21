// @vitest-environment jsdom
//
// P0 regression: the "Default agent mechanics" choice must save reliably.
//
// The old editor kept a mutable dirty-key Set that `mergeAuthoritativeSettings`
// pruned whenever a background settings refetch's value coincided with the local
// one — so a refetch racing the user's edit could drop `defaultMechanics` from
// the PUT body (or leave nothing to PUT at all) while the UI still said "Saved".
// The editor now keeps unsaved edits in a separate overlay that only a successful
// save clears. These tests pin that contract end-to-end against a fake server:
// toggle → save → the PUT body carries defaultMechanics → a remount (reload)
// reads the persisted value back.
import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../../lib/api.js";
import { SettingsRoute } from "./SettingsRoute.js";

const FEATURES = {
  nativeCodex: false,
  persistentClaude: false,
  unifiedTaskIndex: false,
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
} as const;

function baseSettings(): AppSettings {
  return {
    defaultModel: "claude-sonnet-4-6",
    defaultMechanics: "claude",
    defaultPermissionMode: "default",
    theme: "dark",
    density: "comfortable",
    monthlyBudgetUsd: null,
    devHubFeatures: { ...FEATURES },
    requestedDevHubFeatures: { ...FEATURES },
  };
}

class FakeEventSource {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(_url: string) {}
  close() {}
}

/** In-memory /api/settings server: GET returns the store, PUT merges + records the body. */
let store: AppSettings;
let putBodies: Array<Partial<AppSettings>>;

function stubSettingsServer() {
  store = baseSettings();
  putBodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      if (url.includes("/api/settings")) {
        if ((init?.method ?? "GET") === "PUT") {
          const body = JSON.parse(init?.body ?? "{}") as Partial<AppSettings>;
          putBodies.push(body);
          store = { ...store, ...body, requestedDevHubFeatures: body.devHubFeatures ?? store.requestedDevHubFeatures };
          return new Response(JSON.stringify(store), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify(store), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Preserved maintenance widgets probe other routes on mount; they treat a
      // 404 as "not available on this server" and hide themselves.
      return new Response("{}", { status: 404, statusText: "Not Found" });
    }),
  );
}

describe("SettingsRoute — default mechanics saves reliably (P0)", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    stubSettingsServer();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("toggle → save: the PUT body includes defaultMechanics, and it persists across a reload", async () => {
    const user = userEvent.setup();
    const first = render(createElement(SettingsRoute, {}));

    // Loads from the server (no authoritative snapshot passed).
    const codex = await screen.findByRole("radio", { name: "Codex" });
    expect(codex).toHaveAttribute("aria-checked", "false");

    await user.click(codex);
    expect(codex).toHaveAttribute("aria-checked", "true");
    // The sticky save bar reports the real dirty state.
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toMatchObject({ defaultMechanics: "codex" });
    expect(store.defaultMechanics).toBe("codex");

    // The dirty indicator clears and the saved confirmation shows.
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument());
    expect(await screen.findByText("Saved")).toBeInTheDocument();

    // "Reload": a fresh mount re-reads the server and shows the persisted value.
    first.unmount();
    render(createElement(SettingsRoute, {}));
    const reloaded = await screen.findByRole("radio", { name: "Codex" });
    await waitFor(() => expect(reloaded).toHaveAttribute("aria-checked", "true"));
  });

  it("a background authoritative refetch mid-edit cannot drop the mechanics change from the save", async () => {
    const user = userEvent.setup();
    const view = render(createElement(SettingsRoute, { authoritativeSettings: baseSettings() }));

    const codex = await screen.findByRole("radio", { name: "Codex" });
    await user.click(codex);
    expect(codex).toHaveAttribute("aria-checked", "true");

    // The App shell's periodic refetch lands while the edit is unsaved — with a
    // stale snapshot still carrying "claude". The edit must survive both the
    // value and the dirtiness.
    view.rerender(createElement(SettingsRoute, { authoritativeSettings: baseSettings() }));
    expect(screen.getByRole("radio", { name: "Codex" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    // And a refetch whose value COINCIDES with the local edit must not silently
    // swallow the dirty key either (the old dirty-set pruning bug): the user has
    // still not saved, so Save must still send the field.
    const coinciding = { ...baseSettings(), defaultMechanics: "codex" as const };
    view.rerender(createElement(SettingsRoute, { authoritativeSettings: coinciding }));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toMatchObject({ defaultMechanics: "codex" });
  });

  it("saves every dirty field together, not just the last one touched", async () => {
    const user = userEvent.setup();
    render(createElement(SettingsRoute, { authoritativeSettings: baseSettings() }));

    await user.click(await screen.findByRole("radio", { name: "Codex" }));
    await user.selectOptions(screen.getByLabelText("Theme"), "light");

    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toMatchObject({ defaultMechanics: "codex", theme: "light" });
  });
});
