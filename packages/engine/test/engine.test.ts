import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, statSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeLine,
  resolveTitle,
  isCommandOrMetaPrompt,
  readSessionMessages,
  readTail,
} from "../src/parser.js";
import { encodeCwd, projectIdFromCwd } from "../src/paths.js";
import { TranscriptIndex } from "../src/index-db.js";
import { Engine } from "../src/index.js";
import { DEFAULT_SETTINGS } from "../src/types.js";
import { archiveSession, hasArchive, readArchived } from "../src/archive.js";
import { costUsd, pricingForModel, MODEL_PRICING } from "../src/pricing.js";
import { detectSourceKind } from "../src/discovery.js";
import { parseStatus } from "../src/git.js";
import { createLineSplitter } from "../src/driver/buffer.js";
import { listRunningSessions, isPidAlive } from "../src/running.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "cui-test-"));
const jl = (obj: unknown) => JSON.stringify(obj) + "\n";

describe("normalizeLine", () => {
  it("assistant: extracts thinking/text/tool_use + model + usage", () => {
    const m = normalizeLine(
      {
        type: "assistant",
        uuid: "a",
        parentUuid: "p",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "hi" },
            { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 1,
          },
        },
      },
      0,
    )!;
    expect(m.role).toBe("assistant");
    expect(m.model).toBe("claude-opus-4-8");
    expect(m.blocks.map((b) => b.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(m.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
    });
  });

  it("user: string content becomes a text block", () => {
    const m = normalizeLine({ type: "user", message: { role: "user", content: "hello" } }, 0)!;
    expect(m.role).toBe("user");
    expect(m.blocks).toEqual([{ type: "text", text: "hello" }]);
  });

  it("user: tool_result block is normalized", () => {
    const m = normalizeLine(
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu1", content: "output", is_error: false }],
        },
      },
      0,
    )!;
    expect(m.blocks[0]).toMatchObject({ type: "tool_result", toolUseId: "tu1", content: "output" });
  });

  it("attachment carrying hook output is tagged as a hook", () => {
    const m = normalizeLine(
      {
        type: "attachment",
        attachment: { type: "hook_success", hookName: "SessionStart:startup", content: "ready" },
      },
      0,
    )!;
    expect(m.role).toBe("hook");
    expect((m.blocks[0] as { text: string }).text).toContain("SessionStart:startup");
  });

  it("queue-operation is tagged as queue", () => {
    const m = normalizeLine({ type: "queue-operation", operation: "enqueue", content: "later" }, 0)!;
    expect(m.role).toBe("queue");
  });

  it("metadata lines (ai-title) render nothing", () => {
    expect(normalizeLine({ type: "ai-title", aiTitle: "X" }, 0)).toBeNull();
    expect(normalizeLine({ type: "summary", summary: "Y", leafUuid: "z" }, 0)).toBeNull();
  });

  it("unknown non-meta type is kept (tolerant)", () => {
    const m = normalizeLine({ type: "future-thing", foo: 1 }, 0)!;
    expect(m.role).toBe("meta");
    expect(m.blocks[0]!.type).toBe("unknown");
  });
});

describe("resolveTitle", () => {
  it("last ai-title wins (over earlier ai-title and summary)", () => {
    const head = [{ type: "summary", summary: "old summary" }];
    const tail = [
      { type: "ai-title", aiTitle: "First" },
      { type: "ai-title", aiTitle: "Latest" },
    ];
    expect(resolveTitle(head, tail, "id")).toEqual({ title: "Latest", source: "ai-title" });
  });

  it("falls back to summary when no ai-title", () => {
    expect(resolveTitle([{ type: "summary", summary: "S" }], [], "id")).toEqual({
      title: "S",
      source: "summary",
    });
  });

  it("first real prompt wins, skipping command/meta wrappers", () => {
    const head = [
      { type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } },
      { type: "user", message: { role: "user", content: "build me a thing" } },
    ];
    expect(resolveTitle(head, [], "id")).toEqual({ title: "build me a thing", source: "first-prompt" });
  });

  it("falls back to session id when nothing usable", () => {
    expect(resolveTitle([], [], "abcdef123456")).toEqual({ title: "abcdef12", source: "session-id" });
  });
});

describe("isCommandOrMetaPrompt", () => {
  it("flags command/caveat/reminder wrappers", () => {
    expect(isCommandOrMetaPrompt("<command-name>/clear</command-name>")).toBe(true);
    expect(isCommandOrMetaPrompt("Caveat: blah")).toBe(true);
    expect(isCommandOrMetaPrompt("<system-reminder>x</system-reminder>")).toBe(true);
    expect(isCommandOrMetaPrompt("a normal prompt")).toBe(false);
  });
});

describe("path encoding", () => {
  it("is the lossy non-alphanumeric->dash rule", () => {
    expect(encodeCwd("/Users/ronak/Documents/[00] GitHub/01-active/claude-ui")).toBe(
      "-Users-ronak-Documents--00--GitHub-01-active-claude-ui",
    );
  });
  it("collisions exist (different paths, same encoding)", () => {
    expect(encodeCwd("/a/b-c")).toBe(encodeCwd("/a/b/c"));
  });
  it("projectId is stable per cwd", () => {
    expect(projectIdFromCwd("/x/y")).toBe(projectIdFromCwd("/x/y"));
    expect(projectIdFromCwd("/x/y")).not.toBe(projectIdFromCwd("/x/z"));
  });
});

describe("readTail (huge-file tail window)", () => {
  it("drops the leading partial line and returns a complete suffix", async () => {
    const dir = tmp();
    const file = path.join(dir, "s.jsonl");
    writeFileSync(file, Array.from({ length: 8 }, (_, i) => jl({ i, type: "user" })).join(""));
    const size = statSync(file).size;
    const tail = await readTail(file, Math.floor(size / 2));
    expect(tail.from).toBeGreaterThan(0);
    const is = tail.lines.map((l) => l.i as number);
    expect(is[is.length - 1]).toBe(7); // ends at the last line
    expect(Math.min(...is)).toBeGreaterThan(0); // partial first line dropped
  });
});

describe("readSessionMessages (small file => full read)", () => {
  it("normalizes all renderable lines and skips metadata", async () => {
    const dir = tmp();
    const file = path.join(dir, "s.jsonl");
    writeFileSync(
      file,
      jl({ type: "ai-title", aiTitle: "T" }) +
        jl({ type: "user", message: { role: "user", content: "hi" } }) +
        jl({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "yo" }] } }),
    );
    const { messages, truncatedFromStart } = await readSessionMessages(file);
    expect(truncatedFromStart).toBe(false);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("TranscriptIndex incremental indexing", () => {
  it("indexes, then incrementally appends counts/usage and upgrades title", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const file = path.join(proj, "sess1.jsonl");
    const cwd = "/home/me/proj";
    writeFileSync(
      file,
      jl({ type: "user", cwd, message: { role: "user", content: "start the work" } }) +
        jl({
          type: "assistant",
          cwd,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 100, output_tokens: 20 },
          },
        }),
    );

    const idx = new TranscriptIndex(path.join(dir, "i.db"));
    const r1 = await idx.indexSession(file);
    expect(r1).toBe("added");
    let s = idx.getSessionSummary("sess1")!;
    expect(s.messageCount).toBe(2);
    expect(s.cwd).toBe(cwd);
    expect(s.title).toBe("start the work");
    expect(s.usage.inputTokens).toBe(100);

    // unchanged on re-run
    expect(await idx.indexSession(file)).toBe("unchanged");

    // append more + an ai-title => incremental update
    appendFileSync(
      file,
      jl({
        type: "assistant",
        cwd,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 50, output_tokens: 10 },
        },
      }) + jl({ type: "ai-title", aiTitle: "Build the thing" }),
    );
    const r2 = await idx.indexSession(file);
    expect(r2).toBe("updated");
    s = idx.getSessionSummary("sess1")!;
    expect(s.messageCount).toBe(3);
    expect(s.usage.inputTokens).toBe(150);
    expect(s.usage.outputTokens).toBe(30);
    expect(s.title).toBe("Build the thing");
    expect(s.titleSource).toBe("ai-title");

    // rename via sidecar overrides without touching the transcript
    idx.setCustomTitle("sess1", "My name");
    s = idx.getSessionSummary("sess1")!;
    expect(s.title).toBe("My name");
    expect(s.titleSource).toBe("custom");

    // grouping by true cwd
    const projects = idx.getProjects();
    expect(projects.find((p) => p.cwd === cwd)?.sessionCount).toBe(1);
    idx.close();
  });
});

describe("TranscriptIndex search", () => {
  const indexSample = async (dir: string) => {
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const cwd = "/home/me/widget-shop";
    const a = path.join(proj, "sessA.jsonl");
    writeFileSync(
      a,
      jl({ type: "user", cwd, message: { role: "user", content: "How do I add a checkout button?" } }) +
        jl({
          type: "assistant",
          cwd,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Use the Stripe widget to render a checkout flow." }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }),
    );
    const b = path.join(proj, "sessB.jsonl");
    writeFileSync(
      b,
      jl({ type: "user", cwd, message: { role: "user", content: "<command-name>/clear</command-name>" } }) +
        jl({ type: "user", cwd, message: { role: "user", content: "explain the database schema" } }),
    );
    const idx = new TranscriptIndex(path.join(dir, "i.db"));
    await idx.indexSession(a);
    await idx.indexSession(b);
    return { idx, cwd };
  };

  it("finds a word in mirrored user/assistant text and fills hit metadata", async () => {
    const { idx, cwd } = await indexSample(tmp());
    const hits = idx.search("checkout");
    // appears in both the user prompt (sessA) and assistant reply (sessA) -> deduped to one session
    expect(hits.length).toBe(1);
    const hit = hits[0]!;
    expect(hit.sessionId).toBe("sessA");
    expect(hit.projectName).toBe("widget-shop");
    expect(hit.cwd).toBe(cwd);
    expect(hit.snippet.toLowerCase()).toContain("checkout");
    expect(["user", "assistant"]).toContain(hit.role);
    idx.close();
  });

  it("blank query returns nothing; assistant-only words still match", async () => {
    const { idx } = await indexSample(tmp());
    expect(idx.search("   ")).toEqual([]);
    const stripe = idx.search("Stripe");
    expect(stripe.map((h) => h.sessionId)).toContain("sessA");
    idx.close();
  });

  it("does not index command/meta wrappers, but indexes the real prompt", async () => {
    const { idx } = await indexSample(tmp());
    // the /clear command wrapper in sessB must not be searchable
    expect(idx.search("command-name")).toEqual([]);
    // the real follow-up prompt in sessB is
    const schema = idx.search("schema");
    expect(schema.map((h) => h.sessionId)).toContain("sessB");
    idx.close();
  });

  it("incremental append makes newly-added text searchable without dropping old hits", async () => {
    const dir = tmp();
    const { idx } = await indexSample(dir);
    const a = path.join(dir, "-proj", "sessA.jsonl");
    appendFileSync(
      a,
      jl({
        type: "assistant",
        cwd: "/home/me/widget-shop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Also configure the webhook endpoint." }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    );
    expect(await idx.indexSession(a)).toBe("updated");
    expect(idx.search("webhook").map((h) => h.sessionId)).toContain("sessA"); // new text
    expect(idx.search("checkout").map((h) => h.sessionId)).toContain("sessA"); // old text kept
    idx.close();
  });

  // F4: tool I/O is mirrored into the search store as role="tool" rows.
  it("indexes tool_use input and tool_result output (role=tool); usage unchanged", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const cwd = "/home/me/tooled";
    const f = path.join(proj, "sessT.jsonl");
    writeFileSync(
      f,
      jl({ type: "user", cwd, message: { role: "user", content: "run the tests" } }) +
        jl({
          type: "assistant",
          cwd,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Running it." },
              { type: "tool_use", id: "tu1", name: "Bash", input: { command: "pnpm vitest run" } },
              { type: "tool_use", id: "tu2", name: "Read", input: { file_path: "/repo/src/widget.ts" } },
            ],
            usage: { input_tokens: 7, output_tokens: 3 },
          },
        }) +
        jl({
          type: "user",
          cwd,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu1", content: "All 42 specs green and passing" }],
          },
        }),
    );

    const idx = new TranscriptIndex(path.join(dir, "i.db"));
    await idx.indexSession(f);

    // tool_use Bash command is searchable, tagged role="tool"
    const cmd = idx.search("vitest");
    expect(cmd.map((h) => h.sessionId)).toContain("sessT");
    expect(cmd[0]!.role).toBe("tool");
    // tool_use Read file_path is searchable
    expect(idx.search("widget.ts").map((h) => h.sessionId)).toContain("sessT");
    // tool_result body is searchable
    const res = idx.search("specs green");
    expect(res.map((h) => h.sessionId)).toContain("sessT");
    expect(res[0]!.role).toBe("tool");

    // counting/usage logic is untouched (2 messages: 1 user + 1 assistant + 1 user)
    const s = idx.getSessionSummary("sessT")!;
    expect(s.messageCount).toBe(3);
    expect(s.usage.inputTokens).toBe(7);
    expect(s.usage.outputTokens).toBe(3);
    idx.close();
  });

  // F6: smarter query parsing (AND terms, phrases, prefix*, -exclusion) + SQL dedupe.
  it("parses multi-term AND, prefix*, quoted phrase, and -exclusion", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const cwd = "/home/me/q";
    const mk = (id: string, text: string) => {
      const p = path.join(proj, `${id}.jsonl`);
      writeFileSync(p, jl({ type: "user", cwd, message: { role: "user", content: text } }));
      return p;
    };
    const idx = new TranscriptIndex(path.join(dir, "i.db"));
    await idx.indexSession(mk("s1", "the checkout button uses stripe"));
    await idx.indexSession(mk("s2", "database schema migration plan"));
    await idx.indexSession(mk("s3", "checkout flow without any payment provider"));

    // AND: both terms must be present -> only s1
    expect(idx.search("checkout stripe").map((h) => h.sessionId).sort()).toEqual(["s1"]);
    // prefix*: data* matches "database"
    expect(idx.search("data*").map((h) => h.sessionId)).toContain("s2");
    // quoted phrase: adjacent words only
    expect(idx.search('"checkout flow"').map((h) => h.sessionId).sort()).toEqual(["s3"]);
    expect(idx.search('"checkout button"').map((h) => h.sessionId).sort()).toEqual(["s1"]);
    // exclusion: checkout but NOT stripe -> only s3
    expect(idx.search("checkout -stripe").map((h) => h.sessionId).sort()).toEqual(["s3"]);
    // pure negation has no positive term -> nothing
    expect(idx.search("-stripe")).toEqual([]);
    idx.close();
  });

  it("respects the SQL limit and returns one best row per session", async () => {
    const dir = tmp();
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const cwd = "/home/me/lim";
    const idx = new TranscriptIndex(path.join(dir, "i.db"));
    for (let i = 0; i < 5; i++) {
      const p = path.join(proj, `sess${i}.jsonl`);
      // two messages both mentioning "kiwi" in the same session
      writeFileSync(
        p,
        jl({ type: "user", cwd, message: { role: "user", content: `kiwi note ${i} one` } }) +
          jl({ type: "user", cwd, message: { role: "user", content: `kiwi note ${i} two` } }),
      );
      await idx.indexSession(p);
    }
    // 5 sessions match; limit=3 returns 3; each session appears at most once
    const hits = idx.search("kiwi", 3);
    expect(hits.length).toBe(3);
    expect(new Set(hits.map((h) => h.sessionId)).size).toBe(3);
    idx.close();
  });
});

describe("TranscriptIndex faceted search", () => {
  // Two projects, distinct branches/timestamps, plus a tool_use row, all sharing
  // the word "deploy" so the text match is constant and only the facet varies.
  const buildFaceted = async (dir: string) => {
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const cwdA = "/home/me/alpha";
    const cwdB = "/home/me/beta";

    // sessA: project alpha, branch main, older timestamp; user + assistant + a Bash tool_use.
    writeFileSync(
      path.join(proj, "sessA.jsonl"),
      jl({
        type: "user",
        cwd: cwdA,
        gitBranch: "main",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "how do I deploy alpha?" },
      }) +
        jl({
          type: "assistant",
          cwd: cwdA,
          gitBranch: "main",
          timestamp: "2026-01-01T00:01:00.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Run the deploy script." },
              { type: "tool_use", id: "tu1", name: "Bash", input: { command: "./deploy.sh alpha" } },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }),
    );

    // sessB: project beta, branch feature, newer timestamp; user-only.
    writeFileSync(
      path.join(proj, "sessB.jsonl"),
      jl({
        type: "user",
        cwd: cwdB,
        gitBranch: "feature",
        timestamp: "2026-03-01T00:00:00.000Z",
        message: { role: "user", content: "deploy beta to staging" },
      }),
    );

    const idx = new TranscriptIndex(path.join(dir, "i.db"));
    await idx.indexSession(path.join(proj, "sessA.jsonl"));
    await idx.indexSession(path.join(proj, "sessB.jsonl"));
    return { idx, cwdA, cwdB };
  };

  it("plain query (no facets) matches both sessions; backward-compatible", async () => {
    const { idx } = await buildFaceted(tmp());
    expect(idx.search("deploy").map((h) => h.sessionId).sort()).toEqual(["sessA", "sessB"]);
    // legacy positional limit still works
    expect(idx.search("deploy", 1).length).toBe(1);
    idx.close();
  });

  it("projectId facet restricts to one project", async () => {
    const { idx, cwdA } = await buildFaceted(tmp());
    const alphaId = projectIdFromCwd(cwdA);
    const hits = idx.search("deploy", { projectId: alphaId });
    expect(hits.map((h) => h.sessionId)).toEqual(["sessA"]);
    expect(hits[0]!.projectId).toBe(alphaId);
    idx.close();
  });

  it("role facet keeps only matching message rows", async () => {
    const { idx } = await buildFaceted(tmp());
    // Only the assistant text row mentions deploy in sessA; sessB's is a user row.
    expect(idx.search("deploy", { role: "assistant" }).map((h) => h.sessionId)).toEqual(["sessA"]);
    expect(idx.search("deploy", { role: "user" }).map((h) => h.sessionId).sort()).toEqual([
      "sessA",
      "sessB",
    ]);
    idx.close();
  });

  it("toolName facet matches mirrored tool_use rows", async () => {
    const { idx } = await buildFaceted(tmp());
    const hits = idx.search("deploy", { toolName: "Bash" });
    expect(hits.map((h) => h.sessionId)).toEqual(["sessA"]);
    expect(hits[0]!.role).toBe("tool");
    // a tool that was never invoked yields nothing
    expect(idx.search("deploy", { toolName: "Read" })).toEqual([]);
    idx.close();
  });

  it("gitBranch facet filters by branch", async () => {
    const { idx } = await buildFaceted(tmp());
    expect(idx.search("deploy", { gitBranch: "feature" }).map((h) => h.sessionId)).toEqual(["sessB"]);
    expect(idx.search("deploy", { gitBranch: "main" }).map((h) => h.sessionId)).toEqual(["sessA"]);
    idx.close();
  });

  it("since/until facets filter on last activity", async () => {
    const { idx } = await buildFaceted(tmp());
    // sessB's last activity is 2026-03; sessA's is 2026-01.
    expect(idx.search("deploy", { since: "2026-02-01T00:00:00.000Z" }).map((h) => h.sessionId)).toEqual([
      "sessB",
    ]);
    expect(idx.search("deploy", { until: "2026-02-01T00:00:00.000Z" }).map((h) => h.sessionId)).toEqual([
      "sessA",
    ]);
    idx.close();
  });

  it("facets compose (projectId + role together)", async () => {
    const { idx, cwdB } = await buildFaceted(tmp());
    const betaId = projectIdFromCwd(cwdB);
    // beta has only a user row; asking for an assistant row in beta yields nothing.
    expect(idx.search("deploy", { projectId: betaId, role: "assistant" })).toEqual([]);
    expect(idx.search("deploy", { projectId: betaId, role: "user" }).map((h) => h.sessionId)).toEqual([
      "sessB",
    ]);
    idx.close();
  });
});

describe("running-session liveness", () => {
  // listRunningSessions reads liveSessionsDir(), which lives under CLAUDE_CONFIG_DIR.
  // Point it at a temp dir per test and restore afterward so we never touch ~/.claude.
  const withConfigDir = async <T>(fn: (sessionsDir: string) => Promise<T>): Promise<T> => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    const root = tmp();
    process.env.CLAUDE_CONFIG_DIR = root;
    const sessionsDir = path.join(root, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    try {
      return await fn(sessionsDir);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  };

  it("isPidAlive: own pid alive, an unused high pid dead, non-positive dead", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    // A very high pid is virtually never a live process -> ESRCH -> dead.
    expect(isPidAlive(2 ** 30)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });

  it("flags a stale/zombie session file with status=dead and alive=false", async () => {
    await withConfigDir(async (sessionsDir) => {
      const deadPid = 2 ** 30; // no such process
      writeFileSync(
        path.join(sessionsDir, `${deadPid}.json`),
        JSON.stringify({ pid: deadPid, sessionId: "ghost", cwd: "/home/me/x", status: "busy" }),
      );
      // A live entry: our own process pid, which is definitely alive.
      writeFileSync(
        path.join(sessionsDir, `${process.pid}.json`),
        JSON.stringify({ pid: process.pid, sessionId: "live", cwd: "/home/me/y", status: "idle", updatedAt: 100 }),
      );

      const all = await listRunningSessions();
      const dead = all.find((s) => s.sessionId === "ghost")!;
      const live = all.find((s) => s.sessionId === "live")!;
      expect(dead.alive).toBe(false);
      expect(dead.status).toBe("dead"); // stale "busy" overridden
      expect(live.alive).toBe(true);
      expect(live.status).toBe("idle"); // live entry keeps its reported status
    });
  });

  it("dropDead omits stale entries entirely", async () => {
    await withConfigDir(async (sessionsDir) => {
      const deadPid = 2 ** 30;
      writeFileSync(
        path.join(sessionsDir, `${deadPid}.json`),
        JSON.stringify({ pid: deadPid, sessionId: "ghost", cwd: "/home/me/x", status: "busy" }),
      );
      writeFileSync(
        path.join(sessionsDir, `${process.pid}.json`),
        JSON.stringify({ pid: process.pid, sessionId: "live", cwd: "/home/me/y", status: "idle" }),
      );
      const kept = await listRunningSessions({ dropDead: true });
      expect(kept.map((s) => s.sessionId)).toEqual(["live"]);
    });
  });

  it("missing dir => [], internal/claude-mem cwd skipped, unparseable skipped", async () => {
    // No sessions dir created here: point at a fresh temp root with no sessions/.
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmp();
    try {
      expect(await listRunningSessions()).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }

    await withConfigDir(async (sessionsDir) => {
      writeFileSync(path.join(sessionsDir, "bad.json"), "{not json");
      writeFileSync(
        path.join(sessionsDir, "mem.json"),
        JSON.stringify({ pid: process.pid, sessionId: "mem", cwd: "/home/me/.claude-mem/store" }),
      );
      writeFileSync(path.join(sessionsDir, "ignore.txt"), "not a json file");
      expect(await listRunningSessions()).toEqual([]); // all three skipped
    });
  });
});

describe("settings store", () => {
  it("returns defaults on a fresh DB, then round-trips set/get/getAll", () => {
    const dir = tmp();
    const engine = new Engine(path.join(dir, "i.db"));

    // Fresh DB => defaults (and undefined for keys with no default).
    expect(engine.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(engine.settings.get("theme")).toBe("system");
    expect(engine.settings.get("defaultModel")).toBeUndefined();

    // setAll merges only the provided keys; JSON-typed values round-trip.
    engine.setSettings({ defaultModel: "claude-opus-4-8", monthlyBudgetUsd: 42.5, theme: "dark" });
    expect(engine.settings.get("defaultModel")).toBe("claude-opus-4-8");
    expect(engine.settings.get("monthlyBudgetUsd")).toBe(42.5);
    expect(engine.settings.get("theme")).toBe("dark");
    // Untouched keys keep their defaults.
    expect(engine.settings.get("density")).toBe("comfortable");

    // null is a real, stored value (not "no value").
    engine.settings.set("lastProjectId", null);
    expect(engine.settings.get("lastProjectId")).toBeNull();

    const all = engine.getSettings();
    expect(all.defaultModel).toBe("claude-opus-4-8");
    expect(all.monthlyBudgetUsd).toBe(42.5);
    expect(all.theme).toBe("dark");

    engine.close();

    // Persisted across a reopen of the same DB file (shared index.db).
    const reopened = new Engine(path.join(dir, "i.db"));
    expect(reopened.settings.get("defaultModel")).toBe("claude-opus-4-8");
    expect(reopened.settings.get("monthlyBudgetUsd")).toBe(42.5);
    reopened.close();
  });
});

describe("Engine.getStats", () => {
  const today = new Date().toISOString().slice(0, 10);

  const buildEngine = async (dir: string) => {
    const proj = path.join(dir, "-proj");
    mkdirSync(proj);
    const ts = `${today}T12:00:00.000Z`;
    // Two sessions in project A (more tokens), one in project B.
    writeFileSync(
      path.join(proj, "s1.jsonl"),
      jl({ type: "user", cwd: "/home/me/alpha", timestamp: ts, message: { role: "user", content: "hello alpha" } }) +
        jl({
          type: "assistant",
          cwd: "/home/me/alpha",
          timestamp: ts,
          message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1000, output_tokens: 500 } },
        }),
    );
    writeFileSync(
      path.join(proj, "s2.jsonl"),
      jl({ type: "user", cwd: "/home/me/alpha", timestamp: ts, message: { role: "user", content: "more alpha" } }) +
        jl({
          type: "assistant",
          cwd: "/home/me/alpha",
          timestamp: ts,
          message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 200, output_tokens: 100 } },
        }),
    );
    writeFileSync(
      path.join(proj, "s3.jsonl"),
      jl({ type: "user", cwd: "/home/me/beta", timestamp: ts, message: { role: "user", content: "hello beta" } }) +
        jl({
          type: "assistant",
          cwd: "/home/me/beta",
          timestamp: ts,
          message: { role: "assistant", content: [{ type: "text", text: "yo" }], usage: { input_tokens: 10, output_tokens: 5 } },
        }),
    );

    const engine = new Engine(path.join(dir, "i.db"));
    await engine.index.indexSession(path.join(proj, "s1.jsonl"));
    await engine.index.indexSession(path.join(proj, "s2.jsonl"));
    await engine.index.indexSession(path.join(proj, "s3.jsonl"));
    return engine;
  };

  it("aggregates totals, top projects (by tokens desc), and a 30-day activity series", async () => {
    const engine = await buildEngine(tmp());
    const stats = engine.getStats();

    expect(stats.totalSessions).toBe(3);
    expect(stats.totalProjects).toBe(2);
    expect(stats.totalUsage.inputTokens).toBe(1210);
    expect(stats.totalUsage.outputTokens).toBe(605);

    // alpha (1800 tokens across 2 sessions) ranks above beta (15 tokens)
    expect(stats.topProjects[0]!.name).toBe("alpha");
    expect(stats.topProjects[0]!.sessions).toBe(2);
    expect(stats.topProjects[0]!.tokens).toBe(1800);
    expect(stats.topProjects[1]!.name).toBe("beta");
    expect(stats.topProjects.length).toBeLessThanOrEqual(8);

    // exactly 30 days, oldest -> newest, with today carrying all 3 sessions
    expect(stats.activity.length).toBe(30);
    expect(stats.activity[0]!.date < stats.activity[29]!.date).toBe(true);
    expect(stats.activity[29]!.date).toBe(today);
    expect(stats.activity[29]!.sessions).toBe(3);
    expect(stats.activity.reduce((a, d) => a + d.sessions, 0)).toBe(3);

    engine.close();
  });
});

describe("archive (durable gzip round-trip)", () => {
  // archiveDir()/archivePath() derive from appDataDir(), which honors CLAUDE_UI_DATA.
  // Point it at a temp dir per test and restore afterward so we never touch ~/.claude-ui.
  const withArchiveDir = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = process.env.CLAUDE_UI_DATA;
    process.env.CLAUDE_UI_DATA = tmp();
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_UI_DATA;
      else process.env.CLAUDE_UI_DATA = prev;
    }
  };

  it("archives a session and reads the exact same lines back", async () => {
    await withArchiveDir(async () => {
      const dir = tmp();
      const file = path.join(dir, "round.jsonl");
      const lines = [
        { type: "user", message: { role: "user", content: "hello archive" } },
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "hi back" }] },
        },
        { type: "ai-title", aiTitle: "Archived Session" },
      ];
      writeFileSync(file, lines.map(jl).join(""));

      expect(await hasArchive("round")).toBe(false);
      expect(await archiveSession(file, "round")).toBe("archived");
      expect(await hasArchive("round")).toBe(true);

      const back = await readArchived("round");
      expect(back).toEqual(lines); // exact round-trip, line for line
    });
  });

  it("returns undefined for an unknown session and skips a missing source", async () => {
    await withArchiveDir(async () => {
      expect(await readArchived("nope")).toBeUndefined();
      expect(await hasArchive("nope")).toBe(false);
      // Missing source file is a best-effort skip, not a throw.
      expect(await archiveSession(path.join(tmp(), "gone.jsonl"), "gone")).toBe("skipped");
    });
  });

  it("Engine.getSessionMessages falls back to the archive when the source is gone", async () => {
    await withArchiveDir(async () => {
      const dir = tmp();
      const proj = path.join(dir, "-proj");
      mkdirSync(proj);
      const file = path.join(proj, "fallback.jsonl");
      const cwd = "/home/me/fallback";
      writeFileSync(
        file,
        jl({ type: "user", cwd, message: { role: "user", content: "before delete" } }) +
          jl({
            type: "assistant",
            cwd,
            message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
          }),
      );

      const engine = new Engine(path.join(dir, "i.db"));
      // Indexing archives the file (new), so an archive exists after this.
      await engine.index.indexSession(file);
      expect(await hasArchive("fallback")).toBe(true);

      // Live read works.
      const live = await engine.getSessionMessages("fallback");
      expect(live!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

      // Delete the source transcript; index row + archive remain.
      rmSync(file);
      const fromArchive = await engine.getSessionMessages("fallback");
      expect(fromArchive).toBeDefined();
      expect(fromArchive!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(fromArchive!.truncatedFromStart).toBe(false);
      engine.close();
    });
  });
});

describe("pricing (approximate cost estimates)", () => {
  it("has rows for the known models with sensible cache multipliers", () => {
    const opus = MODEL_PRICING["claude-opus-4-8"]!;
    expect(opus.inputPerMtok).toBe(5);
    expect(opus.outputPerMtok).toBe(25);
    expect(opus.cacheReadPerMtok).toBe(0.5); // 0.1x input
    expect(opus.cacheWritePerMtok).toBe(6.25); // 1.25x input

    expect(MODEL_PRICING["claude-sonnet-4-6"]!.inputPerMtok).toBe(3);
    expect(MODEL_PRICING["claude-haiku-4-5"]!.outputPerMtok).toBe(5);
    expect(MODEL_PRICING["claude-fable-5"]!.outputPerMtok).toBe(50);
  });

  it("resolves dated/suffixed ids by prefix and falls back for unknown models", () => {
    expect(pricingForModel("claude-opus-4-8[1m]")).toBe(MODEL_PRICING["claude-opus-4-8"]);
    expect(pricingForModel("claude-opus-4-8-20260101")).toBe(MODEL_PRICING["claude-opus-4-8"]);
    // Unknown model -> fallback row (sonnet-tier), not zero.
    const unknown = pricingForModel("some-future-model");
    expect(unknown.inputPerMtok).toBe(3);
    expect(pricingForModel(null).inputPerMtok).toBe(3);
  });

  it("costUsd multiplies each token bucket by its per-Mtok rate", () => {
    // 1M input + 1M output on opus = $5 + $25 = $30.
    const cost = costUsd("claude-opus-4-8", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(cost).toBeCloseTo(30, 6);

    // Cache buckets are priced too: 1M cache-read ($0.50) + 1M cache-write ($6.25).
    const cacheCost = costUsd("claude-opus-4-8", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });
    expect(cacheCost).toBeCloseTo(6.75, 6);

    // Zero usage is always zero.
    expect(
      costUsd("claude-opus-4-8", {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBe(0);
  });
});

describe("detectSourceKind (multi-source labeling)", () => {
  it("defaults to claude and detects other CLIs by folder/cwd hints", () => {
    expect(detectSourceKind("/home/me/.claude/projects/-proj")).toBe("claude");
    expect(detectSourceKind("/home/me/code/widget")).toBe("claude"); // plain cwd
    expect(detectSourceKind(null)).toBe("claude");
    expect(detectSourceKind("/home/me/.codex/sessions")).toBe("codex");
    expect(detectSourceKind("/home/me/.gemini/logs")).toBe("gemini");
    expect(detectSourceKind("/home/me/.cursor/chats")).toBe("cursor");
  });
});
