import { describe, it, expect } from "vitest";
import { serializeTaskLocator } from "@devhub/engine/providers";
import { parseRoute, buildRouteSearch } from "./router";

/** A valid, canonical serialized provider-task locator for the URL tests. */
const LOCATOR = serializeTaskLocator({
  version: 1,
  provider: "openai",
  homeFingerprint: "a".repeat(64),
  nativeTaskId: "task-123",
});

describe("parseRoute", () => {
  it("reads tab, project, and session from a query string", () => {
    const r = parseRoute("?tab=browse&project=p1&session=s1");
    expect(r).toEqual({ tab: "browse", project: "p1", session: "s1" });
  });

  it("drops an unknown tab but keeps the other params", () => {
    const r = parseRoute("?tab=wat&project=p1");
    expect(r.tab).toBeUndefined();
    expect(r.project).toBe("p1");
  });

  it("returns an empty route for an empty / missing query", () => {
    expect(parseRoute("")).toEqual({});
    expect(parseRoute("?")).toEqual({});
  });

  it("ignores empty param values (treated as absent)", () => {
    const r = parseRoute("?tab=chat&project=&session=");
    expect(r).toEqual({ tab: "chat" });
  });

  it("tolerates a malformed query without throwing", () => {
    // Stray %, duplicate keys, and junk — should never throw, just parse what it can.
    const r = parseRoute("?tab=ops&%=&project=p2&project=p3");
    expect(r.tab).toBe("ops");
    // URLSearchParams.get returns the FIRST value for a repeated key.
    expect(r.project).toBe("p2");
  });

  it("accepts each valid tab", () => {
    for (const tab of ["browse", "chat", "ops", "inbox", "dashboard", "settings"] as const) {
      expect(parseRoute(`?tab=${tab}`).tab).toBe(tab);
    }
  });

  it("reads a valid providerTask locator", () => {
    const r = parseRoute(`?tab=chat&providerTask=${encodeURIComponent(LOCATOR)}`);
    expect(r.tab).toBe("chat");
    expect(r.providerTask).toBe(LOCATOR);
  });

  it("drops a malformed providerTask without throwing, keeping other params", () => {
    const r = parseRoute("?tab=chat&project=p1&providerTask=not-a-locator");
    expect(r.tab).toBe("chat");
    expect(r.project).toBe("p1");
    expect(r.providerTask).toBeUndefined();
  });

  it("drops a providerTask that carries a NUL byte", () => {
    const r = parseRoute("?providerTask=pt1.openai.%00");
    expect(r.providerTask).toBeUndefined();
  });

  it("parses a legacy URL (no providerTask) unchanged", () => {
    expect(parseRoute("?tab=browse&project=p1&session=s1")).toEqual({
      tab: "browse",
      project: "p1",
      session: "s1",
    });
  });
});

describe("buildRouteSearch", () => {
  it("builds a minimal query, omitting empty keys", () => {
    expect(buildRouteSearch({ tab: "browse" })).toBe("?tab=browse");
    expect(buildRouteSearch({ tab: "browse", project: "p1", session: "s1" })).toBe(
      "?tab=browse&project=p1&session=s1",
    );
  });

  it("returns an empty string for an empty route", () => {
    expect(buildRouteSearch({})).toBe("");
  });

  it("omits null/undefined project and session", () => {
    expect(buildRouteSearch({ tab: "chat", project: null, session: undefined })).toBe("?tab=chat");
  });

  it("round-trips a full route through parse", () => {
    const route = { tab: "dashboard", project: "proj-abc", session: "sess-xyz" } as const;
    const search = buildRouteSearch(route);
    expect(parseRoute(search)).toEqual(route);
  });

  it("encodes special characters so the round-trip is lossless", () => {
    const route = { tab: "browse", project: "a/b c&d", session: "x=y?z" } as const;
    const search = buildRouteSearch(route);
    expect(parseRoute(search)).toEqual(route);
  });

  it("emits providerTask last, in stable parameter order", () => {
    const search = buildRouteSearch({
      tab: "chat",
      project: "p1",
      session: "s1",
      providerTask: LOCATOR,
    });
    expect(search).toBe(
      `?tab=chat&project=p1&session=s1&providerTask=${encodeURIComponent(LOCATOR)}`,
    );
  });

  it("round-trips a full route including providerTask", () => {
    const route = { tab: "chat", project: "p1", session: "s1", providerTask: LOCATOR } as const;
    expect(parseRoute(buildRouteSearch(route))).toEqual(route);
  });

  it("omits a malformed providerTask instead of throwing", () => {
    expect(buildRouteSearch({ tab: "chat", providerTask: "garbage" })).toBe("?tab=chat");
    expect(buildRouteSearch({ tab: "chat", providerTask: null })).toBe("?tab=chat");
  });
});
