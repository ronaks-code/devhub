/**
 * Webhook CRUD + test: the REST surface over the engine's webhook config.
 *
 *   GET    /api/webhooks            → list all configured webhooks (engine.getWebhooks)
 *   POST   /api/webhooks            → create one (engine.upsertWebhook), returns it
 *   PUT    /api/webhooks/:id        → update one (engine.upsertWebhook with the id)
 *   DELETE /api/webhooks/:id        → remove one (engine.deleteWebhook)
 *   POST   /api/webhooks/:id/test   → fire a SAMPLE payload to that one webhook and
 *                                     return `{ delivered, status?, error? }` so the
 *                                     UI can show "delivered / failed (reason)".
 *
 * The actual outbound HTTP lives in {@link ../webhook-fire}, the package's single
 * network boundary — this route only validates, persists (through the engine), and
 * for the test endpoint resolves the one webhook and asks webhook-fire to POST a
 * sample payload. The engine owns persistence (validated + backed up via its existing
 * safe-write settings path); we never write the config file ourselves.
 *
 * Bodies are schema-validated: `url` must be a non-empty string (and is re-checked as
 * http(s) at runtime — a non-http URL is rejected 400 BEFORE it can be persisted),
 * and `events` must be a non-empty subset of the known {@link WEBHOOK_EVENTS} set.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MISSING ENGINE SYMBOLS: `Engine.getWebhooks()`, `Engine.upsertWebhook()`, and
 * `Engine.deleteWebhook()` are being added by the engine lane THIS SAME WAVE, so none
 * are declared on the exported `Engine` type yet. Per package constraints we do NOT
 * edit the engine or add a global `.d.ts` shim. Instead we declare the EXPECTED
 * signatures as a narrow, in-package structural type (`WebhookCrudEngine`) and probe
 * for them at runtime:
 *   - GET degrades to `[]` (200) when `getWebhooks` is absent or throws — never a 500.
 *   - POST/PUT/DELETE 503 (unavailable) when the matching engine method is absent or
 *     half-landed (throws) — never a 500.
 *   - the /test endpoint reads the one webhook via `getWebhooks` and fires through
 *     webhook-fire, so it works the moment the reader lands even if upsert/delete are
 *     still catching up.
 * The engine's `upsertWebhook`/`deleteWebhook` return the NEW FULL LIST (not the single
 * record), and `normalizeWebhook` REQUIRES an `id` (it does not mint one), so this
 * route mints an id on create and resolves the affected record back out of the
 * returned list. The engine labels a webhook with `label`; the API speaks `name`, so
 * we map name→label on the way in. Safe to ship at any point along the engine lane's
 * landing.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Engine } from "@claude-ui/engine";
import {
  WEBHOOK_EVENTS,
  isHttpUrl,
  postWebhook,
  type WebhookRecord,
  type DeliveryResult,
} from "../webhook-fire.js";

/**
 * The webhook CRUD methods we PROBE on the engine, all added by the engine lane this
 * wave. Every member is optional and may be sync or async — we `await` either way.
 * Return types are loose so we don't pin the engine's exact shapes from this lane.
 */
interface WebhookCrudEngine {
  getWebhooks?: () => unknown | Promise<unknown>;
  // Engine contract: returns the NEW FULL LIST (not the single record).
  upsertWebhook?: (input: unknown) => unknown | Promise<unknown>;
  deleteWebhook?: (id: string) => unknown | Promise<unknown>;
}

/** A create/update body. `id` rides on PUT (via the path) but is accepted on POST too. */
interface WebhookBody {
  id?: string;
  url: string;
  events: string[];
  enabled?: boolean;
  name?: string;
}

/**
 * Fastify body schema for create/update. `additionalProperties: false` rejects unknown
 * keys (a typo never silently lands). `url` is a required non-empty string (http(s) is
 * re-checked at runtime, since JSON-schema can't express the scheme constraint here);
 * `events` is a required non-empty array drawn ONLY from the known event set; `enabled`
 * + `name` are optional. Mirrors the budget/settings routes' strict-shape convention.
 */
const webhookBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["url", "events"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 128 },
    url: { type: "string", minLength: 1, maxLength: 2048 },
    events: {
      type: "array",
      minItems: 1,
      maxItems: WEBHOOK_EVENTS.length,
      items: { type: "string", enum: WEBHOOK_EVENTS as unknown as string[] },
    },
    enabled: { type: "boolean" },
    name: { type: "string", maxLength: 200 },
  },
} as const;

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1 } },
} as const;

/** Coerce an unknown engine return into well-formed {@link WebhookRecord}s. */
function coerceList(out: unknown): WebhookRecord[] {
  if (!Array.isArray(out)) return [];
  const list: WebhookRecord[] = [];
  for (const item of out) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== "string" || typeof rec.url !== "string") continue;
    const events = Array.isArray(rec.events)
      ? rec.events.filter((e): e is string => typeof e === "string")
      : [];
    list.push({
      id: rec.id,
      url: rec.url,
      events,
      enabled: rec.enabled === undefined ? undefined : rec.enabled === true,
      // The engine labels with `label`; accept either so we surface whatever it stored.
      name: typeof rec.label === "string" ? rec.label : typeof rec.name === "string" ? rec.name : undefined,
    });
  }
  return list;
}

/** Read the full webhook list via the capability guard. Never throws — [] on failure. */
async function readWebhooks(engine: Engine): Promise<WebhookRecord[]> {
  const get = (engine as unknown as WebhookCrudEngine).getWebhooks;
  if (typeof get !== "function") return [];
  try {
    return coerceList(await get.call(engine));
  } catch {
    return [];
  }
}

/**
 * Build the engine input from an API body. The engine requires an `id` (it does not
 * mint one) and labels with `label` (the API speaks `name`), so map accordingly.
 */
function toEngineInput(body: WebhookBody, id: string): Record<string, unknown> {
  const input: Record<string, unknown> = { id, url: body.url, events: body.events };
  if (body.enabled !== undefined) input.enabled = body.enabled;
  if (body.name !== undefined) input.label = body.name;
  return input;
}

/**
 * `upsertWebhook` returns the NEW FULL LIST; pull the single record we just wrote back
 * out by id. Falls back to the input we sent (still a valid record shape) if — against
 * an unexpected engine — the id isn't found in the returned list.
 */
function pickUpserted(returned: unknown, id: string, fallback: Record<string, unknown>): unknown {
  const list = coerceList(returned);
  return list.find((w) => w.id === id) ?? fallback;
}

/** Wire the webhook CRUD + test routes onto an app, backed by the engine config. */
export function registerWebhooksRoutes(app: FastifyInstance, engine: Engine): void {
  // LIST — degrades to [] when the engine reader is absent/half-landed.
  app.get("/api/webhooks", async () => readWebhooks(engine));

  // CREATE — validate (incl. http(s) at runtime) then persist via engine.upsertWebhook.
  app.post<{ Body: WebhookBody }>(
    "/api/webhooks",
    { schema: { body: webhookBodySchema } },
    async (req, reply) => {
      const body = req.body;
      if (!isHttpUrl(body.url)) {
        return reply.code(400).send({ error: "url must be http(s)" });
      }
      const upsert = (engine as unknown as WebhookCrudEngine).upsertWebhook;
      if (typeof upsert !== "function") {
        return reply.code(503).send({ error: "webhooks unavailable" });
      }
      // The engine requires an id and never mints one — mint here on create. A
      // client-supplied id is honored (lets a caller pick a stable id), else random.
      const id = body.id && body.id.trim() ? body.id.trim() : randomUUID();
      const input = toEngineInput(body, id);
      try {
        const returned = await upsert.call(engine, input);
        reply.code(201);
        return pickUpserted(returned, id, input);
      } catch {
        return reply.code(503).send({ error: "webhooks unavailable" });
      }
    },
  );

  // UPDATE — id from the path, validated body, persisted via the same upsert path.
  app.put<{ Params: { id: string }; Body: WebhookBody }>(
    "/api/webhooks/:id",
    { schema: { params: idParams, body: webhookBodySchema } },
    async (req, reply) => {
      const body = req.body;
      if (!isHttpUrl(body.url)) {
        return reply.code(400).send({ error: "url must be http(s)" });
      }
      const upsert = (engine as unknown as WebhookCrudEngine).upsertWebhook;
      if (typeof upsert !== "function") {
        return reply.code(503).send({ error: "webhooks unavailable" });
      }
      // The path id is authoritative for an update.
      const id = req.params.id;
      const input = toEngineInput(body, id);
      try {
        const returned = await upsert.call(engine, input);
        return pickUpserted(returned, id, input);
      } catch {
        return reply.code(503).send({ error: "webhooks unavailable" });
      }
    },
  );

  // DELETE — remove by id via engine.deleteWebhook.
  app.delete<{ Params: { id: string } }>(
    "/api/webhooks/:id",
    { schema: { params: idParams } },
    async (req, reply) => {
      const del = (engine as unknown as WebhookCrudEngine).deleteWebhook;
      if (typeof del !== "function") {
        return reply.code(503).send({ error: "webhooks unavailable" });
      }
      try {
        await del.call(engine, req.params.id);
        return { deleted: true };
      } catch {
        return reply.code(503).send({ error: "webhooks unavailable" });
      }
    },
  );

  // TEST — fire a SAMPLE payload to ONE webhook and report the delivery outcome. We
  // resolve the webhook's url from the persisted list (so the UI can "test" a saved
  // one), build a tiny sample payload, and POST it through the package's single
  // network boundary. Returns `{ delivered, status?, error? }` — never a 500.
  app.post<{ Params: { id: string } }>(
    "/api/webhooks/:id/test",
    { schema: { params: idParams } },
    async (req, reply) => {
      const webhooks = await readWebhooks(engine);
      const target = webhooks.find((w) => w.id === req.params.id);
      if (!target) {
        return reply.code(404).send({ error: "webhook not found" });
      }
      if (!isHttpUrl(target.url)) {
        // A persisted non-http url should never happen (we reject on write), but guard
        // anyway so the test endpoint never attempts a non-network fetch.
        const result: DeliveryResult = { delivered: false, error: "url must be http(s)" };
        return result;
      }
      // A small, obviously-synthetic sample so the receiver can tell it's a test ping.
      const payload = {
        event: "webhook.test",
        ts: Date.now(),
        data: { webhookId: target.id, sample: true },
      };
      // postWebhook is best-effort and never throws — its DeliveryResult is exactly
      // the shape the UI wants.
      return postWebhook(target.url, payload);
    },
  );
}
