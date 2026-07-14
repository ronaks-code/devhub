import Fastify from "fastify";
import {
  ProviderRegistry,
  createNativeTaskKey,
  createProviderRequestIdentity,
  defineProviderCapabilities,
  type ListTasksInput,
  type NativeTask,
  type NativeTaskKey,
  type NativeTurn,
  type NativeTurnRef,
  type Page,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderEventSink,
  type ProviderRequestResponse,
  type StartTaskInput,
  type TaskOverrides,
  type Unsubscribe,
  type UserInput,
} from "../../../packages/engine/src/providers/index.ts";
import { registerProviderTaskRoutes } from "../../../packages/server/src/routes/provider-tasks.ts";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const PROVIDER_DELAY_MS = Math.max(0, Number(process.env.M3_FIXTURE_PROVIDER_DELAY_MS ?? 0));
const UNSUPPORTED_MODE = process.env.M3_FIXTURE_UNSUPPORTED === "1";
const PROVIDER = process.env.DEVHUB_FIXTURE_PROVIDER === "anthropic" ? "anthropic" : "openai";
const IS_CLAUDE = PROVIDER === "anthropic";
const HOME = IS_CLAUDE
  ? "/tmp/devhub-m4-synthetic-claude-home"
  : "/tmp/devhub-m3-synthetic-home";
const NOW = "2026-07-13T12:00:00.000Z";

const capabilities = defineProviderCapabilities({
  list: true,
  read: true,
  start: !UNSUPPORTED_MODE,
  resume: !UNSUPPORTED_MODE,
  fork: !UNSUPPORTED_MODE,
  send: !UNSUPPORTED_MODE,
  steer: false,
  interrupt: !UNSUPPORTED_MODE,
  subscribe: true,
  approveCommand: !UNSUPPORTED_MODE && !IS_CLAUDE,
  approveFileChange: !UNSUPPORTED_MODE,
  approvePermissions: !UNSUPPORTED_MODE && !IS_CLAUDE,
  requestUserInput: !UNSUPPORTED_MODE && !IS_CLAUDE,
  mcpElicitation: !UNSUPPORTED_MODE && !IS_CLAUDE,
  archive: !UNSUPPORTED_MODE,
  rename: !UNSUPPORTED_MODE,
});

function key(nativeTaskId: string): NativeTaskKey {
  return createNativeTaskKey(PROVIDER, HOME, nativeTaskId);
}

function eventBase(nativeTaskId: string) {
  return { provider: PROVIDER, key: key(nativeTaskId), occurredAt: NOW };
}

function commandRequest(nativeTaskId: string, turnId: string): ProviderEvent {
  return {
    ...eventBase(nativeTaskId),
    type: "request",
    request: {
      kind: "command-approval",
      identity: createProviderRequestIdentity({
        key: key(nativeTaskId),
        generation: 1,
        turnId,
        requestId: `request-${nativeTaskId}`,
        itemId: "tool-approval",
        approvalId: "approval-1",
      }),
    },
  };
}

function userInputRequest(nativeTaskId: string, turnId: string): ProviderEvent {
  return {
    ...eventBase(nativeTaskId),
    type: "request",
    request: {
      kind: "user-input",
      identity: createProviderRequestIdentity({
        key: key(nativeTaskId),
        generation: 1,
        turnId,
        requestId: `input-${nativeTaskId}`,
        itemId: "input-request",
        approvalId: null,
      }),
      autoResolutionMs: null,
    },
  };
}

const activeEvents: ProviderEvent[] = [
  { ...eventBase("fixture-active"), type: "message", role: "user", text: "Verify the release and summarize the result.", turnId: "turn-active", itemId: "user-1" },
  { ...eventBase("fixture-active"), type: "message", role: "assistant", text: "I’m checking the release gates and will keep the native plan current.", turnId: "turn-active", itemId: "assistant-1" },
  { ...eventBase("fixture-active"), type: "plan", turnId: "turn-active", itemId: null, stepIndex: 0, text: "Inspect provider state", status: "completed" },
  { ...eventBase("fixture-active"), type: "plan", turnId: "turn-active", itemId: null, stepIndex: 1, text: "Run bounded verification", status: "inProgress" },
  { ...eventBase("fixture-active"), type: "plan", turnId: "turn-active", itemId: null, stepIndex: 2, text: "Report evidence", status: "pending" },
  { ...eventBase("fixture-active"), type: "activity", turnId: "turn-active", itemId: "tool-1", activity: "shell", status: "running", message: "pnpm test" },
  commandRequest("fixture-active", "turn-active"),
  { ...eventBase("fixture-active"), type: "diff-summary", turnId: "turn-active", changedFiles: 3, additions: 42, deletions: 7 },
  { ...eventBase("fixture-active"), type: "usage", turnId: "turn-active", inputTokens: 1200, outputTokens: 320, cachedInputTokens: 800, totalTokens: 1520 },
  { ...eventBase("fixture-active"), type: "status", scope: "turn", status: "inProgress", nativeId: "turn-active" },
];

const longTranscriptEvents: ProviderEvent[] = Array.from(
  { length: 600 },
  (_, index): ProviderEvent => ({
    ...eventBase("fixture-long"),
    type: "message",
    role: index % 2 === 0 ? "user" : "assistant",
    text: `Long transcript message ${index + 1}: bounded virtualization evidence.`,
    turnId: "turn-long",
    itemId: `message-${index + 1}`,
  }),
);

function makeTask(nativeTaskId: string, title: string, turns: NativeTurn[] = []): NativeTask {
  return {
    key: key(nativeTaskId),
    title,
    cwd: "/workspace/devhub-fixture",
    model: IS_CLAUDE ? null : "gpt-5.4",
    status: turns.some((turn) => turn.status === "inProgress") ? "active" : "idle",
    createdAt: NOW,
    updatedAt: NOW,
    archived: false,
    source: "native",
    turns,
  };
}

const tasks = new Map<string, NativeTask>([
  ["fixture-active", makeTask("fixture-active", "Release verification", [{
    id: "turn-active",
    status: "inProgress",
    startedAt: NOW,
    completedAt: null,
    events: activeEvents,
  }])],
  ["fixture-empty", makeTask("fixture-empty", "Empty native task")],
  ["fixture-long", makeTask("fixture-long", "Long native transcript", [{
    id: "turn-long",
    status: "completed",
    startedAt: NOW,
    completedAt: NOW,
    events: longTranscriptEvents,
  }])],
  ["fixture-input", makeTask("fixture-input", "Input request guard", [{
    id: "turn-input",
    status: "inProgress",
    startedAt: NOW,
    completedAt: null,
    events: [
      userInputRequest("fixture-input", "turn-input"),
      { ...eventBase("fixture-input"), type: "status", scope: "turn", status: "inProgress", nativeId: "turn-input" },
    ],
  }])],
]);
const subscribers = new Map<string, Set<ProviderEventSink>>();
let sequence = 0;

function cloneTask(task: NativeTask, includeTurns = true): NativeTask {
  return structuredClone({ ...task, turns: includeTurns ? task.turns : [] });
}

function emit(nativeTaskId: string, event: ProviderEvent): void {
  for (const sink of subscribers.get(nativeTaskId) ?? []) sink(structuredClone(event));
}

function updateTurn(nativeTaskId: string, turnId: string, update: (turn: NativeTurn) => NativeTurn): void {
  const task = tasks.get(nativeTaskId);
  if (!task) return;
  tasks.set(nativeTaskId, {
    ...task,
    updatedAt: new Date().toISOString(),
    turns: task.turns.map((turn) => turn.id === turnId ? update(turn) : turn),
  });
}

function appendEvent(nativeTaskId: string, turnId: string, event: ProviderEvent): void {
  updateTurn(nativeTaskId, turnId, (turn) => ({ ...turn, events: [...turn.events, event] }));
  emit(nativeTaskId, event);
}

function requireTask(taskKey: NativeTaskKey): NativeTask {
  const task = tasks.get(taskKey.nativeTaskId);
  if (!task) throw new Error("fixture task not found");
  return task;
}

const adapter: ProviderAdapter = {
  provider: PROVIDER,
  async capabilities() {
    return capabilities;
  },
  async listTasks(input: ListTasksInput): Promise<Page<NativeTask>> {
    const items = [...tasks.values()].filter((task) => input.includeArchived || !task.archived);
    return { items: items.map((task) => cloneTask(task, false)), nextCursor: null };
  },
  async readTask(taskKey, includeTurns) { return cloneTask(requireTask(taskKey), includeTurns); },
  async startTask(input: StartTaskInput) {
    const nativeTaskId = `fixture-created-${++sequence}`;
    const task = makeTask(nativeTaskId, `New native ${IS_CLAUDE ? "Claude" : "Codex"} task`);
    tasks.set(nativeTaskId, task);
    if (input.input) await adapter.send(task.key, input.input);
    return cloneTask(tasks.get(nativeTaskId)!);
  },
  async resumeTask(taskKey, _overrides?: TaskOverrides) { return cloneTask(requireTask(taskKey)); },
  async forkTask(taskKey, _lastTurnId?: string) {
    const source = requireTask(taskKey);
    const nativeTaskId = `fixture-fork-${++sequence}`;
    const task = { ...cloneTask(source), key: key(nativeTaskId), title: `${source.title} fork`, status: "idle" };
    tasks.set(nativeTaskId, task);
    return cloneTask(task);
  },
  async send(taskKey, input: UserInput): Promise<NativeTurnRef> {
    const task = requireTask(taskKey);
    const turnId = `fixture-turn-${++sequence}`;
    const userEvent: ProviderEvent = { ...eventBase(taskKey.nativeTaskId), type: "message", role: "user", text: input.text, turnId, itemId: `user-${sequence}` };
    const statusEvent: ProviderEvent = { ...eventBase(taskKey.nativeTaskId), type: "status", scope: "turn", status: "inProgress", nativeId: turnId };
    tasks.set(taskKey.nativeTaskId, {
      ...task,
      status: "active",
      turns: [...task.turns, { id: turnId, status: "inProgress", startedAt: new Date().toISOString(), completedAt: null, events: [userEvent, statusEvent] }],
    });
    emit(taskKey.nativeTaskId, userEvent);
    emit(taskKey.nativeTaskId, statusEvent);
    setTimeout(() => {
      const plan: ProviderEvent = { ...eventBase(taskKey.nativeTaskId), type: "plan", turnId, itemId: "plan-live", stepIndex: null, text: "Complete synthetic verification", status: "completed" };
      const activity: ProviderEvent = { ...eventBase(taskKey.nativeTaskId), type: "activity", turnId, itemId: "tool-live", activity: "fixture", status: "completed", message: "Synthetic check passed" };
      const message: ProviderEvent = { ...eventBase(taskKey.nativeTaskId), type: "message", role: "assistant", text: "Synthetic provider turn completed.", turnId, itemId: "assistant-live" };
      const completed: ProviderEvent = { ...eventBase(taskKey.nativeTaskId), type: "status", scope: "turn", status: "completed", nativeId: turnId };
      for (const event of [plan, activity, message, completed]) appendEvent(taskKey.nativeTaskId, turnId, event);
      updateTurn(taskKey.nativeTaskId, turnId, (turn) => ({ ...turn, status: "completed", completedAt: new Date().toISOString() }));
      const current = tasks.get(taskKey.nativeTaskId);
      if (current) tasks.set(taskKey.nativeTaskId, { ...current, status: "idle" });
    }, 250);
    return { taskKey: task.key, turnId };
  },
  async steer() { throw new Error("fixture steer is disabled"); },
  async interrupt(taskKey, turnId) {
    const interrupted: ProviderEvent = {
      ...eventBase(taskKey.nativeTaskId),
      type: "status",
      scope: "turn",
      status: IS_CLAUDE ? "cancelled_by_user" : "interrupted",
      nativeId: turnId,
    };
    appendEvent(taskKey.nativeTaskId, turnId, interrupted);
    updateTurn(taskKey.nativeTaskId, turnId, (turn) => ({ ...turn, status: "interrupted", completedAt: new Date().toISOString() }));
    const task = requireTask(taskKey);
    tasks.set(taskKey.nativeTaskId, { ...task, status: "idle" });
  },
  async respond(response: ProviderRequestResponse) {
    appendEvent(
      response.identity.key.nativeTaskId,
      response.identity.turnId,
      {
        ...eventBase(response.identity.key.nativeTaskId),
        type: "request-resolved",
        identity: response.identity,
      },
    );
  },
  async archive(taskKey) {
    const task = requireTask(taskKey);
    tasks.set(taskKey.nativeTaskId, { ...task, archived: true, status: "archived" });
    emit(taskKey.nativeTaskId, { ...eventBase(taskKey.nativeTaskId), type: "status", scope: "task", status: "archived", nativeId: taskKey.nativeTaskId });
  },
  async rename(taskKey, name) {
    const task = requireTask(taskKey);
    tasks.set(taskKey.nativeTaskId, { ...task, title: name, updatedAt: new Date().toISOString() });
  },
  async subscribe(taskKey, sink: ProviderEventSink): Promise<Unsubscribe> {
    requireTask(taskKey);
    const set = subscribers.get(taskKey.nativeTaskId) ?? new Set<ProviderEventSink>();
    set.add(sink);
    subscribers.set(taskKey.nativeTaskId, set);
    return () => { set.delete(sink); };
  },
};

const registry = new ProviderRegistry();
registry.register(HOME, adapter);
const app = Fastify({ logger: false });
app.addHook("onRequest", async (request, reply) => {
  if (request.url.startsWith("/api/health")) return;
  if (request.headers.authorization !== "Bearer m3-fixture-token") {
    return reply.code(401).send({ error: "unauthorized" });
  }
  if (PROVIDER_DELAY_MS > 0 && request.url.startsWith("/api/providers")) {
    await new Promise((resolve) => setTimeout(resolve, PROVIDER_DELAY_MS));
  }
});
const featureFlags = {
  nativeCodex: !IS_CLAUDE,
  persistentClaude: IS_CLAUDE,
  unifiedTaskIndex: false,
  codexStyleShell: false,
  crossProviderFork: false,
  workMode: false,
};

app.get("/api/health", async () => ({ ok: true, ready: true, sessionCount: 0 }));
app.get("/api/projects", async () => []);
app.get("/api/settings", async () => ({
  theme: "dark",
  density: "comfortable",
  defaultModel: "claude-sonnet-4-6",
  defaultPermissionMode: IS_CLAUDE ? "manual" : "default",
  monthlyBudgetUsd: null,
  devHubFeatures: featureFlags,
  requestedDevHubFeatures: featureFlags,
}));
app.put("/api/settings", async (request) => ({
  theme: "dark",
  density: "comfortable",
  defaultModel: "claude-sonnet-4-6",
  defaultPermissionMode: IS_CLAUDE ? "manual" : "default",
  monthlyBudgetUsd: null,
  ...(request.body as object),
  devHubFeatures: featureFlags,
  requestedDevHubFeatures: featureFlags,
}));
registerProviderTaskRoutes(app, registry, "m3-fixture-token");

await app.listen({ host: HOST, port: PORT });
console.log(`[${IS_CLAUDE ? "m4-claude" : "m3-codex"}-fixture] http://${HOST}:${PORT}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void app.close().finally(() => process.exit(0)); });
}
