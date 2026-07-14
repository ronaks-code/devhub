import { describe, expect, it } from "vitest";
import {
  assertProviderRequestIdentity,
  createProviderRequestIdentity,
  serializeProviderRequestIdentity,
} from "../../src/providers/request-identity.js";
import { createNativeTaskKey } from "../../src/providers/task-key.js";

const key = createNativeTaskKey("openai", "/tmp/codex-home", "task-1");
const invalidNumericIds = [
  { label: "fractional", value: 1.5 },
  { label: "positive unsafe integer", value: Number.MAX_SAFE_INTEGER + 1 },
  { label: "negative unsafe integer", value: Number.MIN_SAFE_INTEGER - 1 },
] as const;
const invalidNumericFields = (["requestId", "approvalId"] as const).flatMap((field) =>
  invalidNumericIds.map(({ label, value }) => ({ field, label, value })));

describe("provider request identity", () => {
  it("freezes every native correlation field with the immutable task key", () => {
    const identity = createProviderRequestIdentity({
      key,
      generation: null,
      turnId: "turn-1",
      requestId: "request-1",
      itemId: "item-1",
      approvalId: "approval-1",
    });

    expect(identity).toEqual({
      key,
      generation: null,
      turnId: "turn-1",
      requestId: "request-1",
      itemId: "item-1",
      approvalId: "approval-1",
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.key)).toBe(true);
  });

  it.each(["turnId", "requestId", "itemId", "approvalId"] as const)(
    "rejects an empty non-null %s",
    (field) => {
      expect(() => createProviderRequestIdentity({
        key,
        generation: null,
        turnId: null,
        requestId: "request-1",
        itemId: null,
        approvalId: null,
        [field]: "   ",
      })).toThrow(new RegExp(field, "i"));
    },
  );

  it.each(["turnId", "requestId", "itemId", "approvalId"] as const)(
    "bounds and filters non-null %s values before correlation storage",
    (field) => {
      for (const unsafe of [
        "x".repeat(513),
        "native\ncontrol",
        "sk-proj-0123456789abcdefghijklmnop",
      ]) {
        expect(() => createProviderRequestIdentity({
          key,
          generation: 1,
          turnId: null,
          requestId: "request-1",
          itemId: null,
          approvalId: null,
          [field]: unsafe,
        })).toThrow(new RegExp(field, "i"));
      }
    },
  );

  it("keeps the serialized maximum-size identity bounded", () => {
    const maximum = "x".repeat(512);
    const serialized = serializeProviderRequestIdentity({
      key: createNativeTaskKey("openai", "/tmp/codex-home", maximum),
      generation: Number.MAX_SAFE_INTEGER,
      turnId: maximum,
      requestId: maximum,
      itemId: maximum,
      approvalId: maximum,
    });
    expect(serialized.length).toBeLessThan(3_000);
  });

  it("rejects a request identity owned by a different task context", () => {
    const identity = createProviderRequestIdentity({
      key: createNativeTaskKey("openai", "/tmp/codex-home", "task-2"),
      generation: null,
      turnId: null,
      requestId: "request-1",
      itemId: null,
      approvalId: null,
    });

    expect(() => assertProviderRequestIdentity(identity, key)).toThrow(/task context/i);
  });

  it("preserves numeric JSON-RPC request and approval ids without coercion", () => {
    const identity = createProviderRequestIdentity({
      key,
      generation: 1,
      turnId: "turn-1",
      requestId: 1,
      itemId: "item-1",
      approvalId: 2,
    });

    expect(identity.requestId).toBe(1);
    expect(typeof identity.requestId).toBe("number");
    expect(identity.approvalId).toBe(2);
    expect(typeof identity.approvalId).toBe("number");
  });

  it.each(invalidNumericFields)(
    "rejects a $label $field",
    ({ field, value }) => {
      expect(() => createProviderRequestIdentity({
        key,
        generation: 1,
        turnId: "turn-1",
        requestId: "request-1",
        itemId: "item-1",
        approvalId: null,
        [field]: value,
      })).toThrow(new RegExp(`${field}.*safe integer`, "i"));
    },
  );

  it.each([
    Number.MIN_SAFE_INTEGER,
    -1,
    0,
    1,
    Number.MAX_SAFE_INTEGER,
  ])("accepts safe integer JSON-RPC ids at %s", (value) => {
    const identity = createProviderRequestIdentity({
      key,
      generation: 1,
      turnId: "turn-1",
      requestId: value,
      itemId: "item-1",
      approvalId: value,
    });

    expect(identity.requestId).toBe(value);
    expect(identity.approvalId).toBe(value);
  });

  it("serializes numeric and string JSON-RPC ids as distinct identities", () => {
    const withId = (requestId: string | number, approvalId: string | number | null) =>
      createProviderRequestIdentity({
        key,
        generation: 1,
        turnId: "turn-1",
        requestId,
        itemId: "item-1",
        approvalId,
      });

    expect(serializeProviderRequestIdentity(withId(1, 2))).not.toBe(
      serializeProviderRequestIdentity(withId("1", 2)),
    );
    expect(serializeProviderRequestIdentity(withId(1, 2))).not.toBe(
      serializeProviderRequestIdentity(withId(1, "2")),
    );
  });

  it("serializes the same native JSON-RPC ids in different generations as distinct identities", () => {
    const inGeneration = (generation: number | null) => createProviderRequestIdentity({
      key,
      generation,
      turnId: "turn-1",
      requestId: 1,
      itemId: "item-1",
      approvalId: 2,
    });

    const legacy = inGeneration(null);
    const first = inGeneration(7);
    const restarted = inGeneration(8);

    expect(serializeProviderRequestIdentity(first)).not.toBe(
      serializeProviderRequestIdentity(restarted),
    );
    expect(serializeProviderRequestIdentity(legacy)).not.toBe(
      serializeProviderRequestIdentity(first),
    );
    expect(JSON.parse(serializeProviderRequestIdentity(first))).toEqual([
      "openai",
      "/tmp/codex-home",
      "task-1",
      ["n", 7],
      ["s", "turn-1"],
      ["n", 1],
      ["s", "item-1"],
      ["n", 2],
    ]);
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an unsafe process generation %s",
    (generation) => {
      expect(() => createProviderRequestIdentity({
        key,
        generation,
        turnId: "turn-1",
        requestId: 1,
        itemId: "item-1",
        approvalId: null,
      })).toThrow(/generation.*non-negative safe integer/i);
    },
  );
});
