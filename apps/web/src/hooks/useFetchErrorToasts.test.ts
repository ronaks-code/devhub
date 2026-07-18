import { describe, expect, it } from "vitest";
import { fetchErrorDedupeKey } from "./useFetchErrorToasts";

describe("fetchErrorDedupeKey", () => {
  it("dedupes query variants of one endpoint without merging methods or paths", () => {
    expect(fetchErrorDedupeKey("get", "/api/rollups?since=2026-01-01")).toBe(
      fetchErrorDedupeKey("GET", "/api/rollups?since=2026-02-01"),
    );
    expect(fetchErrorDedupeKey("POST", "/api/rollups")).not.toBe(
      fetchErrorDedupeKey("GET", "/api/rollups"),
    );
    expect(fetchErrorDedupeKey("GET", "/api/stats")).not.toBe(
      fetchErrorDedupeKey("GET", "/api/rollups"),
    );
  });
});
