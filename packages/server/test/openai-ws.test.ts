import { EventEmitter } from "node:events";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerOpenAIWs } from "../src/openai-ws.js";
import { openAISessions } from "../src/routes/openai.js";

const ACCESS_TOKEN = "test-access-token";

class FakeOpenAISession extends EventEmitter {
  readonly model = "gpt-4.1";
  readonly cwd = "/workspace";
  readonly localToolsEnabled = false as const;
  readonly messages: unknown[] = [];
  readonly sends: string[] = [];
  stopCalls = 0;

  async send(text: string): Promise<void> {
    this.sends.push(text);
  }

  stop(): void {
    this.stopCalls += 1;
  }
}

class PendingOpenAISession extends FakeOpenAISession {
  activeRequests = 0;
  private finishActiveRequest: (() => void) | undefined;

  override send(text: string): Promise<void> {
    this.sends.push(text);
    this.activeRequests += 1;

    if (this.activeRequests > 1) {
      return Promise.reject(new Error("provider received an overlapping send"));
    }

    return new Promise<void>((resolve) => {
      this.finishActiveRequest = () => {
        this.activeRequests -= 1;
        this.finishActiveRequest = undefined;
        resolve();
      };
    });
  }

  override stop(): void {
    super.stop();
    this.finishActiveRequest?.();
  }

  completeActiveRequest(): void {
    this.finishActiveRequest?.();
  }
}

type OpenAIWsOptions = { enabled?: boolean; token?: string };
type TestSocket = Awaited<ReturnType<FastifyInstance["injectWS"]>>;

let app: FastifyInstance;

async function readyWsApp(options: OpenAIWsOptions): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(websocket);
  (registerOpenAIWs as unknown as (
    app: FastifyInstance,
    options: OpenAIWsOptions,
  ) => void)(instance, options);
  await instance.ready();
  return instance;
}

function putSession(id: string, session: FakeOpenAISession): void {
  (openAISessions as unknown as Map<string, FakeOpenAISession>).set(id, session);
}

function nextFrame(socket: TestSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for frame")), 1_000);
    socket.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)) as Record<string, unknown>);
    });
  });
}

function nextClose(socket: TestSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for close")), 1_000);
    socket.once("close", (code, rawReason) => {
      clearTimeout(timer);
      resolve({ code, reason: String(rawReason) });
    });
  });
}

async function connect(
  path: string,
  origin = "http://localhost:5173",
): Promise<TestSocket> {
  return app.injectWS(path, {
    headers: {
      origin,
      host: "127.0.0.1:8787",
    },
  });
}

beforeEach(() => {
  openAISessions.clear();
});

afterEach(async () => {
  for (const session of openAISessions.values()) session.stop();
  openAISessions.clear();
  if (app) await app.close();
});

describe("OpenAI Chat WebSocket security boundary", () => {
  it("cannot send while the feature is disabled", async () => {
    const session = new FakeOpenAISession();
    putSession("existing", session);
    app = await readyWsApp({ enabled: false, token: ACCESS_TOKEN });

    const socket = await connect("/api/ws/openai/existing");
    const closed = nextClose(socket);
    socket.send(JSON.stringify({ type: "authenticate", token: ACCESS_TOKEN }));
    socket.send(JSON.stringify({ type: "send", text: "billable" }));

    expect((await closed).code).toBe(1008);
    expect(session.sends).toEqual([]);
  });

  it("requires authentication as the first frame before session lookup or send", async () => {
    const session = new FakeOpenAISession();
    putSession("existing", session);
    app = await readyWsApp({ enabled: true, token: ACCESS_TOKEN });

    const socket = await connect("/api/ws/openai/existing");
    const closed = nextClose(socket);
    socket.send(JSON.stringify({ type: "send", text: "billable" }));

    const result = await closed;
    expect(result.code).toBe(1008);
    expect(result.reason).toMatch(/unauthorized/i);
    expect(session.sends).toEqual([]);
  });

  it("never treats a URL query token as WebSocket authentication", async () => {
    const session = new FakeOpenAISession();
    putSession("existing", session);
    app = await readyWsApp({ enabled: true, token: ACCESS_TOKEN });

    const socket = await connect(`/api/ws/openai/existing?token=${ACCESS_TOKEN}`);
    const closed = nextClose(socket);
    socket.send(JSON.stringify({ type: "send", text: "billable" }));

    expect((await closed).code).toBe(1008);
    expect(session.sends).toEqual([]);
  });

  it("rejects a hostile browser Origin before an authenticated send", async () => {
    const session = new FakeOpenAISession();
    putSession("existing", session);
    app = await readyWsApp({ enabled: true, token: ACCESS_TOKEN });

    const socket = await connect("/api/ws/openai/existing", "https://hostile.example");
    const closed = nextClose(socket);
    socket.send(JSON.stringify({ type: "authenticate", token: ACCESS_TOKEN }));
    socket.send(JSON.stringify({ type: "send", text: "billable" }));

    expect((await closed).code).toBe(1008);
    expect(session.sends).toEqual([]);
  });

  it("authenticates by first frame, then sends only through an existing session", async () => {
    const session = new FakeOpenAISession();
    putSession("existing", session);
    app = await readyWsApp({ enabled: true, token: ACCESS_TOKEN });

    const socket = await connect("/api/ws/openai/existing");
    const authenticated = nextFrame(socket);
    socket.send(JSON.stringify({ type: "authenticate", token: ACCESS_TOKEN }));
    expect(await authenticated).toEqual({ type: "authenticated", sessionId: "existing" });

    socket.send(JSON.stringify({ type: "send", text: "hello" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.sends).toEqual(["hello"]);

    socket.close();
  });

  it("reports busy without invoking a second overlapping send", async () => {
    const session = new PendingOpenAISession();
    putSession("existing", session);
    app = await readyWsApp({ enabled: true, token: ACCESS_TOKEN });

    const socket = await connect("/api/ws/openai/existing");
    const authenticated = nextFrame(socket);
    socket.send(JSON.stringify({ type: "authenticate", token: ACCESS_TOKEN }));
    await authenticated;

    socket.send(JSON.stringify({ type: "send", text: "first billable request" }));
    await vi.waitFor(() => expect(session.sends).toEqual(["first billable request"]));

    const busy = nextFrame(socket);
    socket.send(JSON.stringify({ type: "send", text: "must not start" }));

    expect(await busy).toEqual({ type: "error", message: "session busy" });
    expect(session.sends).toEqual(["first billable request"]);
    expect(session.activeRequests).toBe(1);

    socket.close();
  });

  it("serializes sends across two sockets sharing one session", async () => {
    const session = new PendingOpenAISession();
    putSession("existing", session);
    app = await readyWsApp({ enabled: true, token: ACCESS_TOKEN });

    const ownerSocket = await connect("/api/ws/openai/existing");
    const ownerAuthenticated = nextFrame(ownerSocket);
    ownerSocket.send(JSON.stringify({ type: "authenticate", token: ACCESS_TOKEN }));
    await ownerAuthenticated;

    const peerSocket = await connect("/api/ws/openai/existing");
    const peerAuthenticated = nextFrame(peerSocket);
    peerSocket.send(JSON.stringify({ type: "authenticate", token: ACCESS_TOKEN }));
    await peerAuthenticated;

    ownerSocket.send(JSON.stringify({ type: "send", text: "owner request" }));
    await vi.waitFor(() => expect(session.sends).toEqual(["owner request"]));

    const busy = nextFrame(peerSocket);
    peerSocket.send(JSON.stringify({ type: "send", text: "must not overlap" }));

    expect(await busy).toEqual({ type: "error", message: "session busy" });
    expect(session.sends).toEqual(["owner request"]);
    expect(session.activeRequests).toBe(1);

    const peerClosed = nextClose(peerSocket);
    peerSocket.terminate();
    await peerClosed;
    expect(session.stopCalls).toBe(0);
    expect(session.activeRequests).toBe(1);

    ownerSocket.close();
  });

  it("does not let a peer stop another socket's active send", async () => {
    const session = new PendingOpenAISession();
    putSession("existing", session);
    app = await readyWsApp({ enabled: true, token: ACCESS_TOKEN });

    const ownerSocket = await connect("/api/ws/openai/existing");
    const ownerAuthenticated = nextFrame(ownerSocket);
    ownerSocket.send(JSON.stringify({ type: "authenticate", token: ACCESS_TOKEN }));
    await ownerAuthenticated;

    const peerSocket = await connect("/api/ws/openai/existing");
    const peerAuthenticated = nextFrame(peerSocket);
    peerSocket.send(JSON.stringify({ type: "authenticate", token: ACCESS_TOKEN }));
    await peerAuthenticated;

    ownerSocket.send(JSON.stringify({ type: "send", text: "owner request" }));
    await vi.waitFor(() => expect(session.activeRequests).toBe(1));

    const busy = nextFrame(peerSocket);
    peerSocket.send(JSON.stringify({ type: "stop" }));

    expect(await busy).toEqual({ type: "error", message: "session busy" });
    expect(session.stopCalls).toBe(0);
    expect(session.activeRequests).toBe(1);

    peerSocket.close();
    ownerSocket.close();
  });

  it("does not let a former owner close abort a newer owner's send", async () => {
    const session = new PendingOpenAISession();
    putSession("existing", session);
    app = await readyWsApp({ enabled: true, token: ACCESS_TOKEN });

    const firstSocket = await connect("/api/ws/openai/existing");
    const firstAuthenticated = nextFrame(firstSocket);
    firstSocket.send(JSON.stringify({ type: "authenticate", token: ACCESS_TOKEN }));
    await firstAuthenticated;

    const secondSocket = await connect("/api/ws/openai/existing");
    const secondAuthenticated = nextFrame(secondSocket);
    secondSocket.send(JSON.stringify({ type: "authenticate", token: ACCESS_TOKEN }));
    await secondAuthenticated;

    firstSocket.send(JSON.stringify({ type: "send", text: "first request" }));
    await vi.waitFor(() => expect(session.activeRequests).toBe(1));
    session.completeActiveRequest();
    await vi.waitFor(() => expect(session.activeRequests).toBe(0));

    secondSocket.send(JSON.stringify({ type: "send", text: "second request" }));
    await vi.waitFor(() => expect(session.activeRequests).toBe(1));

    const firstClosed = nextClose(firstSocket);
    firstSocket.terminate();
    await firstClosed;
    expect(session.stopCalls).toBe(0);
    expect(session.activeRequests).toBe(1);

    secondSocket.close();
  });

  it("never auto-creates a missing session after authentication", async () => {
    app = await readyWsApp({ enabled: true, token: ACCESS_TOKEN });

    const socket = await connect("/api/ws/openai/missing");
    const frame = nextFrame(socket);
    const closed = nextClose(socket);
    socket.send(JSON.stringify({ type: "authenticate", token: ACCESS_TOKEN }));

    expect(await frame).toMatchObject({ type: "error", message: "session not found" });
    expect((await closed).code).toBe(1008);
    expect(openAISessions.size).toBe(0);
  });

  it("forwards the canonical engine event field names", async () => {
    const session = new FakeOpenAISession();
    putSession("existing", session);
    app = await readyWsApp({ enabled: true, token: ACCESS_TOKEN });

    const socket = await connect("/api/ws/openai/existing");
    const authenticated = nextFrame(socket);
    socket.send(JSON.stringify({ type: "authenticate", token: ACCESS_TOKEN }));
    await authenticated;

    const tokenFrame = nextFrame(socket);
    session.emit("event", { type: "token", token: "hello" });
    expect(await tokenFrame).toEqual({ type: "token", token: "hello" });

    const toolStart = nextFrame(socket);
    session.emit("event", { type: "tool_start", id: "call-1", name: "tool", args: "{}" });
    expect(await toolStart).toEqual({
      type: "tool_start",
      id: "call-1",
      name: "tool",
      args: "{}",
    });

    const toolEnd = nextFrame(socket);
    session.emit("event", { type: "tool_end", id: "call-1", result: "done" });
    expect(await toolEnd).toEqual({
      type: "tool_end",
      id: "call-1",
      result: "done",
    });

    socket.close();
  });

  it("stops the active provider request on a stop frame", async () => {
    const session = new PendingOpenAISession();
    putSession("existing", session);
    app = await readyWsApp({ enabled: true, token: ACCESS_TOKEN });

    const socket = await connect("/api/ws/openai/existing");
    const authenticated = nextFrame(socket);
    socket.send(JSON.stringify({ type: "authenticate", token: ACCESS_TOKEN }));
    await authenticated;

    socket.send(JSON.stringify({ type: "send", text: "billable" }));
    await vi.waitFor(() => expect(session.activeRequests).toBe(1));

    const stopped = nextFrame(socket);
    socket.send(JSON.stringify({ type: "stop" }));
    expect(await stopped).toEqual({ type: "stopped", sessionId: "existing" });
    expect(session.stopCalls).toBe(1);
    expect(session.activeRequests).toBe(0);

    socket.close();
  });

  it("stops the active provider request when the socket closes", async () => {
    const session = new PendingOpenAISession();
    putSession("existing", session);
    app = await readyWsApp({ enabled: true, token: ACCESS_TOKEN });

    const socket = await connect("/api/ws/openai/existing");
    const authenticated = nextFrame(socket);
    socket.send(JSON.stringify({ type: "authenticate", token: ACCESS_TOKEN }));
    await authenticated;

    socket.send(JSON.stringify({ type: "send", text: "billable" }));
    await vi.waitFor(() => expect(session.activeRequests).toBe(1));

    const closed = nextClose(socket);
    socket.terminate();
    await closed;
    await vi.waitFor(() => expect(session.stopCalls).toBe(1));
    expect(session.activeRequests).toBe(0);
  });
});
