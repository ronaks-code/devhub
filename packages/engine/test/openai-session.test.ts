import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as openAI from "../src/openai-session.js";
import { OpenAISession } from "../src/openai-session.js";
import type { OpenAIMessage, OpenAISessionOptions } from "../src/openai-session.js";

type CompletionRequestBody = {
  model: string;
  stream: boolean;
  messages: OpenAIMessage[];
  tools?: unknown;
};

type CompletionRequestBodyBuilder = (input: {
  model: string;
  messages: OpenAIMessage[];
  systemPrompt?: string;
}) => CompletionRequestBody;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("OpenAI Chat quarantine", () => {
  it("builds the default completion payload without tools or local-tool claims", () => {
    const buildRequestBody = (
      openAI as unknown as {
        buildOpenAICompletionRequestBody?: CompletionRequestBodyBuilder;
      }
    ).buildOpenAICompletionRequestBody;

    expect(buildRequestBody, "a test-visible request-body seam is required").toBeTypeOf(
      "function",
    );
    if (!buildRequestBody) return;

    const body = buildRequestBody({ model: "gpt-4.1", messages: [] });
    expect(body).not.toHaveProperty("tools");

    const systemMessage = body.messages[0];
    expect(systemMessage?.role).toBe("system");
    expect(systemMessage?.content).not.toMatch(/\bbash\b|read_file|write_file|local tools?/i);
  });

  it("cannot enable local tools through public session options", () => {
    const attemptedOptIn = {
      model: "gpt-4.1",
      tools: true,
      localToolsEnabled: true,
    } as unknown as OpenAISessionOptions;

    const session = new OpenAISession(attemptedOptIn);
    expect(
      (session as unknown as { localToolsEnabled?: boolean }).localToolsEnabled,
    ).toBe(false);
  });

  it("fails closed before bash, read_file, or write_file can touch the filesystem", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "devhub-openai-quarantine-"));
    tempDirs.push(dir);

    const bashSentinel = path.join(dir, "bash-ran");
    const writeSentinel = path.join(dir, "write-ran");
    const readableSecret = path.join(dir, "readable-secret");
    writeFileSync(readableSecret, "must-not-be-read", "utf8");

    const session = new OpenAISession({ cwd: dir });
    const executeTool = (
      session as unknown as {
        _executeTool(name: string, argsJson: string): Promise<string>;
      }
    )._executeTool.bind(session);

    const attempts = await Promise.allSettled([
      executeTool("bash", JSON.stringify({ command: `touch ${bashSentinel}` })),
      executeTool("read_file", JSON.stringify({ path: readableSecret })),
      executeTool(
        "write_file",
        JSON.stringify({ path: writeSentinel, content: "must-not-be-written" }),
      ),
    ]);

    expect(attempts).toHaveLength(3);
    for (const attempt of attempts) {
      expect(attempt.status).toBe("rejected");
      if (attempt.status === "rejected") {
        expect(String(attempt.reason)).toContain("Local tools are disabled");
      }
    }
    expect(existsSync(bashSentinel)).toBe(false);
    expect(existsSync(writeSentinel)).toBe(false);
  });
});

describe("OpenAI Chat request concurrency", () => {
  it("rejects an overlapping send and keeps stop attached to the original request", async () => {
    const session = new OpenAISession();
    const pending: Array<() => void> = [];
    const signals: Array<AbortSignal | undefined> = [];
    const streamCompletion = vi.fn(
      (
        _onToken: (token: string) => void,
        _onToolDelta: (
          index: number,
          id: string | undefined,
          name: string | undefined,
          argsDelta: string | undefined,
        ) => void,
        _onFinishReason: (reason: string) => void,
        _onUsage: (input: number, output: number) => void,
        signal?: AbortSignal,
      ) =>
        new Promise<void>((resolve) => {
          signals.push(signal);
          pending.push(resolve);
          signal?.addEventListener("abort", resolve, { once: true });
        }),
    );

    (
      session as unknown as {
        _streamCompletion: typeof streamCompletion;
      }
    )._streamCompletion = streamCompletion;

    const first = session.send("first billable request");
    await vi.waitFor(() => expect(streamCompletion).toHaveBeenCalledTimes(1));

    const secondOutcome = session.send("must not start").then(
      () => ({ status: "fulfilled" as const, error: undefined }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    session.stop();
    for (const resolve of pending) resolve();
    await first;
    const second = await secondOutcome;

    expect(streamCompletion).toHaveBeenCalledTimes(1);
    expect(second.status).toBe("rejected");
    expect(String(second.error)).toMatch(/busy|already.*progress/i);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(session.messages.filter((message) => message.role === "user")).toEqual([
      { role: "user", content: "first billable request" },
    ]);
  });
});
