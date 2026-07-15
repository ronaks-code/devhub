/**
 * Outbound webhook CONFIG + payload helpers — the engine owns the durable list of
 * subscriptions and the PURE shaping/matching; the SERVER lane owns the actual
 * firing (timeout/abort/network) this wave.
 *
 *  - Subscriptions live as a JSON array under the existing `settings.webhooks` key
 *    (the SettingsStore is key-agnostic, so this rides alongside the other prefs and
 *    breaks nothing). Each is a {@link WebhookConfig}: an id, an http(s) url, the set
 *    of {@link WebhookEvent} kinds it wants, an enabled flag, and an optional label.
 *  - {@link WebhookConfigStore} wraps a SettingsStore: `list` reads (default []),
 *    `set` VALIDATES (http/https url, known events, de-duped ids) before persisting,
 *    and `upsert`/`delete` are thin convenience writes. Persistence reuses the
 *    settings store's safe write path (one JSON row in the shared index.db) — we add
 *    no schema and never open a second connection.
 *  - {@link buildWebhookPayload} and {@link webhooksForEvent} are PURE (no DB / no
 *    Node / no network), so the server can build a body and pick recipients
 *    deterministically and they are trivially unit-testable. The engine performs NO
 *    network I/O this wave — that keeps it side-effect-light and lets the server own
 *    the timeout/abort/scheme guards.
 */
import type { SettingsStore } from "./settings.js";

/**
 * The known webhook event kinds (a closed string union). A subscription's `events`
 * are validated against this set; an unknown kind is rejected by {@link normalizeWebhook}.
 *
 *  - "session.finished" — a session/turn completed.
 *  - "session.stalled"  — a session looks dead-but-busy / blocked on the user.
 *  - "budget.warn"      — month-to-date spend crossed the soft warn threshold.
 *  - "budget.over"      — month-to-date spend reached/exceeded the cap.
 *  - "turn.error"       — a turn ended in an error (CLI/driver failure).
 */
export type WebhookEvent =
  | "session.finished"
  | "session.stalled"
  | "budget.warn"
  | "budget.over"
  | "turn.error";

/** Every known event kind, in declaration order (stable for UI listings / tests). */
export const WEBHOOK_EVENTS: readonly WebhookEvent[] = [
  "session.finished",
  "session.stalled",
  "budget.warn",
  "budget.over",
  "turn.error",
];

const KNOWN_EVENTS = new Set<string>(WEBHOOK_EVENTS);

/**
 * The webhook wire payload version a subscription emits.
 *  - `1` — LEGACY/default: byte-compatible `source:"claude-ui"` body (no version fields).
 *  - `2` — DevHub: `source:"devhub"`, `schemaVersion:2`, opaque locators, optional
 *          `sourceAliases:["claude-ui"]` for a receiver mid-migration.
 * A subscription emits EXACTLY ONE version — never a duplicate v1+v2 delivery.
 */
export type WebhookPayloadVersion = 1 | 2;

/** The default payload version for a legacy/absent config (keeps existing receivers working). */
export const DEFAULT_WEBHOOK_PAYLOAD_VERSION: WebhookPayloadVersion = 1;

/** A persisted webhook subscription. */
export interface WebhookConfig {
  /** Caller-supplied stable id (trimmed; non-empty). Duplicate ids are de-duped, last write wins. */
  id: string;
  /** Destination URL. MUST be http: or https: — other schemes are rejected. */
  url: string;
  /** The event kinds this webhook is subscribed to (from {@link WEBHOOK_EVENTS}, de-duped). */
  events: WebhookEvent[];
  /** Whether this subscription is active. A disabled webhook is stored but never matched. */
  enabled: boolean;
  /**
   * Wire payload version. Absent/legacy configs normalize to {@link DEFAULT_WEBHOOK_PAYLOAD_VERSION}
   * (1) and keep the byte-compatible `source:"claude-ui"` body; 2 opts into the DevHub body.
   * `normalizeWebhook` always populates this, so a normalized config always carries it.
   */
  payloadVersion?: WebhookPayloadVersion;
  /** Optional human label for the UI. */
  label?: string;
}

/**
 * The JSON body the server POSTs for an event: a stable envelope (`event`,
 * `timestamp`, `source`) merged with the event's `data`. Open-ended on purpose so
 * callers can carry event-specific fields without a type churn here.
 */
export interface WebhookPayload {
  event: WebhookEvent;
  /** ISO-8601 instant the payload was built. */
  timestamp: string;
  /** Constant provenance marker so a receiver can tell where the call came from. */
  source: "claude-ui";
  [key: string]: unknown;
}

/**
 * The v2 (DevHub) body: same envelope as {@link WebhookPayload} but `source:"devhub"`,
 * an explicit `schemaVersion:2`, and an optional `sourceAliases:["claude-ui"]` so a
 * receiver migrating off the old name can still recognise the sender. Provider data must
 * be OPAQUE (fingerprints/locators) — the envelope never carries a raw home path.
 */
export interface WebhookPayloadV2 {
  event: WebhookEvent;
  /** ISO-8601 instant the payload was built. */
  timestamp: string;
  /** DevHub provenance marker. */
  source: "devhub";
  /** Wire schema version for the DevHub body. */
  schemaVersion: 2;
  /** Optional former-name aliases for a receiver mid-migration (e.g. `["claude-ui"]`). */
  sourceAliases?: string[];
  [key: string]: unknown;
}

/** Either wire body — v1 (legacy) or v2 (DevHub). */
export type AnyWebhookPayload = WebhookPayload | WebhookPayloadV2;

/** Options for {@link buildWebhookPayload}. */
export interface BuildWebhookPayloadOptions {
  /** Which wire version to emit. Defaults to {@link DEFAULT_WEBHOOK_PAYLOAD_VERSION} (1). */
  payloadVersion?: WebhookPayloadVersion;
  /** v2-only: former-name aliases to advertise (omitted from the body when absent/empty). */
  sourceAliases?: readonly string[];
}

/** Coerce/validate a raw payload version; throws with `label` context on an unknown value. */
function normalizePayloadVersion(raw: unknown, label: string): WebhookPayloadVersion {
  if (raw === undefined || raw === null) return DEFAULT_WEBHOOK_PAYLOAD_VERSION;
  if (raw === 1 || raw === 2) return raw;
  throw new Error(`webhook ${label}: payloadVersion must be 1 or 2`);
}

/** The payload version a subscription emits (default {@link DEFAULT_WEBHOOK_PAYLOAD_VERSION}). */
export function webhookPayloadVersionFor(config: WebhookConfig): WebhookPayloadVersion {
  return config.payloadVersion ?? DEFAULT_WEBHOOK_PAYLOAD_VERSION;
}

/** True for a string that parses as an http: or https: URL (no other scheme passes). */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * Validate + normalize ONE raw webhook into a clean {@link WebhookConfig}, throwing a
 * typed Error on anything invalid:
 *   - `url` must be http/https (no file:/// or other schemes),
 *   - `events` must be a non-empty subset of {@link WEBHOOK_EVENTS} (de-duped),
 *   - `id` is trimmed and required.
 * `enabled` defaults to true; `label` is trimmed and dropped when blank.
 */
export function normalizeWebhook(raw: unknown): WebhookConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("webhook: expected an object");
  }
  const w = raw as Record<string, unknown>;

  const id = typeof w.id === "string" ? w.id.trim() : "";
  if (!id) throw new Error("webhook: id is required");

  const url = w.url;
  if (!isHttpUrl(url)) {
    throw new Error(`webhook ${id}: url must be an http(s) URL`);
  }

  const rawEvents = Array.isArray(w.events) ? w.events : [];
  const events: WebhookEvent[] = [];
  for (const e of rawEvents) {
    if (typeof e !== "string" || !KNOWN_EVENTS.has(e)) {
      throw new Error(`webhook ${id}: unknown event ${JSON.stringify(e)}`);
    }
    if (!events.includes(e as WebhookEvent)) events.push(e as WebhookEvent);
  }
  if (events.length === 0) {
    throw new Error(`webhook ${id}: at least one event is required`);
  }

  const out: WebhookConfig = {
    id,
    url: url as string,
    events,
    enabled: w.enabled === undefined ? true : Boolean(w.enabled),
    payloadVersion: normalizePayloadVersion(w.payloadVersion, id),
  };
  if (typeof w.label === "string" && w.label.trim()) out.label = w.label.trim();
  return out;
}

/**
 * Validate + normalize a whole list, de-duping by id (LAST occurrence wins, mirroring
 * an upsert). Throws on the first invalid entry so a bad write never half-persists.
 */
export function normalizeWebhooks(list: unknown): WebhookConfig[] {
  if (!Array.isArray(list)) {
    throw new Error("webhooks: expected an array");
  }
  const byId = new Map<string, WebhookConfig>();
  for (const raw of list) {
    const wh = normalizeWebhook(raw);
    byId.set(wh.id, wh);
  }
  return [...byId.values()];
}

/**
 * Build the JSON body to POST for `event`. PURE: spreads the event-specific `data` onto a
 * stable envelope, then stamps the envelope fields LAST so they win over same-named `data`
 * keys (provenance can't be spoofed). `timestamp` is injectable for deterministic tests.
 *
 *  - v1 (DEFAULT): byte-compatible with the legacy body — `source:"claude-ui"`, NO version
 *    fields. Existing receivers keep working unchanged.
 *  - v2: `source:"devhub"`, `schemaVersion:2`, and — when supplied — `sourceAliases`. The
 *    envelope carries no raw home; callers must pass OPAQUE locators in `data`.
 *
 * A single call emits EXACTLY ONE version (the requested one) — never a merged v1+v2 body.
 */
export function buildWebhookPayload(
  event: WebhookEvent,
  data: Record<string, unknown> = {},
  timestamp: Date = new Date(),
  options: BuildWebhookPayloadOptions = {},
): AnyWebhookPayload {
  const version = options.payloadVersion ?? DEFAULT_WEBHOOK_PAYLOAD_VERSION;
  if (version === 2) {
    const payload: WebhookPayloadV2 = {
      ...data,
      event,
      timestamp: timestamp.toISOString(),
      source: "devhub",
      schemaVersion: 2,
    };
    const aliases = (options.sourceAliases ?? []).filter(
      (a): a is string => typeof a === "string" && a.length > 0,
    );
    if (aliases.length > 0) payload.sourceAliases = [...aliases];
    return payload;
  }
  return {
    ...data,
    event,
    timestamp: timestamp.toISOString(),
    source: "claude-ui",
  };
}

/**
 * Build the body a SUBSCRIPTION should emit — exactly one version, chosen by the config's
 * {@link WebhookConfig.payloadVersion} (default 1). A v2 subscription advertises the
 * `["claude-ui"]` alias so a receiver mid-migration still recognises the sender. This is
 * the single call site that guarantees "one version per subscription, never both".
 */
export function buildWebhookPayloadFor(
  config: WebhookConfig,
  event: WebhookEvent,
  data: Record<string, unknown> = {},
  timestamp: Date = new Date(),
): AnyWebhookPayload {
  const payloadVersion = webhookPayloadVersionFor(config);
  return buildWebhookPayload(event, data, timestamp, {
    payloadVersion,
    ...(payloadVersion === 2 ? { sourceAliases: ["claude-ui"] } : {}),
  });
}

/**
 * The ENABLED webhooks from `list` subscribed to `event`, in list order. PURE: a
 * disabled webhook or one not subscribed to the event is skipped, so the server can
 * fan out to exactly the right recipients. Returns [] when none match.
 */
export function webhooksForEvent(
  list: readonly WebhookConfig[],
  event: WebhookEvent,
): WebhookConfig[] {
  return list.filter((w) => w.enabled && w.events.includes(event));
}

/**
 * Durable webhook subscriptions on top of the existing {@link SettingsStore} (one JSON
 * row under the `webhooks` key — no schema, no second DB handle). Reads default to []
 * and tolerate a corrupt/legacy value; writes validate first via {@link normalizeWebhooks}.
 */
export class WebhookConfigStore {
  constructor(private readonly settings: SettingsStore) {}

  /** All stored webhooks (default []). A non-array / corrupt stored value reads back as []. */
  list(): WebhookConfig[] {
    const raw = this.settings.get("webhooks") as unknown;
    if (!Array.isArray(raw)) return [];
    // Tolerate a legacy/partial stored entry: keep the valid ones, drop the rest,
    // rather than throwing on read.
    const out: WebhookConfig[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
      let wh: WebhookConfig;
      try {
        wh = normalizeWebhook(entry);
      } catch {
        continue;
      }
      if (seen.has(wh.id)) {
        // last wins: replace the earlier one
        const idx = out.findIndex((w) => w.id === wh.id);
        if (idx >= 0) out[idx] = wh;
        continue;
      }
      seen.add(wh.id);
      out.push(wh);
    }
    return out;
  }

  /**
   * Replace the whole list. VALIDATES every entry (http/https url, known events) and
   * de-dupes ids before persisting via the settings store. Throws (without writing) on
   * the first invalid entry. Returns the normalized, stored list.
   */
  set(list: unknown): WebhookConfig[] {
    const normalized = normalizeWebhooks(list);
    this.settings.set("webhooks", normalized);
    return normalized;
  }

  /** Insert or replace one webhook (matched by id). Validates it; returns the new full list. */
  upsert(wh: unknown): WebhookConfig[] {
    const next = normalizeWebhook(wh);
    const others = this.list().filter((w) => w.id !== next.id);
    return this.set([...others, next]);
  }

  /** Remove one webhook by id. Returns the new full list (unchanged when the id wasn't present). */
  delete(id: string): WebhookConfig[] {
    const trimmed = (id ?? "").trim();
    const next = this.list().filter((w) => w.id !== trimmed);
    return this.set(next);
  }
}
