/**
 * M5-CUTOVER-FINALIZE Browser QA fixture. Like the M3/M4 fixtures, this hand-rolls a
 * minimal Fastify app rather than the full `buildApp` from `packages/server/src/app.ts`
 * — `buildApp` wires transcript/config filesystem watchers meant for a real `~/.claude`
 * directory, which retry-loop against this synthetic temp home and run the process out
 * of memory. Instead this registers the REAL, unmodified production route functions
 * (`registerProviderTaskRoutes`, `registerProviderIndexRoutes`) directly against a real
 * `ProviderTaskIndexStore` (via a real temp-file `Engine`) and a real, initialized
 * `ProviderTaskIndexCoordinator` — so the browser's indexed-transport client
 * (`apps/web/src/lib/provider-index-api.ts`) talks to the exact `/api/provider-index/*`
 * code path end to end, with `unifiedTaskIndex` applied true. No provider process is
 * spawned: the only provider surface is a fake in-memory `ProviderAdapter` registered at
 * a synthetic home, exactly the DoD-sanctioned injection seam used by the server test
 * suite (`packages/server/test/provider-index.test.ts` /
 * `provider-index-composition.test.ts`).
 *
 * Run: `npx tsx .planning/devhub-codex-parity/qa/m5-fixture-server.ts`
 * then Vite dev on 5173 proxies /api to this on 8787 (apps/web/vite.config.ts).
 */
import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Engine, createProviderTaskIndexCoordinator } from "../../../packages/engine/src/index.ts";
import {
  ProviderRegistry,
  createNativeTaskKey,
  defineProviderCapabilities,
  canonicalizeProviderHome,
  homeFingerprint,
  type ListTasksInput,
  type NativeTask,
  type NativeTaskKey,
  type NativeTaskSummary,
  type NativeTurn,
  type Page,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderEventSink,
  type StartTaskInput,
  type TaskOverrides,
  type Unsubscribe,
  type UserInput,
} from "../../../packages/engine/src/providers/index.ts";
import { registerProviderTaskRoutes } from "../../../packages/server/src/routes/provider-tasks.ts";
import { registerProviderIndexRoutes } from "../../../packages/server/src/routes/provider-index.ts";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const PROVIDER = "openai" as const;
const NOW = "2026-07-15T12:00:00.000Z";

const root = mkdtempSync(path.join(os.tmpdir(), "devhub-m5-fixture-"));
const codexHome = realpathSync(root);

function key(nativeTaskId: string): NativeTaskKey {
  return createNativeTaskKey(PROVIDER, codexHome, nativeTaskId);
}

function eventBase(nativeTaskId: string) {
  return { provider: PROVIDER, key: key(nativeTaskId), occurredAt: NOW };
}

const capabilities = defineProviderCapabilities({
  list: true,
  read: true,
  start: true,
  resume: true,
  fork: true,
  send: true,
  steer: false,
  interrupt: true,
  subscribe: true,
  approveCommand: true,
  approveFileChange: true,
  approvePermissions: false,
  requestUserInput: false,
  mcpElicitation: false,
  archive: true,
  rename: true,
});

function makeTask(nativeTaskId: string, title: string, turns: NativeTurn[] = []): NativeTask {
  const lastTurn = turns.at(-1) ?? null;
  return {
    key: key(nativeTaskId),
    title,
    cwd: "/workspace/devhub-m5-fixture",
    model: "gpt-5.4",
    status: turns.some((turn) => turn.status === "inProgress") ? "active" : "idle",
    createdAt: NOW,
    updatedAt: NOW,
    archived: false,
    source: "native",
    // Real native task summaries always carry a revision (see
    // packages/server/test/provider-index.test.ts summaryFor: "real native tasks
    // always carry a revision"). `ProviderRegistry.listTasks`'s `snapshotTaskSummary`
    // drops the `revision` key entirely when it is falsy, and the coordinator's
    // rebuild rank check then rejects the resulting summary as an absent own
    // property — so every fixture task, including the turn-less idle one, needs a
    // real (non-null) revision object here.
    revision: {
      updatedAt: 1,
      status: lastTurn?.status ?? "idle",
      lastTurnId: lastTurn?.id ?? null,
      lastTurnStatus: lastTurn?.status ?? null,
      lastItemId: lastTurn?.events.at(-1)?.itemId ?? null,
      fingerprint: `${PROVIDER}:v1:${nativeTaskId}`,
    },
    turns,
  };
}

const activeEvents: ProviderEvent[] = [
  { ...eventBase("m5-active"), type: "message", role: "user", text: "Confirm the indexed transport is live end to end.", turnId: "turn-active", itemId: "user-1" },
  { ...eventBase("m5-active"), type: "message", role: "assistant", text: "Reading through the provider index cache now.", turnId: "turn-active", itemId: "assistant-1" },
  { ...eventBase("m5-active"), type: "plan", turnId: "turn-active", itemId: null, stepIndex: 0, text: "Read provider-index/homes", status: "completed" },
  { ...eventBase("m5-active"), type: "plan", turnId: "turn-active", itemId: null, stepIndex: 1, text: "Read provider-index/tasks", status: "inProgress" },
  { ...eventBase("m5-active"), type: "activity", turnId: "turn-active", itemId: "tool-1", activity: "shell", status: "running", message: "warm cache" },
  { ...eventBase("m5-active"), type: "usage", turnId: "turn-active", inputTokens: 400, outputTokens: 120, cachedInputTokens: 200, totalTokens: 520 },
  { ...eventBase("m5-active"), type: "status", scope: "turn", status: "inProgress", nativeId: "turn-active" },
];

const tasks = new Map<string, NativeTask>([
  ["m5-active", makeTask("m5-active", "Indexed transport verification", [{
    id: "turn-active",
    status: "inProgress",
    startedAt: NOW,
    completedAt: null,
    events: activeEvents,
  }])],
  ["m5-idle", makeTask("m5-idle", "Idle indexed task")],
  ["m5-completed", makeTask("m5-completed", "Completed indexed task", [{
    id: "turn-done",
    status: "completed",
    startedAt: NOW,
    completedAt: NOW,
    events: [
      { ...eventBase("m5-completed"), type: "message", role: "user", text: "Ship it.", turnId: "turn-done", itemId: "user-1" },
      { ...eventBase("m5-completed"), type: "message", role: "assistant", text: "Done — cutover verified.", turnId: "turn-done", itemId: "assistant-1" },
      { ...eventBase("m5-completed"), type: "status", scope: "turn", status: "completed", nativeId: "turn-done" },
    ],
  }])],
]);
const subscribers = new Map<string, Set<ProviderEventSink>>();
let sequence = 0;

function cloneTask(task: NativeTask, includeTurns = true): NativeTask {
  return structuredClone({ ...task, turns: includeTurns ? task.turns : [] });
}

function requireTask(taskKey: NativeTaskKey): NativeTask {
  const task = tasks.get(taskKey.nativeTaskId);
  if (!task) throw new Error("fixture task not found");
  return task;
}

const adapter: ProviderAdapter = {
  provider: PROVIDER,
  async capabilities() { return capabilities; },
  async listTasks(_input: ListTasksInput): Promise<Page<NativeTaskSummary>> {
    // List must return NativeTaskSummary (no `turns`), not the full NativeTask — the
    // coordinator's rebuild validates the summary shape strictly and rejects extra fields.
    return {
      items: [...tasks.values()].map((task) => {
        const { turns: _turns, ...summary } = cloneTask(task, false);
        return summary;
      }),
      nextCursor: null,
    };
  },
  async readTask(taskKey, includeTurns) { return cloneTask(requireTask(taskKey), includeTurns); },
  async startTask(input: StartTaskInput) {
    const nativeTaskId = `m5-created-${++sequence}`;
    const task = makeTask(nativeTaskId, "New indexed task");
    tasks.set(nativeTaskId, task);
    return cloneTask(task);
  },
  async resumeTask(taskKey, _overrides?: TaskOverrides) { return cloneTask(requireTask(taskKey)); },
  async forkTask(taskKey, _lastTurnId?: string) {
    const source = requireTask(taskKey);
    const nativeTaskId = `m5-fork-${++sequence}`;
    const task = { ...cloneTask(source), key: key(nativeTaskId), title: `${source.title} fork`, status: "idle" as const };
    tasks.set(nativeTaskId, task);
    return cloneTask(task);
  },
  async send(taskKey, input: UserInput) {
    const task = requireTask(taskKey);
    const turnId = `m5-turn-${++sequence}`;
    tasks.set(taskKey.nativeTaskId, {
      ...task,
      status: "active",
      turns: [...task.turns, {
        id: turnId,
        status: "inProgress",
        startedAt: new Date().toISOString(),
        completedAt: null,
        events: [{ ...eventBase(taskKey.nativeTaskId), type: "message", role: "user", text: input.text, turnId, itemId: `user-${sequence}` }],
      }],
    });
    return { taskKey: task.key, turnId };
  },
  async steer() { throw new Error("fixture steer is disabled"); },
  async interrupt(taskKey, turnId) {
    const task = requireTask(taskKey);
    tasks.set(taskKey.nativeTaskId, { ...task, status: "idle" });
  },
  async respond() { /* no-op fixture */ },
  async archive(taskKey) {
    const task = requireTask(taskKey);
    tasks.set(taskKey.nativeTaskId, { ...task, archived: true, status: "archived" as const });
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

const providerRegistry = new ProviderRegistry();
providerRegistry.register(codexHome, adapter);

// Real Engine on a temp SQLite file — only the shared ProviderTaskIndexStore is used
// (`engine.index.providerIndex`); the transcript/config watchers that `buildApp` wires
// for a real `~/.claude` home are deliberately NOT started here (see file header).
const engine = new Engine(path.join(root, "index.db"));

const TOKEN = "m5-fixture-token";

const canonicalHome = canonicalizeProviderHome(codexHome);
const registeredHomes = [{
  provider: PROVIDER,
  homeFingerprint: homeFingerprint(PROVIDER, canonicalHome),
  canonicalHome,
}];

// Real coordinator, initialized eagerly (the M5-cutover requested default is
// unifiedTaskIndex: true) — exactly the object `buildApp`'s onReady hook would build,
// constructed directly against the real store instead of through the full app.
const coordinator = createProviderTaskIndexCoordinator({
  registry: providerRegistry,
  store: engine.index.providerIndex,
  registeredHomes: [{ provider: PROVIDER, home: codexHome }],
  clock: { now: () => Date.now() },
});
coordinator.initialize();

const app = Fastify({ logger: false });
app.addHook("onRequest", async (request, reply) => {
  if (request.url.startsWith("/api/health")) return;
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    return reply.code(401).send({ error: "unauthorized" });
  }
});

const featureFlags = {
  nativeCodex: false,
  persistentClaude: false,
  unifiedTaskIndex: true,
  shellChrome: false,
  taskRail: false,
  taskHeaderSetup: false,
  threadWorkspace: false,
  composerSurface: false,
  inspectorDock: false,
  searchCommands: false,
  // Enabled purely so the Settings surface renders `SettingsRoute` (which shows the
  // "Provider runtime status" table with the Unified task index row) instead of the
  // legacy `SettingsPane` — unrelated to and does not gate the M5 unifiedTaskIndex
  // cutover itself.
  settingsSecondary: true,
};

app.get("/api/health", async () => ({ ok: true, ready: true, sessionCount: 0 }));
app.get("/api/projects", async () => []);
app.get("/api/settings", async () => ({
  theme: "dark",
  density: "comfortable",
  defaultModel: "claude-sonnet-4-6",
  defaultPermissionMode: "default",
  monthlyBudgetUsd: null,
  devHubFeatures: featureFlags,
  requestedDevHubFeatures: featureFlags,
}));
app.put("/api/settings", async (request) => ({
  theme: "dark",
  density: "comfortable",
  defaultModel: "claude-sonnet-4-6",
  defaultPermissionMode: "default",
  monthlyBudgetUsd: null,
  ...(request.body as object),
  devHubFeatures: featureFlags,
  requestedDevHubFeatures: featureFlags,
}));

registerProviderTaskRoutes(app, providerRegistry, TOKEN, {
  getCoordinator: () => coordinator,
});
registerProviderIndexRoutes(app, {
  registry: providerRegistry,
  store: engine.index.providerIndex,
  getCoordinator: () => coordinator,
  registeredHomes,
  token: TOKEN,
});

await app.listen({ host: HOST, port: PORT });
console.log(`[m5-fixture] http://${HOST}:${PORT} (unifiedTaskIndex applied: real coordinator, real provider-index routes)`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void app.close().finally(() => process.exit(0)); });
}
