/**
 * Webhook FIRING — the network boundary for outbound webhooks.
 *
 * The engine owns the PURE side of webhooks (their config CRUD and the pure
 * `webhooksForEvent` / `buildWebhookPayload` selectors); this module owns the one
 * thing the engine deliberately does NOT — making the actual HTTP request. Keeping
 * the network boundary here (the server package) means the engine stays
 * framework/transport-agnostic and never reaches out to the network on its own.
 *
 * {@link fireWebhooks} resolves the matching enabled webhooks for an event and POSTs
 * the JSON payload to each one. It is BEST-EFFORT by design:
 *  - It only ever talks http(s) — any other scheme (file:, data:, ftp:, …) is dropped
 *    BEFORE a request is made, so a malicious/typo'd config can't make us read a local
 *    file or hit a non-network URL.
 *  - Each request carries a short {@link FIRE_TIMEOUT_MS} AbortController timeout, so a
 *    hung endpoint can't pin a fire indefinitely.
 *  - Redirects are NOT followed (`redirect: "manual"`) — a 30x to `file:///…` or an
 *    internal address can't be chased.
 *  - The response BODY is ignored entirely (we read only the status), so a huge or
 *    slow body can't be used to exhaust us.
 *  - EVERY error is swallowed. `fireWebhooks` never throws into its caller and never
 *    retries (no retry-storm). A failed delivery is simply a failed delivery.
 *  - Deliveries run concurrently but BOUNDED ({@link FIRE_CONCURRENCY}) so a config
 *    with many webhooks can't open an unbounded fan-out of sockets at once.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MISSING ENGINE SYMBOLS: `Engine.getWebhooks()`, plus the pure `webhooksForEvent()`
 * and `buildWebhookPayload()` selectors, are being added by the engine lane THIS SAME
 * WAVE, so none are declared on the exported `Engine` type yet. Per package
 * constraints we do NOT edit the engine or add a global `.d.ts` shim. Instead we
 * declare the EXPECTED signatures as a narrow, in-package structural type
 * (`WebhookEngine`) and probe for them at runtime:
 *   - `getWebhooks()` absent → no webhooks are known, so `fireWebhooks` is a clean
 *     no-op (it can't fire what it can't read).
 *   - the pure selectors absent → we fall back to a LOCAL equivalent: filter the
 *     webhook list by `enabled` + `events.includes(event)` ourselves, and wrap the
 *     event/data in a default `{ event, ts, data }` envelope.
 * Safe to ship at any point along the engine lane's landing — it simply fires nothing
 * until the engine can tell it what to fire.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { Engine } from "@devhub/engine";

/** Per-request network timeout. Short — a webhook target should answer promptly. */
export const FIRE_TIMEOUT_MS = 5_000;

/** Most webhook deliveries in flight at once (bounded fan-out, never unbounded). */
export const FIRE_CONCURRENCY = 4;

/**
 * The webhook record shape we rely on. Mirrors what the engine persists/returns, but
 * declared locally + loosely so we don't pin the engine's exact type from this lane.
 * Only the fields firing needs are named; unknown extra fields ride along untouched.
 */
export interface WebhookRecord {
  id: string;
  url: string;
  /** Event names this webhook subscribes to (the known set, see {@link WEBHOOK_EVENTS}). */
  events: string[];
  /** When false/absent treat as enabled? No — absent `enabled` means enabled (opt-out). */
  enabled?: boolean;
  /** Free-form label, ignored by firing. */
  name?: string;
}

/**
 * The webhook methods we PROBE on the engine, all added by the engine lane this wave.
 * Every member is optional and may be sync or async — we tolerate either. Return
 * types are loose so we don't pin the engine's exact shapes from this lane.
 */
interface WebhookEngine {
  /** All persisted webhooks (enabled and disabled). */
  getWebhooks?: () => unknown | Promise<unknown>;
  /** PURE selector: the enabled webhooks matching an event. */
  webhooksForEvent?: (event: string) => unknown;
  /** PURE selector: build the JSON payload for an event + data. */
  buildWebhookPayload?: (event: string, data: unknown) => unknown;
}

/** The known webhook events. The notifications watcher fires the first two today. */
export const WEBHOOK_EVENTS = [
  "session.finished",
  "session.stalled",
  "budget.warn",
  "budget.over",
  "turn.error",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** True for `http:`/`https:` URLs only — the ONLY schemes we will ever POST to. */
export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false; // unparseable → not a URL we'll touch
  }
}

/** A webhook is "enabled" unless it explicitly opts out with `enabled: false`. */
function isEnabled(w: WebhookRecord): boolean {
  return w.enabled !== false;
}

/** Coerce an unknown list into well-formed {@link WebhookRecord}s (drop the rest). */
function coerceWebhooks(out: unknown): WebhookRecord[] {
  if (!Array.isArray(out)) return [];
  const list: WebhookRecord[] = [];
  for (const item of out) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== "string" || typeof rec.url !== "string") continue;
    const events = Array.isArray(rec.events) ? rec.events.filter((e): e is string => typeof e === "string") : [];
    list.push({
      id: rec.id,
      url: rec.url,
      events,
      enabled: rec.enabled === undefined ? undefined : rec.enabled === true,
      name: typeof rec.name === "string" ? rec.name : undefined,
    });
  }
  return list;
}

/**
 * The enabled webhooks that should receive `event`. Prefers the engine's pure
 * `webhooksForEvent` selector (engine lane, this wave); falls back to filtering the
 * full `getWebhooks()` list ourselves by `enabled` + `events.includes(event)`. Returns
 * [] (never throws) when the engine can't tell us — so firing degrades to a no-op.
 */
async function matchingWebhooks(engine: Engine, event: string): Promise<WebhookRecord[]> {
  const probe = engine as unknown as WebhookEngine;
  // Prefer the pure selector when present (it encodes the engine's own matching rules).
  if (typeof probe.webhooksForEvent === "function") {
    try {
      const out = probe.webhooksForEvent(event);
      return coerceWebhooks(out).filter(isEnabled);
    } catch {
      // Half-landed selector — fall through to the full-list path below.
    }
  }
  // Fallback: read the full list and filter ourselves.
  if (typeof probe.getWebhooks === "function") {
    try {
      const all = coerceWebhooks(await probe.getWebhooks());
      return all.filter((w) => isEnabled(w) && w.events.includes(event));
    } catch {
      // Half-landed reader — nothing we can fire.
    }
  }
  return [];
}

/**
 * Build the JSON payload for an event. Prefers the engine's pure
 * `buildWebhookPayload` (so the wire shape is the engine's contract); falls back to a
 * default `{ event, ts, data }` envelope when it's absent or throws.
 */
function buildPayload(engine: Engine, event: string, data: unknown): unknown {
  const probe = engine as unknown as WebhookEngine;
  if (typeof probe.buildWebhookPayload === "function") {
    try {
      const out = probe.buildWebhookPayload(event, data);
      if (out !== undefined && out !== null) return out;
    } catch {
      // Half-landed builder — fall through to the default envelope.
    }
  }
  return { event, ts: Date.now(), data };
}

/** The outcome of a single delivery attempt — surfaced by the test endpoint. */
export interface DeliveryResult {
  delivered: boolean;
  status?: number;
  error?: string;
}

/**
 * POST a JSON payload to ONE url. The lone network call in this module. Best-effort:
 * never throws — resolves a {@link DeliveryResult} describing what happened. Enforces
 * http(s)-only, the short timeout, no redirect-following, and ignores the body.
 */
export async function postWebhook(url: string, payload: unknown): Promise<DeliveryResult> {
  if (!isHttpUrl(url)) return { delivered: false, error: "url must be http(s)" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIRE_TIMEOUT_MS);
  if (typeof timer.unref === "function") timer.unref();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      // Do NOT chase a redirect into file:/// or an internal address — treat a 30x as
      // a (non-2xx) terminal response.
      redirect: "manual",
      signal: controller.signal,
    });
    // We don't care about the body, but drain a little so the socket can be reused and
    // a huge/slow body can't pin us. Cancelling the stream is the cleanest way to free
    // it; fall back to a bounded read if cancel isn't available.
    await drainBody(res);
    // 2xx counts as delivered; everything else is a delivery the target refused.
    const delivered = res.status >= 200 && res.status < 300;
    return delivered ? { delivered: true, status: res.status } : { delivered: false, status: res.status };
  } catch (err) {
    // Network error, abort (timeout), DNS failure, etc. — best-effort, no throw.
    const error = err instanceof Error ? (err.name === "AbortError" ? "timeout" : err.message) : "request failed";
    return { delivered: false, error };
  } finally {
    clearTimeout(timer);
  }
}

/** Discard the response body without buffering all of it. Never throws. */
async function drainBody(res: Response): Promise<void> {
  try {
    if (res.body && typeof res.body.cancel === "function") {
      // Cancelling the stream is the cleanest way to free the socket without reading.
      await res.body.cancel();
      return;
    }
    // No cancellable stream — read and drop it (bounded by the runtime's own limits).
    await res.arrayBuffer();
  } catch {
    // Ignore — draining is a courtesy, not a requirement.
  }
}

/**
 * Run async tasks with a bounded concurrency. Each task is best-effort (a rejection is
 * swallowed) so one bad delivery can't sink the batch. Resolves when all settle.
 */
async function runBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  const max = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!; // guarded by the loop condition — always present
      try {
        await fn(item);
      } catch {
        // Best-effort — never let one delivery reject the whole batch.
      }
    }
  };
  await Promise.all(Array.from({ length: max }, () => worker()));
}

/**
 * Fire `event` (carrying `data`) to every enabled webhook subscribed to it.
 *
 * BEST-EFFORT and FIRE-AND-FORGET friendly: it resolves once all deliveries settle but
 * NEVER throws and never retries. Callers in hot paths (the notifications watcher) can
 * `void fireWebhooks(...)` it. A no-op when the engine can't enumerate webhooks (the
 * engine lane hasn't landed) or none match the event.
 */
export async function fireWebhooks(engine: Engine, event: string, data: unknown): Promise<void> {
  let targets: WebhookRecord[];
  try {
    targets = await matchingWebhooks(engine, event);
  } catch {
    return; // capability probe itself failed — nothing to do, never throw.
  }
  if (targets.length === 0) return;

  const payload = buildPayload(engine, event, data);
  await runBounded(targets, FIRE_CONCURRENCY, async (w) => {
    await postWebhook(w.url, payload);
  });
}
