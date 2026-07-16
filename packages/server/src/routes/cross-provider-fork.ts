/**
 * M7 Task fork-server: the HTTP boundary over the engine's cross-provider handoff
 * model ({@link buildCrossProviderHandoffPreview} / {@link commitCrossProviderHandoff}
 * in `@devhub/engine/providers`). Two endpoints:
 *
 *  - POST .../fork-preview builds a REVIEW-ONLY preview: the allowlisted/redacted
 *    transferred context plus the target provider/model/mode/cwd descriptor and the
 *    source content hash the eventual commit re-checks against. Nothing is created.
 *  - POST .../fork-commit takes the opaque `previewId` returned above and actually
 *    creates the native target task (via `ProviderRegistry.startTask`), returning the
 *    bidirectional `CrossProviderHandoffLink`.
 *
 * The preview is held server-side (never round-tripped through the client) precisely
 * so a client can never smuggle tampered transferred-context text into a commit —
 * the only client input at commit time is the `previewId` handed back at preview
 * time. Both routes re-check the `crossProviderFork` feature flag themselves (never
 * trusting a client-supplied flag value) and answer with a disabled response when it
 * is not exactly `true`. Every response is built from the engine's own preview/link
 * shapes, which are locator-based (home FINGERPRINT only) — no raw provider home path
 * is ever part of a response body.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import type { Engine } from "@devhub/engine";
import {
  buildCrossProviderHandoffPreview,
  commitCrossProviderHandoff,
  createNativeTaskKey,
  CrossProviderForkDisabledError,
  HandoffTargetNotNativeError,
  ProviderAdapterError,
  ProviderCapabilityError,
  ProviderOperationError,
  ProviderRegistryNotFoundError,
  SourceTaskMutatedError,
  type CrossProviderHandoffPreview,
  type NativeTaskKey,
  type ProviderId,
  type ProviderRegistry,
} from "@devhub/engine/providers";

const PROVIDER_IDS = new Set<ProviderId>(["openai", "anthropic"]);

const MAX_HOME_LENGTH = 4_096;
const MAX_NATIVE_ID_LENGTH = 512;
const MAX_MODEL_LENGTH = 256;
const MAX_MODE_LENGTH = 64;

/** Previews are single-use and short-lived: 10 minutes, or the process's own cap. */
const PREVIEW_TTL_MS = 10 * 60 * 1_000;
const MAX_STORED_PREVIEWS = 256;

interface StoredPreview {
  readonly sourceKey: NativeTaskKey;
  readonly targetHome: string;
  readonly preview: CrossProviderHandoffPreview;
  readonly expiresAt: number;
}

interface TaskParams {
  provider: string;
  nativeTaskId: string;
}

interface PreviewBody {
  home: string;
  target: {
    provider: string;
    home: string;
    cwd: string;
    model?: string;
    mode?: string;
  };
}

interface CommitBody {
  previewId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseProvider(value: string): ProviderId | null {
  return PROVIDER_IDS.has(value as ProviderId) ? (value as ProviderId) : null;
}

function providerNotFound(reply: FastifyReply, provider: string): FastifyReply {
  return reply.code(404).send({ error: "provider_not_found", provider });
}

function invalidRequest(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({ error: "invalid_cross_provider_fork_request" });
}

function forkDisabled(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({ error: "cross_provider_fork_disabled" });
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

function sendCrossProviderForkError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof CrossProviderForkDisabledError) return forkDisabled(reply);
  if (error instanceof SourceTaskMutatedError) {
    return reply.code(409).send({
      error: "cross_provider_fork_source_mutated",
      code: error.code,
    });
  }
  if (error instanceof HandoffTargetNotNativeError) {
    return reply.code(409).send({
      error: "cross_provider_fork_target_not_native",
      code: error.code,
    });
  }
  if (error instanceof ProviderRegistryNotFoundError) {
    return providerNotFound(reply, error.provider);
  }
  if (error instanceof ProviderCapabilityError) {
    return reply.code(409).send({
      error: "provider_capability_unavailable",
      code: error.code,
      provider: error.provider,
      capability: error.capability,
    });
  }
  if (error instanceof ProviderOperationError) {
    return reply.code(409).send({ error: "provider_operation_failed", code: error.code });
  }
  if (error instanceof ProviderAdapterError) {
    return reply.code(503).send({
      error: "provider_unavailable",
      code: error.code,
      provider: error.provider,
    });
  }
  if (error instanceof TypeError) return invalidRequest(reply);
  return reply.code(500).send({ error: "cross_provider_fork_request_failed" });
}

function hasExactPreviewBodyShape(value: unknown): value is PreviewBody {
  if (!isRecord(value)) return false;
  if (typeof value.home !== "string") return false;
  const target = value.target;
  if (!isRecord(target)) return false;
  const allowedTargetKeys = new Set(["provider", "home", "cwd", "model", "mode"]);
  if (!Object.keys(target).every((key) => allowedTargetKeys.has(key))) return false;
  if (typeof target.provider !== "string") return false;
  if (typeof target.home !== "string") return false;
  if (typeof target.cwd !== "string") return false;
  if (target.model !== undefined && typeof target.model !== "string") return false;
  if (target.mode !== undefined && typeof target.mode !== "string") return false;
  const allowedTopKeys = new Set(["home", "target"]);
  return Object.keys(value).every((key) => allowedTopKeys.has(key));
}

function hasExactCommitBodyShape(value: unknown): value is CommitBody {
  if (!isRecord(value)) return false;
  if (typeof value.previewId !== "string" || value.previewId.length === 0) return false;
  return Object.keys(value).every((key) => key === "previewId");
}

const previewBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["home", "target"],
  properties: {
    home: { type: "string", minLength: 1, maxLength: MAX_HOME_LENGTH },
    target: {
      type: "object",
      additionalProperties: false,
      required: ["provider", "home", "cwd"],
      properties: {
        provider: { type: "string", minLength: 1, maxLength: 32 },
        home: { type: "string", minLength: 1, maxLength: MAX_HOME_LENGTH },
        cwd: { type: "string", minLength: 1, maxLength: MAX_HOME_LENGTH },
        model: { type: "string", minLength: 1, maxLength: MAX_MODEL_LENGTH },
        mode: { type: "string", minLength: 1, maxLength: MAX_MODE_LENGTH },
      },
    },
  },
} as const;

const commitBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["previewId"],
  properties: {
    previewId: { type: "string", minLength: 1, maxLength: 256 },
  },
} as const;

const taskParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["provider", "nativeTaskId"],
  properties: {
    provider: { type: "string", minLength: 1, maxLength: 32 },
    nativeTaskId: { type: "string", minLength: 1, maxLength: MAX_NATIVE_ID_LENGTH },
  },
} as const;

/**
 * Register the M7 cross-provider fork HTTP boundary. `mutationToken` gates BOTH
 * routes exactly like every other task-mutating route on `registerProviderTaskRoutes`
 * (POST + Bearer token, disabled server-wide when no token is configured) — a
 * preview reads a task and a commit creates one, so neither is a bare read.
 */
export function registerCrossProviderForkRoutes(
  app: FastifyInstance,
  registry: ProviderRegistry,
  engine: Pick<Engine, "getSettings">,
  mutationToken?: string,
): void {
  const previews = new Map<string, StoredPreview>();

  const isFlagEnabled = (): boolean =>
    engine.getSettings().devHubFeatures?.crossProviderFork === true;

  const prune = (now: number): void => {
    for (const [id, entry] of previews) {
      if (entry.expiresAt <= now) previews.delete(id);
    }
    while (previews.size > MAX_STORED_PREVIEWS) {
      const oldest = previews.keys().next().value;
      if (oldest === undefined) break;
      previews.delete(oldest);
    }
  };

  app.post<{ Params: TaskParams; Body: PreviewBody }>(
    "/api/providers/:provider/tasks/:nativeTaskId/fork-preview",
    { schema: { params: taskParamsSchema, body: previewBodySchema } },
    async (req, reply) => {
      const authError = authorizeMutation(reply, req.headers.authorization, mutationToken);
      if (authError) return authError;
      if (!hasExactPreviewBodyShape(req.body)) return invalidRequest(reply);
      if (!isFlagEnabled()) return forkDisabled(reply);

      const sourceProvider = parseProvider(req.params.provider);
      if (!sourceProvider) return providerNotFound(reply, req.params.provider);
      const targetProvider = parseProvider(req.body.target.provider);
      if (!targetProvider) return providerNotFound(reply, req.body.target.provider);

      let sourceKey: NativeTaskKey;
      try {
        sourceKey = createNativeTaskKey(
          sourceProvider,
          req.body.home,
          req.params.nativeTaskId,
        );
      } catch (error) {
        return sendCrossProviderForkError(reply, error);
      }

      try {
        const sourceTask = await registry.readTask(sourceKey, true);
        const preview = buildCrossProviderHandoffPreview(
          { crossProviderFork: true },
          sourceTask,
          {
            provider: targetProvider,
            home: req.body.target.home,
            cwd: req.body.target.cwd,
            ...(req.body.target.model !== undefined ? { model: req.body.target.model } : {}),
            ...(req.body.target.mode !== undefined ? { mode: req.body.target.mode } : {}),
          },
        );

        const now = Date.now();
        prune(now);
        const previewId = randomUUID();
        previews.set(previewId, {
          sourceKey,
          targetHome: req.body.target.home,
          preview,
          expiresAt: now + PREVIEW_TTL_MS,
        });

        return reply.code(200).send({ previewId, preview });
      } catch (error) {
        return sendCrossProviderForkError(reply, error);
      }
    },
  );

  app.post<{ Params: TaskParams; Body: CommitBody }>(
    "/api/providers/:provider/tasks/:nativeTaskId/fork-commit",
    { schema: { params: taskParamsSchema, body: commitBodySchema } },
    async (req, reply) => {
      const authError = authorizeMutation(reply, req.headers.authorization, mutationToken);
      if (authError) return authError;
      if (!hasExactCommitBodyShape(req.body)) return invalidRequest(reply);
      if (!isFlagEnabled()) return forkDisabled(reply);

      const provider = parseProvider(req.params.provider);
      if (!provider) return providerNotFound(reply, req.params.provider);

      prune(Date.now());
      const stored = previews.get(req.body.previewId);
      if (!stored) {
        return reply.code(404).send({ error: "cross_provider_fork_preview_not_found" });
      }
      if (
        stored.sourceKey.provider !== provider ||
        stored.sourceKey.nativeTaskId !== req.params.nativeTaskId
      ) {
        return invalidRequest(reply);
      }

      // Single-use: remove immediately so a retried/duplicated commit request can
      // never replay the same preview against a (possibly since-changed) source.
      previews.delete(req.body.previewId);

      try {
        const result = await commitCrossProviderHandoff(
          registry,
          { crossProviderFork: true },
          stored.sourceKey,
          stored.preview,
          stored.targetHome,
        );
        return reply.code(201).send({ targetTask: result.targetTask, link: result.link });
      } catch (error) {
        return sendCrossProviderForkError(reply, error);
      }
    },
  );
}
