import { describe, it, expect } from "vitest";
import {
  buildDiffContent,
  buildEnvironmentSummary,
  buildFilesContent,
  buildTaskRailSections,
  legacyDestinationForTarget,
  LEGACY_SESSION_PROVIDER,
  mapMessagesToThreadItems,
  searchHitToResult,
} from "./m6-compose.js";
import {
  navigationTargetForResult,
  providerFromTaskKey,
  resultProviderLabel,
} from "../components/features/search/TaskSearchDialog.js";
import type { ContentBlock, GitStatus, NormalizedMessage, SearchHitWithSeq, SessionSummary } from "./types.js";

function message(role: NormalizedMessage["role"], blocks: ContentBlock[], seq = 0): NormalizedMessage {
  return { seq, uuid: `u${seq}`, parentUuid: null, role, type: role, timestamp: null, blocks };
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "s1",
    filePath: "/tmp/s1.jsonl",
    cwd: "/repo",
    projectId: "p1",
    title: "Fix the thing",
    titleSource: "derived",
    firstTimestamp: "2026-07-01T00:00:00Z",
    lastTimestamp: "2026-07-01T00:00:00Z",
    messageCount: 4,
    usage: { inputTokens: 0, outputTokens: 0 },
    sizeBytes: 100,
    mtimeMs: 1,
    hasSubagents: false,
    ...overrides,
  } as SessionSummary;
}

describe("buildTaskRailSections", () => {
  it("returns no sections for an empty session list", () => {
    expect(buildTaskRailSections([], "Sessions")).toEqual([]);
  });

  it("maps every session to a real, provider-tagged task row", () => {
    const sections = buildTaskRailSections(
      [session({ sessionId: "a", title: "Older", lastTimestamp: "2026-07-01T00:00:00Z" }),
       session({ sessionId: "b", title: "Newer", lastTimestamp: "2026-07-02T00:00:00Z" })],
      "Sessions",
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]!.label).toBe("Sessions");
    // Most-recent first.
    expect(sections[0]!.tasks.map((t) => t.id)).toEqual(["b", "a"]);
    for (const t of sections[0]!.tasks) {
      expect(t.provider).toBe(LEGACY_SESSION_PROVIDER);
    }
  });

  it("uses human titles, then the known project name before cwd or raw identity", () => {
    const sections = buildTaskRailSections([
      session({ sessionId: "custom", title: "Release audit", titleSource: "custom", cwd: "/repo/devhub" }),
      session({ sessionId: "hashed", title: "2b7ef4eb251a", titleSource: "session-id", cwd: "/repo/mission-studio" }),
      session({ sessionId: "empty", title: "", titleSource: "first-prompt", cwd: "/repo/capture/" }),
      session({ sessionId: "raw-only", title: "", titleSource: "session-id", cwd: null }),
    ], "DevHub");
    expect(sections[0]!.tasks.map((task) => task.title)).toEqual([
      "Release audit",
      "DevHub",
      "DevHub",
      "DevHub",
    ]);
  });

  it("caps the row count so the rail never renders an unbounded list", () => {
    const many = Array.from({ length: 5 }, (_, i) => session({ sessionId: `s${i}` }));
    const sections = buildTaskRailSections(many, "Sessions", 3);
    expect(sections[0]!.tasks).toHaveLength(3);
  });
});

describe("searchHitToResult / legacyDestinationForTarget round-trip", () => {
  const hit: SearchHitWithSeq = {
    sessionId: "sess-9",
    projectId: "proj-9",
    projectName: "My Project",
    title: "Session title",
    cwd: "/repo",
    role: "assistant",
    snippet: "hello [world]",
    timestamp: "2026-07-01T00:00:00Z",
    seq: 12,
  };

  it("derives an honest anthropic-provider composite key", () => {
    const result = searchHitToResult(hit);
    expect(providerFromTaskKey(result.taskKey)).toBe("anthropic");
    expect(resultProviderLabel(result)).toBe("Claude");
    expect(result.degraded).toBe(false);
    expect(result.title).toBe("Session title");
    expect(result.snippet).toBe("hello [world]");
  });

  it("replaces only an authoritative session-id fallback with the project name", () => {
    expect(searchHitToResult({
      ...hit,
      sessionId: "2b7ef4eb251a-full-session-id",
      title: "2b7ef4eb",
      projectName: "DevHub",
    }).title).toBe("DevHub");
  });

  it("preserves a hex-looking human title that is not the session id or its prefix", () => {
    expect(searchHitToResult({
      ...hit,
      sessionId: "different-session-id",
      title: "deadbeef release audit",
      projectName: "DevHub",
    }).title).toBe("deadbeef release audit");
  });

  it("round-trips back to the legacy (projectId, sessionId, seq) destination", () => {
    const result = searchHitToResult(hit);
    const target = navigationTargetForResult(result);
    const dest = legacyDestinationForTarget(target);
    expect(dest).toEqual({ projectId: "proj-9", sessionId: "sess-9", seq: 12 });
  });

  it("omits seq when the navigation target carries none", () => {
    const result = searchHitToResult({ ...hit, seq: undefined });
    const target = navigationTargetForResult(result);
    expect(legacyDestinationForTarget(target).seq).toBeUndefined();
  });
});

describe("buildEnvironmentSummary", () => {
  const gitStatus: GitStatus = {
    branch: "main",
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
  };

  it("omits every row when there is no backing data", () => {
    expect(buildEnvironmentSummary(null, [])).toEqual({});
  });

  it("includes only the branch when there are no file changes", () => {
    expect(buildEnvironmentSummary(gitStatus, [])).toEqual({ branch: "main" });
  });

  it("includes a real change summary derived from the transcript's own file changes", () => {
    const env = buildEnvironmentSummary(gitStatus, [
      { filePath: "a.ts", added: 3, removed: 1 },
      { filePath: "b.ts", added: 0, removed: 2 },
    ]);
    expect(env.branch).toBe("main");
    expect(env.changes).toBe("2 files · +3 -3");
  });

  it("singularizes a one-file change summary", () => {
    const env = buildEnvironmentSummary(null, [{ filePath: "a.ts", added: 1, removed: 0 }]);
    expect(env.changes).toBe("1 file · +1 -0");
  });
});

describe("buildDiffContent / buildFilesContent", () => {
  it("carries every changed file path into both the diff and files content", () => {
    const changes = [
      { filePath: "a.ts", added: 3, removed: 1 },
      { filePath: "b.ts", added: 0, removed: 2 },
    ];
    expect(buildDiffContent(changes)).toEqual({
      files: ["a.ts", "b.ts"],
      summary: "2 files · +3 -3",
    });
    expect(buildFilesContent(changes)).toEqual([{ path: "a.ts" }, { path: "b.ts" }]);
  });

  it("has no summary and empty file lists when there are no changes", () => {
    expect(buildDiffContent([])).toEqual({ files: [], summary: undefined });
    expect(buildFilesContent([])).toEqual([]);
  });
});

describe("mapMessagesToThreadItems", () => {
  it("maps plain user/assistant text to the matching ThreadItem kind", () => {
    const items = mapMessagesToThreadItems([
      message("user", [{ type: "text", text: "hello" }], 0),
      message("assistant", [{ type: "text", text: "hi there" }], 1),
    ]);
    expect(items).toEqual([
      { kind: "user", id: "u0-text", content: "hello" },
      { kind: "assistant", id: "u1-text", content: "hi there" },
    ]);
  });

  it("drops an empty-text message silently (nothing to show is honest, not a bug)", () => {
    expect(mapMessagesToThreadItems([message("user", [{ type: "text", text: "   " }], 0)])).toEqual([]);
  });

  it("never fabricates a tool card: a tool_use block becomes a bounded raw diagnostic", () => {
    const items = mapMessagesToThreadItems([
      message("assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], 0),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("raw");
    if (items[0]!.kind === "raw") {
      expect(items[0]!.raw).toContain("assistant:tool_use");
      expect(items[0]!.raw).toContain("Bash");
    }
  });

  it("routes a non-user/assistant role's text through the raw diagnostic, never as prose", () => {
    const items = mapMessagesToThreadItems([message("system", [{ type: "text", text: "hook fired" }], 0)]);
    expect(items).toEqual([{ kind: "raw", id: "u0-text", raw: "[system] hook fired" }]);
  });

  it("keeps both the text and a raw diagnostic when a message mixes prose with a tool block", () => {
    const items = mapMessagesToThreadItems([
      message(
        "assistant",
        [
          { type: "text", text: "running a command" },
          { type: "tool_use", id: "t1", name: "Bash", input: {} },
        ],
        0,
      ),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ kind: "assistant", id: "u0-text", content: "running a command" });
    expect(items[1]!.kind).toBe("raw");
  });
});
