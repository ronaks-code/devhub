/**
 * Authenticated, locator-only indexed task routes (M5 Task 5).
 *
 * These routes are the browser-facing surface of the unified provider task index.
 * They are LOCATOR-ONLY: no request body or query ever carries a raw provider home,
 * and no response, log, or SSE frame interpolates a canonical home. Trusted homes are
 * registered exclusively by server startup (installed-runtime discovery / BuildOptions /
 * DEVHUB_*_HOME env); the browser can only reference a home through its opaque fingerprint.
 *
 * Read/list/SSE honor the existing configured-token + origin policy. Every mutation,
 * control, rebuild, meta, and ack route additionally requires a configured Bearer token
 * plus a trusted (same-origin / loopback) Origin, and never accepts a query-string token.
 *
 * The whole surface is active only while the coordinator exists (unifiedTaskIndex applied
 * true). When the flag is off, `getCoordinator()` returns null and every route reports the
 * feature as disabled so the legacy provider routes remain the instant rollback path.
 */
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
  preValidationHookHandler,
} from "fastify";
import {
  ProviderAdapterError,
  ProviderCapabilityError,
  ProviderOperationError,
  ProviderRegistryNotFoundError,
  ProviderIndexStoreError,
  createNativeTaskKey,
  createProviderRequestIdentity,
  parseTaskLocator,
  serializeTaskLocator,
  taskLocator,
  projectIndexedProviderEvent,
  indexedProviderEventItemId,
  indexedProviderEventTurnId,
  type IndexedProviderEvent,
  type JsonRpcRequestId,
  type NativeTask,
  type NativeTaskKey,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderId,
  type ProviderRegistry,
  type ProviderRequestResponse,
  type ProviderTaskLocator,
  type UserInput,
} from "@devhub/engine/providers";
import type {
  ProviderTaskIndexCoordinator,
  ProviderTaskIndexCoordinatorError,
} from "@devhub/engine";
import type { ProviderTaskIndexStore } from "@devhub/engine";
import { isTrustedOpenAIOrigin } from "./openai.js";

const PROVIDER_IDS = new Set<ProviderId>(["openai", "anthropic"]);

const MAX_LOCATOR_LENGTH = 8_192;
const MAX_FINGERPRINT_LENGTH = 64;
const MAX_NATIVE_ID_LENGTH = 512;
const MAX_MODEL_LENGTH = 256;
const MAX_MODE_LENGTH = 64;
const MAX_PERMISSION_MODE_LENGTH = 64;
const MAX_CWD_LENGTH = 4_096;
const MAX_INPUT_TEXT_LENGTH = 100_000;
const MAX_ATTACHMENT_COUNT = 50;
const MAX_ATTACHMENT_NAME_LENGTH = 255;
const MAX_MEDIA_TYPE_LENGTH = 256;
const MAX_TASK_NAME_LENGTH = 200;
const MAX_TAG_COUNT = 128;
const MAX_TAG_LENGTH = 128;
const MAX_LABEL_LENGTH = 512;
const MAX_NOTES_LENGTH = 100_000;
const MAX_CURSOR_LENGTH = 8_192;
const MAX_FINGERPRINT_INPUT = 64;
const MAX_REVISION_FINGERPRINT_LENGTH = 512;

const MAX_INDEX_SSE_CONNECTIONS = 32;
const MAX_INDEX_EVENT_BYTES = 256 * 1_024;
const MAX_INDEX_STREAM_QUEUE_BYTES = 512 * 1_024;
const INDEX_STREAM_HEARTBEAT_MS = 25_000;

/** A trusted, backend-only registered provider home. The canonical home never leaves the server. */
export interface RegisteredIndexHome {
  readonly provider: ProviderId;
  readonly homeFingerprint: string;
  readonly canonicalHome: string;
}

export interface ProviderIndexRouteDeps {
  readonly registry: ProviderRegistry;
  readonly store: ProviderTaskIndexStore;
  readonly getCoordinator: () => ProviderTaskIndexCoordinator | null;
  readonly registeredHomes: readonly RegisteredIndexHome[];
  readonly token?: string;
}

interface LocatorParams {
  locator: string;
}

interface PublicProviderHome {
  readonly provider: ProviderId;
  readonly homeFingerprint: string;
  readonly status: "available" | "unavailable";
  readonly capabilities: ProviderCapabilities | null;
}

interface PublicResponseIdentity {
  readonly generation: number | null;
  readonly turnId: string | null;
  readonly requestId: JsonRpcRequestId;
  readonly itemId: string | null;
  readonly approvalId: JsonRpcRequestId | null;
}

type RespondBody =
  | {
      kind: "command-approval" | "file-change-approval" | "mcp-elicitation";
      identity: PublicResponseIdentity;
      decision: "allow" | "deny" | "cancel";
    }
  | { kind: "permission"; identity: PublicResponseIdentity; permissions: string[] }
  | { kind: "user-input"; identity: PublicResponseIdentity; answers: Record<string, string> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: unknown, allowed: readonly string[]): boolean {
  if (!isRecord(value)) return true;
  const allowlist = new Set(allowed);
  return Object.keys(value).every((key) => allowlist.has(key));
}

function parseProvider(value: unknown): ProviderId | null {
  return typeof value === "string" && PROVIDER_IDS.has(value as ProviderId)
    ? (value as ProviderId)
    : null;
}

// ---- shape validators (preValidation, before AJV coercion) ----

function isJsonRpcId(value: unknown, nullable: boolean): boolean {
  if (value === null) return nullable;
  if (typeof value === "number") return Number.isSafeInteger(value);
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_NATIVE_ID_LENGTH &&
    !value.includes(" ");
}

function isNullableNativeId(value: unknown): boolean {
  return value === null || isJsonRpcId(value, false);
}

function hasExactUserInputShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["text", "attachments"])) return false;
  if (typeof value.text !== "string") return false;
  if (value.attachments === undefined) return true;
  if (!Array.isArray(value.attachments)) return false;
  return value.attachments.every((attachment) => {
    if (!isRecord(attachment)) return false;
    if (!hasOnlyKeys(attachment, ["name", "path", "mediaType"])) return false;
    return typeof attachment.name === "string" &&
      typeof attachment.path === "string" &&
      (attachment.mediaType === undefined || typeof attachment.mediaType === "string");
  });
}

function hasExactResponseIdentityShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["generation", "turnId", "requestId", "itemId", "approvalId"])) {
    return false;
  }
  if (!["generation", "turnId", "requestId", "itemId", "approvalId"].every(
    (field) => Object.prototype.hasOwnProperty.call(value, field),
  )) return false;
  const generationValid = value.generation === null ||
    (Number.isSafeInteger(value.generation) && (value.generation as number) >= 0);
  return generationValid &&
    isNullableNativeId(value.turnId) &&
    isJsonRpcId(value.requestId, false) &&
    isNullableNativeId(value.itemId) &&
    isJsonRpcId(value.approvalId, true);
}

function hasExactRespondBodyShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasExactResponseIdentityShape(value.identity)) return false;
  switch (value.kind) {
    case "command-approval":
    case "file-change-approval":
    case "mcp-elicitation":
      return hasOnlyKeys(value, ["kind", "identity", "decision"]) &&
        (value.decision === "allow" || value.decision === "deny" || value.decision === "cancel");
    case "permission":
      return hasOnlyKeys(value, ["kind", "identity", "permissions"]) &&
        Array.isArray(value.permissions) &&
        value.permissions.every((permission) => typeof permission === "string");
    case "user-input":
      return hasOnlyKeys(value, ["kind", "identity", "answers"]) &&
        isRecord(value.answers) &&
        Object.values(value.answers).every((answer) => typeof answer === "string");
    default:
      return false;
  }
}

function isMetadataJson(value: unknown, depth: number): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isMetadataJson(entry, depth + 1));
  if (isRecord(value)) {
    return Object.values(value).every((entry) => isMetadataJson(entry, depth + 1));
  }
  return false;
}

function hasExactMetaPatchShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = [
    "favorite", "pinned", "localLabel", "tags", "notes",
    "localArchived", "uiState", "unsupportedLocal",
  ];
  if (!hasOnlyKeys(value, allowed)) return false;
  if (Object.keys(value).length === 0) return false;
  if (value.favorite !== undefined && typeof value.favorite !== "boolean") return false;
  if (value.pinned !== undefined && typeof value.pinned !== "boolean") return false;
  if (value.localArchived !== undefined && typeof value.localArchived !== "boolean") return false;
  if (value.localLabel !== undefined &&
    !(value.localLabel === null ||
      (typeof value.localLabel === "string" && value.localLabel.length <= MAX_LABEL_LENGTH))) {
    return false;
  }
  if (value.notes !== undefined &&
    !(value.notes === null ||
      (typeof value.notes === "string" && value.notes.length <= MAX_NOTES_LENGTH))) {
    return false;
  }
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length > MAX_TAG_COUNT) return false;
    if (!value.tags.every((tag) =>
      typeof tag === "string" && tag.length > 0 && tag.length <= MAX_TAG_LENGTH)) {
      return false;
    }
  }
  if (value.uiState !== undefined && !isMetadataJson(value.uiState, 0)) return false;
  if (value.unsupportedLocal !== undefined && !isMetadataJson(value.unsupportedLocal, 0)) {
    return false;
  }
  return true;
}

// ---- auth ----

function rejectsQueryToken(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isRecord(request.query) && Object.hasOwn(request.query, "token")) {
    void reply.code(401).send({ error: "unauthorized" });
    return true;
  }
  return false;
}

/**
 * Read/list/SSE auth: honors the existing configured-token policy (Bearer only, never a
 * query-string token) plus the trusted-origin check. When no token is configured the server
 * is local-only and these routes are open, matching the existing provider read policy.
 */
function readAuthHook(token: string | undefined): onRequestHookHandler {
  return (request, reply, done) => {
    if (rejectsQueryToken(request, reply)) return;
    if (token && request.headers.authorization !== `Bearer ${token}`) {
      void reply.code(401).send({ error: "unauthorized" });
      return;
    }
    if (!isTrustedOpenAIOrigin(request.headers.origin, request.headers.host)) {
      void reply.code(403).send({ error: "untrusted_origin" });
      return;
    }
    done();
  };
}

/**
 * Mutation/control/rebuild/meta/ack auth: requires a configured Bearer token AND a trusted
 * origin, and never accepts a query-string token. Without a configured token the whole
 * mutation surface is disabled (503) so credentials can never be bypassed.
 */
function mutationAuthHook(token: string | undefined): onRequestHookHandler {
  return (request, reply, done) => {
    if (rejectsQueryToken(request, reply)) return;
    if (!token) {
      void reply.code(503).send({ error: "provider_mutations_disabled" });
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      void reply.code(401).send({ error: "unauthorized" });
      return;
    }
    if (!isTrustedOpenAIOrigin(request.headers.origin, request.headers.host)) {
      void reply.code(403).send({ error: "untrusted_origin" });
      return;
    }
    done();
  };
}

// ---- error mapping (stable, value-free codes; no home/path bytes) ----

function coordinatorErrorName(error: unknown): string | null {
  if (error instanceof Error && error.name === "ProviderTaskIndexCoordinatorError") {
    return (error as ProviderTaskIndexCoordinatorError).code;
  }
  return null;
}

function sendIndexError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ProviderIndexStoreError) {
    switch (error.code) {
      case "UNKNOWN_HOME":
        return reply.code(404).send({ error: "unknown_home", code: error.code });
      case "INVALID_INPUT":
        return reply.code(400).send({ error: "invalid_index_request", code: error.code });
      case "CAPACITY":
        return reply.code(429).send({ error: "index_capacity_reached", code: error.code });
      case "RECONCILIATION_CAS_MISMATCH":
        return reply.code(409).send({ error: "reconciliation_conflict", code: error.code });
      case "CORRUPT_ROW":
        return reply.code(500).send({ error: "index_corrupt", code: error.code });
      default:
        return reply.code(503).send({ error: "index_unavailable", code: error.code });
    }
  }
  const coordinatorCode = coordinatorErrorName(error);
  if (coordinatorCode) {
    switch (coordinatorCode) {
      case "INVALID_INPUT":
        return reply.code(400).send({ error: "invalid_index_request", code: coordinatorCode });
      case "CAPACITY":
        return reply.code(429).send({ error: "index_capacity_reached", code: coordinatorCode });
      case "REBUILD_BUSY":
        return reply.code(409).send({ error: "rebuild_in_progress", code: coordinatorCode });
      case "REBUILD_TIMEOUT":
        return reply.code(504).send({ error: "rebuild_timeout", code: coordinatorCode });
      case "CANCELLED":
        return reply.code(409).send({ error: "rebuild_cancelled", code: coordinatorCode });
      case "STALE_OBSERVATION":
        return reply.code(409).send({ error: "reconciliation_conflict", code: coordinatorCode });
      default:
        return reply.code(503).send({ error: "index_unavailable", code: coordinatorCode });
    }
  }
  if (error instanceof ProviderRegistryNotFoundError) {
    return reply.code(404).send({
      error: "provider_not_found",
      code: "PROVIDER_ADAPTER_NOT_FOUND",
      provider: error.provider,
    });
  }
  if (error instanceof ProviderCapabilityError) {
    return reply.code(409).send({
      error: "provider_capability_unavailable",
      code: error.code,
      capability: error.capability,
    });
  }
  if (error instanceof ProviderOperationError) {
    switch (error.code) {
      case "INVALID_INPUT":
      case "UNSAFE_OVERRIDE":
        return reply.code(400).send({ error: "provider_invalid_request", code: error.code });
      case "POLICY_MISMATCH":
        return reply.code(409).send({ error: "provider_policy_mismatch", code: error.code });
      case "RECONCILIATION_REQUIRED":
        return reply.code(409).send({ error: "provider_reconciliation_required", code: error.code });
      case "NATIVE_TASK_MISSING":
        return reply.code(404).send({ error: "provider_task_not_found", code: error.code });
      case "MUTATION_UNCERTAIN":
        return reply.code(409).send({
          error: "provider_mutation_uncertain",
          code: error.code,
          retryable: false,
        });
      case "UNSUPPORTED_INTERACTION":
        return reply.code(409).send({ error: "provider_interaction_unavailable", code: error.code });
      case "SUBSCRIPTION_CAPACITY":
        return reply.code(429).send({ error: "provider_capacity_reached", code: error.code });
      case "DISABLED":
        return reply.code(409).send({ error: "provider_runtime_disabled", code: error.code });
      default:
        return reply.code(503).send({ error: "provider_unavailable", code: error.code });
    }
  }
  if (error instanceof ProviderAdapterError) {
    return reply.code(503).send({ error: "provider_unavailable", code: error.code });
  }
  if (error instanceof TypeError) {
    return reply.code(400).send({ error: "invalid_index_request" });
  }
  return reply.code(500).send({ error: "index_request_failed" });
}

function parseLocatorParam(reply: FastifyReply, value: string): ProviderTaskLocator | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LOCATOR_LENGTH) {
    void reply.code(400).send({ error: "invalid_locator" });
    return null;
  }
  try {
    return parseTaskLocator(value);
  } catch {
    void reply.code(400).send({ error: "invalid_locator" });
    return null;
  }
}

// ---- SSE dedup identity ----

/**
 * A stable dedup key for a snapshot/live event so a buffered live event already represented in
 * the authoritative snapshot is dropped during drain. Request identities dedup by their exact
 * serialized identity; other item-bearing events dedup by (turn, item, type). Path-free.
 */
function indexedEventDedupKey(event: IndexedProviderEvent): string | null {
  if (event.type === "request") {
    return `req ${JSON.stringify(event.request.identity)}`;
  }
  if (event.type === "request-resolved") {
    return `res ${JSON.stringify(event.identity)}`;
  }
  const turnId = indexedProviderEventTurnId(event);
  const itemId = indexedProviderEventItemId(event);
  if (itemId === null) return null;
  return `item ${turnId ?? ""} ${itemId} ${event.type}`;
}

function liveEventDedupKey(event: ProviderEvent): string | null {
  try {
    return indexedEventDedupKey(projectIndexedProviderEvent(event));
  } catch {
    return null;
  }
}

function sseFrame(payload: string): string {
  return `data: ${payload}\n\n`;
}

function snapshotFramePayload(event: IndexedProviderEvent): string | null {
  try {
    const payload = JSON.stringify({ type: "event", event });
    if (Buffer.byteLength(payload) > MAX_INDEX_EVENT_BYTES) return null;
    return payload;
  } catch {
    return null;
  }
}

function liveFramePayload(event: ProviderEvent): string | null {
  try {
    const indexed = projectIndexedProviderEvent(event);
    const payload = JSON.stringify({ type: "event", event: indexed });
    if (Buffer.byteLength(payload) > MAX_INDEX_EVENT_BYTES) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Register the authenticated, locator-only indexed task routes.
 */
export function registerProviderIndexRoutes(
  app: FastifyInstance,
  deps: ProviderIndexRouteDeps,
): void {
  const { registry, store, getCoordinator, registeredHomes, token } = deps;
  const homeByFingerprint = new Map<string, RegisteredIndexHome>();
  for (const home of registeredHomes) {
    homeByFingerprint.set(`${home.provider} ${home.homeFingerprint}`, home);
  }
  let activeStreams = 0;

  /** Require the feature to be active (coordinator built). Returns null when disabled. */
  const requireCoordinator = (reply: FastifyReply): ProviderTaskIndexCoordinator | null => {
    const coordinator = getCoordinator();
    if (coordinator === null) {
      void reply.code(404).send({ error: "unified_task_index_disabled" });
      return null;
    }
    return coordinator;
  };

  /** Resolve a locator's canonical home via the backend registry. Backend-only; never returned. */
  const resolveHome = (locator: ProviderTaskLocator): string | null => {
    return store.resolveHome(locator.provider, locator.homeFingerprint);
  };

  const nativeKey = (locator: ProviderTaskLocator, home: string): NativeTaskKey =>
    createNativeTaskKey(locator.provider, home, locator.nativeTaskId);

  const locatorForKey = (key: NativeTaskKey): ProviderTaskLocator => taskLocator(key);

  /** Best-effort: fold a fresh native task into the cache. Never throws into the response. */
  const observeTask = async (
    coordinator: ProviderTaskIndexCoordinator,
    task: NativeTask,
  ): Promise<void> => {
    try {
      await coordinator.observeTask(task);
    } catch {
      // Cache warming is best-effort; the authoritative provider result is already returned.
    }
  };

  const invalidate = (locator: ProviderTaskLocator): void => {
    try {
      store.invalidate(locator);
    } catch {
      // Invalidation is best-effort; a stale row is corrected on the next read-through.
    }
  };

  // GET /api/provider-index/homes
  app.get(
    "/api/provider-index/homes",
    { onRequest: readAuthHook(token) },
    async (_req, reply) => {
      if (requireCoordinator(reply) === null) return reply;
      let census: readonly { provider: ProviderId; home: string; status: string;
        capabilities?: ProviderCapabilities }[];
      try {
        census = await registry.descriptorCensus() as never;
      } catch {
        census = [];
      }
      const censusByHome = new Map<string, { status: string; capabilities?: ProviderCapabilities }>();
      for (const entry of census) {
        censusByHome.set(`${entry.provider} ${entry.home}`, {
          status: entry.status,
          ...(entry.capabilities ? { capabilities: entry.capabilities } : {}),
        });
      }
      const homes: PublicProviderHome[] = registeredHomes
        .map((home) => {
          const match = censusByHome.get(`${home.provider} ${home.canonicalHome}`);
          const available = match?.status === "available" && match.capabilities !== undefined;
          return {
            provider: home.provider,
            homeFingerprint: home.homeFingerprint,
            status: available ? "available" as const : "unavailable" as const,
            capabilities: available ? match!.capabilities! : null,
          };
        })
        .sort((left, right) =>
          left.provider !== right.provider
            ? (left.provider < right.provider ? -1 : 1)
            : left.homeFingerprint < right.homeFingerprint ? -1
            : left.homeFingerprint > right.homeFingerprint ? 1 : 0);
      return reply.send(homes);
    },
  );

  // GET /api/provider-index/tasks
  app.get<{
    Querystring: {
      provider?: string;
      homeFingerprint?: string;
      cursor?: string;
      limit?: number;
      includeArchived?: boolean;
    };
  }>(
    "/api/provider-index/tasks",
    {
      onRequest: readAuthHook(token),
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            provider: { type: "string", minLength: 1, maxLength: 32 },
            homeFingerprint: { type: "string", minLength: 1, maxLength: MAX_FINGERPRINT_LENGTH },
            cursor: { type: "string", minLength: 1, maxLength: MAX_CURSOR_LENGTH },
            limit: { type: "integer", minimum: 1, maximum: 200 },
            includeArchived: { type: "boolean" },
          },
        },
      },
    },
    async (req, reply) => {
      if (requireCoordinator(reply) === null) return reply;
      const query = req.query;
      let provider: ProviderId | null = null;
      if (query.provider !== undefined) {
        provider = parseProvider(query.provider);
        if (provider === null) return reply.code(400).send({ error: "invalid_index_request" });
      }
      if (query.homeFingerprint !== undefined && provider === null) {
        // A home fingerprint is meaningless without its provider scope.
        return reply.code(400).send({ error: "invalid_index_request" });
      }
      try {
        const page = store.list({
          ...(provider === null ? {} : { provider }),
          ...(query.homeFingerprint === undefined ? {} : { homeFingerprint: query.homeFingerprint }),
          ...(query.includeArchived === undefined ? {} : { includeArchived: query.includeArchived }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        });
        return reply.send({ items: page.items, nextCursor: page.nextCursor });
      } catch (error) {
        return sendIndexError(reply, error);
      }
    },
  );

  // GET /api/provider-index/tasks/:locator
  app.get<{ Params: LocatorParams; Querystring: { freshness?: string } }>(
    "/api/provider-index/tasks/:locator",
    {
      onRequest: readAuthHook(token),
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { freshness: { type: "string", enum: ["native", "cache"] } },
        },
      },
    },
    async (req, reply) => {
      const coordinator = requireCoordinator(reply);
      if (coordinator === null) return reply;
      const locator = parseLocatorParam(reply, req.params.locator);
      if (locator === null) return reply;
      const freshness = req.query.freshness === "cache" ? "cache" : "native";
      try {
        const result = await coordinator.readThrough({
          locator,
          projection: "snapshot",
          allowDegradedCache: freshness === "cache",
        });
        if (result.freshness === "missing") {
          return reply.code(404).send({
            error: "provider_task_not_found",
            code: "NATIVE_TASK_MISSING",
            provider: locator.provider,
          });
        }
        const reconciliation = store.getReconciliation(locator);
        return reply.send({
          task: result.task,
          freshness: result.freshness,
          reconciliation,
        });
      } catch (error) {
        return sendIndexError(reply, error);
      }
    },
  );

  // POST /api/provider-index/tasks  (start)
  app.post<{
    Body: {
      provider: string;
      homeFingerprint: string;
      cwd: string;
      input?: UserInput;
      model?: string;
      mode?: string;
      permissionMode?: string;
    };
  }>(
    "/api/provider-index/tasks",
    {
      onRequest: mutationAuthHook(token),
      preValidation: exactBody((body) =>
        isRecord(body) &&
        hasOnlyKeys(body, ["provider", "homeFingerprint", "cwd", "input", "model", "mode", "permissionMode"]) &&
        typeof body.provider === "string" && typeof body.homeFingerprint === "string" &&
        typeof body.cwd === "string" &&
        (body.model === undefined || typeof body.model === "string") &&
        (body.mode === undefined || typeof body.mode === "string") &&
        (body.permissionMode === undefined || typeof body.permissionMode === "string") &&
        (body.input === undefined || hasExactUserInputShape(body.input))),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["provider", "homeFingerprint", "cwd"],
          properties: {
            provider: { type: "string", minLength: 1, maxLength: 32 },
            homeFingerprint: { type: "string", minLength: 1, maxLength: MAX_FINGERPRINT_INPUT },
            cwd: { type: "string", minLength: 1, maxLength: MAX_CWD_LENGTH },
            model: { type: "string", minLength: 1, maxLength: MAX_MODEL_LENGTH },
            mode: { type: "string", minLength: 1, maxLength: MAX_MODE_LENGTH },
            permissionMode: { type: "string", minLength: 1, maxLength: MAX_PERMISSION_MODE_LENGTH },
            input: userInputSchema(),
          },
        },
      },
    },
    async (req, reply) => {
      const coordinator = requireCoordinator(reply);
      if (coordinator === null) return reply;
      const provider = parseProvider(req.body.provider);
      if (provider === null) return reply.code(400).send({ error: "invalid_index_request" });
      const home = store.resolveHome(provider, req.body.homeFingerprint);
      if (home === null) return reply.code(404).send({ error: "unknown_home" });
      try {
        const task = await registry.startTask(provider, {
          home,
          cwd: req.body.cwd,
          ...(req.body.model === undefined ? {} : { model: req.body.model }),
          ...(req.body.mode === undefined ? {} : { mode: req.body.mode }),
          ...(req.body.permissionMode === undefined ? {} : { permissionMode: req.body.permissionMode }),
          ...(req.body.input === undefined ? {} : { input: req.body.input }),
        });
        await observeTask(coordinator, task);
        const locator = locatorForKey(task.key);
        const result = await coordinator.readThrough({
          locator,
          projection: "snapshot",
          allowDegradedCache: true,
        });
        if (result.freshness === "missing") {
          return reply.code(500).send({ error: "index_request_failed" });
        }
        return reply.code(201).send(result.task);
      } catch (error) {
        return sendIndexError(reply, error);
      }
    },
  );

  // POST /api/provider-index/tasks/:locator/resume
  app.post<{
    Params: LocatorParams;
    Body: { model?: string; mode?: string; permissionMode?: string };
  }>(
    "/api/provider-index/tasks/:locator/resume",
    {
      onRequest: mutationAuthHook(token),
      preValidation: exactBody((body) =>
        isRecord(body) &&
        hasOnlyKeys(body, ["model", "mode", "permissionMode"]) &&
        (body.model === undefined || typeof body.model === "string") &&
        (body.mode === undefined || typeof body.mode === "string") &&
        (body.permissionMode === undefined || typeof body.permissionMode === "string")),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            model: { type: "string", minLength: 1, maxLength: MAX_MODEL_LENGTH },
            mode: { type: "string", minLength: 1, maxLength: MAX_MODE_LENGTH },
            permissionMode: { type: "string", minLength: 1, maxLength: MAX_PERMISSION_MODE_LENGTH },
          },
        },
      },
    },
    async (req, reply) => {
      const coordinator = requireCoordinator(reply);
      if (coordinator === null) return reply;
      const locator = parseLocatorParam(reply, req.params.locator);
      if (locator === null) return reply;
      const home = resolveHome(locator);
      if (home === null) return reply.code(404).send({ error: "unknown_home" });
      const overrides: { model?: string; mode?: string; permissionMode?: string } = {};
      if (req.body.model !== undefined) overrides.model = req.body.model;
      if (req.body.mode !== undefined) overrides.mode = req.body.mode;
      if (req.body.permissionMode !== undefined) overrides.permissionMode = req.body.permissionMode;
      try {
        const task = await registry.resumeTask(
          nativeKey(locator, home),
          Object.keys(overrides).length === 0 ? undefined : overrides,
        );
        await observeTask(coordinator, task);
        const result = await coordinator.readThrough({
          locator,
          projection: "snapshot",
          allowDegradedCache: true,
        });
        if (result.freshness === "missing") {
          return reply.code(404).send({
            error: "provider_task_not_found",
            code: "NATIVE_TASK_MISSING",
            provider: locator.provider,
          });
        }
        return reply.send(result.task);
      } catch (error) {
        return sendIndexError(reply, error);
      }
    },
  );

  // POST /api/provider-index/tasks/:locator/fork
  app.post<{ Params: LocatorParams; Body: { lastTurnId?: string } }>(
    "/api/provider-index/tasks/:locator/fork",
    {
      onRequest: mutationAuthHook(token),
      preValidation: exactBody((body) =>
        isRecord(body) && hasOnlyKeys(body, ["lastTurnId"]) &&
        (body.lastTurnId === undefined || typeof body.lastTurnId === "string")),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            lastTurnId: { type: "string", minLength: 1, maxLength: MAX_NATIVE_ID_LENGTH },
          },
        },
      },
    },
    async (req, reply) => {
      const coordinator = requireCoordinator(reply);
      if (coordinator === null) return reply;
      const locator = parseLocatorParam(reply, req.params.locator);
      if (locator === null) return reply;
      const home = resolveHome(locator);
      if (home === null) return reply.code(404).send({ error: "unknown_home" });
      try {
        const target = await registry.forkTask(nativeKey(locator, home), req.body.lastTurnId);
        await observeTask(coordinator, target);
        const targetLocator = locatorForKey(target.key);
        const createdAt = Date.now();
        const transferDigest = await forkDigest(locator, targetLocator);
        let link: unknown = null;
        try {
          link = store.linkFork(locator, targetLocator, transferDigest, createdAt);
        } catch {
          // Fork link is DevHub-owned bookkeeping; a link conflict never fails the native fork.
        }
        return reply.code(201).send({ source: locator, target: targetLocator, link });
      } catch (error) {
        return sendIndexError(reply, error);
      }
    },
  );

  // POST /api/provider-index/tasks/:locator/send
  app.post<{ Params: LocatorParams; Body: { input: UserInput } }>(
    "/api/provider-index/tasks/:locator/send",
    {
      onRequest: mutationAuthHook(token),
      preValidation: exactBody((body) =>
        isRecord(body) && hasOnlyKeys(body, ["input"]) && hasExactUserInputShape(body.input)),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["input"],
          properties: { input: userInputSchema() },
        },
      },
    },
    async (req, reply) => {
      const coordinator = requireCoordinator(reply);
      if (coordinator === null) return reply;
      const locator = parseLocatorParam(reply, req.params.locator);
      if (locator === null) return reply;
      const home = resolveHome(locator);
      if (home === null) return reply.code(404).send({ error: "unknown_home" });
      try {
        const ref = await registry.send(nativeKey(locator, home), req.body.input);
        invalidate(locator);
        return reply.code(202).send({
          taskKey: locatorForKey(ref.taskKey),
          turnId: ref.turnId,
        });
      } catch (error) {
        invalidate(locator);
        return sendIndexError(reply, error);
      }
    },
  );

  // POST /api/provider-index/tasks/:locator/steer
  app.post<{ Params: LocatorParams; Body: { expectedTurnId: string; input: UserInput } }>(
    "/api/provider-index/tasks/:locator/steer",
    {
      onRequest: mutationAuthHook(token),
      preValidation: exactBody((body) =>
        isRecord(body) && hasOnlyKeys(body, ["expectedTurnId", "input"]) &&
        typeof body.expectedTurnId === "string" && hasExactUserInputShape(body.input)),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["expectedTurnId", "input"],
          properties: {
            expectedTurnId: { type: "string", minLength: 1, maxLength: MAX_NATIVE_ID_LENGTH },
            input: userInputSchema(),
          },
        },
      },
    },
    async (req, reply) => {
      const coordinator = requireCoordinator(reply);
      if (coordinator === null) return reply;
      const locator = parseLocatorParam(reply, req.params.locator);
      if (locator === null) return reply;
      const home = resolveHome(locator);
      if (home === null) return reply.code(404).send({ error: "unknown_home" });
      try {
        await registry.steer(nativeKey(locator, home), req.body.expectedTurnId, req.body.input);
        invalidate(locator);
        return reply.code(204).send();
      } catch (error) {
        invalidate(locator);
        return sendIndexError(reply, error);
      }
    },
  );

  // POST /api/provider-index/tasks/:locator/interrupt
  app.post<{ Params: LocatorParams; Body: { turnId: string } }>(
    "/api/provider-index/tasks/:locator/interrupt",
    {
      onRequest: mutationAuthHook(token),
      preValidation: exactBody((body) =>
        isRecord(body) && hasOnlyKeys(body, ["turnId"]) && typeof body.turnId === "string"),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["turnId"],
          properties: { turnId: { type: "string", minLength: 1, maxLength: MAX_NATIVE_ID_LENGTH } },
        },
      },
    },
    async (req, reply) => {
      const coordinator = requireCoordinator(reply);
      if (coordinator === null) return reply;
      const locator = parseLocatorParam(reply, req.params.locator);
      if (locator === null) return reply;
      const home = resolveHome(locator);
      if (home === null) return reply.code(404).send({ error: "unknown_home" });
      try {
        await registry.interrupt(nativeKey(locator, home), req.body.turnId);
        invalidate(locator);
        return reply.code(204).send();
      } catch (error) {
        invalidate(locator);
        return sendIndexError(reply, error);
      }
    },
  );

  // POST /api/provider-index/tasks/:locator/respond
  app.post<{ Params: LocatorParams; Body: RespondBody }>(
    "/api/provider-index/tasks/:locator/respond",
    {
      onRequest: mutationAuthHook(token),
      preValidation: exactBody(hasExactRespondBodyShape),
      schema: { body: { type: "object" } },
    },
    async (req, reply) => {
      const coordinator = requireCoordinator(reply);
      if (coordinator === null) return reply;
      const locator = parseLocatorParam(reply, req.params.locator);
      if (locator === null) return reply;
      const home = resolveHome(locator);
      if (home === null) return reply.code(404).send({ error: "unknown_home" });
      try {
        const key = nativeKey(locator, home);
        const identity = createProviderRequestIdentity({
          key,
          generation: req.body.identity.generation,
          turnId: req.body.identity.turnId,
          requestId: req.body.identity.requestId,
          itemId: req.body.identity.itemId,
          approvalId: req.body.identity.approvalId,
        });
        const response: ProviderRequestResponse =
          "decision" in req.body
            ? { kind: req.body.kind, identity, decision: req.body.decision }
            : "permissions" in req.body
            ? { kind: req.body.kind, identity, permissions: req.body.permissions }
            : { kind: req.body.kind, identity, answers: req.body.answers };
        const status = await registry.respond(response);
        invalidate(locator);
        if (status === "stale") {
          return reply.code(409).send({ error: "provider_response_stale", code: "STALE" });
        }
        return reply.code(204).send();
      } catch (error) {
        invalidate(locator);
        return sendIndexError(reply, error);
      }
    },
  );

  // POST /api/provider-index/tasks/:locator/archive
  app.post<{ Params: LocatorParams; Body: Record<string, never> }>(
    "/api/provider-index/tasks/:locator/archive",
    {
      onRequest: mutationAuthHook(token),
      preValidation: exactBody((body) =>
        body === undefined || body === null ||
        (isRecord(body) && Object.keys(body).length === 0)),
      schema: { body: { type: "object", additionalProperties: false } },
    },
    async (req, reply) => {
      const coordinator = requireCoordinator(reply);
      if (coordinator === null) return reply;
      const locator = parseLocatorParam(reply, req.params.locator);
      if (locator === null) return reply;
      const home = resolveHome(locator);
      if (home === null) return reply.code(404).send({ error: "unknown_home" });
      try {
        await registry.archive(nativeKey(locator, home));
        invalidate(locator);
        return reply.code(204).send();
      } catch (error) {
        invalidate(locator);
        return sendIndexError(reply, error);
      }
    },
  );

  // POST /api/provider-index/tasks/:locator/rename
  app.post<{ Params: LocatorParams; Body: { name: string } }>(
    "/api/provider-index/tasks/:locator/rename",
    {
      onRequest: mutationAuthHook(token),
      preValidation: exactBody((body) =>
        isRecord(body) && hasOnlyKeys(body, ["name"]) && typeof body.name === "string"),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: { name: { type: "string", minLength: 1, maxLength: MAX_TASK_NAME_LENGTH } },
        },
      },
    },
    async (req, reply) => {
      const coordinator = requireCoordinator(reply);
      if (coordinator === null) return reply;
      const locator = parseLocatorParam(reply, req.params.locator);
      if (locator === null) return reply;
      const home = resolveHome(locator);
      if (home === null) return reply.code(404).send({ error: "unknown_home" });
      try {
        await registry.rename(nativeKey(locator, home), req.body.name);
        invalidate(locator);
        return reply.code(204).send();
      } catch (error) {
        invalidate(locator);
        return sendIndexError(reply, error);
      }
    },
  );

  // GET /api/provider-index/tasks/:locator/reconciliation
  app.get<{ Params: LocatorParams }>(
    "/api/provider-index/tasks/:locator/reconciliation",
    { onRequest: readAuthHook(token) },
    async (req, reply) => {
      if (requireCoordinator(reply) === null) return reply;
      const locator = parseLocatorParam(reply, req.params.locator);
      if (locator === null) return reply;
      try {
        return reply.send(store.getReconciliation(locator));
      } catch (error) {
        return sendIndexError(reply, error);
      }
    },
  );

  // POST /api/provider-index/tasks/:locator/reconciliation/ack
  app.post<{
    Params: LocatorParams;
    Body: { latchRevision: number; reviewedFingerprint: string | null };
  }>(
    "/api/provider-index/tasks/:locator/reconciliation/ack",
    {
      onRequest: mutationAuthHook(token),
      preValidation: exactBody((body) =>
        isRecord(body) && hasOnlyKeys(body, ["latchRevision", "reviewedFingerprint"]) &&
        Number.isSafeInteger(body.latchRevision) && (body.latchRevision as number) >= 0 &&
        (body.reviewedFingerprint === null ||
          (typeof body.reviewedFingerprint === "string" &&
            body.reviewedFingerprint.length > 0 &&
            body.reviewedFingerprint.length <= MAX_REVISION_FINGERPRINT_LENGTH))),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["latchRevision", "reviewedFingerprint"],
          properties: {
            latchRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            reviewedFingerprint: {
              type: ["string", "null"],
              minLength: 1,
              maxLength: MAX_REVISION_FINGERPRINT_LENGTH,
            },
          },
        },
      },
    },
    async (req, reply) => {
      const coordinator = requireCoordinator(reply);
      if (coordinator === null) return reply;
      const locator = parseLocatorParam(reply, req.params.locator);
      if (locator === null) return reply;
      const home = resolveHome(locator);
      if (home === null) return reply.code(404).send({ error: "unknown_home" });
      // Authoritative reread: the acknowledgement records the exact native fingerprint observed
      // now (null when the reviewed outcome is deletion), then commits an exact store CAS.
      let observedNativeFingerprint: string | null = null;
      try {
        const task = await registry.readTask(nativeKey(locator, home), true);
        observedNativeFingerprint = task.revision?.fingerprint ?? null;
      } catch (error) {
        if (error instanceof ProviderOperationError && error.code === "NATIVE_TASK_MISSING") {
          observedNativeFingerprint = null;
        } else {
          return sendIndexError(reply, error);
        }
      }
      try {
        const state = store.acknowledgeReconciliation(
          locator,
          req.body.latchRevision,
          req.body.reviewedFingerprint,
          observedNativeFingerprint,
        );
        return reply.send(state);
      } catch (error) {
        return sendIndexError(reply, error);
      }
    },
  );

  // PATCH /api/provider-index/tasks/:locator/meta
  app.patch<{ Params: LocatorParams; Body: Record<string, unknown> }>(
    "/api/provider-index/tasks/:locator/meta",
    {
      onRequest: mutationAuthHook(token),
      preValidation: exactBody(hasExactMetaPatchShape),
      schema: { body: { type: "object" } },
    },
    async (req, reply) => {
      const coordinator = requireCoordinator(reply);
      if (coordinator === null) return reply;
      const locator = parseLocatorParam(reply, req.params.locator);
      if (locator === null) return reply;
      try {
        const meta = store.patchMeta(locator, req.body as never);
        return reply.send(meta);
      } catch (error) {
        return sendIndexError(reply, error);
      }
    },
  );

  // POST /api/provider-index/rebuild
  app.post<{ Body: { provider: string; homeFingerprint: string } }>(
    "/api/provider-index/rebuild",
    {
      onRequest: mutationAuthHook(token),
      preValidation: exactBody((body) =>
        isRecord(body) && hasOnlyKeys(body, ["provider", "homeFingerprint"]) &&
        typeof body.provider === "string" && typeof body.homeFingerprint === "string"),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["provider", "homeFingerprint"],
          properties: {
            provider: { type: "string", minLength: 1, maxLength: 32 },
            homeFingerprint: { type: "string", minLength: 1, maxLength: MAX_FINGERPRINT_INPUT },
          },
        },
      },
    },
    async (req, reply) => {
      const coordinator = requireCoordinator(reply);
      if (coordinator === null) return reply;
      const provider = parseProvider(req.body.provider);
      if (provider === null) return reply.code(400).send({ error: "invalid_index_request" });
      const home = store.resolveHome(provider, req.body.homeFingerprint);
      if (home === null) return reply.code(404).send({ error: "unknown_home" });
      try {
        const promotion = await coordinator.rebuild({ provider, home });
        return reply.send({
          activeGeneration: promotion.activeGeneration,
          taskCount: promotion.taskCount,
          eventCount: promotion.eventCount,
        });
      } catch (error) {
        return sendIndexError(reply, error);
      }
    },
  );

  // GET /api/provider-index/tasks/:locator/events  (SSE)
  app.get<{ Params: LocatorParams }>(
    "/api/provider-index/tasks/:locator/events",
    { onRequest: readAuthHook(token) },
    async (req, reply) => {
      const coordinator = requireCoordinator(reply);
      if (coordinator === null) return reply;
      const locator = parseLocatorParam(reply, req.params.locator);
      if (locator === null) return reply;
      const home = resolveHome(locator);
      if (home === null) return reply.code(404).send({ error: "unknown_home" });

      if (activeStreams >= MAX_INDEX_SSE_CONNECTIONS) {
        return reply.code(429).send({ error: "index_stream_limit_reached" });
      }
      activeStreams += 1;

      const key = nativeKey(locator, home);
      let reserved = true;
      let stopped = false;
      let requestClosed = false;
      let accepting = true;
      let live = false;
      let waitingForDrain = false;
      let queueBytes = 0;
      let subscriptionSettled = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: (() => void | Promise<void>) | undefined;
      let unsubscribePromise: Promise<void> | undefined;
      let raw: FastifyReply["raw"] | undefined;
      const queue: string[] = [];
      // Events observed live before the snapshot switch are buffered here; a bounded byte cap
      // makes overflow deterministic. Each entry keeps its dedup key so the drain can drop
      // events already represented in the authoritative snapshot.
      const preSwitchBuffer: Array<{ frame: string; dedupKey: string | null }> = [];
      let bufferBytes = 0;
      let bufferOverflow = false;
      const snapshotDedup = new Set<string>();

      const releaseReservation = (): void => {
        if (!reserved) return;
        reserved = false;
        activeStreams -= 1;
      };

      const runUnsubscribe = (): Promise<void> => {
        if (!unsubscribe) {
          if (subscriptionSettled) releaseReservation();
          return Promise.resolve();
        }
        if (!unsubscribePromise) {
          unsubscribePromise = Promise.resolve()
            .then(() => unsubscribe?.())
            .then(() => undefined)
            .catch(() => undefined)
            .finally(releaseReservation);
        }
        return unsubscribePromise;
      };

      const onDrain = (): void => {
        waitingForDrain = false;
        flush();
      };

      const stop = (): void => {
        if (!stopped) {
          stopped = true;
          accepting = false;
          if (heartbeat) clearInterval(heartbeat);
          if (raw) raw.off("drain", onDrain);
          queue.length = 0;
          queueBytes = 0;
          preSwitchBuffer.length = 0;
          bufferBytes = 0;
        }
        void runUnsubscribe();
      };

      const closeStream = (): void => {
        stop();
        try {
          raw?.destroy();
        } catch {
          // Already stopping; the provider subscription is closing.
        }
      };

      function flush(): void {
        if (!raw || stopped || waitingForDrain) return;
        while (queue.length > 0 && !stopped) {
          const frame = queue.shift()!;
          queueBytes -= Buffer.byteLength(frame);
          try {
            if (!raw.write(frame)) {
              waitingForDrain = true;
              raw.once("drain", onDrain);
              return;
            }
          } catch {
            closeStream();
            return;
          }
        }
      }

      const enqueue = (frame: string): void => {
        if (!accepting || stopped) return;
        const frameBytes = Buffer.byteLength(frame);
        if (queueBytes + frameBytes > MAX_INDEX_STREAM_QUEUE_BYTES) {
          accepting = false;
          emitResyncAndClose();
          return;
        }
        queue.push(frame);
        queueBytes += frameBytes;
        flush();
      };

      const emitResyncAndClose = (): void => {
        // Value-free terminal: the client must resync from a fresh snapshot; no event is dropped
        // silently and no home/path bytes are emitted.
        if (raw && !stopped) {
          try {
            raw.write(sseFrame(JSON.stringify({ type: "resync-required" })));
          } catch {
            // Falls through to close.
          }
        }
        closeStream();
      };

      const onRequestClose = (): void => {
        requestClosed = true;
        stop();
      };
      req.raw.once("close", onRequestClose);

      // Phase 1: subscribe FIRST into the bounded buffer (no cross-connection replay claim).
      try {
        unsubscribe = await registry.subscribe(key, (event) => {
          if (!accepting || stopped) return;
          if (live) {
            const payload = liveFramePayload(event);
            if (payload !== null) enqueue(sseFrame(payload));
            return;
          }
          if (bufferOverflow) return;
          const payload = liveFramePayload(event);
          if (payload === null) return;
          const frame = sseFrame(payload);
          const frameBytes = Buffer.byteLength(frame);
          if (bufferBytes + frameBytes > MAX_INDEX_STREAM_QUEUE_BYTES) {
            bufferOverflow = true;
            return;
          }
          preSwitchBuffer.push({ frame, dedupKey: liveEventDedupKey(event) });
          bufferBytes += frameBytes;
        });
        subscriptionSettled = true;
      } catch (error) {
        subscriptionSettled = true;
        req.raw.off("close", onRequestClose);
        stop();
        if (requestClosed) return reply;
        return sendIndexError(reply, error);
      }

      if (requestClosed) {
        await runUnsubscribe();
        return reply;
      }

      // Phase 2: take the authoritative snapshot with a fresh random stream epoch.
      let snapshotEvents: readonly IndexedProviderEvent[];
      try {
        const result = await coordinator.readThrough({
          locator,
          projection: "snapshot",
          allowDegradedCache: true,
        });
        if (result.freshness !== "missing" && result.projection === "snapshot") {
          snapshotEvents = result.task.turns.flatMap((turn) => turn.events);
        } else {
          snapshotEvents = [];
        }
      } catch (error) {
        req.raw.off("close", onRequestClose);
        stop();
        if (requestClosed) return reply;
        return sendIndexError(reply, error);
      }

      if (requestClosed || bufferOverflow) {
        // Overflow before the switch: fail closed rather than emit an incomplete stream.
        req.raw.off("close", onRequestClose);
        if (bufferOverflow && !requestClosed) {
          reply.hijack();
          raw = reply.raw;
          raw.writeHead(200, sseHeaders());
          raw.once("error", stop);
          emitResyncAndClose();
          return reply;
        }
        stop();
        await runUnsubscribe();
        return reply;
      }

      const streamEpoch = randomEpoch();

      reply.hijack();
      raw = reply.raw;
      raw.writeHead(200, sseHeaders());
      raw.once("error", stop);

      queue.push(sseFrame(JSON.stringify({ type: "snapshot", streamEpoch })));
      queueBytes += Buffer.byteLength(queue[queue.length - 1]!);
      for (const event of snapshotEvents) {
        const dedupKey = indexedEventDedupKey(event);
        if (dedupKey !== null) snapshotDedup.add(dedupKey);
        const payload = snapshotFramePayload(event);
        if (payload !== null) enqueue(sseFrame(payload));
        if (stopped) return reply;
      }

      // Phase 3: drain buffered events, dropping any already represented in the snapshot.
      for (const buffered of preSwitchBuffer) {
        if (stopped) return reply;
        if (buffered.dedupKey !== null && snapshotDedup.has(buffered.dedupKey)) continue;
        enqueue(buffered.frame);
      }
      preSwitchBuffer.length = 0;
      bufferBytes = 0;

      // Phase 4: atomic switch to live delivery on the same sink.
      live = true;
      if (stopped) return reply;
      enqueue(sseFrame(JSON.stringify({ type: "live" })));
      flush();
      if (!stopped) {
        heartbeat = setInterval(() => enqueue(": ping\n\n"), INDEX_STREAM_HEARTBEAT_MS);
      }
      return reply;
    },
  );

  async function forkDigest(
    source: ProviderTaskLocator,
    target: ProviderTaskLocator,
  ): Promise<string> {
    const { createHash } = await import("node:crypto");
    return createHash("sha256")
      .update(`devhub-fork-link:v1 ${serializeTaskLocator(source)} ${serializeTaskLocator(target)}`,
        "utf8")
      .digest("hex");
  }
}

function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  };
}

function randomEpoch(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function userInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: { type: "string", maxLength: MAX_INPUT_TEXT_LENGTH },
      attachments: {
        type: "array",
        maxItems: MAX_ATTACHMENT_COUNT,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "path"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: MAX_ATTACHMENT_NAME_LENGTH },
            path: { type: "string", minLength: 1, maxLength: MAX_CWD_LENGTH },
            mediaType: { type: "string", minLength: 1, maxLength: MAX_MEDIA_TYPE_LENGTH },
          },
        },
      },
    },
  };
}

function exactBody(validate: (body: unknown) => boolean): preValidationHookHandler {
  return (request, reply, done) => {
    if (validate(request.body)) {
      done();
      return;
    }
    void reply.code(400).send({ error: "invalid_index_request" });
  };
}
