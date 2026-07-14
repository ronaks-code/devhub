import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodexSession } from "../../src/codex.js";
import { ProviderCapabilityError } from "../../src/providers/capabilities.js";
import { CodexHistoryFallbackAdapter } from "../../src/providers/codex/history-fallback-adapter.js";
import { createProviderRequestIdentity } from "../../src/providers/request-identity.js";
import { createNativeTaskKey } from "../../src/providers/task-key.js";

const session = (id: string): CodexSession => ({
  id,
  filename: `/tmp/${id}.jsonl`,
  startedAt: "2026-07-12T22:00:00.000Z",
  cwd: "/work/codex-project",
  model: "openai",
  provider: "openai",
  cliVersion: "0.144.1",
  userMessageCount: 2,
  turnCount: 1,
});

function writeRollout(home: string, id: string): void {
  const sessions = path.join(home, "sessions", "2026", "07", "13");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    path.join(sessions, `rollout-${id}.jsonl`),
    `${JSON.stringify({
      type: "session_meta",
      payload: {
        id,
        timestamp: "2026-07-13T07:00:00.000Z",
        cwd: `/work/${id}`,
        model_provider: "openai",
      },
    })}\n`,
  );
}

describe("CodexHistoryFallbackAdapter", () => {
  it("scans only its effective Codex home when using the default loader", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "devhub-codex-fallback-home-"));
    const userHome = path.join(root, "user-home");
    const effectiveHome = path.join(root, "effective-codex-home");
    const previousHome = process.env.HOME;

    try {
      writeRollout(path.join(userHome, ".codex"), "default-home-session");
      writeRollout(effectiveHome, "effective-home-session");
      process.env.HOME = userHome;

      const adapter = new CodexHistoryFallbackAdapter({ home: effectiveHome });
      const page = await adapter.listTasks({ home: effectiveHome });

      expect(page.items.map((item) => item.key.nativeTaskId)).toEqual([
        "effective-home-session",
      ]);
      expect(page.items[0]?.key.home).toBe(realpathSync(effectiveHome));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not follow a sessions root that escapes the effective Codex home", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "devhub-codex-fallback-boundary-"));
    const userHome = path.join(root, "user-home");
    const effectiveHome = path.join(userHome, ".codex");
    const outsideHome = path.join(root, "outside-codex-home");
    const previousHome = process.env.HOME;

    try {
      mkdirSync(effectiveHome, { recursive: true });
      writeRollout(outsideHome, "outside-session");
      symlinkSync(path.join(outsideHome, "sessions"), path.join(effectiveHome, "sessions"), "dir");
      process.env.HOME = userHome;

      const adapter = new CodexHistoryFallbackAdapter({ home: effectiveHome });
      const page = await adapter.listTasks({ home: effectiveHome });

      expect(page.items).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a sessions root that resolves to the effective home's parent", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "devhub-codex-fallback-parent-"));
    const effectiveHome = path.join(root, "effective-codex-home");

    try {
      mkdirSync(effectiveHome);
      writeRollout(root, "parent-session");
      symlinkSync(root, path.join(effectiveHome, "sessions"), "dir");

      const adapter = new CodexHistoryFallbackAdapter({ home: effectiveHome });
      const page = await adapter.listTasks({ home: effectiveHome });

      expect(page.items).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps rollout summaries to list-only degraded fallback tasks", async () => {
    const listSessions = vi.fn(async () => [session("codex-1"), session("codex-2")]);
    const adapter = new CodexHistoryFallbackAdapter({
      home: "/tmp/codex-home",
      listSessions,
    });

    expect(await adapter.capabilities()).toMatchObject({
      list: true,
      read: false,
      start: false,
      resume: false,
      send: false,
      interrupt: false,
      subscribe: false,
      approvePermissions: false,
    });
    const page = await adapter.listTasks({ home: "/tmp/codex-home", limit: 1 });
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(page.nextCursor).toBe("1");
    expect(page.items[0]).toMatchObject({
      key: {
        provider: "openai",
        home: "/tmp/codex-home",
        nativeTaskId: "codex-1",
      },
      title: "codex-project",
      source: "degraded-fallback",
      status: "complete",
      archived: null,
    });
  });

  it("fails closed for read and every mutation or control operation", async () => {
    const adapter = new CodexHistoryFallbackAdapter({
      home: "/tmp/codex-home",
      listSessions: async () => [session("codex-1")],
    });
    const page = await adapter.listTasks({ home: "/tmp/codex-home" });
    const key = page.items[0]!.key;
    const identity = (requestId: string) => createProviderRequestIdentity({
      key,
      generation: null,
      turnId: "turn-1",
      requestId,
      itemId: "item-1",
      approvalId: null,
    });

    await expect(adapter.readTask(key, true)).rejects.toMatchObject({
      code: "PROVIDER_CAPABILITY_UNAVAILABLE",
      capability: "read",
    });
    await expect(
      adapter.startTask({ home: "/tmp/codex-home", cwd: "/work" }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    await expect(adapter.resumeTask(key)).rejects.toMatchObject({ capability: "resume" });
    await expect(adapter.forkTask(key)).rejects.toMatchObject({ capability: "fork" });
    await expect(adapter.send(key, { text: "continue" })).rejects.toMatchObject({
      capability: "send",
    });
    await expect(adapter.steer(key, "turn-1", { text: "redirect" })).rejects.toMatchObject({
      capability: "steer",
    });
    await expect(adapter.interrupt(key, "turn-1")).rejects.toMatchObject({
      capability: "interrupt",
    });
    await expect(
      adapter.respond({
        kind: "command-approval",
        identity: identity("command-1"),
        decision: "cancel",
      }),
    ).rejects.toMatchObject({ capability: "approveCommand" });
    await expect(
      adapter.respond({
        kind: "file-change-approval",
        identity: identity("file-1"),
        decision: "cancel",
      }),
    ).rejects.toMatchObject({ capability: "approveFileChange" });
    await expect(
      adapter.respond({
        kind: "mcp-elicitation",
        identity: identity("mcp-1"),
        decision: "cancel",
      }),
    ).rejects.toMatchObject({ capability: "mcpElicitation" });
    await expect(
      adapter.respond({ kind: "user-input", identity: identity("input-1"), answers: {} }),
    ).rejects.toMatchObject({ capability: "requestUserInput" });
    await expect(
      adapter.respond({
        kind: "permission",
        identity: identity("permission-1"),
        permissions: [],
      }),
    ).rejects.toMatchObject({ capability: "approvePermissions" });
    await expect(adapter.archive(key)).rejects.toMatchObject({ capability: "archive" });
    await expect(adapter.rename(key, "renamed")).rejects.toMatchObject({ capability: "rename" });
    await expect(adapter.subscribe(key, vi.fn())).rejects.toMatchObject({
      code: "PROVIDER_CAPABILITY_UNAVAILABLE",
      capability: "subscribe",
    });
  });

  it("rejects a mismatched provider home before scanning rollouts", async () => {
    const listSessions = vi.fn(async () => []);
    const adapter = new CodexHistoryFallbackAdapter({
      home: "/tmp/codex-home",
      listSessions,
    });

    await expect(adapter.listTasks({ home: "/tmp/other-home" })).rejects.toThrow(/home/i);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("rejects foreign subscribe and response identities before capability dispatch", async () => {
    const adapter = new CodexHistoryFallbackAdapter({
      home: "/tmp/codex-home",
      listSessions: async () => [],
    });
    const foreignKey = createNativeTaskKey("anthropic", "/tmp/claude-home", "session-1");

    await expect(adapter.subscribe(foreignKey, vi.fn())).rejects.toThrow(/belong/i);
    await expect(adapter.respond({
      kind: "permission",
      identity: createProviderRequestIdentity({
        key: foreignKey,
        generation: null,
        turnId: "turn-1",
        requestId: "request-1",
        itemId: "item-1",
        approvalId: null,
      }),
      permissions: [],
    })).rejects.toThrow(/belong/i);
  });
});
