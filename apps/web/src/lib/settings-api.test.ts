import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";

function settingsResponse(theme: "dark" | "light") {
  return new Response(JSON.stringify({ theme }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("serialized settings API", () => {
  it("commits concurrent partial writes in invocation order", async () => {
    let resolveFirst!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(settingsResponse("light"));
    vi.stubGlobal("fetch", fetchMock);

    const first = api.putSettings({ density: "compact" });
    const second = api.putSettings({ theme: "light" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveFirst(settingsResponse("dark"));
    await expect(first).resolves.toMatchObject({ theme: "dark" });
    await expect(second).resolves.toMatchObject({ theme: "light" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ density: "compact" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({ theme: "light" });
  });
});
