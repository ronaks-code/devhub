/**
 * Hermetic tests for the webhook CONFIG + pure payload/matcher helpers (no network).
 * Covers: get/set round-trip + persistence across re-open; setWebhooks rejecting
 * non-http urls + unknown events; webhooksForEvent filtering by enabled + subscription;
 * the stable buildWebhookPayload shape; and upsert/delete convenience.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../src/index.js";
import {
  buildWebhookPayload,
  webhooksForEvent,
  normalizeWebhook,
  normalizeWebhooks,
  isHttpUrl,
  WEBHOOK_EVENTS,
  type WebhookConfig,
  type WebhookEvent,
} from "../src/webhooks.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "cui-wh-"));

function wh(over: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    id: "a",
    url: "https://example.com/hook",
    events: ["session.finished"],
    enabled: true,
    ...over,
  };
}

describe("webhooks config store (Engine accessors)", () => {
  it("defaults to [] on a fresh DB, then round-trips get/set + persists across re-open", () => {
    const dir = tmp();
    const engine = new Engine(path.join(dir, "i.db"));

    expect(engine.getWebhooks()).toEqual([]);

    const stored = engine.setWebhooks([
      wh({ id: "a", url: "https://a.example/hook", events: ["session.finished"], label: "A" }),
      wh({ id: "b", url: "http://b.example/hook", events: ["budget.warn", "budget.over"], enabled: false }),
    ]);
    expect(stored).toHaveLength(2);
    expect(engine.getWebhooks()).toEqual(stored);
    expect(engine.getWebhooks()[0]).toMatchObject({ id: "a", label: "A", enabled: true });
    expect(engine.getWebhooks()[1]).toMatchObject({ id: "b", enabled: false });

    engine.close();

    // Persisted across a reopen of the same shared index.db.
    const reopened = new Engine(path.join(dir, "i.db"));
    const back = reopened.getWebhooks();
    expect(back).toHaveLength(2);
    expect(back.map((w) => w.id)).toEqual(["a", "b"]);
    expect(back[1].events).toEqual(["budget.warn", "budget.over"]);
    reopened.close();
  });

  it("setWebhooks rejects non-http urls and unknown events (and does not persist a bad write)", () => {
    const dir = tmp();
    const engine = new Engine(path.join(dir, "i.db"));

    engine.setWebhooks([wh({ id: "ok", url: "https://ok.example/hook" })]);
    expect(engine.getWebhooks()).toHaveLength(1);

    // file:/// and other non-http schemes are refused.
    expect(() => engine.setWebhooks([wh({ url: "file:///etc/passwd" })])).toThrow(/http/);
    expect(() => engine.setWebhooks([wh({ url: "ftp://x.example/hook" })])).toThrow(/http/);
    expect(() => engine.setWebhooks([wh({ url: "not a url" })])).toThrow(/http/);

    // Unknown event kind is refused.
    expect(() =>
      engine.setWebhooks([wh({ events: ["session.bogus"] as unknown as WebhookEvent[] })]),
    ).toThrow(/unknown event/);

    // Empty event list is refused.
    expect(() => engine.setWebhooks([wh({ events: [] })])).toThrow(/at least one event/);

    // The earlier valid write is untouched by the failed attempts.
    expect(engine.getWebhooks()).toHaveLength(1);
    expect(engine.getWebhooks()[0].id).toBe("ok");
    engine.close();
  });

  it("de-dupes ids on set (last write wins)", () => {
    const dir = tmp();
    const engine = new Engine(path.join(dir, "i.db"));
    const out = engine.setWebhooks([
      wh({ id: "dup", url: "https://first.example/hook" }),
      wh({ id: "dup", url: "https://second.example/hook" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://second.example/hook");
    engine.close();
  });

  it("upsertWebhook inserts then replaces; deleteWebhook removes by id", () => {
    const dir = tmp();
    const engine = new Engine(path.join(dir, "i.db"));

    engine.upsertWebhook(wh({ id: "x", url: "https://x.example/1" }));
    expect(engine.getWebhooks()).toHaveLength(1);

    engine.upsertWebhook(wh({ id: "y", url: "https://y.example/1" }));
    expect(engine.getWebhooks().map((w) => w.id)).toEqual(["x", "y"]);

    // upsert on an existing id replaces in place rather than appending.
    engine.upsertWebhook(wh({ id: "x", url: "https://x.example/2" }));
    const after = engine.getWebhooks();
    expect(after).toHaveLength(2);
    expect(after.find((w) => w.id === "x")?.url).toBe("https://x.example/2");

    // upsert validates too.
    expect(() => engine.upsertWebhook(wh({ id: "z", url: "file:///nope" }))).toThrow(/http/);
    expect(engine.getWebhooks()).toHaveLength(2);

    const remaining = engine.deleteWebhook("x");
    expect(remaining.map((w) => w.id)).toEqual(["y"]);
    // Deleting an absent id is a no-op.
    expect(engine.deleteWebhook("absent")).toHaveLength(1);
    engine.close();
  });

  it("tolerates a corrupt/legacy stored value on read (drops invalid entries)", () => {
    const dir = tmp();
    const engine = new Engine(path.join(dir, "i.db"));
    // Bypass validation by writing straight through the settings store.
    engine.settings.set("webhooks", [
      { id: "good", url: "https://good.example/hook", events: ["turn.error"], enabled: true },
      { id: "bad", url: "file:///etc/hosts", events: ["turn.error"], enabled: true },
      "garbage",
      42,
    ] as never);
    const list = engine.getWebhooks();
    expect(list.map((w) => w.id)).toEqual(["good"]);

    // A non-array stored value reads back as [].
    engine.settings.set("webhooks", "nope" as never);
    expect(engine.getWebhooks()).toEqual([]);
    engine.close();
  });
});

describe("webhooks pure helpers", () => {
  it("isHttpUrl accepts http/https only", () => {
    expect(isHttpUrl("http://x.example")).toBe(true);
    expect(isHttpUrl("https://x.example/path?q=1")).toBe(true);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("ftp://x.example")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
    expect(isHttpUrl(123)).toBe(false);
  });

  it("normalizeWebhook trims, defaults enabled=true, de-dupes events, drops blank label", () => {
    const out = normalizeWebhook({
      id: "  k  ",
      url: "https://k.example/hook",
      events: ["budget.warn", "budget.warn", "turn.error"],
      label: "  ",
    });
    expect(out.id).toBe("k");
    expect(out.enabled).toBe(true);
    expect(out.events).toEqual(["budget.warn", "turn.error"]);
    expect(out.label).toBeUndefined();

    expect(() => normalizeWebhook({ url: "https://k.example", events: ["turn.error"] })).toThrow(
      /id is required/,
    );
    expect(() => normalizeWebhook(null)).toThrow(/expected an object/);
    expect(() => normalizeWebhooks("nope")).toThrow(/expected an array/);
  });

  it("WEBHOOK_EVENTS is the documented closed set", () => {
    expect([...WEBHOOK_EVENTS]).toEqual([
      "session.finished",
      "session.stalled",
      "budget.warn",
      "budget.over",
      "turn.error",
    ]);
  });

  it("webhooksForEvent filters by enabled AND subscription, preserving order", () => {
    const list: WebhookConfig[] = [
      wh({ id: "a", events: ["session.finished", "turn.error"], enabled: true }),
      wh({ id: "b", events: ["session.finished"], enabled: false }),
      wh({ id: "c", events: ["budget.over"], enabled: true }),
      wh({ id: "d", events: ["session.finished"], enabled: true }),
    ];
    expect(webhooksForEvent(list, "session.finished").map((w) => w.id)).toEqual(["a", "d"]);
    expect(webhooksForEvent(list, "turn.error").map((w) => w.id)).toEqual(["a"]);
    expect(webhooksForEvent(list, "budget.over").map((w) => w.id)).toEqual(["c"]);
    expect(webhooksForEvent(list, "budget.warn")).toEqual([]);
    expect(webhooksForEvent([], "session.finished")).toEqual([]);
  });

  it("buildWebhookPayload has a stable shape with an injectable timestamp", () => {
    const ts = new Date("2026-06-18T00:00:00.000Z");
    const payload = buildWebhookPayload("session.finished", { sessionId: "s1", costUsd: 1.25 }, ts);
    expect(payload).toEqual({
      event: "session.finished",
      timestamp: "2026-06-18T00:00:00.000Z",
      source: "claude-ui",
      sessionId: "s1",
      costUsd: 1.25,
    });

    // Envelope fields win over same-named data keys (no provenance spoofing).
    const spoof = buildWebhookPayload(
      "turn.error",
      { source: "evil", event: "budget.over", timestamp: "fake" } as never,
      ts,
    );
    expect(spoof.source).toBe("claude-ui");
    expect(spoof.event).toBe("turn.error");
    expect(spoof.timestamp).toBe("2026-06-18T00:00:00.000Z");

    // Defaults: empty data + now (just assert the constant fields + ISO shape).
    const now = buildWebhookPayload("budget.warn");
    expect(now.event).toBe("budget.warn");
    expect(now.source).toBe("claude-ui");
    expect(typeof now.timestamp).toBe("string");
    expect(now.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
