import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as openAIPane from "./OpenAIPane.js";
import { openaiApi } from "../lib/api.js";

const ACCESS_TOKEN = "test-access-token";

interface Handlers {
  onToken: (text: string) => void;
  onToolStart: (id: string, toolName: string, input?: string) => void;
  onToolEnd: (id: string, output: string) => void;
  onTurnDone: () => void;
  onError: (message: string) => void;
}

interface Connection {
  send: (payload: { type: "send"; text: string }) => void;
  stop: () => void;
  close: () => void;
}

type OpenChat = (sessionId: string, handlers: Handlers) => Connection;

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(raw: string): void {
    this.sent.push(raw);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

function handlers(): Handlers {
  return {
    onToken: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onTurnDone: vi.fn(),
    onError: vi.fn(),
  };
}

function openChat(): OpenChat | undefined {
  return (openAIPane as unknown as { openOpenAIChat?: OpenChat }).openOpenAIChat;
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  vi.stubGlobal("location", { protocol: "http:", host: "localhost:5173" });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: () => ACCESS_TOKEN,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI Chat browser-safe WebSocket contract", () => {
  it("uses canonical session envelopes and an authenticated REST stop", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: "session-1", localToolsEnabled: false }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, sessionId: "session-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const created = await (
      openaiApi.createSession as unknown as (input: {
        model: string;
        cwd: string;
      }) => Promise<{ sessionId: string }>
    )({ model: "gpt-4.1", cwd: "/workspace" });
    expect(created.sessionId).toBe("session-1");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/openai/sessions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: `Bearer ${ACCESS_TOKEN}` }),
        body: JSON.stringify({ model: "gpt-4.1", cwd: "/workspace" }),
      }),
    );

    const stopSession = (
      openaiApi as unknown as {
        stopSession?: (sessionId: string) => Promise<{ ok: boolean; sessionId: string }>;
      }
    ).stopSession;
    expect(stopSession).toBeTypeOf("function");
    if (!stopSession) return;
    await stopSession("session-1");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/openai/sessions/session-1/stop",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: `Bearer ${ACCESS_TOKEN}` }),
      }),
    );
  });

  it("keeps the token out of the URL and authenticates before queued sends", () => {
    const open = openChat();
    expect(open).toBeTypeOf("function");
    if (!open) return;

    const connection = open("session-1", handlers());
    connection.send({ type: "send", text: "hello" });
    const socket = FakeWebSocket.instances[0]!;
    expect(socket.url).toBe("ws://localhost:5173/api/ws/openai/session-1");

    socket.open();
    expect(socket.sent.map((raw) => JSON.parse(raw))).toEqual([
      { type: "authenticate", token: ACCESS_TOKEN },
      { type: "send", text: "hello" },
    ]);
    connection.close();
  });

  it("maps canonical token/name/args/result event fields into UI handlers", () => {
    const open = openChat();
    expect(open).toBeTypeOf("function");
    if (!open) return;

    const callbacks = handlers();
    const connection = open("session-1", callbacks);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.receive({ type: "token", token: "hello" });
    socket.receive({ type: "tool_start", id: "call-1", name: "tool", args: "{}" });
    socket.receive({ type: "tool_end", id: "call-1", result: "done" });

    expect(callbacks.onToken).toHaveBeenCalledWith("hello");
    expect(callbacks.onToolStart).toHaveBeenCalledWith("call-1", "tool", "{}");
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("call-1", "done");
    connection.close();
  });

  it("sends an explicit stop frame before closing an active connection", () => {
    const open = openChat();
    expect(open).toBeTypeOf("function");
    if (!open) return;

    const connection = open("session-1", handlers());
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    connection.stop();

    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: "stop" });
    connection.close();
  });

  it("also sends stop during UI teardown before closing the socket", () => {
    const open = openChat();
    expect(open).toBeTypeOf("function");
    if (!open) return;

    const connection = open("session-1", handlers());
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    connection.close();

    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: "stop" });
    expect(socket.readyState).toBe(3);
  });

  it("fails closed without an access token instead of sending a billable frame", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    });
    const open = openChat();
    expect(open).toBeTypeOf("function");
    if (!open) return;

    const callbacks = handlers();
    const connection = open("session-1", callbacks);
    connection.send({ type: "send", text: "must not send" });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    expect(socket.sent).toEqual([]);
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.stringMatching(/access token|authentication/i),
    );
    connection.close();
  });
});
