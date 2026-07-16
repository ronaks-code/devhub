/**
 * M7-WORKMODE-WIRING / M7-WORKMODE-PERSIST: the HTTP boundary over the engine's
 * Work-mode task model (`@devhub/engine/providers/work-mode.ts`). Work mode is a
 * DISTINCT product mode from Code mode — never "Cowork", never implied
 * background/subagent execution — so every route here re-checks the `workMode`
 * feature flag itself, straight off `engine.getSettings()`, and never trusts a
 * client-supplied flag value.
 *
 * Storage is `engine.index.workModeTasks` (`WorkModeTaskStore`,
 * `packages/engine/src/work-mode-store.ts`) — a table in the SAME durable SQLite
 * file every other engine store shares (`work_mode_tasks`, added to the base
 * schema), so a task created here survives a server restart: a fresh `Engine`
 * pointed at the same db file rehydrates the same row. Previously this was a
 * closure-scoped in-memory `Map` (mirroring the ephemeral preview store in
 * `cross-provider-fork.ts`) that lost every task on restart; the wiring below is
 * otherwise unchanged — real engine model in, real engine model out, flag-gated
 * at every entry point.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Engine } from "@devhub/engine";
import {
  addWorkModeDeliverable,
  createNativeTaskKey,
  createWorkModeTask,
  recordWorkModeArtifact,
  updateWorkModeProgress,
  WorkModeDisabledError,
  WorkModeFolderScopeViolationError,
  WorkModePermissionDeniedError,
  type ProviderId,
  type WorkModeTask,
} from "@devhub/engine/providers";

const PROVIDER_IDS = new Set<ProviderId>(["openai", "anthropic"]);

const MAX_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4_096;

interface TaskParams {
  id: string;
}

interface CreateBody {
  id: string;
  provider: string;
  home: string;
  nativeTaskId: string;
  folderScope: { root: string; writablePaths?: string[] };
  permissionProfile: { allowedActions: string[]; deniedActions?: string[] };
}

interface ProgressBody {
  status: "pending" | "in-progress" | "delivered" | "failed" | "cancelled";
  summary: string;
}

interface ArtifactBody {
  path: string;
  kind: "file" | "diff" | "log" | "other";
}

interface DeliverableBody {
  id: string;
  description: string;
  satisfiedByArtifactPaths?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function workModeDisabled(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({ error: "work_mode_disabled" });
}

function invalidRequest(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({ error: "invalid_work_mode_request" });
}

function taskNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: "work_mode_task_not_found" });
}

function sendWorkModeError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof WorkModeDisabledError) return workModeDisabled(reply);
  if (error instanceof WorkModeFolderScopeViolationError) {
    return reply.code(400).send({
      error: "work_mode_folder_scope_violation",
      code: error.code,
      path: error.path,
    });
  }
  if (error instanceof WorkModePermissionDeniedError) {
    return reply.code(403).send({
      error: "work_mode_permission_denied",
      code: error.code,
      action: error.action,
    });
  }
  if (error instanceof TypeError) {
    return reply.code(400).send({ error: "invalid_work_mode_request", message: error.message });
  }
  return reply.code(500).send({ error: "work_mode_request_failed" });
}

function hasExactCreateBodyShape(value: unknown): value is CreateBody {
  if (!isRecord(value)) return false;
  const allowedTopKeys = new Set([
    "id",
    "provider",
    "home",
    "nativeTaskId",
    "folderScope",
    "permissionProfile",
  ]);
  if (!Object.keys(value).every((key) => allowedTopKeys.has(key))) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (typeof value.provider !== "string") return false;
  if (typeof value.home !== "string") return false;
  if (typeof value.nativeTaskId !== "string") return false;
  const folderScope = value.folderScope;
  if (!isRecord(folderScope)) return false;
  const allowedFolderKeys = new Set(["root", "writablePaths"]);
  if (!Object.keys(folderScope).every((key) => allowedFolderKeys.has(key))) return false;
  if (typeof folderScope.root !== "string") return false;
  if (
    folderScope.writablePaths !== undefined &&
    (!Array.isArray(folderScope.writablePaths) ||
      !folderScope.writablePaths.every((entry) => typeof entry === "string"))
  ) {
    return false;
  }
  const permissionProfile = value.permissionProfile;
  if (!isRecord(permissionProfile)) return false;
  const allowedPermissionKeys = new Set(["allowedActions", "deniedActions"]);
  if (!Object.keys(permissionProfile).every((key) => allowedPermissionKeys.has(key))) return false;
  if (
    !Array.isArray(permissionProfile.allowedActions) ||
    !permissionProfile.allowedActions.every((entry) => typeof entry === "string")
  ) {
    return false;
  }
  if (
    permissionProfile.deniedActions !== undefined &&
    (!Array.isArray(permissionProfile.deniedActions) ||
      !permissionProfile.deniedActions.every((entry) => typeof entry === "string"))
  ) {
    return false;
  }
  return true;
}

function hasExactProgressBodyShape(value: unknown): value is ProgressBody {
  if (!isRecord(value)) return false;
  const allowed = new Set(["status", "summary"]);
  if (!Object.keys(value).every((key) => allowed.has(key))) return false;
  const statuses = new Set(["pending", "in-progress", "delivered", "failed", "cancelled"]);
  if (typeof value.status !== "string" || !statuses.has(value.status)) return false;
  return typeof value.summary === "string";
}

function hasExactArtifactBodyShape(value: unknown): value is ArtifactBody {
  if (!isRecord(value)) return false;
  const allowed = new Set(["path", "kind"]);
  if (!Object.keys(value).every((key) => allowed.has(key))) return false;
  const kinds = new Set(["file", "diff", "log", "other"]);
  if (typeof value.path !== "string" || value.path.length === 0) return false;
  return typeof value.kind === "string" && kinds.has(value.kind);
}

function hasExactDeliverableBodyShape(value: unknown): value is DeliverableBody {
  if (!isRecord(value)) return false;
  const allowed = new Set(["id", "description", "satisfiedByArtifactPaths"]);
  if (!Object.keys(value).every((key) => allowed.has(key))) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (typeof value.description !== "string") return false;
  if (
    value.satisfiedByArtifactPaths !== undefined &&
    (!Array.isArray(value.satisfiedByArtifactPaths) ||
      !value.satisfiedByArtifactPaths.every((entry) => typeof entry === "string"))
  ) {
    return false;
  }
  return true;
}

const idParamSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: MAX_ID_LENGTH },
  },
} as const;

const createBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "provider", "home", "nativeTaskId", "folderScope", "permissionProfile"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: MAX_ID_LENGTH },
    provider: { type: "string", minLength: 1, maxLength: 32 },
    home: { type: "string", minLength: 1, maxLength: MAX_PATH_LENGTH },
    nativeTaskId: { type: "string", minLength: 1, maxLength: MAX_PATH_LENGTH },
    folderScope: {
      type: "object",
      additionalProperties: false,
      required: ["root"],
      properties: {
        root: { type: "string", minLength: 1, maxLength: MAX_PATH_LENGTH },
        writablePaths: { type: "array", items: { type: "string", maxLength: MAX_PATH_LENGTH } },
      },
    },
    permissionProfile: {
      type: "object",
      additionalProperties: false,
      required: ["allowedActions"],
      properties: {
        allowedActions: { type: "array", items: { type: "string", maxLength: 128 } },
        deniedActions: { type: "array", items: { type: "string", maxLength: 128 } },
      },
    },
  },
} as const;

const progressBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary"],
  properties: {
    status: {
      type: "string",
      enum: ["pending", "in-progress", "delivered", "failed", "cancelled"],
    },
    summary: { type: "string", maxLength: 4_096 },
  },
} as const;

const artifactBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "kind"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: MAX_PATH_LENGTH },
    kind: { type: "string", enum: ["file", "diff", "log", "other"] },
  },
} as const;

const deliverableBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "description"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: MAX_ID_LENGTH },
    description: { type: "string", maxLength: 4_096 },
    satisfiedByArtifactPaths: { type: "array", items: { type: "string", maxLength: MAX_PATH_LENGTH } },
  },
} as const;

/**
 * Ephemeral fallback used ONLY when `engine.index` is absent (a partial/mocked
 * `Engine` in a hermetic test that never exercises Work mode itself — the same
 * `engine.index?.foo ?? null` tolerance `app.ts` already applies for the provider
 * index). A real `Engine` always has `index.workModeTasks` and gets real
 * restart-durable persistence; this fallback never runs in a real server process.
 */
class InMemoryWorkModeTaskFallback {
  private readonly map = new Map<string, WorkModeTask>();
  get(id: string): WorkModeTask | null {
    return this.map.get(id) ?? null;
  }
  has(id: string): boolean {
    return this.map.has(id);
  }
  put(task: WorkModeTask): void {
    this.map.set(task.id, task);
  }
}

/**
 * Register the Work-mode HTTP boundary: GET .../status (always answers, never
 * gated — it's the flag probe itself), and the CRUD surface over the real engine
 * model, every one of which re-checks `workMode` off `engine.getSettings()` before
 * doing anything, regardless of what the client sent.
 */
export function registerWorkModeRoutes(
  app: FastifyInstance,
  engine: Pick<Engine, "getSettings"> & { index?: Pick<Engine["index"], "workModeTasks"> },
): void {
  const tasks = engine.index?.workModeTasks ?? new InMemoryWorkModeTaskFallback();
  const isFlagEnabled = (): boolean => engine.getSettings().devHubFeatures?.workMode === true;
  const flags = { get workMode() {
    return isFlagEnabled();
  } };

  app.get("/api/work-mode/status", async () => ({ enabled: isFlagEnabled() }));

  app.post<{ Body: CreateBody }>(
    "/api/work-mode/tasks",
    { schema: { body: createBodySchema } },
    async (req, reply) => {
      if (!hasExactCreateBodyShape(req.body)) return invalidRequest(reply);
      if (!isFlagEnabled()) return workModeDisabled(reply);
      const provider = PROVIDER_IDS.has(req.body.provider as ProviderId)
        ? (req.body.provider as ProviderId)
        : null;
      if (!provider) return invalidRequest(reply);
      if (tasks.has(req.body.id)) {
        return reply.code(409).send({ error: "work_mode_task_already_exists" });
      }
      try {
        const nativeTaskKey = createNativeTaskKey(provider, req.body.home, req.body.nativeTaskId);
        const task = createWorkModeTask(flags, {
          id: req.body.id,
          runtime: { provider, home: req.body.home, nativeTaskKey },
          folderScope: req.body.folderScope,
          permissionProfile: req.body.permissionProfile,
        });
        tasks.put(task);
        return reply.code(201).send({ task });
      } catch (error) {
        return sendWorkModeError(reply, error);
      }
    },
  );

  app.get<{ Params: TaskParams }>(
    "/api/work-mode/tasks/:id",
    { schema: { params: idParamSchema } },
    async (req, reply) => {
      if (!isFlagEnabled()) return workModeDisabled(reply);
      const task = tasks.get(req.params.id);
      if (!task) return taskNotFound(reply);
      return reply.code(200).send({ task });
    },
  );

  app.post<{ Params: TaskParams; Body: ProgressBody }>(
    "/api/work-mode/tasks/:id/progress",
    { schema: { params: idParamSchema, body: progressBodySchema } },
    async (req, reply) => {
      if (!hasExactProgressBodyShape(req.body)) return invalidRequest(reply);
      if (!isFlagEnabled()) return workModeDisabled(reply);
      const task = tasks.get(req.params.id);
      if (!task) return taskNotFound(reply);
      try {
        const next = updateWorkModeProgress(flags, task, req.body);
        tasks.put(next);
        return reply.code(200).send({ task: next });
      } catch (error) {
        return sendWorkModeError(reply, error);
      }
    },
  );

  app.post<{ Params: TaskParams; Body: ArtifactBody }>(
    "/api/work-mode/tasks/:id/artifacts",
    { schema: { params: idParamSchema, body: artifactBodySchema } },
    async (req, reply) => {
      if (!hasExactArtifactBodyShape(req.body)) return invalidRequest(reply);
      if (!isFlagEnabled()) return workModeDisabled(reply);
      const task = tasks.get(req.params.id);
      if (!task) return taskNotFound(reply);
      try {
        const next = recordWorkModeArtifact(flags, task, req.body);
        tasks.put(next);
        return reply.code(200).send({ task: next });
      } catch (error) {
        return sendWorkModeError(reply, error);
      }
    },
  );

  app.post<{ Params: TaskParams; Body: DeliverableBody }>(
    "/api/work-mode/tasks/:id/deliverables",
    { schema: { params: idParamSchema, body: deliverableBodySchema } },
    async (req, reply) => {
      if (!hasExactDeliverableBodyShape(req.body)) return invalidRequest(reply);
      if (!isFlagEnabled()) return workModeDisabled(reply);
      const task = tasks.get(req.params.id);
      if (!task) return taskNotFound(reply);
      try {
        const next = addWorkModeDeliverable(flags, task, {
          id: req.body.id,
          description: req.body.description,
          satisfiedByArtifactPaths: req.body.satisfiedByArtifactPaths ?? [],
        });
        tasks.put(next);
        return reply.code(200).send({ task: next });
      } catch (error) {
        return sendWorkModeError(reply, error);
      }
    },
  );
}
