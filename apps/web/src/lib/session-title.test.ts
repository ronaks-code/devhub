import { describe, expect, it } from "vitest";
import {
  displayCodexSessionTitle,
  displaySearchHitTitle,
  displaySessionTitle,
} from "./session-title.js";

describe("displaySessionTitle", () => {
  it.each([
    ["custom title", { title: "Release audit", titleSource: "custom", cwd: "/repo/devhub", sessionId: "id" }, "Release audit"],
    ["first prompt", { title: "Fix navigation", titleSource: "first-prompt", cwd: "/repo/devhub", sessionId: "id" }, "Fix navigation"],
    ["cwd over session-id title", { title: "2b7ef4eb251a", titleSource: "session-id", cwd: "/repo/mission-studio/", sessionId: "id" }, "mission-studio"],
    ["raw title without cwd", { title: "2b7ef4eb251a", titleSource: "session-id", cwd: null, sessionId: "id" }, "2b7ef4eb251a"],
    ["session id as final fallback", { title: "", titleSource: "session-id", cwd: null, sessionId: "id" }, "id"],
  ] as const)("uses the %s fallback", (_label, session, expected) => {
    expect(displaySessionTitle(session)).toBe(expected);
  });

  it("uses a known project name before cwd or raw identity", () => {
    expect(displaySessionTitle({
      title: "2b7ef4eb251a",
      titleSource: "session-id",
      cwd: null,
      sessionId: "session-id",
    }, "Mission Studio")).toBe("Mission Studio");
  });
});

describe("displayCodexSessionTitle", () => {
  it("uses the cwd project name when available", () => {
    expect(displayCodexSessionTitle({ cwd: "/repo/devhub/", id: "codex-id" })).toBe("devhub");
  });

  it("uses the session id when cwd is missing", () => {
    expect(displayCodexSessionTitle({ cwd: null, id: "codex-id" })).toBe("codex-id");
  });
});

describe("displaySearchHitTitle", () => {
  const hit = {
    sessionId: "2b7ef4eb251a-full-session-id",
    title: "Useful title",
    projectName: "DevHub",
    cwd: "/repo/devhub",
  };

  it("uses the project name for the full session id or exact eight-character engine fallback", () => {
    expect(displaySearchHitTitle({ ...hit, title: hit.sessionId })).toBe("DevHub");
    expect(displaySearchHitTitle({ ...hit, title: "2b7ef4eb" })).toBe("DevHub");
  });

  it("preserves a custom title that happens to be a shorter session-id prefix", () => {
    expect(displaySearchHitTitle({ ...hit, title: "2b7e" })).toBe("2b7e");
  });

  it("uses cwd when the authoritative identity fallback has no project name", () => {
    expect(displaySearchHitTitle({ ...hit, title: hit.sessionId, projectName: "" })).toBe("devhub");
  });

  it("falls back to the raw identity when no human project data exists", () => {
    expect(displaySearchHitTitle({
      ...hit,
      title: "2b7ef4eb",
      projectName: "",
      cwd: null,
    })).toBe("2b7ef4eb");
  });

  it("preserves arbitrary hex-looking human titles", () => {
    expect(displaySearchHitTitle({ ...hit, title: "deadbeef release audit" }))
      .toBe("deadbeef release audit");
  });
});
