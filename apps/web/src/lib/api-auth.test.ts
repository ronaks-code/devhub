// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, setToken } from "./api.js";

/**
 * A minimal in-memory `Storage`. The `jsdom` env here does not expose a usable
 * `window.localStorage` (accessing it throws on the opaque `about:blank`
 * origin), so — exactly like compat-storage.test.ts — we stub a working one.
 * Without this, `setToken` is a silent no-op and this assertion fails for an
 * environment reason rather than a real one (the header logic is correct).
 */
function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("window", { localStorage: makeStorage() });
});

afterEach(() => {
  setToken(null);
  vi.unstubAllGlobals();
});

describe("authenticated API helpers", () => {
  it("search carries the stored desktop bearer token", async () => {
    setToken("desktop-launch-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.search("native app", 30, "project-1")).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/search?q=native%20app&limit=30&projectId=project-1",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer desktop-launch-token" }),
      }),
    );
  });
});
