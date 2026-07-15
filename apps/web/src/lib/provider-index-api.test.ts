import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  taskLocator,
  createNativeTaskKey,
  serializeTaskLocator,
} from "@devhub/engine/providers";
import {
  createProviderIndexApiClient,
  isUnifiedTaskIndexApplied,
  selectProviderTransport,
  ProviderIndexHttpError,
} from "./provider-index-api.js";

const LOCATOR = taskLocator(createNativeTaskKey("openai", "/Users/test/.codex home", "task/with spaces"));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("selectProviderTransport", () => {
  it("selects the direct transport unless the flag is applied true (never defaults on)", () => {
    expect(selectProviderTransport(undefined).mode).toBe("direct");
    expect(selectProviderTransport({}).mode).toBe("direct");
    expect(selectProviderTransport({ unifiedTaskIndex: false }).mode).toBe("direct");
    expect(isUnifiedTaskIndexApplied({ unifiedTaskIndex: false })).toBe(false);
  });

  it("selects the locator facade when applied true", () => {
    const transport = selectProviderTransport({ unifiedTaskIndex: true });
    expect(transport.mode).toBe("indexed");
    if (transport.mode === "indexed") expect(typeof transport.client.list).toBe("function");
  });
});

describe("ProviderIndexApiClient", () => {
  it("lists via /api/provider-index/tasks with no raw home", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createProviderIndexApiClient();
    const page = await client.list({ provider: "openai", limit: 10 });
    expect(page).toEqual({ items: [], nextCursor: null });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/api/provider-index/tasks");
    expect(url).toContain("provider=openai");
    expect(url).not.toContain(".codex");
  });

  it("sends input to the locator path and never puts a home in the URL or body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({ taskKey: LOCATOR, turnId: "turn-1" }, 202),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createProviderIndexApiClient();
    const ref = await client.send(LOCATOR, { text: "hi" });
    expect(ref.turnId).toBe("turn-1");
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain("/api/provider-index/tasks/");
    expect(url).toContain("/send");
    expect(url).not.toContain(".codex");
    expect(String(init.body)).not.toContain("home");
    expect(String(init.body)).toContain("hi");
  });

  it("rebuilds by provider + fingerprint (never a raw home)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({ activeGeneration: 3, taskCount: 2, eventCount: 5 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createProviderIndexApiClient();
    const result = await client.rebuild("openai", "f".repeat(64));
    expect(result.activeGeneration).toBe(3);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("/api/provider-index/rebuild");
    expect(String(init.body)).toContain("f".repeat(64));
    expect(String(init.body)).not.toContain(".codex");
  });

  it("archives with a 204 and surfaces a value-free error code otherwise", async () => {
    const ok = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", ok);
    const client = createProviderIndexApiClient();
    await expect(client.archive(LOCATOR)).resolves.toBeUndefined();

    const failing = vi.fn().mockResolvedValue(
      json({ error: "provider_reconciliation_required", code: "RECONCILIATION_REQUIRED" }, 409),
    );
    vi.stubGlobal("fetch", failing);
    await expect(client.archive(LOCATOR)).rejects.toBeInstanceOf(ProviderIndexHttpError);
  });

  it("serializes locator paths with the exact engine grammar (browser-safe mirror, path-free)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createProviderIndexApiClient();
    await client.archive(LOCATOR);
    const url = fetchMock.mock.calls[0]![0] as string;
    // The browser mirror must produce byte-identical output to the Node engine serializer
    // so the server parser accepts it; and the raw home never appears in the path.
    expect(url).toContain(encodeURIComponent(serializeTaskLocator(LOCATOR)));
    expect(url).not.toContain(".codex");
    expect(url).not.toContain("/Users/");
  });

  it("uses PATCH for additive meta", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ locator: LOCATOR, favorite: true, tags: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createProviderIndexApiClient();
    await client.patchMeta(LOCATOR, { favorite: true });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("PATCH");
  });
});
