import { describe, it, expect } from "vitest";
import {
  buildChangedFiles,
  buildEnvironmentSummary,
  buildTaskRailSections,
  deriveRunStatus,
  describeRunReason,
  groupSessionsByRunStatus,
  indexRunningBySession,
  legacyDestinationForTarget,
  LEGACY_SESSION_PROVIDER,
  mapMessagesToThreadItems,
  searchHitToResult,
} from "./m6-compose.js";
import type { RunningSession } from "./types.js";
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

function running(overrides: Partial<RunningSession> = {}): RunningSession {
  return { pid: 1, sessionId: "s1", cwd: "/repo", status: "busy", alive: true, ...overrides } as RunningSession;
}

describe("deriveRunStatus (honest run-state join)", () => {
  it("returns undefined when there is no running entry (idle/recent, no dot)", () => {
    expect(deriveRunStatus(undefined)).toBeUndefined();
    expect(deriveRunStatus(null)).toBeUndefined();
  });
  it("maps needsYou → waiting (Needs review) ahead of every other signal", () => {
    expect(deriveRunStatus(running({ needsYou: true, status: "busy", alive: true }))).toBe("waiting");
  });
  it("maps stale / dead / not-alive → failed", () => {
    expect(deriveRunStatus(running({ stale: true }))).toBe("failed");
    expect(deriveRunStatus(running({ status: "dead", alive: false }))).toBe("failed");
    expect(deriveRunStatus(running({ alive: false, status: "busy" }))).toBe("failed");
  });
  it("maps busy/alive → running and a parked waiting status → waiting", () => {
    expect(deriveRunStatus(running({ status: "busy", alive: true }))).toBe("running");
    expect(deriveRunStatus(running({ status: "waiting", alive: true, needsYou: false }))).toBe("running");
    expect(deriveRunStatus(running({ status: "idle", alive: false }))).toBe("failed");
  });
});

describe("describeRunReason (§3.1v2 Needs-you reason line)", () => {
  it("quotes the real waitingFor string when the run reports one", () => {
    const r = running({ status: "waiting", waitingFor: "Bash(git push)", needsYou: true });
    expect(describeRunReason(r, "waiting")).toBe('Asked: "Bash(git push)"');
  });
  it("falls back to the real needsYou / waiting flags", () => {
    expect(describeRunReason(running({ needsYou: true }), "waiting")).toBe("Needs your approval");
    expect(describeRunReason(running({ status: "waiting" }), "waiting")).toBe("Waiting");
  });
  it("describes failed runs from the real alive/stale flags", () => {
    expect(describeRunReason(running({ alive: false, status: "dead" }), "failed")).toBe("Process exited");
    expect(describeRunReason(running({ stale: true }), "failed")).toBe("Stalled — no recent progress");
  });
  it("returns undefined when there is no explainable signal (no fabricated reason)", () => {
    expect(describeRunReason(running({ status: "busy", alive: true }), "running")).toBeUndefined();
  });
});

describe("groupSessionsByRunStatus", () => {
  it("groups by the running join and treats sessions with no entry as idle", () => {
    const a = session({ sessionId: "a", lastTimestamp: "2026-07-03T00:00:00Z" });
    const b = session({ sessionId: "b", lastTimestamp: "2026-07-02T00:00:00Z" });
    const c = session({ sessionId: "c", lastTimestamp: "2026-07-01T00:00:00Z" });
    const groups = groupSessionsByRunStatus(
      [c, a, b],
      [running({ sessionId: "a", status: "busy", alive: true }), running({ sessionId: "b", needsYou: true })],
    );
    expect(groups.running.map((s) => s.sessionId)).toEqual(["a"]);
    expect(groups.needsReview.map((s) => s.sessionId)).toEqual(["b"]);
    expect(groups.idle.map((s) => s.sessionId)).toEqual(["c"]); // no running entry
  });
  it("buckets stale/failed sessions separately from needsReview (W3-COUNTS)", () => {
    const waiting = session({ sessionId: "w" });
    const stale = session({ sessionId: "s" });
    const groups = groupSessionsByRunStatus(
      [waiting, stale],
      [running({ sessionId: "w", needsYou: true }), running({ sessionId: "s", stale: true })],
    );
    expect(groups.needsReview.map((s) => s.sessionId)).toEqual(["w"]);
    expect(groups.stale.map((s) => s.sessionId)).toEqual(["s"]);
  });
  it("sorts most-recent-first within a group and never fabricates status", () => {
    const older = session({ sessionId: "o", lastTimestamp: "2026-07-01T00:00:00Z" });
    const newer = session({ sessionId: "n", lastTimestamp: "2026-07-09T00:00:00Z" });
    const groups = groupSessionsByRunStatus([older, newer], null);
    expect(groups.idle.map((s) => s.sessionId)).toEqual(["n", "o"]);
    expect(groups.running).toEqual([]);
  });
  it("indexRunningBySession keys by sessionId", () => {
    const idx = indexRunningBySession([running({ sessionId: "x" }), running({ sessionId: "y" })]);
    expect(idx.get("x")?.sessionId).toBe("x");
    expect(idx.size).toBe(2);
  });
});

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

describe("buildChangedFiles (§3.3 CHANGED FILES — path + deltas only, no diff hunks)", () => {
  it("carries every changed file path + its line deltas (no diff content)", () => {
    const changes = [
      { filePath: "a.ts", added: 3, removed: 1 },
      { filePath: "b.ts", added: 0, removed: 2 },
    ];
    expect(buildChangedFiles(changes)).toEqual([
      { path: "a.ts", added: 3, removed: 1 },
      { path: "b.ts", added: 0, removed: 2 },
    ]);
  });

  it("is an empty list when there are no changes (dock shows 'No changes')", () => {
    expect(buildChangedFiles([])).toEqual([]);
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

  it("renders a real tool_use block as a compact tool card (§3.3), never a fabricated one", () => {
    const items = mapMessagesToThreadItems([
      message("assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], 0),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("tool");
    if (items[0]!.kind === "tool") {
      expect(items[0]!.block.name).toBe("Bash");
      // Unpaired (no following tool_result in the window) → no attached result.
      expect(items[0]!.block.result).toBeUndefined();
    }
  });

  it("pairs a following tool_result onto its tool_use so a call is ONE card, not two", () => {
    const items = mapMessagesToThreadItems([
      message("assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], 0),
      message("user", [{ type: "tool_result", toolUseId: "t1", content: "a.ts\nb.ts", isError: false }], 1),
    ]);
    // The standalone tool_result is absorbed; only the one tool card remains.
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("tool");
    if (items[0]!.kind === "tool") {
      expect(items[0]!.block.result?.content).toContain("a.ts");
    }
  });

  it("routes an image/unknown block through the honest raw diagnostic", () => {
    const items = mapMessagesToThreadItems([
      message("assistant", [{ type: "image" } as unknown as ContentBlock], 0),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("raw");
    if (items[0]!.kind === "raw") expect(items[0]!.raw).toContain("assistant:image");
  });

  it("routes a thinking block through a COLLAPSED raw diagnostic with its real text, never a JSON dump (M8)", () => {
    const items = mapMessagesToThreadItems([
      message("assistant", [{ type: "thinking", text: "hmm" } as unknown as ContentBlock], 0),
    ]);
    expect(items).toEqual([
      { kind: "raw", id: "u0-0", raw: "[assistant:thinking] hmm", collapsed: true, summary: "Reasoning" },
    ]);
  });

  it("routes a non-user/assistant role's text through a COLLAPSED raw diagnostic, never as prose or an open JSON dump (M8)", () => {
    const items = mapMessagesToThreadItems([message("system", [{ type: "text", text: "hook fired" }], 0)]);
    expect(items).toEqual([
      { kind: "raw", id: "u0-text", raw: "[system] hook fired", collapsed: true, summary: "System event" },
    ]);
  });

  it("keeps both the prose and a tool card when a message mixes text with a tool block", () => {
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
    expect(items[1]!.kind).toBe("tool");
    if (items[1]!.kind === "tool") expect(items[1]!.block.name).toBe("Bash");
  });

  // W3-TX (M8 remainder): a `<task-notification>` subagent-completion block and an
  // `[Image: original …]` scaling note both arrive on a real `user`-role message —
  // Claude Code appends them, not the human — so they used to render as a
  // fabricated "You" bubble. Content-based detection routes them through the same
  // collapsed raw diagnostic as [hook]/[queue]/[attachment], never a chat bubble.
  it("collapses a <task-notification> block on a user-role message instead of a fabricated You bubble", () => {
    const notification =
      '<task-notification>\n<task-id>wckj209zt</task-id>\n<status>completed</status>\n</task-notification>';
    const items = mapMessagesToThreadItems([message("user", [{ type: "text", text: notification }], 0)]);
    expect(items).toEqual([
      { kind: "raw", id: "u0-text", raw: `[user] ${notification}`, collapsed: true, summary: "Task update" },
    ]);
  });

  it("collapses an [Image: original …] scaling note on a user-role message instead of a fabricated You bubble", () => {
    const note = "[Image: original 1237x2200, displayed at 1125x2000. Multiply coordinates by 1.10 to map to original image.]";
    const items = mapMessagesToThreadItems([message("user", [{ type: "text", text: note }], 0)]);
    expect(items).toEqual([
      { kind: "raw", id: "u0-text", raw: `[user] ${note}`, collapsed: true, summary: "Image (scaled for display)" },
    ]);
  });

  it("still renders ordinary user prose as a real bubble, even mentioning 'Image' or 'task' in passing", () => {
    const items = mapMessagesToThreadItems([
      message("user", [{ type: "text", text: "can you resize this Image for the task?" }], 0),
    ]);
    expect(items).toEqual([{ kind: "user", id: "u0-text", content: "can you resize this Image for the task?" }]);
  });

  // W3 QA MAJOR: bare `[image]`/`[attachment]` placeholders (parser emits these for
  // non-text content) used to slip through as fabricated user bubbles, and real
  // `image` blocks dumped `[role:image] {json}` inline. Both now collapse to a
  // clean, human-labelled row.
  it("collapses a bare [image]/[attachment] placeholder on a user message with a human label", () => {
    const img = mapMessagesToThreadItems([message("user", [{ type: "text", text: "[image]" }], 0)]);
    expect(img).toEqual([{ kind: "raw", id: "u0-text", raw: "[user] [image]", collapsed: true, summary: "Image" }]);
    const att = mapMessagesToThreadItems([message("user", [{ type: "text", text: "[attachment]" }], 0)]);
    expect(att).toEqual([
      { kind: "raw", id: "u0-text", raw: "[user] [attachment]", collapsed: true, summary: "Attachment" },
    ]);
  });

  it("collapses a real image content block to an Image row, not an inline JSON dump", () => {
    const items = mapMessagesToThreadItems([
      message("user", [{ type: "image", mediaType: "image/png" } as unknown as ContentBlock], 0),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("raw");
    if (items[0]!.kind === "raw") {
      expect(items[0]!.collapsed).toBe(true);
      expect(items[0]!.summary).toBe("Image");
    }
  });
});
