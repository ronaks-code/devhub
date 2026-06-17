import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { normalizeLine } from "../src/parser.js";
import type { NormalizedMessage } from "../src/types.js";

// Golden-fixture corpus: one sanitized, synthetic transcript LINE per shape the
// parser must handle (test/fixtures/*.json, documented in fixtures/README.md). We
// load each file FROM DISK and run it through the same `normalizeLine` the engine
// uses, asserting the normalized shape. Hermetic: the fixtures live under this test
// dir; nothing reads the real ~/.claude.
const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Load a fixture line object from disk (it is a single JSON object = one line). */
const load = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8")) as Record<string, unknown>;

/** Normalize a named fixture (seq 0) and return the message (or null for meta). */
const norm = (name: string, agentId?: string): NormalizedMessage | null =>
  normalizeLine(load(name), 0, agentId);

describe("transcript fixture corpus (golden line shapes)", () => {
  it("user-text: string content becomes one text block", () => {
    const m = norm("user-text")!;
    expect(m.role).toBe("user");
    expect(m.type).toBe("user");
    expect(m.blocks).toEqual([{ type: "text", text: "how do I add a route?" }]);
    expect(m.uuid).toBe("u1");
  });

  it("assistant-text: text block + model + mapped usage", () => {
    const m = norm("assistant-text")!;
    expect(m.role).toBe("assistant");
    expect(m.model).toBe("claude-opus-4-8");
    expect(m.blocks.map((b) => b.type)).toEqual(["text"]);
    expect(m.usage).toEqual({
      inputTokens: 12,
      outputTokens: 6,
      cacheReadTokens: 3,
      cacheCreationTokens: 1,
    });
  });

  it("system-line: surfaces as a system text block", () => {
    const m = norm("system-line")!;
    expect(m.role).toBe("system");
    expect(m.type).toBe("system");
    expect((m.blocks[0] as { type: string }).type).toBe("text");
    expect((m.blocks[0] as { text: string }).text).toContain("session resumed");
  });

  it("assistant-thinking: thinking + text blocks in order", () => {
    const m = norm("assistant-thinking")!;
    expect(m.role).toBe("assistant");
    expect(m.blocks.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect((m.blocks[0] as { text: string }).text).toContain("wants a new route");
  });

  it("assistant-tool-use: tool_use block parses id/name/input", () => {
    const m = norm("assistant-tool-use")!;
    expect(m.role).toBe("assistant");
    const tool = m.blocks.find((b) => b.type === "tool_use");
    expect(tool).toMatchObject({ type: "tool_use", id: "toolu_001", name: "Bash" });
    expect((tool as { input: { command: string } }).input).toEqual({ command: "pnpm test" });
  });

  it("user-tool-result: tool_result block normalizes content", () => {
    const m = norm("user-tool-result")!;
    expect(m.role).toBe("user");
    expect(m.blocks[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "toolu_001",
      content: "All 7 tests passed",
      isError: false,
    });
  });

  it("attachment-hook: hook output is tagged role=hook", () => {
    const m = norm("attachment-hook")!;
    expect(m.role).toBe("hook");
    expect((m.blocks[0] as { text: string }).text).toContain("SessionStart:startup");
    expect((m.blocks[0] as { text: string }).text).toContain("environment ready");
  });

  it("queue-operation: tagged role=queue with the queued content", () => {
    const m = norm("queue-operation")!;
    expect(m.role).toBe("queue");
    expect((m.blocks[0] as { text: string }).text).toContain("run the linter next");
  });

  it("summary-legacy: a legacy summary line is pure metadata (null)", () => {
    expect(norm("summary-legacy")).toBeNull();
  });

  it("ai-title: an ai-title line is pure metadata (null)", () => {
    expect(norm("ai-title")).toBeNull();
  });

  it("spilled-tool-result: a tool_result referencing a spilled file flattens to text", () => {
    const m = norm("spilled-tool-result")!;
    expect(m.role).toBe("user");
    expect(m.blocks[0]).toMatchObject({ type: "tool_result", toolUseId: "toolu_002" });
    expect((m.blocks[0] as { content: string }).content).toContain("spilled to toolu_002.txt");
  });

  it("subagent-line: a sidechain assistant line carries isSidechain + optional agentId", () => {
    const m = norm("subagent-line", "agent-investigate")!;
    expect(m.role).toBe("assistant");
    expect(m.isSidechain).toBe(true);
    expect(m.agentId).toBe("agent-investigate");
    expect((m.blocks[0] as { text: string }).text).toContain("subagent investigating");
  });

  it("unknown-type: an unknown future type is kept as role=meta, never throws", () => {
    const m = norm("unknown-type")!;
    expect(m.role).toBe("meta");
    expect(m.type).toBe("x-future-telemetry");
    expect(m.blocks[0]!.type).toBe("unknown");
  });

  it("every fixture round-trips without throwing (tolerant parser)", () => {
    const names = [
      "user-text",
      "assistant-text",
      "system-line",
      "assistant-thinking",
      "assistant-tool-use",
      "user-tool-result",
      "attachment-hook",
      "queue-operation",
      "summary-legacy",
      "ai-title",
      "spilled-tool-result",
      "subagent-line",
      "unknown-type",
    ];
    for (const name of names) {
      expect(() => norm(name)).not.toThrow();
    }
  });
});
