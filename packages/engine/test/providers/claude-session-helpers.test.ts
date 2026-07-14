import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_AGENT_SDK_PINNED_VERSION,
  CLAUDE_SESSION_HELPER_MAX_CONCURRENT_PROCESSES,
  CLAUDE_SESSION_HELPER_MAX_STDIN_BYTES,
  ClaudeSessionHelpers,
  runClaudeSessionHelperProcess,
  type ClaudeSessionHelperInvocation,
  type ClaudeSessionHelperProcessRunner,
} from "../../src/providers/claude/session-helpers.js";

const HOME = "/canonical/claude-home";
const CWD = "/canonical/project";
const SESSION = "019f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const MESSAGE = "419f5b78-18c0-7b60-8f0c-6afc120ecd7d";

const harness = (responseValue: unknown) => {
  const invocations: ClaudeSessionHelperInvocation[] = [];
  const runner: ClaudeSessionHelperProcessRunner = vi.fn(async (invocation) => {
    invocations.push(invocation);
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ ok: true, value: responseValue })}\n`,
      stderr: "",
    };
  });
  const helpers = new ClaudeSessionHelpers({
    configHome: HOME,
    cwd: CWD,
    canonicalizePath: (value) => value,
    runProcess: runner,
  });
  return { helpers, invocations, runner };
};

describe("ClaudeSessionHelpers", () => {
  it("lists programmatic sessions through one isolated pinned-SDK request", async () => {
    const secret = "sk-ant-secret-never-inherited";
    const { helpers, invocations } = harness([{
        sessionId: SESSION,
        customTitle: "Safe session",
        summary: "Safe summary",
        cwd: CWD,
        createdAt: Date.parse("2026-07-13T16:00:00.000Z"),
        lastModified: Date.parse("2026-07-13T16:01:00.000Z"),
        fileSize: 42_000,
        hidden_reasoning: "never expose",
        raw: { token: secret },
    }]);

    const sessions = await helpers.listSessions({ limit: 20, offset: 3 });
      expect(sessions).toEqual([{
        sessionId: SESSION,
        title: "Safe session",
        summary: "Safe summary",
        cwd: CWD,
        createdAt: "2026-07-13T16:00:00.000Z",
        updatedAt: "2026-07-13T16:01:00.000Z",
        fileSize: 42_000,
      }]);
      expect(Object.isFrozen(sessions)).toBe(true);
      expect(Object.isFrozen(sessions[0])).toBe(true);
      expect(invocations).toHaveLength(1);
      const invocation = invocations[0]!;
      expect(invocation.cwd).toBe(CWD);
      expect(invocation.env).toEqual({
        CLAUDE_CONFIG_DIR: HOME,
        LANG: "C.UTF-8",
        PATH: expect.any(String),
      });
      expect(JSON.stringify(invocation)).not.toContain(secret);
      expect(JSON.parse(invocation.stdin)).toEqual({
        version: 1,
        sdkVersion: "0.3.207",
        method: "listSessions",
        args: [{ dir: CWD, includeProgrammatic: true, limit: 20, offset: 3 }],
      });
    expect(CLAUDE_AGENT_SDK_PINNED_VERSION).toBe("0.3.207");
  });

  it("executes the real pinned-SDK child boundary with an isolated environment", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "devhub-claude-helper-real-"));
    const configHome = path.join(root, "claude-home");
    const cwd = path.join(root, "project");
    mkdirSync(configHome);
    mkdirSync(cwd);
    const secretName = "DEVHUB_HELPER_PARENT_SECRET";
    const secret = "must-not-enter-helper-child";
    const previousSecret = process.env[secretName];
    process.env[secretName] = secret;
    try {
      let captured: ClaudeSessionHelperInvocation | undefined;
      const capture = new ClaudeSessionHelpers({
        configHome,
        cwd,
        canonicalizePath: (value) => value,
        runProcess: async (invocation) => {
          captured = invocation;
          return { exitCode: 0, stdout: '{"ok":true,"value":[]}\n', stderr: "" };
        },
      });
      await expect(capture.listSessions({ limit: 1 })).resolves.toEqual([]);
      const invocation = captured;
      if (!invocation) throw new Error("missing captured helper invocation");

      await expect(runClaudeSessionHelperProcess(invocation)).resolves.toEqual({
        exitCode: 0,
        stdout: '{"ok":true,"value":[]}\n',
        stderr: "",
      });

      const environment = await runClaudeSessionHelperProcess({
        ...invocation,
        args: [
          "--input-type=module",
          "--eval",
          `process.stdout.write(JSON.stringify({ secret: process.env.${secretName} ?? null, keys: Object.keys(process.env).sort() }) + "\\n");`,
        ],
        stdin: "",
      });
      const environmentProjection = JSON.parse(environment.stdout) as {
        secret: string | null;
        keys: string[];
      };
      expect(environmentProjection.secret).toBeNull();
      expect(environmentProjection.keys).toEqual(expect.arrayContaining(
        Object.keys(invocation.env),
      ));
      expect(environmentProjection.keys).not.toContain(secretName);
      expect(environmentProjection.keys).not.toContain("HOME");
      expect(environment.stdout).not.toContain(secret);

      const request = JSON.parse(invocation.stdin) as Record<string, unknown>;
      const wrongVersion = await runClaudeSessionHelperProcess({
        ...invocation,
        stdin: `${JSON.stringify({ ...request, sdkVersion: "0.3.206" })}\n`,
      });
      expect(wrongVersion).toEqual({
        exitCode: 0,
        stdout: '{"ok":false,"code":"SDK_FAILURE"}\n',
        stderr: "",
      });

      const oversizedInput = await runClaudeSessionHelperProcess({
        ...invocation,
        stdin: "x".repeat(CLAUDE_SESSION_HELPER_MAX_STDIN_BYTES + 1),
      });
      expect(oversizedInput).toEqual({
        exitCode: 0,
        stdout: '{"ok":false,"code":"SDK_FAILURE"}\n',
        stderr: "",
      });
    } finally {
      if (previousSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = previousSecret;
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("kills timed-out real children and bounds both output channels", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "devhub-claude-runner-"));
    const base: ClaudeSessionHelperInvocation = {
      executable: process.execPath,
      args: [],
      cwd: root,
      env: {
        LANG: "C.UTF-8",
        PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      },
      stdin: "",
      timeoutMs: 100,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
    };
    try {
      await expect(runClaudeSessionHelperProcess({
        ...base,
        args: ["--input-type=module", "--eval", "setInterval(() => undefined, 1_000);"],
      })).rejects.toThrow("Claude session helper process failed");

      await expect(runClaudeSessionHelperProcess({
        ...base,
        args: ["--input-type=module", "--eval", 'process.stdout.write("12345");'],
        maxStdoutBytes: 4,
      })).rejects.toThrow("Claude session helper process failed");

      await expect(runClaudeSessionHelperProcess({
        ...base,
        args: ["--input-type=module", "--eval", 'process.stderr.write("12345");'],
        maxStderrBytes: 4,
      })).rejects.toThrow("Claude session helper process failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects only user, assistant, and system text blocks from official messages", async () => {
    const secret = "sk-1234567890abcdefghijkl";
    const { helpers, invocations } = harness([
      {
        type: "assistant",
        uuid: "119f5b78-18c0-7b60-8f0c-6afc120ecd7d",
        session_id: SESSION,
        message: {
          id: "assistant-message-1",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning" },
            { type: "text", text: `safe answer ${secret}` },
            { type: "text", text: "second safe paragraph" },
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "private" } },
          ],
        },
        hidden_reasoning: "private hidden reasoning",
      },
      {
        type: "user",
        uuid: "219f5b78-18c0-7b60-8f0c-6afc120ecd7d",
        session_id: SESSION,
        message: {
          role: "user",
          content: [
            { type: "text", text: "safe question" },
            { type: "tool_result", tool_use_id: "tool-1", content: "private result" },
          ],
        },
      },
      {
        type: "system",
        uuid: "319f5b78-18c0-7b60-8f0c-6afc120ecd7d",
        session_id: SESSION,
        message: { role: "system", content: [{ type: "text", text: "safe system" }] },
        raw: { credential: secret },
      },
    ]);

    const page = await helpers.getSessionMessages(SESSION, { limit: 10, offset: 2 });
    expect(page).toEqual({
      messages: [
        {
          id: "119f5b78-18c0-7b60-8f0c-6afc120ecd7d",
          role: "assistant",
          text: "safe answer [REDACTED]\nsecond safe paragraph",
        },
        {
          id: "219f5b78-18c0-7b60-8f0c-6afc120ecd7d",
          role: "user",
          text: "safe question",
        },
        {
          id: "319f5b78-18c0-7b60-8f0c-6afc120ecd7d",
          role: "system",
          text: "safe system",
        },
      ],
      limit: 10,
      offset: 2,
      rawCount: 3,
    });
    expect(JSON.stringify(page)).not.toContain("private");
    expect(JSON.stringify(page)).not.toContain(secret);
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.messages)).toBe(true);
    expect(page.messages.every(Object.isFrozen)).toBe(true);
    expect(JSON.parse(invocations[0]!.stdin)).toEqual({
      version: 1,
      sdkVersion: "0.3.207",
      method: "getSessionMessages",
      args: [SESSION, { dir: CWD, includeSystemMessages: true, limit: 10, offset: 2 }],
    });

    const foreign = harness([{
      type: "assistant",
      uuid: "319f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      session_id: "129f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      message: { role: "assistant", content: [{ type: "text", text: "foreign" }] },
    }]);
    await expect(foreign.helpers.getSessionMessages(SESSION)).rejects.toMatchObject({
      code: "PROTOCOL_FAULT",
    });
  });

  it("skips valid non-text system records such as official compaction boundaries", async () => {
    const compactBoundary = harness([{
      type: "system",
      uuid: "319f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      session_id: SESSION,
      subtype: "compact_boundary",
    }]);

    await expect(compactBoundary.helpers.getSessionMessages(SESSION)).resolves.toEqual({
      messages: [],
      limit: 50,
      offset: 0,
      rawCount: 1,
    });

    const foreignBoundary = harness([{
      type: "system",
      uuid: "319f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      session_id: "129f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      subtype: "compact_boundary",
    }]);
    await expect(foreignBoundary.helpers.getSessionMessages(SESSION)).rejects.toMatchObject({
      code: "PROTOCOL_FAULT",
    });
  });

  it("reports bounded raw rows consumed when text projection skips valid records", async () => {
    const mixed = harness([
      {
        type: "user",
        uuid: "119f5b78-18c0-7b60-8f0c-6afc120ecd7d",
        session_id: SESSION,
        message: { role: "user", content: [{ type: "text", text: "first" }] },
      },
      {
        type: "assistant",
        uuid: "219f5b78-18c0-7b60-8f0c-6afc120ecd7d",
        session_id: SESSION,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: {} }],
        },
      },
      {
        type: "system",
        uuid: "319f5b78-18c0-7b60-8f0c-6afc120ecd7d",
        session_id: SESSION,
        subtype: "compact_boundary",
      },
      {
        type: "assistant",
        uuid: "419f5b78-18c0-7b60-8f0c-6afc120ecd7d",
        session_id: SESSION,
        message: { role: "assistant", content: [{ type: "text", text: "last" }] },
      },
    ]);

    await expect(mixed.helpers.getSessionMessages(SESSION, { limit: 4, offset: 10 }))
      .resolves.toEqual({
        messages: [
          {
            id: "119f5b78-18c0-7b60-8f0c-6afc120ecd7d",
            role: "user",
            text: "first",
          },
          {
            id: "419f5b78-18c0-7b60-8f0c-6afc120ecd7d",
            role: "assistant",
            text: "last",
          },
        ],
        limit: 4,
        offset: 10,
        rawCount: 4,
      });
  });

  it("requires the authoritative top-level SDK message uuid", async () => {
    const aliasesOnly = harness([{
      type: "assistant",
      id: "519f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      session_id: SESSION,
      message: {
        id: "619f5b78-18c0-7b60-8f0c-6afc120ecd7d",
        role: "assistant",
        content: [{ type: "text", text: "must not receive alias identity" }],
      },
    }]);

    await expect(aliasesOnly.helpers.getSessionMessages(SESSION)).rejects.toMatchObject({
      code: "PROTOCOL_FAULT",
    });
  });

  it("rejects a nested role that disagrees with the authoritative top-level type", async () => {
    const mismatched = harness([{
      type: "assistant",
      uuid: "719f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      session_id: SESSION,
      message: {
        role: "user",
        content: [{ type: "text", text: "must not be relabeled" }],
      },
    }]);

    await expect(mismatched.helpers.getSessionMessages(SESSION)).rejects.toMatchObject({
      code: "PROTOCOL_FAULT",
    });
  });

  it("bounds the aggregate text joined into one message snapshot", async () => {
    const oversized = harness([{
      type: "assistant",
      uuid: "819f5b78-18c0-7b60-8f0c-6afc120ecd7d",
      session_id: SESSION,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "a".repeat(20_000) },
          { type: "text", text: "b".repeat(20_000) },
        ],
      },
    }]);

    await expect(oversized.helpers.getSessionMessages(SESSION)).rejects.toMatchObject({
      code: "PROTOCOL_FAULT",
    });
  });

  it("maps info, rename, fork, and delete to the exact official helper calls", async () => {
    const requests: unknown[] = [];
    const runner: ClaudeSessionHelperProcessRunner = async (invocation) => {
      const request = JSON.parse(invocation.stdin) as { method: string };
      requests.push(request);
      const value = request.method === "getSessionInfo"
        ? {
          sessionId: SESSION,
          customTitle: "Info title",
          summary: "Info summary",
          lastModified: Date.parse("2026-07-13T16:01:00.000Z"),
          cwd: CWD,
        }
        : request.method === "forkSession"
          ? { sessionId: "129f5b78-18c0-7b60-8f0c-6afc120ecd7d" }
          : null;
      return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, value })}\n`, stderr: "" };
    };
    const helpers = new ClaudeSessionHelpers({
      configHome: HOME,
      cwd: CWD,
      canonicalizePath: (value) => value,
      runProcess: runner,
    });

    await expect(helpers.getSessionInfo(SESSION)).resolves.toMatchObject({
      sessionId: SESSION,
      title: "Info title",
      fileSize: null,
    });
    await expect(helpers.renameSession(SESSION, "Renamed session")).resolves.toBeUndefined();
    await expect(helpers.forkSession(SESSION))
      .resolves.toBe("129f5b78-18c0-7b60-8f0c-6afc120ecd7d");
    await expect(helpers.forkSession(SESSION, { upToMessageId: MESSAGE }))
      .resolves.toBe("129f5b78-18c0-7b60-8f0c-6afc120ecd7d");
    await expect(helpers.deleteSession(SESSION)).resolves.toBeUndefined();

    expect(requests).toEqual([
      {
        version: 1,
        sdkVersion: "0.3.207",
        method: "getSessionInfo",
        args: [SESSION, { dir: CWD }],
      },
      {
        version: 1,
        sdkVersion: "0.3.207",
        method: "renameSession",
        args: [SESSION, "Renamed session", { dir: CWD }],
      },
      {
        version: 1,
        sdkVersion: "0.3.207",
        method: "forkSession",
        args: [SESSION, { dir: CWD }],
      },
      {
        version: 1,
        sdkVersion: "0.3.207",
        method: "forkSession",
        args: [SESSION, { dir: CWD, upToMessageId: MESSAGE }],
      },
      {
        version: 1,
        sdkVersion: "0.3.207",
        method: "deleteSession",
        args: [SESSION, { dir: CWD }],
      },
    ]);
  });

  it("omits dir from every exact all-projects SDK helper request", async () => {
    const requests: unknown[] = [];
    const invocations: ClaudeSessionHelperInvocation[] = [];
    const runner: ClaudeSessionHelperProcessRunner = async (invocation) => {
      invocations.push(invocation);
      const request = JSON.parse(invocation.stdin) as { method: string };
      requests.push(request);
      const value = request.method === "getSessionInfo"
        ? {
          sessionId: SESSION,
          customTitle: "Global info",
          summary: "Global summary",
          lastModified: Date.parse("2026-07-13T16:01:00.000Z"),
          cwd: CWD,
        }
        : request.method === "forkSession"
          ? { sessionId: "129f5b78-18c0-7b60-8f0c-6afc120ecd7d" }
          : request.method === "listSessions" || request.method === "getSessionMessages"
            ? []
            : null;
      return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, value })}\n`, stderr: "" };
    };
    const helpers = new ClaudeSessionHelpers({
      configHome: HOME,
      cwd: CWD,
      scope: "all-projects",
      canonicalizePath: (value) => value,
      runProcess: runner,
    });

    await expect(helpers.listSessions({ limit: 7, offset: 4 })).resolves.toEqual([]);
    await expect(helpers.getSessionInfo(SESSION)).resolves.toMatchObject({
      sessionId: SESSION,
    });
    await expect(helpers.getSessionMessages(SESSION, { limit: 8, offset: 5 })).resolves.toEqual({
      messages: [],
      limit: 8,
      offset: 5,
      rawCount: 0,
    });
    await expect(helpers.renameSession(SESSION, "Global rename")).resolves.toBeUndefined();
    await expect(helpers.forkSession(SESSION))
      .resolves.toBe("129f5b78-18c0-7b60-8f0c-6afc120ecd7d");
    await expect(helpers.forkSession(SESSION, { upToMessageId: MESSAGE }))
      .resolves.toBe("129f5b78-18c0-7b60-8f0c-6afc120ecd7d");
    await expect(helpers.deleteSession(SESSION)).resolves.toBeUndefined();

    expect(invocations.every((invocation) => invocation.cwd === CWD)).toBe(true);
    expect(requests).toEqual([
      {
        version: 1,
        sdkVersion: "0.3.207",
        method: "listSessions",
        args: [{ includeProgrammatic: true, limit: 7, offset: 4 }],
      },
      {
        version: 1,
        sdkVersion: "0.3.207",
        method: "getSessionInfo",
        args: [SESSION, {}],
      },
      {
        version: 1,
        sdkVersion: "0.3.207",
        method: "getSessionMessages",
        args: [SESSION, { includeSystemMessages: true, limit: 8, offset: 5 }],
      },
      {
        version: 1,
        sdkVersion: "0.3.207",
        method: "renameSession",
        args: [SESSION, "Global rename", {}],
      },
      {
        version: 1,
        sdkVersion: "0.3.207",
        method: "forkSession",
        args: [SESSION, {}],
      },
      {
        version: 1,
        sdkVersion: "0.3.207",
        method: "forkSession",
        args: [SESSION, { upToMessageId: MESSAGE }],
      },
      {
        version: 1,
        sdkVersion: "0.3.207",
        method: "deleteSession",
        args: [SESSION, {}],
      },
    ]);
  });

  it("enforces one process-wide capacity gate across project and all-project scopes", async () => {
    expect(CLAUDE_SESSION_HELPER_MAX_CONCURRENT_PROCESSES).toBe(4);
    const releases: Array<(result: {
      exitCode: number;
      stdout: string;
      stderr: string;
    }) => void> = [];
    let started = 0;
    const runner: ClaudeSessionHelperProcessRunner = vi.fn(() => {
      started += 1;
      return new Promise((resolve) => releases.push(resolve));
    });
    const project = new ClaudeSessionHelpers({
      configHome: HOME,
      cwd: CWD,
      scope: "project",
      canonicalizePath: (value) => value,
      runProcess: runner,
    });
    const global = new ClaudeSessionHelpers({
      configHome: HOME,
      cwd: CWD,
      scope: "all-projects",
      canonicalizePath: (value) => value,
      runProcess: runner,
    });

    const active = Array.from(
      { length: CLAUDE_SESSION_HELPER_MAX_CONCURRENT_PROCESSES },
      (_, index) => (index % 2 === 0 ? project : global).listSessions({ limit: 1 }),
    );
    const overflow = global.listSessions({ limit: 1 }).then(
      () => ({ status: "fulfilled" as const }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    const initiallyStarted = started;
    for (const release of releases.splice(0)) {
      release({ exitCode: 0, stdout: '{"ok":true,"value":[]}\n', stderr: "" });
    }

    await expect(Promise.all(active)).resolves.toEqual([[], [], [], []]);
    expect(initiallyStarted).toBe(CLAUDE_SESSION_HELPER_MAX_CONCURRENT_PROCESSES);
    expect(runner).toHaveBeenCalledTimes(CLAUDE_SESSION_HELPER_MAX_CONCURRENT_PROCESSES);
    await expect(overflow).resolves.toMatchObject({
      status: "rejected",
      reason: { code: "CAPACITY" },
    });

    const afterRelease = project.listSessions({ limit: 1 });
    expect(runner).toHaveBeenCalledTimes(CLAUDE_SESSION_HELPER_MAX_CONCURRENT_PROCESSES + 1);
    releases.shift()?.({ exitCode: 0, stdout: '{"ok":true,"value":[]}\n', stderr: "" });
    await expect(afterRelease).resolves.toEqual([]);
  });

  it("charges each production helper child exactly once against the process-wide gate", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "devhub-claude-helper-capacity-"));
    const configHome = path.join(root, "claude-home");
    const cwd = path.join(root, "project");
    mkdirSync(configHome);
    mkdirSync(cwd);
    try {
      const helpers = new ClaudeSessionHelpers({
        configHome,
        cwd,
        scope: "all-projects",
        canonicalizePath: (value) => value,
      });
      const calls = Array.from(
        { length: CLAUDE_SESSION_HELPER_MAX_CONCURRENT_PROCESSES },
        () => helpers.listSessions({ limit: 1 }),
      );
      await expect(Promise.all(calls)).resolves.toEqual([[], [], [], []]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects invalid helper scopes", () => {
    for (const scope of ["all", "ALL-PROJECTS", "", null, 1]) {
      expect(() => new ClaudeSessionHelpers({
        configHome: HOME,
        cwd: CWD,
        scope: scope as "project",
        canonicalizePath: (value) => value,
      })).toThrow(/configuration/i);
    }
  });

  it("rejects unsafe session file sizes", async () => {
    for (const fileSize of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      const unsafe = harness([{
        sessionId: SESSION,
        summary: "Unsafe revision",
        cwd: CWD,
        lastModified: Date.parse("2026-07-13T16:01:00.000Z"),
        fileSize,
      }]);
      await expect(unsafe.helpers.listSessions()).rejects.toMatchObject({
        code: "PROTOCOL_FAULT",
      });
    }
  });

  it("rejects invalid pagination, ids, names, and non-canonical ownership before spawning", async () => {
    const { helpers, runner } = harness([]);
    await expect(helpers.listSessions({ limit: 0 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(helpers.listSessions({ offset: -1 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(helpers.getSessionInfo("not-a-uuid")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(helpers.renameSession(SESSION, "")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(helpers.forkSession(SESSION, { upToMessageId: "not-a-uuid" }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(runner).not.toHaveBeenCalled();

    expect(() => new ClaudeSessionHelpers({
      configHome: "/not-canonical",
      cwd: CWD,
      canonicalizePath: () => HOME,
    })).toThrow(/configuration/i);
  });

  it("fails closed on abort, process failure, SDK errors, oversized output, and extra JSON", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const { helpers, runner } = harness([]);
    await expect(helpers.listSessions({ signal: aborted.signal })).rejects.toMatchObject({
      code: "ABORTED",
    });
    expect(runner).not.toHaveBeenCalled();

    const outcomes = [
      { exitCode: 1, stdout: "", stderr: "provider-secret" },
      { exitCode: 0, stdout: '{"ok":false,"code":"SDK_FAILURE"}\n', stderr: "" },
      { exitCode: 0, stdout: `${"x".repeat(2 * 1024 * 1024 + 1)}\n`, stderr: "" },
      {
        exitCode: 0,
        stdout: '{"ok":true,"value":[]}\n{"ok":true,"value":[]}\n',
        stderr: "",
      },
    ];
    for (const outcome of outcomes) {
      const failing = new ClaudeSessionHelpers({
        configHome: HOME,
        cwd: CWD,
        canonicalizePath: (value) => value,
        runProcess: async () => outcome,
      });
      await expect(failing.listSessions()).rejects.toMatchObject({
        code: expect.stringMatching(/^(PROCESS_FAILED|SDK_FAILED|PROTOCOL_FAULT)$/u),
        message: expect.not.stringContaining("provider-secret"),
      });
    }
  });

  it("contains runner rejection and hostile helper values without reflecting secrets", async () => {
    const secret = "runner-or-helper-secret";
    const throwing = new ClaudeSessionHelpers({
      configHome: HOME,
      cwd: CWD,
      canonicalizePath: (value) => value,
      runProcess: async () => {
        throw new Error(secret);
      },
    });
    await expect(throwing.listSessions()).rejects.toMatchObject({
      code: "PROCESS_FAILED",
      message: expect.not.stringContaining(secret),
    });

    const hostile = new ClaudeSessionHelpers({
      configHome: HOME,
      cwd: CWD,
      canonicalizePath: (value) => value,
      runProcess: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify({
          ok: true,
          value: [{
            sessionId: SESSION,
            title: secret,
            extra: { hidden_reasoning: secret },
          }],
        })}\n`,
        stderr: "",
      }),
    });
    await expect(hostile.listSessions()).rejects.toMatchObject({
      code: "PROTOCOL_FAULT",
      message: expect.not.stringContaining(secret),
    });
  });
});
