import type {
  FastifyInstance,
  FastifyReply,
  onRequestHookHandler,
  preValidationHookHandler,
} from "fastify";
import {
  ProviderAdapterError,
  ProviderCapabilityError,
  MAX_CODEX_LIST_CURSOR_CHARS,
  ProviderOperationError,
  ProviderRegistryNotFoundError,
  createNativeTaskKey,
  createProviderRequestIdentity,
  type JsonRpcRequestId,
  type ListTasksInput,
  type ProviderEvent,
  type ProviderId,
  type ProviderRegistry,
  type ProviderRequestResponse,
  type StartTaskInput,
  type TaskOverrides,
  type UserInput,
} from "@devhub/engine/providers";

const PROVIDER_IDS = new Set<ProviderId>(["openai", "anthropic"]);

const MAX_HOME_LENGTH = 4_096;
const MAX_NATIVE_ID_LENGTH = 512;
const MAX_MODEL_LENGTH = 256;
const MAX_MODE_LENGTH = 64;
const MAX_PERMISSION_MODE_LENGTH = 64;
const MAX_REVISION_FINGERPRINT_LENGTH = 512;
const MAX_INPUT_TEXT_LENGTH = 100_000;
const MAX_ATTACHMENT_COUNT = 50;
const MAX_ATTACHMENT_NAME_LENGTH = 255;
const MAX_MEDIA_TYPE_LENGTH = 256;
const MAX_TASK_NAME_LENGTH = 200;
const MAX_RESPONSE_COLLECTION_SIZE = 128;
const MAX_RESPONSE_VALUE_LENGTH = 100_000;

const MAX_PROVIDER_SSE_CONNECTIONS = 32;
const MAX_PROVIDER_EVENT_BYTES = 256 * 1_024;
const MAX_PROVIDER_STREAM_QUEUE_BYTES = 512 * 1_024;
const PROVIDER_STREAM_HEARTBEAT_MS = 25_000;

interface TaskParams {
  provider: string;
  nativeTaskId: string;
}

interface HomeBody {
  home: string;
}

interface ResumeBody extends HomeBody, TaskOverrides {}

interface ForkBody extends HomeBody {
  lastTurnId?: string;
}

interface SendBody extends HomeBody {
  input: UserInput;
}

interface SteerBody extends SendBody {
  expectedTurnId: string;
}

interface InterruptBody extends HomeBody {
  turnId: string;
}

interface RenameBody extends HomeBody {
  name: string;
}

interface ReconciliationBody extends HomeBody {
  fingerprint: string;
}

interface ResponseIdentityBody {
  generation: number | null;
  turnId: string | null;
  requestId: JsonRpcRequestId;
  itemId: string | null;
  approvalId: JsonRpcRequestId | null;
}

type RespondBody =
  | (HomeBody & {
      kind: "command-approval" | "file-change-approval" | "mcp-elicitation";
      identity: ResponseIdentityBody;
      decision: "allow" | "deny" | "cancel";
    })
  | (HomeBody & {
      kind: "permission";
      identity: ResponseIdentityBody;
      permissions: string[];
    })
  | (HomeBody & {
      kind: "user-input";
      identity: ResponseIdentityBody;
      answers: Record<string, string>;
    });

const providerParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["provider"],
  properties: {
    provider: { type: "string", minLength: 1, maxLength: 32 },
  },
};

const taskParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["provider", "nativeTaskId"],
  properties: {
    provider: { type: "string", minLength: 1, maxLength: 32 },
    nativeTaskId: { type: "string", minLength: 1, maxLength: MAX_NATIVE_ID_LENGTH },
  },
};

const homeSchema = {
  type: "string",
  minLength: 1,
  maxLength: MAX_HOME_LENGTH,
};

const nativeIdSchema = {
  type: "string",
  minLength: 1,
  maxLength: MAX_NATIVE_ID_LENGTH,
};

const nullableNativeIdSchema = {
  type: ["string", "null"],
  minLength: 1,
  maxLength: MAX_NATIVE_ID_LENGTH,
};

// Fastify's default AJV coercion can collapse JSON-RPC string and numeric ids.
// Their exact validation therefore runs in preValidation, before AJV, while the
// schema still requires the fields and constrains the surrounding object shape.
const jsonRpcIdSchema = {};
const nullableJsonRpcIdSchema = {};

const taskOverridesProperties = {
  model: { type: "string", minLength: 1, maxLength: MAX_MODEL_LENGTH },
  mode: { type: "string", minLength: 1, maxLength: MAX_MODE_LENGTH },
  permissionMode: {
    type: "string",
    minLength: 1,
    maxLength: MAX_PERMISSION_MODE_LENGTH,
  },
};

const userInputSchema = {
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
          path: { type: "string", minLength: 1, maxLength: MAX_HOME_LENGTH },
          mediaType: { type: "string", minLength: 1, maxLength: MAX_MEDIA_TYPE_LENGTH },
        },
      },
    },
  },
};

const responseIdentitySchema = {
  type: "object",
  additionalProperties: false,
  required: ["generation", "turnId", "requestId", "itemId", "approvalId"],
  properties: {
    generation: {
      type: ["integer", "null"],
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    turnId: nullableNativeIdSchema,
    requestId: jsonRpcIdSchema,
    itemId: nullableNativeIdSchema,
    approvalId: nullableJsonRpcIdSchema,
  },
};

const homeOnlyBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["home"],
  properties: { home: homeSchema },
};

const respondBodySchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["home", "kind", "identity", "decision"],
      properties: {
        home: homeSchema,
        kind: {
          type: "string",
          enum: ["command-approval", "file-change-approval", "mcp-elicitation"],
        },
        identity: responseIdentitySchema,
        decision: { type: "string", enum: ["allow", "deny", "cancel"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["home", "kind", "identity", "permissions"],
      properties: {
        home: homeSchema,
        kind: { type: "string", const: "permission" },
        identity: responseIdentitySchema,
        permissions: {
          type: "array",
          maxItems: MAX_RESPONSE_COLLECTION_SIZE,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: MAX_NATIVE_ID_LENGTH },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["home", "kind", "identity", "answers"],
      properties: {
        home: homeSchema,
        kind: { type: "string", const: "user-input" },
        identity: responseIdentitySchema,
        answers: {
          type: "object",
          maxProperties: MAX_RESPONSE_COLLECTION_SIZE,
          propertyNames: { type: "string", minLength: 1, maxLength: MAX_NATIVE_ID_LENGTH },
          additionalProperties: { type: "string", maxLength: MAX_RESPONSE_VALUE_LENGTH },
        },
      },
    },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: unknown, allowed: readonly string[]): boolean {
  if (!isRecord(value)) return true;
  const allowlist = new Set(allowed);
  return Object.keys(value).every((key) => allowlist.has(key));
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

function isJsonRpcId(value: unknown, nullable: boolean): boolean {
  if (value === null) return nullable;
  if (typeof value === "number") return Number.isSafeInteger(value);
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_NATIVE_ID_LENGTH &&
    !value.includes("\u0000");
}

function isNullableNativeId(value: unknown): boolean {
  if (value === null) return true;
  return typeof value === "string" && isJsonRpcId(value, false);
}

function hasExactResponseIdentityShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, [
    "generation",
    "turnId",
    "requestId",
    "itemId",
    "approvalId",
  ])) return false;
  if (!["generation", "turnId", "requestId", "itemId", "approvalId"].every(
    (field) => Object.prototype.hasOwnProperty.call(value, field),
  )) return false;
  const generationIsValid = value.generation === null ||
    (Number.isSafeInteger(value.generation) && (value.generation as number) >= 0);
  return generationIsValid &&
    isNullableNativeId(value.turnId) &&
    isJsonRpcId(value.requestId, false) &&
    isNullableNativeId(value.itemId) &&
    isJsonRpcId(value.approvalId, true);
}

function hasExactRespondBodyShape(value: unknown): boolean {
  if (!isRecord(value) || typeof value.home !== "string") return false;
  if (!hasExactResponseIdentityShape(value.identity)) return false;
  switch (value.kind) {
    case "command-approval":
    case "file-change-approval":
    case "mcp-elicitation":
      return hasOnlyKeys(value, ["home", "kind", "identity", "decision"]) &&
        typeof value.decision === "string";
    case "permission":
      return hasOnlyKeys(value, ["home", "kind", "identity", "permissions"]) &&
        Array.isArray(value.permissions) &&
        value.permissions.every((permission) => typeof permission === "string");
    case "user-input":
      return hasOnlyKeys(value, ["home", "kind", "identity", "answers"]) &&
        isRecord(value.answers) &&
        Object.values(value.answers).every((answer) => typeof answer === "string");
    default:
      return hasOnlyKeys(value, ["home", "kind", "identity"]);
  }
}

function exactBodyHook(
  validate: (body: unknown) => boolean,
): preValidationHookHandler {
  return (request, reply, done) => {
    if (hasOnlyKeys(request.query, []) && validate(request.body)) {
      done();
      return;
    }
    void reply.code(400).send({ error: "invalid_provider_request" });
  };
}

function exactQueryHook(allowed: readonly string[]): preValidationHookHandler {
  return (request, reply, done) => {
    if (hasOnlyKeys(request.query, allowed)) {
      done();
      return;
    }
    void reply.code(400).send({ error: "invalid_provider_request" });
  };
}

function mutationAuthHook(token: string | undefined): onRequestHookHandler {
  return (request, reply, done) => {
    if (isRecord(request.query) && Object.hasOwn(request.query, "token")) {
      void reply.code(401).send({ error: "unauthorized" });
      return;
    }
    const authError = authorizeMutation(reply, request.headers.authorization, token);
    if (!authError) done();
  };
}

function providerReadAuthHook(token: string | undefined): onRequestHookHandler {
  return (request, reply, done) => {
    const hasUrlToken = isRecord(request.query) && Object.hasOwn(request.query, "token");
    if (hasUrlToken || token && request.headers.authorization !== `Bearer ${token}`) {
      void reply.code(401).send({ error: "unauthorized" });
      return;
    }
    done();
  };
}

function exactStringBodyShape(
  value: unknown,
  allowed: readonly string[],
  stringFields: readonly string[],
): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, allowed)) return false;
  return stringFields.every((field) =>
    !(field in value) || typeof value[field] === "string");
}

function exactInputBodyShape(
  value: unknown,
  allowed: readonly string[],
  stringFields: readonly string[],
  inputRequired = true,
): boolean {
  if (!exactStringBodyShape(value, allowed, stringFields) || !isRecord(value)) return false;
  if (value.input === undefined) return !inputRequired;
  return hasExactUserInputShape(value.input);
}

function parseProvider(value: string): ProviderId | null {
  return PROVIDER_IDS.has(value as ProviderId) ? (value as ProviderId) : null;
}

function providerNotFound(reply: FastifyReply, provider: string): FastifyReply {
  return reply.code(404).send({
    error: "provider_not_found",
    code: "PROVIDER_ADAPTER_NOT_FOUND",
    provider,
  });
}

function invalidProviderRequest(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({ error: "invalid_provider_request" });
}

function sendProviderError(
  reply: FastifyReply,
  error: unknown,
  fallbackProvider: ProviderId,
): FastifyReply {
  if (error instanceof ProviderRegistryNotFoundError) {
    return providerNotFound(reply, error.provider);
  }
  if (error instanceof ProviderCapabilityError) {
    return reply.code(409).send({
      error: "provider_capability_unavailable",
      code: error.code,
      provider: error.provider ?? fallbackProvider,
      capability: error.capability,
    });
  }
  if (error instanceof ProviderOperationError) {
    switch (error.code) {
      case "PARTIAL_START":
      case "PARTIAL_FORK":
        if (!error.task) {
          return reply.code(500).send({ error: "provider_request_failed" });
        }
        return reply.code(201).send({
          outcome: "partial",
          code: error.code,
          provider: fallbackProvider,
          task: error.task,
        });
      case "INVALID_INPUT":
      case "UNSAFE_OVERRIDE":
        return reply.code(400).send({
          error: "provider_invalid_request",
          code: error.code,
          provider: fallbackProvider,
        });
      case "POLICY_MISMATCH":
        return reply.code(409).send({
          error: "provider_policy_mismatch",
          code: error.code,
          provider: fallbackProvider,
        });
      case "RECONCILIATION_REQUIRED":
        return reply.code(409).send({
          error: "provider_reconciliation_required",
          code: error.code,
          provider: fallbackProvider,
        });
      case "NATIVE_TASK_MISSING":
        return reply.code(404).send({
          error: "provider_task_not_found",
          code: error.code,
          provider: fallbackProvider,
        });
      case "MUTATION_UNCERTAIN":
        return reply.code(409).send({
          error: "provider_mutation_uncertain",
          code: error.code,
          provider: fallbackProvider,
          retryable: false,
        });
      case "UNSUPPORTED_INTERACTION":
        return reply.code(409).send({
          error: "provider_interaction_unavailable",
          code: error.code,
          provider: fallbackProvider,
        });
      case "SUBSCRIPTION_CAPACITY":
        return reply.code(429).send({
          error: "provider_capacity_reached",
          code: error.code,
          provider: fallbackProvider,
        });
      case "DISABLED":
        return reply.code(409).send({
          error: "provider_runtime_disabled",
          code: error.code,
          provider: fallbackProvider,
        });
      case "DISPOSED":
      case "OWNERSHIP":
        return reply.code(503).send({
          error: "provider_unavailable",
          code: error.code,
          provider: fallbackProvider,
        });
    }
  }
  if (error instanceof ProviderAdapterError) {
    return reply.code(503).send({
      error: "provider_unavailable",
      code: error.code,
      provider: error.provider,
    });
  }
  if (error instanceof TypeError) return invalidProviderRequest(reply);
  return reply.code(500).send({ error: "provider_request_failed" });
}

function authorizeMutation(
  reply: FastifyReply,
  authorization: string | undefined,
  mutationToken: string | undefined,
): FastifyReply | null {
  if (!mutationToken) {
    return reply.code(503).send({ error: "provider_mutations_disabled" });
  }
  if (authorization !== `Bearer ${mutationToken}`) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  return null;
}

function taskKey(provider: ProviderId, body: HomeBody, nativeTaskId: string) {
  return createNativeTaskKey(provider, body.home, nativeTaskId);
}

function pickOverrides(body: ResumeBody): TaskOverrides | undefined {
  const overrides: TaskOverrides = {};
  if (body.model !== undefined) overrides.model = body.model;
  if (body.mode !== undefined) overrides.mode = body.mode;
  if (body.permissionMode !== undefined) overrides.permissionMode = body.permissionMode;
  return Object.keys(overrides).length === 0 ? undefined : overrides;
}

function providerResponse(
  provider: ProviderId,
  nativeTaskId: string,
  body: RespondBody,
): ProviderRequestResponse {
  const identity = createProviderRequestIdentity({
    key: taskKey(provider, body, nativeTaskId),
    generation: body.identity.generation,
    turnId: body.identity.turnId,
    requestId: body.identity.requestId,
    itemId: body.identity.itemId,
    approvalId: body.identity.approvalId,
  });
  switch (body.kind) {
    case "command-approval":
    case "file-change-approval":
    case "mcp-elicitation":
      return { kind: body.kind, identity, decision: body.decision };
    case "permission":
      return { kind: body.kind, identity, permissions: body.permissions };
    case "user-input":
      return { kind: body.kind, identity, answers: body.answers };
  }
}

function oversizedEventDiagnostic(event: ProviderEvent): ProviderEvent {
  return {
    type: "diagnostic",
    provider: event.provider,
    key: event.key,
    occurredAt: event.occurredAt,
    level: "warning",
    code: "PROVIDER_EVENT_TOO_LARGE",
    message: "Provider event exceeded the bounded stream payload limit",
    method: null,
    shapeKeys: [],
  };
}

function providerEventFrame(event: ProviderEvent): string {
  let payload: string;
  try {
    payload = JSON.stringify(event);
  } catch {
    payload = JSON.stringify(oversizedEventDiagnostic(event));
  }
  if (Buffer.byteLength(payload) > MAX_PROVIDER_EVENT_BYTES) {
    payload = JSON.stringify(oversizedEventDiagnostic(event));
  }
  return `data: ${payload}\n\n`;
}

/**
 * Register the provider-neutral task HTTP and event seam.
 *
 * Provider processes, homes, and credentials remain backend-owned. Mutations
 * require an exact Bearer header and are disabled unless the server has a token.
 * The read-only event stream is local-tokenless when the rest of the server is,
 * but when a token exists it likewise rejects URL credentials and accepts only
 * the Authorization header.
 */
export function registerProviderTaskRoutes(
  app: FastifyInstance,
  registry: ProviderRegistry,
  mutationToken?: string,
): void {
  let activeProviderStreams = 0;

  app.get(
    "/api/providers",
    {
      onRequest: providerReadAuthHook(mutationToken),
      preValidation: exactQueryHook([]),
    },
    async () => registry.descriptorCensus(),
  );

  app.get<{
    Params: { provider: string };
    Querystring: {
      home: string;
      cursor?: string;
      limit?: number;
      includeArchived?: boolean;
    };
  }>(
    "/api/providers/:provider/tasks",
    {
      onRequest: providerReadAuthHook(mutationToken),
      preValidation: exactQueryHook(["home", "cursor", "limit", "includeArchived"]),
      schema: {
        params: providerParamsSchema,
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["home"],
          properties: {
            home: homeSchema,
            cursor: { type: "string", minLength: 1, maxLength: MAX_CODEX_LIST_CURSOR_CHARS },
            limit: { type: "integer", minimum: 1, maximum: 200 },
            includeArchived: { type: "boolean" },
          },
        },
      },
    },
    async (req, reply) => {
      const provider = parseProvider(req.params.provider);
      if (!provider) return providerNotFound(reply, req.params.provider);

      const input: ListTasksInput = { home: req.query.home };
      if (req.query.cursor !== undefined) input.cursor = req.query.cursor;
      if (req.query.limit !== undefined) input.limit = req.query.limit;
      if (req.query.includeArchived !== undefined) {
        input.includeArchived = req.query.includeArchived;
      }

      try {
        return await registry.listTasks(provider, input);
      } catch (error) {
        return sendProviderError(reply, error, provider);
      }
    },
  );

  app.get<{
    Params: TaskParams;
    Querystring: { home: string; includeTurns?: boolean };
  }>(
    "/api/providers/:provider/tasks/:nativeTaskId",
    {
      onRequest: providerReadAuthHook(mutationToken),
      preValidation: exactQueryHook(["home", "includeTurns"]),
      schema: {
        params: taskParamsSchema,
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["home"],
          properties: {
            home: homeSchema,
            includeTurns: { type: "boolean" },
          },
        },
      },
    },
    async (req, reply) => {
      const provider = parseProvider(req.params.provider);
      if (!provider) return providerNotFound(reply, req.params.provider);

      try {
        const key = createNativeTaskKey(provider, req.query.home, req.params.nativeTaskId);
        return await registry.readTask(key, req.query.includeTurns === true);
      } catch (error) {
        return sendProviderError(reply, error, provider);
      }
    },
  );

  app.post<{ Params: TaskParams; Body: ReconciliationBody }>(
    "/api/providers/:provider/tasks/:nativeTaskId/reconciliation",
    {
      onRequest: mutationAuthHook(mutationToken),
      preValidation: exactBodyHook((body) =>
        exactStringBodyShape(body, ["home", "fingerprint"], ["home", "fingerprint"])),
      schema: {
        params: taskParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["home", "fingerprint"],
          properties: {
            home: homeSchema,
            fingerprint: {
              type: "string",
              minLength: 1,
              maxLength: MAX_REVISION_FINGERPRINT_LENGTH,
            },
          },
        },
      },
    },
    async (req, reply) => {
      const authError = authorizeMutation(reply, req.headers.authorization, mutationToken);
      if (authError) return authError;
      const provider = parseProvider(req.params.provider);
      if (!provider) return providerNotFound(reply, req.params.provider);
      try {
        await registry.acknowledgeReconciliation(
          taskKey(provider, req.body, req.params.nativeTaskId),
          req.body.fingerprint,
        );
        return reply.code(204).send();
      } catch (error) {
        return sendProviderError(reply, error, provider);
      }
    },
  );

  app.post<{
    Params: { provider: string };
    Body: StartTaskInput;
  }>(
    "/api/providers/:provider/tasks",
    {
      onRequest: mutationAuthHook(mutationToken),
      preValidation: exactBodyHook((body) =>
        exactInputBodyShape(
          body,
          ["home", "cwd", "model", "mode", "permissionMode", "input"],
          ["home", "cwd", "model", "mode", "permissionMode"],
          false,
        )),
      schema: {
        params: providerParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["home", "cwd"],
          properties: {
            home: homeSchema,
            cwd: { type: "string", minLength: 1, maxLength: MAX_HOME_LENGTH },
            ...taskOverridesProperties,
            input: userInputSchema,
          },
        },
      },
    },
    async (req, reply) => {
      const authError = authorizeMutation(
        reply,
        req.headers.authorization,
        mutationToken,
      );
      if (authError) return authError;

      const provider = parseProvider(req.params.provider);
      if (!provider) return providerNotFound(reply, req.params.provider);

      try {
        const task = await registry.startTask(provider, req.body);
        return reply.code(201).send(task);
      } catch (error) {
        return sendProviderError(reply, error, provider);
      }
    },
  );

  app.post<{ Params: TaskParams; Body: ResumeBody }>(
    "/api/providers/:provider/tasks/:nativeTaskId/resume",
    {
      onRequest: mutationAuthHook(mutationToken),
      preValidation: exactBodyHook((body) =>
        exactStringBodyShape(
          body,
          ["home", "model", "mode", "permissionMode"],
          ["home", "model", "mode", "permissionMode"],
        )),
      schema: {
        params: taskParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["home"],
          properties: { home: homeSchema, ...taskOverridesProperties },
        },
      },
    },
    async (req, reply) => {
      const authError = authorizeMutation(reply, req.headers.authorization, mutationToken);
      if (authError) return authError;
      const provider = parseProvider(req.params.provider);
      if (!provider) return providerNotFound(reply, req.params.provider);
      try {
        return await registry.resumeTask(
          taskKey(provider, req.body, req.params.nativeTaskId),
          pickOverrides(req.body),
        );
      } catch (error) {
        return sendProviderError(reply, error, provider);
      }
    },
  );

  app.post<{ Params: TaskParams; Body: ForkBody }>(
    "/api/providers/:provider/tasks/:nativeTaskId/fork",
    {
      onRequest: mutationAuthHook(mutationToken),
      preValidation: exactBodyHook(
        (body) => exactStringBodyShape(
          body,
          ["home", "lastTurnId"],
          ["home", "lastTurnId"],
        ),
      ),
      schema: {
        params: taskParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["home"],
          properties: { home: homeSchema, lastTurnId: nativeIdSchema },
        },
      },
    },
    async (req, reply) => {
      const authError = authorizeMutation(reply, req.headers.authorization, mutationToken);
      if (authError) return authError;
      const provider = parseProvider(req.params.provider);
      if (!provider) return providerNotFound(reply, req.params.provider);
      try {
        const task = await registry.forkTask(
          taskKey(provider, req.body, req.params.nativeTaskId),
          req.body.lastTurnId,
        );
        return reply.code(201).send(task);
      } catch (error) {
        return sendProviderError(reply, error, provider);
      }
    },
  );

  app.post<{ Params: TaskParams; Body: SendBody }>(
    "/api/providers/:provider/tasks/:nativeTaskId/send",
    {
      onRequest: mutationAuthHook(mutationToken),
      preValidation: exactBodyHook(
        (body) => exactInputBodyShape(body, ["home", "input"], ["home"]),
      ),
      schema: {
        params: taskParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["home", "input"],
          properties: { home: homeSchema, input: userInputSchema },
        },
      },
    },
    async (req, reply) => {
      const authError = authorizeMutation(reply, req.headers.authorization, mutationToken);
      if (authError) return authError;
      const provider = parseProvider(req.params.provider);
      if (!provider) return providerNotFound(reply, req.params.provider);
      try {
        const ref = await registry.send(
          taskKey(provider, req.body, req.params.nativeTaskId),
          req.body.input,
        );
        return reply.code(202).send(ref);
      } catch (error) {
        return sendProviderError(reply, error, provider);
      }
    },
  );

  app.post<{ Params: TaskParams; Body: SteerBody }>(
    "/api/providers/:provider/tasks/:nativeTaskId/steer",
    {
      onRequest: mutationAuthHook(mutationToken),
      preValidation: exactBodyHook((body) =>
        exactInputBodyShape(
          body,
          ["home", "expectedTurnId", "input"],
          ["home", "expectedTurnId"],
        )),
      schema: {
        params: taskParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["home", "expectedTurnId", "input"],
          properties: {
            home: homeSchema,
            expectedTurnId: nativeIdSchema,
            input: userInputSchema,
          },
        },
      },
    },
    async (req, reply) => {
      const authError = authorizeMutation(reply, req.headers.authorization, mutationToken);
      if (authError) return authError;
      const provider = parseProvider(req.params.provider);
      if (!provider) return providerNotFound(reply, req.params.provider);
      try {
        await registry.steer(
          taskKey(provider, req.body, req.params.nativeTaskId),
          req.body.expectedTurnId,
          req.body.input,
        );
        return reply.code(204).send();
      } catch (error) {
        return sendProviderError(reply, error, provider);
      }
    },
  );

  app.post<{ Params: TaskParams; Body: InterruptBody }>(
    "/api/providers/:provider/tasks/:nativeTaskId/interrupt",
    {
      onRequest: mutationAuthHook(mutationToken),
      preValidation: exactBodyHook(
        (body) => exactStringBodyShape(
          body,
          ["home", "turnId"],
          ["home", "turnId"],
        ),
      ),
      schema: {
        params: taskParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["home", "turnId"],
          properties: { home: homeSchema, turnId: nativeIdSchema },
        },
      },
    },
    async (req, reply) => {
      const authError = authorizeMutation(reply, req.headers.authorization, mutationToken);
      if (authError) return authError;
      const provider = parseProvider(req.params.provider);
      if (!provider) return providerNotFound(reply, req.params.provider);
      try {
        await registry.interrupt(
          taskKey(provider, req.body, req.params.nativeTaskId),
          req.body.turnId,
        );
        return reply.code(204).send();
      } catch (error) {
        return sendProviderError(reply, error, provider);
      }
    },
  );

  app.post<{ Params: TaskParams; Body: RespondBody }>(
    "/api/providers/:provider/tasks/:nativeTaskId/respond",
    {
      onRequest: mutationAuthHook(mutationToken),
      preValidation: exactBodyHook(hasExactRespondBodyShape),
      schema: { params: taskParamsSchema, body: respondBodySchema },
    },
    async (req, reply) => {
      const authError = authorizeMutation(reply, req.headers.authorization, mutationToken);
      if (authError) return authError;
      const provider = parseProvider(req.params.provider);
      if (!provider) return providerNotFound(reply, req.params.provider);
      try {
        const status = await registry.respond(
          providerResponse(provider, req.params.nativeTaskId, req.body),
        );
        return { status };
      } catch (error) {
        return sendProviderError(reply, error, provider);
      }
    },
  );

  app.post<{ Params: TaskParams; Body: HomeBody }>(
    "/api/providers/:provider/tasks/:nativeTaskId/archive",
    {
      onRequest: mutationAuthHook(mutationToken),
      preValidation: exactBodyHook((body) =>
        exactStringBodyShape(body, ["home"], ["home"])),
      schema: { params: taskParamsSchema, body: homeOnlyBodySchema },
    },
    async (req, reply) => {
      const authError = authorizeMutation(reply, req.headers.authorization, mutationToken);
      if (authError) return authError;
      const provider = parseProvider(req.params.provider);
      if (!provider) return providerNotFound(reply, req.params.provider);
      try {
        await registry.archive(taskKey(provider, req.body, req.params.nativeTaskId));
        return reply.code(204).send();
      } catch (error) {
        return sendProviderError(reply, error, provider);
      }
    },
  );

  app.post<{ Params: TaskParams; Body: RenameBody }>(
    "/api/providers/:provider/tasks/:nativeTaskId/rename",
    {
      onRequest: mutationAuthHook(mutationToken),
      preValidation: exactBodyHook(
        (body) => exactStringBodyShape(
          body,
          ["home", "name"],
          ["home", "name"],
        ),
      ),
      schema: {
        params: taskParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["home", "name"],
          properties: {
            home: homeSchema,
            name: { type: "string", minLength: 1, maxLength: MAX_TASK_NAME_LENGTH },
          },
        },
      },
    },
    async (req, reply) => {
      const authError = authorizeMutation(reply, req.headers.authorization, mutationToken);
      if (authError) return authError;
      const provider = parseProvider(req.params.provider);
      if (!provider) return providerNotFound(reply, req.params.provider);
      try {
        await registry.rename(
          taskKey(provider, req.body, req.params.nativeTaskId),
          req.body.name,
        );
        return reply.code(204).send();
      } catch (error) {
        return sendProviderError(reply, error, provider);
      }
    },
  );

  app.get<{
    Params: TaskParams;
    Querystring: { home: string };
  }>(
    "/api/providers/:provider/tasks/:nativeTaskId/events",
    {
      onRequest: providerReadAuthHook(mutationToken),
      preValidation: exactQueryHook(["home"]),
      schema: {
        params: taskParamsSchema,
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["home"],
          properties: {
            home: homeSchema,
          },
        },
      },
    },
    async (req, reply) => {
      if (
        mutationToken &&
        req.headers.authorization !== `Bearer ${mutationToken}`
      ) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      const provider = parseProvider(req.params.provider);
      if (!provider) return providerNotFound(reply, req.params.provider);

      let key;
      try {
        key = createNativeTaskKey(provider, req.query.home, req.params.nativeTaskId);
      } catch (error) {
        return sendProviderError(reply, error, provider);
      }

      if (activeProviderStreams >= MAX_PROVIDER_SSE_CONNECTIONS) {
        return reply.code(429).send({ error: "provider_stream_limit_reached" });
      }
      activeProviderStreams += 1;

      let reserved = true;
      let stopped = false;
      let requestClosed = false;
      let accepting = true;
      let overloaded = false;
      let waitingForDrain = false;
      let queueBytes = 0;
      let subscriptionSettled = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: (() => void | Promise<void>) | undefined;
      let unsubscribePromise: Promise<void> | undefined;
      let raw: FastifyReply["raw"] | undefined;
      const queue: string[] = [];

      const releaseReservation = (): void => {
        if (!reserved) return;
        reserved = false;
        activeProviderStreams -= 1;
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
        }
        void runUnsubscribe();
      };

      const closeForBackpressure = (): void => {
        overloaded = true;
        stop();
        try {
          raw?.destroy();
        } catch {
          // The stream is already stopped and its provider subscription is closing.
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
            closeForBackpressure();
            return;
          }
        }
      }

      const enqueue = (frame: string): void => {
        if (!accepting || stopped) return;
        const frameBytes = Buffer.byteLength(frame);
        if (queueBytes + frameBytes > MAX_PROVIDER_STREAM_QUEUE_BYTES) {
          overloaded = true;
          accepting = false;
          queue.length = 0;
          queueBytes = 0;
          if (raw) closeForBackpressure();
          return;
        }
        queue.push(frame);
        queueBytes += frameBytes;
        flush();
      };

      const onRequestClose = (): void => {
        requestClosed = true;
        stop();
      };
      req.raw.once("close", onRequestClose);

      try {
        unsubscribe = await registry.subscribe(key, (event) => {
          if (!accepting || stopped) return;
          enqueue(providerEventFrame(event));
        });
        subscriptionSettled = true;
      } catch (error) {
        subscriptionSettled = true;
        req.raw.off("close", onRequestClose);
        stop();
        if (requestClosed) return reply;
        return sendProviderError(reply, error, provider);
      }

      if (requestClosed) {
        await runUnsubscribe();
        return reply;
      }
      if (overloaded) {
        req.raw.off("close", onRequestClose);
        stop();
        await runUnsubscribe();
        return reply.code(503).send({ error: "provider_stream_overloaded" });
      }

      reply.hijack();
      raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      raw.once("error", stop);

      queue.unshift(": connected\n\n");
      queueBytes += Buffer.byteLength(": connected\n\n");
      flush();
      if (!stopped) {
        heartbeat = setInterval(() => enqueue(": ping\n\n"), PROVIDER_STREAM_HEARTBEAT_MS);
      }
      return reply;
    },
  );
}
