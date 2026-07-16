import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "@devhub/engine";
import { registerWorkModeRoutes } from "../src/routes/work-mode.js";

const roots: string[] = [];

function makeApp(): { app: FastifyInstance; engine: Engine } {
  const root = mkdtempSync(path.join(os.tmpdir(), "devhub-work-mode-route-test-"));
  roots.push(root);
  const engine = new Engine(path.join(root, "index.db"));
  const app = Fastify();
  registerWorkModeRoutes(app, engine);
  return { app, engine };
}

/** Build a second app/engine pointed at the SAME db file — a simulated server restart. */
function makeAppAt(dbPath: string): { app: FastifyInstance; engine: Engine } {
  const engine = new Engine(dbPath);
  const app = Fastify();
  registerWorkModeRoutes(app, engine);
  return { app, engine };
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

const CREATE_BODY = {
  id: "work-task-1",
  provider: "anthropic",
  home: "/homes/anthropic",
  nativeTaskId: "native-1",
  folderScope: { root: "/active/claude-ui" },
  permissionProfile: { allowedActions: ["progress:update", "artifact:record", "deliverable:add"] },
};

describe("work-mode routes", () => {
  it("GET /api/work-mode/status always answers, reflecting the real stored flag", async () => {
    const { app, engine } = makeApp();
    // M7-WORKMODE-CUTOVER flipped the requested default to true, so explicitly
    // store the off value here to exercise the flag-off branch.
    engine.setSettings({ devHubFeatures: { workMode: false } as never });
    const off = await app.inject({ method: "GET", url: "/api/work-mode/status" });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ enabled: false });

    engine.setSettings({ devHubFeatures: { workMode: true } as never });
    const on = await app.inject({ method: "GET", url: "/api/work-mode/status" });
    expect(on.json()).toEqual({ enabled: true });
  });

  it("rejects every mutating/reading route with 403 when the flag is off, even with a valid body", async () => {
    const { app, engine } = makeApp();
    // M7-WORKMODE-CUTOVER flipped the requested default to true, so explicitly
    // store the off value here to exercise the flag-off rejection branch.
    engine.setSettings({ devHubFeatures: { workMode: false } as never });
    const create = await app.inject({ method: "POST", url: "/api/work-mode/tasks", payload: CREATE_BODY });
    expect(create.statusCode).toBe(403);
    expect(create.json()).toEqual({ error: "work_mode_disabled" });

    const read = await app.inject({ method: "GET", url: "/api/work-mode/tasks/work-task-1" });
    expect(read.statusCode).toBe(403);
  });

  it("never trusts a client-supplied flag value in the body — the real (off) flag still wins", async () => {
    const { app, engine } = makeApp();
    // M7-WORKMODE-CUTOVER flipped the requested default to true, so explicitly
    // store the off value here — the point of this test is the real stored flag
    // (off) beating a client-smuggled `workMode: true` in the body.
    engine.setSettings({ devHubFeatures: { workMode: false } as never });
    const create = await app.inject({
      method: "POST",
      url: "/api/work-mode/tasks",
      // A client-smuggled `workMode: true` is either stripped by the schema's
      // additionalProperties:false or ignored outright — either way the server's
      // OWN stored flag (off, here) is what decides the outcome, never the body.
      payload: { ...CREATE_BODY, workMode: true },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json()).toEqual({ error: "work_mode_disabled" });
  });

  it("creates, reads, and advances a real Work-mode task once the flag is on", async () => {
    const { app, engine } = makeApp();
    engine.setSettings({ devHubFeatures: { workMode: true } as never });

    const created = await app.inject({ method: "POST", url: "/api/work-mode/tasks", payload: CREATE_BODY });
    expect(created.statusCode).toBe(201);
    const createdTask = created.json().task;
    expect(createdTask.kind).toBe("work");
    expect(createdTask.id).toBe("work-task-1");
    expect(createdTask.progress.status).toBe("pending");
    expect(createdTask.folderScope.root).toBe("/active/claude-ui");

    const read = await app.inject({ method: "GET", url: "/api/work-mode/tasks/work-task-1" });
    expect(read.statusCode).toBe(200);
    expect(read.json().task.id).toBe("work-task-1");

    const artifact = await app.inject({
      method: "POST",
      url: "/api/work-mode/tasks/work-task-1/artifacts",
      payload: { path: "/active/claude-ui/build-report.json", kind: "file" },
    });
    expect(artifact.statusCode).toBe(200);
    expect(artifact.json().task.artifacts).toHaveLength(1);

    const deliverable = await app.inject({
      method: "POST",
      url: "/api/work-mode/tasks/work-task-1/deliverables",
      payload: {
        id: "build-report",
        description: "Build report",
        satisfiedByArtifactPaths: ["/active/claude-ui/build-report.json"],
      },
    });
    expect(deliverable.statusCode).toBe(200);
    expect(deliverable.json().task.deliverables).toHaveLength(1);

    const progress = await app.inject({
      method: "POST",
      url: "/api/work-mode/tasks/work-task-1/progress",
      payload: { status: "in-progress", summary: "3 of 5 deliverables underway" },
    });
    expect(progress.statusCode).toBe(200);
    expect(progress.json().task.progress).toMatchObject({
      status: "in-progress",
      summary: "3 of 5 deliverables underway",
    });

    engine.setSettings({ devHubFeatures: { workMode: false } as never });
    const afterFlip = await app.inject({ method: "GET", url: "/api/work-mode/tasks/work-task-1" });
    expect(afterFlip.statusCode).toBe(403);
  });

  it("404s on an unknown task id once the flag is on", async () => {
    const { app, engine } = makeApp();
    engine.setSettings({ devHubFeatures: { workMode: true } as never });
    const read = await app.inject({ method: "GET", url: "/api/work-mode/tasks/nope" });
    expect(read.statusCode).toBe(404);
  });

  it("409s creating a task id that already exists", async () => {
    const { app, engine } = makeApp();
    engine.setSettings({ devHubFeatures: { workMode: true } as never });
    await app.inject({ method: "POST", url: "/api/work-mode/tasks", payload: CREATE_BODY });
    const again = await app.inject({ method: "POST", url: "/api/work-mode/tasks", payload: CREATE_BODY });
    expect(again.statusCode).toBe(409);
  });

  it("rejects a deliverable referencing an artifact path never recorded on the task", async () => {
    const { app, engine } = makeApp();
    engine.setSettings({ devHubFeatures: { workMode: true } as never });
    await app.inject({ method: "POST", url: "/api/work-mode/tasks", payload: CREATE_BODY });
    const deliverable = await app.inject({
      method: "POST",
      url: "/api/work-mode/tasks/work-task-1/deliverables",
      payload: { id: "x", description: "x", satisfiedByArtifactPaths: ["/never/recorded"] },
    });
    expect(deliverable.statusCode).toBe(400);
  });

  it("M7-WORKMODE-PERSIST: a task created before a simulated server restart is still readable after", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "devhub-work-mode-restart-test-"));
    roots.push(root);
    const dbPath = path.join(root, "index.db");

    // "Before restart": a fresh Engine/app pair, flag on, create the task.
    const before = makeAppAt(dbPath);
    before.engine.setSettings({ devHubFeatures: { workMode: true } as never });
    const created = await before.app.inject({
      method: "POST",
      url: "/api/work-mode/tasks",
      payload: CREATE_BODY,
    });
    expect(created.statusCode).toBe(201);
    await before.app.inject({
      method: "POST",
      url: "/api/work-mode/tasks/work-task-1/progress",
      payload: { status: "in-progress", summary: "underway before restart" },
    });
    await before.engine.index.close();
    await before.app.close();

    // "After restart": a BRAND NEW Engine/app pointed at the same db file — nothing
    // shared in-process with `before`, exactly like a real process restart. The task
    // (and its progress update) must still be readable, and the flag must still be
    // re-read from the SAME durable settings store (still on, since it's the same db).
    const after = makeAppAt(dbPath);
    const read = await after.app.inject({ method: "GET", url: "/api/work-mode/tasks/work-task-1" });
    expect(read.statusCode).toBe(200);
    expect(read.json().task).toMatchObject({
      id: "work-task-1",
      progress: { status: "in-progress", summary: "underway before restart" },
    });

    // The existing 403-while-off behavior is unchanged by persistence: flip the flag
    // off on the SAME restarted process and confirm the route still 403s.
    after.engine.setSettings({ devHubFeatures: { workMode: false } as never });
    const afterFlagOff = await after.app.inject({
      method: "GET",
      url: "/api/work-mode/tasks/work-task-1",
    });
    expect(afterFlagOff.statusCode).toBe(403);
    await after.app.close();
  });

  it("400s an invalid provider and an artifact path outside the folder scope", async () => {
    const { app, engine } = makeApp();
    engine.setSettings({ devHubFeatures: { workMode: true } as never });

    const badProvider = await app.inject({
      method: "POST",
      url: "/api/work-mode/tasks",
      payload: { ...CREATE_BODY, provider: "not-a-provider" },
    });
    expect(badProvider.statusCode).toBe(400);

    await app.inject({ method: "POST", url: "/api/work-mode/tasks", payload: CREATE_BODY });
    const outside = await app.inject({
      method: "POST",
      url: "/api/work-mode/tasks/work-task-1/artifacts",
      payload: { path: "/etc/passwd", kind: "file" },
    });
    expect(outside.statusCode).toBe(400);
    expect(outside.json().error).toBe("work_mode_folder_scope_violation");
  });
});
