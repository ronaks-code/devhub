// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, setToken } from "./api.js";

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
