import { describe, expect, it } from "vitest";
import {
  CODEX_DEVHUB_SOURCE_KINDS,
  CodexListCursorCodec,
  CodexListCursorError,
  advanceCodexListCursorState,
  createCodexThreadListRequests,
  initialCodexListCursorState,
} from "../../src/providers/codex/list-cursor.js";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("Codex list cursor", () => {
  it("round-trips deterministic opaque state bound to home and filters", () => {
    const codec = new CodexListCursorCodec(SECRET);
    const scope = { home: "/tmp/codex-home-a", includeArchived: true, limit: 50 };
    const state = {
      activeCursor: "active-provider-cursor",
      activeDone: false,
      archivedCursor: "archived-provider-cursor",
      archivedDone: false,
      nextLane: "active",
    } as const;

    const first = codec.encode(scope, state);
    const second = codec.encode({ ...scope }, { ...state });

    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(8_192);
    expect(first).not.toContain(scope.home);
    expect(codec.decode(first, scope)).toEqual(state);
  });

  it("rejects payload and signature tampering without echoing cursor material", () => {
    const codec = new CodexListCursorCodec(SECRET);
    const scope = { home: "/tmp/codex-home-a", includeArchived: true, limit: 50 };
    const cursor = codec.encode(scope, initialCodexListCursorState(true));
    const index = Math.floor(cursor.length / 2);
    const tampered = `${cursor.slice(0, index)}${cursor[index] === "a" ? "b" : "a"}${cursor.slice(index + 1)}`;

    let thrown: unknown;
    try {
      codec.decode(tampered, scope);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CodexListCursorError);
    expect((thrown as CodexListCursorError).code).toBe("INVALID_CURSOR");
    expect((thrown as Error).message).not.toContain(tampered);
  });

  it.each([
    { home: "/tmp/codex-home-b", includeArchived: true, limit: 50 },
    { home: "/tmp/codex-home-a", includeArchived: false, limit: 50 },
    { home: "/tmp/codex-home-a", includeArchived: true, limit: 49 },
  ])("rejects a cursor outside its exact list scope", (otherScope) => {
    const codec = new CodexListCursorCodec(SECRET);
    const scope = { home: "/tmp/codex-home-a", includeArchived: true, limit: 50 };
    const cursor = codec.encode(scope, initialCodexListCursorState(true));

    expect(() => codec.decode(cursor, otherScope)).toThrowError(
      expect.objectContaining({ code: "CURSOR_SCOPE_MISMATCH" }),
    );
  });

  it("requires a high-entropy cursor secret and bounded native cursors", () => {
    expect(() => new CodexListCursorCodec("short")).toThrowError(
      expect.objectContaining({ code: "INVALID_CONFIGURATION" }),
    );

    const codec = new CodexListCursorCodec(SECRET);
    expect(() =>
      codec.encode(
        { home: "/tmp/codex-home", includeArchived: false, limit: 20 },
        {
          ...initialCodexListCursorState(false),
          activeCursor: "x".repeat(2_049),
        },
      )
    ).toThrowError(expect.objectContaining({ code: "INVALID_CURSOR_STATE" }));
  });

  it("builds active and archived updated-desc requests for both observed DevHub source kinds", () => {
    const scope = { home: "/tmp/codex-home", includeArchived: true, limit: 40 };
    const requests = createCodexThreadListRequests(scope, {
      activeCursor: "active-next",
      activeDone: false,
      archivedCursor: null,
      archivedDone: false,
      nextLane: "active",
    });

    expect(CODEX_DEVHUB_SOURCE_KINDS).toEqual(["vscode", "appServer"]);
    expect(requests).toEqual([
      {
        lane: "active",
        params: {
          archived: false,
          cursor: "active-next",
          limit: 20,
          sourceKinds: ["vscode", "appServer"],
          sortKey: "updated_at",
          sortDirection: "desc",
        },
      },
      {
        lane: "archived",
        params: {
          archived: true,
          cursor: null,
          limit: 20,
          sourceKinds: ["vscode", "appServer"],
          sortKey: "updated_at",
          sortDirection: "desc",
        },
      },
    ]);
  });

  it("partitions odd request quotas losslessly and alternates the remainder", () => {
    const scope = { home: "/tmp/codex-home", includeArchived: true, limit: 5 };
    const initial = initialCodexListCursorState(true);
    const firstRequests = createCodexThreadListRequests(scope, initial);

    expect(firstRequests.map((request) => [request.lane, request.params.limit])).toEqual([
      ["active", 3],
      ["archived", 2],
    ]);
    expect(firstRequests.reduce((sum, request) => sum + request.params.limit, 0)).toBe(5);

    const next = advanceCodexListCursorState(scope, initial, [
      { lane: "active", nextCursor: "active-page-2" },
      { lane: "archived", nextCursor: "archived-page-2" },
    ]);
    expect(next.nextLane).toBe("archived");
    expect(createCodexThreadListRequests(scope, next).map((request) => [
      request.lane,
      request.params.limit,
    ])).toEqual([
      ["active", 2],
      ["archived", 3],
    ]);
  });

  it("alternates a one-item page without advancing an unrequested lane", () => {
    const scope = { home: "/tmp/codex-home", includeArchived: true, limit: 1 };
    const initial = initialCodexListCursorState(true);

    expect(createCodexThreadListRequests(scope, initial).map((request) => request.lane)).toEqual([
      "active",
    ]);
    const next = advanceCodexListCursorState(scope, initial, [
      { lane: "active", nextCursor: "active-page-2" },
    ]);
    expect(next).toEqual({
      activeCursor: "active-page-2",
      activeDone: false,
      archivedCursor: null,
      archivedDone: false,
      nextLane: "archived",
    });
    expect(createCodexThreadListRequests(scope, next).map((request) => request.lane)).toEqual([
      "archived",
    ]);
  });

  it("requires exactly one response for every issued lane before advancing", () => {
    const scope = { home: "/tmp/codex-home", includeArchived: true, limit: 4 };
    const initial = initialCodexListCursorState(true);

    expect(() =>
      advanceCodexListCursorState(scope, initial, [
        { lane: "active", nextCursor: "active-page-2" },
      ])
    ).toThrowError(expect.objectContaining({ code: "INVALID_CURSOR_STATE" }));
    expect(() =>
      advanceCodexListCursorState(scope, initial, [
        { lane: "active", nextCursor: "active-page-2" },
        { lane: "active", nextCursor: "active-page-3" },
      ])
    ).toThrowError(expect.objectContaining({ code: "INVALID_CURSOR_STATE" }));
  });

  it("omits exhausted and disabled lanes", () => {
    expect(
      createCodexThreadListRequests(
        { home: "/tmp/codex-home", includeArchived: false, limit: 20 },
        initialCodexListCursorState(false),
      ),
    ).toHaveLength(1);

    expect(
      createCodexThreadListRequests(
        { home: "/tmp/codex-home", includeArchived: true, limit: 20 },
        {
          activeCursor: null,
          activeDone: true,
          archivedCursor: null,
          archivedDone: true,
          nextLane: "active",
        },
      ),
    ).toEqual([]);
  });
});
