/**
 * Integration tests for the webhook REST surface + the firing network boundary.
 *
 * HERMETIC: like app.test.ts we point CLAUDE_CONFIG_DIR at a fresh temp dir and build
 * an Engine against a temp SQLite DB — no real ~/.claude, no external network. The
 * engine's webhook CRUD methods (getWebhooks/upsertWebhook/deleteWebhook) landed in the
 * engine lane THIS SAME WAVE and persist through the (hermetic) settings store, so the
 * CRUD round-trip runs against the REAL engine. To exercise the route's degraded
 * (capability-absent) branches we shadow those methods to `undefined` on the test's
 * fresh engine instance. The /test + fireWebhooks network assertions hit a LOCAL
 * throwaway http server we start on 127.0.0.1 and tear down per-test — never any
 * real endpoint.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { Engine } from "@claude-ui/engine";
import { buildApp } from "../src/app.js";
import { fireWebhooks, postWebhook } from "../src/webhook-fire.js";

let prevConfigDir: string | undefined;

/** A captured inbound request to the throwaway server. */
interface Captured {
  method: string;
  url: string;
  contentType: string | undefined;
  body: string;
}

/**
 * Start a throwaway http server on 127.0.0.1:<random> that records every request it
 * receives and replies with a caller-chosen status. Returns its base URL + the capture
 * log + a stop fn. NEVER binds a fixed port (port 0 → OS picks a free one).
 */
async function startCaptureServer(
  status = 200,
): Promise<{ url: string; received: Captured[]; stop: () => Promise<void> }> {
  const received: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function makeApp(): Promise<{ app: FastifyInstance; engine: Engine }> {
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const root = mkdtempSync(path.join(os.tmpdir(), "cui-webhooks-test-"));
  process.env.CLAUDE_CONFIG_DIR = root;
  const engine = new Engine(path.join(root, "index.db"));
  await engine.indexAll();
  const { app } = buildApp({ engine });
  await app.ready();
  return { app, engine };
}

let current: { app: FastifyInstance; engine: Engine } | undefined;

afterEach(async () => {
  if (current) {
    await current.app.close();
    current.engine.close();
    current = undefined;
  }
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
});

describe("webhooks CRUD", () => {
  beforeEach(async () => {
    current = await makeApp();
  });

  it("GET /api/webhooks returns an empty list on a fresh config dir", async () => {
    // Real engine, no webhooks persisted yet → []. (Also the degraded shape: identical.)
    const res = await current!.app.inject({ method: "GET", url: "/api/webhooks" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("GET /api/webhooks degrades to [] when the engine reader is absent", async () => {
    // Shadow the (now-landed) reader to undefined to exercise the route's typeof guard:
    // it must return an empty list (200), never a 500.
    (current!.engine as unknown as Record<string, unknown>).getWebhooks = undefined;
    const res = await current!.app.inject({ method: "GET", url: "/api/webhooks" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("POST /api/webhooks 503s when the engine upsert is absent", async () => {
    (current!.engine as unknown as Record<string, unknown>).upsertWebhook = undefined;
    const res = await current!.app.inject({
      method: "POST",
      url: "/api/webhooks",
      payload: { url: "https://example.com/hook", events: ["session.finished"] },
    });
    expect(res.statusCode).toBe(503);
  });

  it("create → list → update → delete round-trips against the real engine store", async () => {
    // CREATE — the route mints an id and persists through the real engine (settings store).
    const created = await current!.app.inject({
      method: "POST",
      url: "/api/webhooks",
      payload: {
        url: "https://example.com/hook",
        events: ["session.finished", "session.stalled"],
        name: "deploy bot",
      },
    });
    expect(created.statusCode).toBe(201);
    const wh = created.json() as { id: string; url: string; events: string[] };
    expect(typeof wh.id).toBe("string");
    expect(wh.id.length).toBeGreaterThan(0);
    expect(wh.url).toBe("https://example.com/hook");
    expect(wh.events).toEqual(["session.finished", "session.stalled"]);

    // LIST — the new webhook is present (the API surfaces the engine's `label` as `name`).
    const listed = await current!.app.inject({ method: "GET", url: "/api/webhooks" });
    expect(listed.statusCode).toBe(200);
    const list = listed.json() as Array<{ id: string; name?: string }>;
    expect(list.map((w) => w.id)).toEqual([wh.id]);
    expect(list[0]!.name).toBe("deploy bot");

    // UPDATE — same id (from the path), changed events + disabled.
    const updated = await current!.app.inject({
      method: "PUT",
      url: `/api/webhooks/${wh.id}`,
      payload: {
        url: "https://example.com/hook2",
        events: ["budget.over"],
        enabled: false,
        name: "deploy bot",
      },
    });
    expect(updated.statusCode).toBe(200);
    const upd = updated.json() as { id: string; url: string; events: string[] };
    expect(upd.id).toBe(wh.id); // id is stable across the update
    expect(upd.url).toBe("https://example.com/hook2");
    expect(upd.events).toEqual(["budget.over"]);

    // The list reflects the update (still one record, the mutated one, now disabled).
    const listed2 = await current!.app.inject({ method: "GET", url: "/api/webhooks" });
    const list2 = listed2.json() as Array<{ id: string; url: string; enabled?: boolean }>;
    expect(list2.length).toBe(1);
    expect(list2[0]!.url).toBe("https://example.com/hook2");
    expect(list2[0]!.enabled).toBe(false);

    // DELETE
    const deleted = await current!.app.inject({
      method: "DELETE",
      url: `/api/webhooks/${wh.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });

    // Gone from the list — proven by re-reading the real engine through the route.
    const listed3 = await current!.app.inject({ method: "GET", url: "/api/webhooks" });
    expect(listed3.json()).toEqual([]);
  });

  it("POST /api/webhooks rejects a non-http url (400)", async () => {
    const res = await current!.app.inject({
      method: "POST",
      url: "/api/webhooks",
      payload: { url: "file:///etc/passwd", events: ["session.finished"] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("http");
  });

  it("POST /api/webhooks rejects an unknown event (400, schema enum)", async () => {
    const res = await current!.app.inject({
      method: "POST",
      url: "/api/webhooks",
      payload: { url: "https://example.com/hook", events: ["not.a.real.event"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/webhooks rejects an empty events array (400, schema minItems)", async () => {
    const res = await current!.app.inject({
      method: "POST",
      url: "/api/webhooks",
      payload: { url: "https://example.com/hook", events: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT /api/webhooks/:id rejects a non-http url (400)", async () => {
    const res = await current!.app.inject({
      method: "PUT",
      url: "/api/webhooks/some-id",
      payload: { url: "ftp://example.com/hook", events: ["session.finished"] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("webhooks /test endpoint (local throwaway server)", () => {
  beforeEach(async () => {
    current = await makeApp();
  });

  it("POST /api/webhooks/:id/test delivers a sample POST to the saved url", async () => {
    const capture = await startCaptureServer(200);
    try {
      // Persist a webhook pointing at our LOCAL throwaway server (real engine).
      const created = await current!.app.inject({
        method: "POST",
        url: "/api/webhooks",
        payload: { url: capture.url, events: ["session.finished"] },
      });
      const wh = created.json() as { id: string };

      const res = await current!.app.inject({
        method: "POST",
        url: `/api/webhooks/${wh.id}/test`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ delivered: true, status: 200 });

      // The throwaway server saw exactly one POST with a JSON content-type and the
      // sample payload shape (event/ts/data).
      expect(capture.received.length).toBe(1);
      const hit = capture.received[0]!;
      expect(hit.method).toBe("POST");
      expect(hit.contentType).toContain("application/json");
      const sent = JSON.parse(hit.body) as { event: string; ts: number; data: { webhookId: string; sample: boolean } };
      expect(sent.event).toBe("webhook.test");
      expect(typeof sent.ts).toBe("number");
      expect(sent.data).toEqual({ webhookId: wh.id, sample: true });
    } finally {
      await capture.stop();
    }
  });

  it("POST /api/webhooks/:id/test reports delivered:false for a non-2xx target", async () => {
    const capture = await startCaptureServer(500);
    try {
      const created = await current!.app.inject({
        method: "POST",
        url: "/api/webhooks",
        payload: { url: capture.url, events: ["session.finished"] },
      });
      const wh = created.json() as { id: string };

      const res = await current!.app.inject({
        method: "POST",
        url: `/api/webhooks/${wh.id}/test`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { delivered: boolean; status?: number };
      expect(body.delivered).toBe(false);
      expect(body.status).toBe(500);
      expect(capture.received.length).toBe(1);
    } finally {
      await capture.stop();
    }
  });

  it("POST /api/webhooks/:id/test 404s for an unknown id", async () => {
    const res = await current!.app.inject({
      method: "POST",
      url: "/api/webhooks/nope/test",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("postWebhook + fireWebhooks (unit, local server)", () => {
  beforeEach(async () => {
    current = await makeApp();
  });

  it("postWebhook refuses a non-http url without making a request", async () => {
    const result = await postWebhook("file:///etc/passwd", { hello: "world" });
    expect(result.delivered).toBe(false);
    expect(result.error).toContain("http");
  });

  it("fireWebhooks POSTs to every enabled webhook matching the event", async () => {
    const a = await startCaptureServer(200);
    const b = await startCaptureServer(200);
    const disabled = await startCaptureServer(200);
    try {
      const probe = current!.engine as unknown as Record<string, unknown>;
      probe.getWebhooks = () => [
        { id: "1", url: a.url, events: ["session.finished"] },
        { id: "2", url: b.url, events: ["session.finished", "budget.over"] },
        { id: "3", url: disabled.url, events: ["session.finished"], enabled: false },
        { id: "4", url: "https://example.com/other", events: ["budget.over"] },
      ];

      await fireWebhooks(current!.engine, "session.finished", { sessionId: "s1", cwd: "/x" });

      // Both enabled subscribers got exactly one POST; the disabled one and the
      // non-matching one got none.
      expect(a.received.length).toBe(1);
      expect(b.received.length).toBe(1);
      expect(disabled.received.length).toBe(0);
      // The default envelope wraps the event + data.
      const sent = JSON.parse(a.received[0]!.body) as { event: string; data: { sessionId: string } };
      expect(sent.event).toBe("session.finished");
      expect(sent.data.sessionId).toBe("s1");
    } finally {
      await a.stop();
      await b.stop();
      await disabled.stop();
    }
  });

  it("fireWebhooks prefers the engine's pure webhooksForEvent selector when present", async () => {
    const a = await startCaptureServer(200);
    try {
      const probe = current!.engine as unknown as Record<string, unknown>;
      const calls: string[] = [];
      // When the pure selector exists the route uses it verbatim (no extra filtering).
      probe.webhooksForEvent = (event: string) => {
        calls.push(event);
        return [{ id: "1", url: a.url, events: [event] }];
      };
      await fireWebhooks(current!.engine, "session.stalled", { sessionId: "s9" });
      expect(calls).toEqual(["session.stalled"]);
      expect(a.received.length).toBe(1);
    } finally {
      await a.stop();
    }
  });

  it("fireWebhooks is a clean no-op when the engine can't enumerate webhooks", async () => {
    // No getWebhooks / webhooksForEvent installed on the fresh engine — must not throw.
    await expect(
      fireWebhooks(current!.engine, "session.finished", { sessionId: "x" }),
    ).resolves.toBeUndefined();
  });

  it("fireWebhooks never throws even when a delivery target is unreachable", async () => {
    const probe = current!.engine as unknown as Record<string, unknown>;
    // Port 1 on localhost refuses immediately — the delivery fails but fireWebhooks
    // swallows it (best-effort) and resolves cleanly.
    probe.getWebhooks = () => [{ id: "1", url: "http://127.0.0.1:1/hook", events: ["session.finished"] }];
    await expect(
      fireWebhooks(current!.engine, "session.finished", { sessionId: "x" }),
    ).resolves.toBeUndefined();
  });
});
