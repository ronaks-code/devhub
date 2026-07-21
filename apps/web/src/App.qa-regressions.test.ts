import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isShortcutHelpKey, resolveInitialUiState } from "./App";

const appSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "App.tsx"),
  "utf8",
);

describe("QA app-shell regressions", () => {
  it("honors an entry URL over persisted UI state, including a session", () => {
    expect(resolveInitialUiState(
      { tab: "home", projectId: "saved-project" },
      { tab: "settings", session: "linked-session" },
    )).toEqual({
      tab: "settings",
      projectId: "saved-project",
      sessionId: "linked-session",
    });
  });

  it("keeps persisted navigation when the entry URL has no route", () => {
    expect(resolveInitialUiState({ tab: "dashboard", projectId: "saved" }, {})).toEqual({
      tab: "dashboard",
      projectId: "saved",
      sessionId: null,
    });
  });

  it("mounts Commands whenever its button or shortcut opens it", () => {
    expect(appSource).toContain('{commandOpen ? (');
    expect(appSource).not.toContain('searchCommandsMode === "devhub" && commandOpen');
  });

  it("gives the two new-chat destinations distinct provider labels", () => {
    expect(appSource).toContain('"New Claude Chat"');
    expect(appSource).toContain('"New OpenAI Chat"');
  });

  it("accepts both browser representations of the question-mark shortcut", () => {
    const base = { metaKey: false, ctrlKey: false, altKey: false };
    expect(isShortcutHelpKey({ ...base, key: "?", code: "Slash", shiftKey: true })).toBe(true);
    expect(isShortcutHelpKey({ ...base, key: "/", code: "Slash", shiftKey: true })).toBe(true);
    expect(isShortcutHelpKey({ ...base, key: "/", code: "Slash", shiftKey: false })).toBe(false);
  });

  it("keeps the native OpenAI/Codex panes reachable from the devhub TaskRail", () => {
    // Regression: the TaskRail destination model once dropped `openai-chat` and
    // `codex-history`, making the native Codex routes URL-only. Both must stay in
    // the rail model (the legacy rail lists them under its "OpenAI" section).
    const start = appSource.indexOf("const taskRailModel");
    expect(start).toBeGreaterThan(-1);
    const railModel = appSource.slice(
      start,
      appSource.indexOf("resolveTaskHeaderSetupMode(", start),
    );
    expect(railModel).toContain('id: "openai-chat"');
    expect(railModel).toContain('id: "codex-history"');
    expect(railModel).toContain('tab === "openai-chat"');
    expect(railModel).toContain('tab === "codex-history"');
  });

  it("mounts the search/command dialogs inside a centered backdrop overlay", () => {
    // Regression: both dialogs rendered in normal flow (a clipped bottom-left
    // sheet with no scrim). Each must mount inside the modal overlay wrapper.
    const overlays = appSource.split('className="dh-dialog-overlay"').length - 1;
    expect(overlays).toBeGreaterThanOrEqual(2);
  });
});
