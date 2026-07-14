import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertLocatorMatchesKey,
  canonicalProviderIndexJson,
  cachedEventItemId,
  cachedTurnKey,
  homeFingerprint,
  indexedProviderEventItemId,
  indexedProviderEventTurnId,
  parseCachedEventItemKey,
  parseCachedTurnKey,
  parseProviderEventReplayKey,
  parseTaskLocator,
  projectIndexedProviderEvent,
  providerEventReplayKey,
  serializeTaskLocator,
  taskLocator,
  type IndexedProviderEvent,
  type IndexedProviderRequestIdentity,
  type ProviderTaskLocator,
} from "../../src/provider-index/identity.js";
import { normalizeProviderEvent, type ProviderEvent } from "../../src/providers/events.js";
import * as providersIndex from "../../src/providers/index.js";
import { createProviderRequestIdentity } from "../../src/providers/request-identity.js";
import { createNativeTaskKey } from "../../src/providers/task-key.js";

const CANONICAL_HOME = "/__devhub_identity_contract__/home";
const OCCURRED_AT = "2026-07-13T20:00:00.000Z";
const key = createNativeTaskKey("openai", CANONICAL_HOME, "task-1");
const context = { provider: "openai" as const, key, occurredAt: OCCURRED_AT };

const providerEvent = (input: unknown): ProviderEvent => normalizeProviderEvent(input, context);

const messageDelta = (delta: string, itemId: string | null = "item-α"): ProviderEvent =>
  providerEvent({
    type: "message-delta",
    role: "assistant",
    delta,
    turnId: "turn-1",
    itemId,
  });

const identity = createProviderRequestIdentity({
  key,
  generation: 7,
  turnId: "turn-1",
  requestId: "request-1",
  itemId: "request-item-1",
  approvalId: "approval-1",
});

const captureError = (action: () => unknown): unknown => {
  try {
    action();
    return null;
  } catch (error) {
    return error;
  }
};

const expectValueFreeTypeError = (
  action: () => unknown,
  message: string,
  forbidden: string,
): void => {
  const error = captureError(action);
  expect(error).toBeInstanceOf(TypeError);
  expect((error as Error).message).toBe(message);
  expect(String(error)).not.toContain(forbidden);
};

const diagnosticEvent = (
  overrides: Partial<Extract<ProviderEvent, { type: "diagnostic" }>> = {},
): Extract<ProviderEvent, { type: "diagnostic" }> => {
  const event = {
    provider: "openai" as const,
    key,
    occurredAt: OCCURRED_AT,
    type: "diagnostic" as const,
    level: "warning" as const,
    code: "SAFE_DIAGNOSTIC",
    message: "safe diagnostic",
    method: null,
    shapeKeys: Object.freeze(["detail"]),
    ...overrides,
  };
  return Object.freeze(event);
};

describe("provider task locators", () => {
  it("uses an exact stable provider-isolated home fingerprint", () => {
    expect(homeFingerprint("openai", CANONICAL_HOME)).toBe(
      "7066394e4c1edb1a19490232746f70a5bf046ff5d22b50e7b45e678bb9083416",
    );
    expect(homeFingerprint("anthropic", CANONICAL_HOME)).toMatch(/^[0-9a-f]{64}$/u);
    expect(homeFingerprint("anthropic", CANONICAL_HOME)).not.toBe(
      homeFingerprint("openai", CANONICAL_HOME),
    );
    expect(() => homeFingerprint("other" as "openai", CANONICAL_HOME)).toThrow(TypeError);
    expect(() => homeFingerprint("openai", "/tmp/identity/../home")).toThrow(/canonical/i);
  });

  it("gives existing-home symlink aliases the same locator", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "devhub-locator-home-"));
    try {
      const actual = path.join(root, "actual");
      const alias = path.join(root, "alias");
      mkdirSync(actual);
      symlinkSync(actual, alias);

      const actualKey = createNativeTaskKey("openai", actual, "task-1");
      const aliasKey = createNativeTaskKey("openai", alias, "task-1");

      expect(actualKey.home).toBe(realpathSync(actual));
      expect(aliasKey.home).toBe(actualKey.home);
      expect(taskLocator(aliasKey)).toEqual(taskLocator(actualKey));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("round-trips a Unicode native task id without disclosing the raw home", () => {
    const unicodeKey = createNativeTaskKey("openai", CANONICAL_HOME, "任务/🧪");
    const locator = taskLocator(unicodeKey);
    const serialized = serializeTaskLocator(locator);

    expect(serialized).toBe(
      "pt1.openai.7066394e4c1edb1a19490232746f70a5bf046ff5d22b50e7b45e678bb9083416.5Lu75YqhL_Cfp6o",
    );
    expect(serialized).not.toContain(CANONICAL_HOME);
    expect(serialized).not.toContain("\u0000");
    expect(parseTaskLocator(serialized)).toEqual(locator);
  });

  it.each([
    "",
    "pt2.openai." + "a".repeat(64) + ".dGFzaw",
    "PT1.openai." + "a".repeat(64) + ".dGFzaw",
    "pt1.other." + "a".repeat(64) + ".dGFzaw",
    "pt1.openai." + "a".repeat(63) + ".dGFzaw",
    "pt1.openai." + "A".repeat(64) + ".dGFzaw",
    "pt1.openai." + "a".repeat(64) + ".dGFzaw.extra",
    " pt1.openai." + "a".repeat(64) + ".dGFzaw",
    "pt1.openai." + "a".repeat(64) + ".dGFzaw\n",
    "pt1.openai." + "a".repeat(64) + ".dGFzaw==",
    "pt1.openai." + "a".repeat(64) + ".***",
    "pt1.openai." + "a".repeat(64) + "._w",
  ])("rejects malformed or noncanonical serialized locators %#", (value) => {
    expect(() => parseTaskLocator(value)).toThrow(TypeError);
  });

  it.each([
    " task ",
    "task\ncontrol",
    "sk-proj-0123456789abcdefghijklmnop",
    "x".repeat(513),
  ])("rejects invalid decoded native task ids %#", (nativeTaskId) => {
    const encoded = Buffer.from(nativeTaskId, "utf8").toString("base64url");
    expect(() => parseTaskLocator(`pt1.openai.${"a".repeat(64)}.${encoded}`)).toThrow(
      TypeError,
    );
  });

  it("bounds both serialization and parsing to 1024 characters", () => {
    const locator = {
      ...taskLocator(key),
      nativeTaskId: "界".repeat(400),
    } satisfies ProviderTaskLocator;

    expect(() => serializeTaskLocator(locator)).toThrow(TypeError);
    expect(() => parseTaskLocator(`pt1.openai.${"a".repeat(64)}.${"e".repeat(1025)}`)).toThrow(
      TypeError,
    );
  });

  it("asserts exact provider, home fingerprint, and native task ownership", () => {
    const locator = taskLocator(key);
    expect(() => assertLocatorMatchesKey(locator, key)).not.toThrow();
    expect(() =>
      assertLocatorMatchesKey(
        locator,
        createNativeTaskKey("openai", "/__devhub_identity_contract__/other", "task-1"),
      ),
    ).toThrow(/match/i);
    expect(() =>
      assertLocatorMatchesKey(
        locator,
        createNativeTaskKey("openai", CANONICAL_HOME, "task-2"),
      ),
    ).toThrow(/match/i);
    expect(() =>
      assertLocatorMatchesKey(
        locator,
        createNativeTaskKey("anthropic", CANONICAL_HOME, "task-1"),
      ),
    ).toThrow(/match/i);
  });

  it("returns frozen locator snapshots and re-exports the API", () => {
    const locator = taskLocator(key);
    const parsed = parseTaskLocator(serializeTaskLocator(locator));

    expect(Object.isFrozen(locator)).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(providersIndex.homeFingerprint).toBe(homeFingerprint);
    expect(providersIndex.taskLocator).toBe(taskLocator);
    expect(providersIndex.projectIndexedProviderEvent).toBe(projectIndexedProviderEvent);
  });

  it("rejects lossy UTF-8 native ids instead of colliding a lone surrogate with U+FFFD", () => {
    const loneSurrogate = "\ud800";
    const replacement = "\ufffd";
    expect(Buffer.from(loneSurrogate, "utf8")).toEqual(Buffer.from(replacement, "utf8"));

    const lossyKey = createNativeTaskKey("openai", CANONICAL_HOME, loneSurrogate);
    const replacementKey = createNativeTaskKey("openai", CANONICAL_HOME, replacement);
    expect(() => taskLocator(lossyKey)).toThrow(TypeError);
    expect(() => serializeTaskLocator({
      ...taskLocator(key),
      nativeTaskId: loneSurrogate,
    })).toThrow(TypeError);
    expect(serializeTaskLocator(taskLocator(replacementKey))).toContain(
      Buffer.from(replacement, "utf8").toString("base64url"),
    );
  });

  it("rejects task identity that contains its exact raw provider home", () => {
    const collisionKey = createNativeTaskKey(
      "openai",
      CANONICAL_HOME,
      `task:${CANONICAL_HOME}:collision`,
    );
    expectValueFreeTypeError(
      () => taskLocator(collisionKey),
      "native task key is unsafe for provider indexing",
      CANONICAL_HOME,
    );
  });

  it("rejects a canonical missing provider home whose UTF-8 encoding is lossy", () => {
    const loneSurrogateHome = "/__devhub_identity_contract__/home-\ud800";
    const replacementHome = "/__devhub_identity_contract__/home-\ufffd";
    expect(Buffer.from(loneSurrogateHome, "utf8")).toEqual(
      Buffer.from(replacementHome, "utf8"),
    );

    expectValueFreeTypeError(
      () => homeFingerprint("openai", loneSurrogateHome),
      "provider home must be canonical exact UTF-8",
      loneSurrogateHome,
    );
    expect(homeFingerprint("openai", replacementHome)).toMatch(/^[0-9a-f]{64}$/u);

    const lossyKey = createNativeTaskKey("openai", loneSurrogateHome, "task-home-lossy");
    const replacementKey = createNativeTaskKey("openai", replacementHome, "task-home-lossy");
    expectValueFreeTypeError(
      () => taskLocator(lossyKey),
      "native task key is unsafe for provider indexing",
      loneSurrogateHome,
    );
    expect(taskLocator(replacementKey).homeFingerprint).toBe(
      homeFingerprint("openai", replacementHome),
    );
  });

  it("accepts a null-prototype locator with exactly the required data properties", () => {
    const locator = taskLocator(key);
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, locator);
    expect(serializeTaskLocator(nullPrototype as unknown as ProviderTaskLocator)).toBe(
      serializeTaskLocator(locator),
    );
  });

  it.each([
    {
      name: "extra field",
      value: { ...taskLocator(key), extra: "unsafe" },
    },
    {
      name: "symbol field",
      value: Object.assign({}, taskLocator(key), { [Symbol("extra")]: "unsafe" }),
    },
    {
      name: "inherited field",
      value: Object.assign(Object.create({ provider: "openai" }) as Record<string, unknown>, {
        version: 1,
        homeFingerprint: taskLocator(key).homeFingerprint,
        nativeTaskId: "task-1",
      }),
    },
  ])("rejects locator objects with $name", ({ value }) => {
    expectValueFreeTypeError(
      () => serializeTaskLocator(value as unknown as ProviderTaskLocator),
      "provider task locator is invalid",
      "unsafe",
    );
  });

  it("rejects accessors without invoking a throwing or changing getter", () => {
    const secret = "getter-secret-must-not-escape";
    let reads = 0;
    const locator = {
      version: 1,
      provider: "openai",
      homeFingerprint: taskLocator(key).homeFingerprint,
    } as Record<string, unknown>;
    Object.defineProperty(locator, "nativeTaskId", {
      enumerable: true,
      get() {
        reads += 1;
        if (reads > 1) throw new Error(secret);
        return reads % 2 === 1 ? "task-1" : "task-2";
      },
    });

    expectValueFreeTypeError(
      () => serializeTaskLocator(locator as unknown as ProviderTaskLocator),
      "provider task locator is invalid",
      secret,
    );
    expect(reads).toBe(0);
  });

  it("contains descriptor-proxy failures without reflecting their value", () => {
    const secret = "descriptor-proxy-secret";
    const locator = new Proxy(taskLocator(key), {
      getOwnPropertyDescriptor() {
        throw new Error(secret);
      },
    });

    expectValueFreeTypeError(
      () => serializeTaskLocator(locator),
      "provider task locator is invalid",
      secret,
    );
  });

  it("snapshots NativeTaskKey data properties without invoking changing accessors", () => {
    const secret = "native-task-key-getter-secret";
    let reads = 0;
    const hostile = {
      provider: "openai",
      home: CANONICAL_HOME,
    } as Record<string, unknown>;
    Object.defineProperty(hostile, "nativeTaskId", {
      enumerable: true,
      get() {
        reads += 1;
        if (reads > 1) throw new Error(secret);
        return reads === 1 ? "task-1" : "task-2";
      },
    });

    expectValueFreeTypeError(
      () => taskLocator(hostile as unknown as Parameters<typeof taskLocator>[0]),
      "native task key is unsafe for provider indexing",
      secret,
    );
    expect(reads).toBe(0);
  });

  it.each([
    {
      name: "descriptor proxy",
      secret: "task-key-descriptor-proxy-secret",
      value: new Proxy(key, {
        getOwnPropertyDescriptor() {
          throw new Error("task-key-descriptor-proxy-secret");
        },
      }),
    },
    {
      name: "prototype proxy",
      secret: "task-key-prototype-proxy-secret",
      value: new Proxy(key, {
        getPrototypeOf() {
          throw new Error("task-key-prototype-proxy-secret");
        },
      }),
    },
  ])("contains $name failures without reflecting values", ({ value, secret }) => {
    expectValueFreeTypeError(
      () => taskLocator(value),
      "native task key is unsafe for provider indexing",
      secret,
    );
  });

  it.each([
    {
      name: "extra field",
      value: { ...key, extra: "unsafe-task-key-extra" },
    },
    {
      name: "symbol field",
      value: Object.assign({}, key, { [Symbol("task-key-extra")]: "unsafe" }),
    },
    {
      name: "inherited provider",
      value: Object.assign(Object.create({ provider: "openai" }) as Record<string, unknown>, {
        home: CANONICAL_HOME,
        nativeTaskId: "task-1",
      }),
    },
  ])("rejects NativeTaskKey objects with $name", ({ value }) => {
    expectValueFreeTypeError(
      () => taskLocator(value as unknown as Parameters<typeof taskLocator>[0]),
      "native task key is unsafe for provider indexing",
      "unsafe-task-key-extra",
    );
  });

  it("accepts exact plain and null-prototype NativeTaskKey snapshots", () => {
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, key);
    expect(taskLocator(key)).toEqual(taskLocator(
      nullPrototype as unknown as Parameters<typeof taskLocator>[0],
    ));
  });

  it("does not reflect unsupported provider text from parse or serialize", () => {
    const secret = "attacker-provider-value";
    expectValueFreeTypeError(
      () => parseTaskLocator(`pt1.${secret}.${"a".repeat(64)}.dGFzaw`),
      "provider task locator is invalid",
      secret,
    );
    expectValueFreeTypeError(
      () => serializeTaskLocator({
        ...taskLocator(key),
        provider: secret as "openai",
      }),
      "provider task locator is invalid",
      secret,
    );
  });
});

describe("cache identity keys", () => {
  it("uses a non-null sentinel for absent turns and canonical base64url for native turns", () => {
    expect(cachedTurnKey(null)).toBe("none:v1");
    expect(cachedTurnKey("轮次/🧪")).toBe(
      `native:v1:${Buffer.from("轮次/🧪", "utf8").toString("base64url")}`,
    );
  });

  it("strictly parses cached turn keys with a fixed Unicode vector", () => {
    const vector = "native:v1:6L2u5qyhL_Cfp6o";
    expect(cachedTurnKey("轮次/🧪")).toBe(vector);
    expect(parseCachedTurnKey("none:v1")).toBeNull();
    expect(parseCachedTurnKey(vector)).toBe("轮次/🧪");

    for (const malformed of [
      "",
      "none:v1:extra",
      "native:v1:",
      "native:v1:dHVybg==",
      "native:v1:***",
      "native:v1:_w",
      "native:v1:IA",
      `native:v1:${"e".repeat(1_025)}`,
    ]) {
      expect(() => parseCachedTurnKey(malformed)).toThrow("cached turn key is invalid");
    }
  });

  it("exports canonical JSON and strict event cache identity helpers", () => {
    const api = providersIndex as unknown as Record<string, unknown>;
    for (const name of [
      "canonicalProviderIndexJson",
      "parseCachedTurnKey",
      "parseCachedEventItemKey",
      "parseProviderEventReplayKey",
      "indexedProviderEventItemId",
      "indexedProviderEventTurnId",
    ]) {
      expect(api[name], name).toBeTypeOf("function");
    }
  });

  it("canonicalizes dense finite JSON with lexicographic record keys", () => {
    expect(canonicalProviderIndexJson({
      z: [1, true, null],
      a: { y: "界", x: -0 },
    })).toBe('{"a":{"x":0,"y":"界"},"z":[1,true,null]}');
    expect(canonicalProviderIndexJson(Object.assign(Object.create(null), {
      b: 2,
      a: 1,
    }))).toBe('{"a":1,"b":2}');
  });

  it("rejects hostile or non-JSON canonicalization inputs with one value-free error", () => {
    const sparse = Array(1);
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        throw new Error("must-never-leak-canonical-accessor");
      },
    });
    const proxy = new Proxy({}, {
      ownKeys() {
        throw new Error("must-never-leak-canonical-proxy");
      },
    });
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      1n,
      sparse,
      new Date(0),
      { [Symbol("hidden")]: 1 },
      accessor,
      proxy,
    ]) {
      expectValueFreeTypeError(
        () => canonicalProviderIndexJson(value),
        "provider index canonical JSON is invalid",
        "must-never-leak",
      );
    }
  });

  it("strictly parses native and synthetic event item keys", () => {
    const native = `native:v1:${Buffer.from("项目/🧪", "utf8").toString("base64url")}`;
    expect(parseCachedEventItemKey(native, 7)).toEqual({
      kind: "native",
      nativeItemId: "项目/🧪",
    });
    const synthetic = `synthetic:v1:7:${"a".repeat(64)}`;
    const parsedSynthetic = parseCachedEventItemKey(synthetic, 7);
    expect(parsedSynthetic).toEqual({ kind: "synthetic", nativeItemId: null });
    expect(Object.isFrozen(parsedSynthetic)).toBe(true);

    for (const malformed of [
      "none:v1",
      "native:v1:",
      "native:v1:_w",
      `synthetic:v1:07:${"a".repeat(64)}`,
      `synthetic:v1:8:${"a".repeat(64)}`,
      `synthetic:v1:7:${"A".repeat(64)}`,
      `synthetic:v1:7:${"a".repeat(63)}`,
    ]) {
      expect(() => parseCachedEventItemKey(malformed, 7))
        .toThrow("cached event item key is invalid");
    }
  });

  it("strictly parses replay keys against the exact canonical ordinal", () => {
    const replay = `replay:v1:23:${"b".repeat(64)}`;
    expect(parseProviderEventReplayKey(replay, 23)).toBe(replay);
    for (const malformed of [
      `replay:v1:023:${"b".repeat(64)}`,
      `replay:v1:24:${"b".repeat(64)}`,
      `replay:v1:23:${"B".repeat(64)}`,
      `replay:v1:23:${"b".repeat(63)}`,
      `synthetic:v1:23:${"b".repeat(64)}`,
    ]) {
      expect(() => parseProviderEventReplayKey(malformed, 23))
        .toThrow("provider event replay key is invalid");
    }
  });

  it("extracts readable item and turn ownership from indexed event variants", () => {
    const request = projectIndexedProviderEvent(providerEvent({
      type: "request",
      request: { kind: "command-approval", identity },
    }));
    const resolved = projectIndexedProviderEvent(providerEvent({
      type: "request-resolved",
      identity,
    }));
    const turnStatus = projectIndexedProviderEvent(providerEvent({
      type: "status",
      scope: "turn",
      status: "running",
      nativeId: "turn-status",
    }));
    const itemStatus = projectIndexedProviderEvent(providerEvent({
      type: "status",
      scope: "item",
      status: "running",
      nativeId: "item-status",
    }));
    const delta = projectIndexedProviderEvent(messageDelta("owned", "item-α"));
    const diagnostic = projectIndexedProviderEvent(diagnosticEvent());

    expect(indexedProviderEventItemId(delta)).toBe("item-α");
    expect(indexedProviderEventItemId(request)).toBe("request-item-1");
    expect(indexedProviderEventItemId(resolved)).toBe("request-item-1");
    expect(indexedProviderEventItemId(itemStatus)).toBe("item-status");
    expect(indexedProviderEventItemId(turnStatus)).toBeNull();
    expect(indexedProviderEventItemId(diagnostic)).toBeNull();

    expect(indexedProviderEventTurnId(delta)).toBe("turn-1");
    expect(indexedProviderEventTurnId(request)).toBe("turn-1");
    expect(indexedProviderEventTurnId(resolved)).toBe("turn-1");
    expect(indexedProviderEventTurnId(turnStatus)).toBe("turn-status");
    expect(indexedProviderEventTurnId(itemStatus)).toBeNull();
    expect(indexedProviderEventTurnId(diagnostic)).toBeNull();
  });

  it.each(["   ", "turn\ncontrol", "sk-proj-0123456789abcdefghijklmnop", "x".repeat(513)])(
    "rejects an invalid supplied turn id %#",
    (nativeTurnId) => {
      expect(() => cachedTurnKey(nativeTurnId)).toThrow(TypeError);
    },
  );

  it("uses one item key but distinct replay keys for multiple deltas of one native item", () => {
    const first = messageDelta("hello ");
    const second = messageDelta("world");
    const expected = `native:v1:${Buffer.from("item-α", "utf8").toString("base64url")}`;

    expect(cachedEventItemId(first, 0)).toBe(expected);
    expect(cachedEventItemId(second, 1)).toBe(expected);
    expect(providerEventReplayKey(first, 0)).not.toBe(providerEventReplayKey(second, 1));
  });

  it("uses deterministic non-null synthetic item keys when an event has no item id", () => {
    const event = messageDelta("legacy", null);
    const first = cachedEventItemId(event, 19);

    expect(first).toMatch(/^synthetic:v1:19:[0-9a-f]{64}$/u);
    expect(first).toBe(cachedEventItemId(event, 19));
    expect(first).not.toBe(cachedEventItemId(event, 20));
  });

  it("derives actual item identity from requests, resolutions, and item status", () => {
    const request = providerEvent({
      type: "request",
      request: { kind: "command-approval", identity },
    });
    const resolved = providerEvent({ type: "request-resolved", identity });
    const status = providerEvent({
      type: "status",
      scope: "item",
      status: "running",
      nativeId: "status-item-1",
    });

    expect(cachedEventItemId(request, 0)).toBe(
      `native:v1:${Buffer.from("request-item-1").toString("base64url")}`,
    );
    expect(cachedEventItemId(resolved, 1)).toBe(cachedEventItemId(request, 0));
    expect(cachedEventItemId(status, 2)).toBe(
      `native:v1:${Buffer.from("status-item-1").toString("base64url")}`,
    );
  });

  it("keeps replay hashes stable while separating content, ordinals, and providers", () => {
    const event = messageDelta("same");
    const changed = messageDelta("changed");
    const anthropicKey = createNativeTaskKey("anthropic", CANONICAL_HOME, "task-1");
    const anthropicEvent = normalizeProviderEvent(
      {
        type: "message-delta",
        role: "assistant",
        delta: "same",
        turnId: "turn-1",
        itemId: "item-α",
      },
      { provider: "anthropic", key: anthropicKey, occurredAt: OCCURRED_AT },
    );

    expect(providerEventReplayKey(event, 4)).toMatch(/^replay:v1:4:[0-9a-f]{64}$/u);
    expect(providerEventReplayKey(event, 4)).toBe(providerEventReplayKey(event, 4));
    expect(providerEventReplayKey(changed, 4)).not.toBe(providerEventReplayKey(event, 4));
    expect(providerEventReplayKey(event, 5)).not.toBe(providerEventReplayKey(event, 4));
    expect(providerEventReplayKey(anthropicEvent, 4)).not.toBe(providerEventReplayKey(event, 4));
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER, 1_000_001])(
    "rejects an unsafe event ordinal %s",
    (ordinal) => {
      const event = messageDelta("unsafe ordinal");
      expect(() => cachedEventItemId(event, ordinal)).toThrow(TypeError);
      expect(() => providerEventReplayKey(event, ordinal)).toThrow(TypeError);
    },
  );

  it("rejects lossy UTF-8 turn and actual-item ids while accepting U+FFFD distinctly", () => {
    const loneSurrogate = "\ud800";
    const replacement = "\ufffd";
    expect(() => cachedTurnKey(loneSurrogate)).toThrow(TypeError);
    expect(cachedTurnKey(replacement)).toBe(
      `native:v1:${Buffer.from(replacement, "utf8").toString("base64url")}`,
    );

    const lossyItem = messageDelta("lossy item", loneSurrogate);
    const replacementItem = messageDelta("replacement item", replacement);
    expect(() => cachedEventItemId(lossyItem, 0)).toThrow(TypeError);
    expect(cachedEventItemId(replacementItem, 0)).toBe(
      `native:v1:${Buffer.from(replacement, "utf8").toString("base64url")}`,
    );
  });

  it.each([
    providerEvent({
      type: "diff-summary",
      turnId: "turn-no-item",
      changedFiles: 1,
      additions: 2,
      deletions: 0,
    }),
    providerEvent({
      type: "usage",
      turnId: "turn-no-item",
      inputTokens: 1,
      outputTokens: 2,
      cachedInputTokens: 0,
      totalTokens: 3,
    }),
    diagnosticEvent(),
    providerEvent({
      type: "status",
      scope: "task",
      status: "running",
      nativeId: "task-1",
    }),
  ])("uses synthetic identity for current event variants without an item %#", (event) => {
    expect(cachedEventItemId(event, 31)).toMatch(/^synthetic:v1:31:[0-9a-f]{64}$/u);
  });
});

describe("indexed provider event projection", () => {
  it("preserves normalized redacted fields without exposing a raw home", () => {
    const secret = "abcdefghijklmnop";
    const normalized = providerEvent({
      type: "message",
      role: "assistant",
      text: `safe Bearer ${secret}`,
      turnId: "turn-1",
      itemId: "item-1",
      home: CANONICAL_HOME,
      authorization: `Bearer ${secret}`,
    });
    const projected: IndexedProviderEvent = projectIndexedProviderEvent(normalized);
    const serialized = JSON.stringify(projected);

    expect(projected).toMatchObject({
      type: "message",
      provider: "openai",
      locator: taskLocator(key),
      occurredAt: OCCURRED_AT,
      role: "assistant",
      text: "safe Bearer [REDACTED]",
      turnId: "turn-1",
      itemId: "item-1",
    });
    expect(projected).not.toHaveProperty("key");
    expect(projected).not.toHaveProperty("home");
    expect(serialized).not.toContain(CANONICAL_HOME);
    expect(serialized).not.toContain(secret);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.locator)).toBe(true);
  });

  it("replaces nested request identity keys with frozen locators", () => {
    const normalized = providerEvent({
      type: "request",
      request: { kind: "permission", identity },
    });
    const projected = projectIndexedProviderEvent(normalized);

    expect(projected.type).toBe("request");
    if (projected.type !== "request") throw new Error("expected request");
    const indexedIdentity: IndexedProviderRequestIdentity = projected.request.identity;
    expect(indexedIdentity.locator).toEqual(taskLocator(key));
    expect(indexedIdentity).not.toHaveProperty("key");
    expect(JSON.stringify(projected)).not.toContain(CANONICAL_HOME);
    expect(Object.isFrozen(projected.request)).toBe(true);
    expect(Object.isFrozen(indexedIdentity)).toBe(true);
    expect(Object.isFrozen(indexedIdentity.locator)).toBe(true);
  });

  it("replaces request-resolved identity keys without losing public fields", () => {
    const normalized = providerEvent({ type: "request-resolved", identity });
    const projected = projectIndexedProviderEvent(normalized);

    expect(projected.type).toBe("request-resolved");
    if (projected.type !== "request-resolved") throw new Error("expected request resolution");
    expect(projected.identity).toEqual({
      locator: taskLocator(key),
      generation: 7,
      turnId: "turn-1",
      requestId: "request-1",
      itemId: "request-item-1",
      approvalId: "approval-1",
    });
    expect(projected.identity).not.toHaveProperty("key");
    expect(JSON.stringify(projected)).not.toContain(CANONICAL_HOME);
    expect(Object.isFrozen(projected.identity)).toBe(true);
  });

  it("clones and freezes nested arrays in projected diagnostics", () => {
    const normalized = providerEvent({
      type: "provider/future",
      method: "future/update",
      detail: "safe value",
    });
    expect(normalized.type).toBe("diagnostic");
    if (normalized.type !== "diagnostic") throw new Error("expected diagnostic");

    const projected = projectIndexedProviderEvent(normalized);
    expect(projected.type).toBe("diagnostic");
    if (projected.type !== "diagnostic") throw new Error("expected projected diagnostic");
    expect(projected.shapeKeys).not.toBe(normalized.shapeKeys);
    expect(Object.isFrozen(projected.shapeKeys)).toBe(true);
    expect(Object.isFrozen(projected)).toBe(true);
  });

  it("turns a throwing proxy boundary into a value-free TypeError", () => {
    const secret = "must-never-escape-proxy-value";
    const normalized = messageDelta("safe");
    const throwing = new Proxy(normalized, {
      get(target, property, receiver) {
        if (property === "delta") throw new Error(secret);
        return Reflect.get(target, property, receiver);
      },
    });

    let thrown: unknown;
    try {
      projectIndexedProviderEvent(throwing);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).not.toContain(secret);
    expect(String(thrown)).not.toContain(secret);
  });

  it.each([
    { occurredAt: { rawHome: CANONICAL_HOME }, label: "object timestamp" },
    { occurredAt: "2026-07-13T20:00:00Z", label: "noncanonical timestamp" },
    { occurredAt: "x".repeat(128), label: "oversized timestamp" },
  ])("rejects a $label before normalization with a fixed value-free error", ({ occurredAt }) => {
    const event = { ...messageDelta("timestamp"), occurredAt } as unknown as ProviderEvent;
    expectValueFreeTypeError(
      () => projectIndexedProviderEvent(event),
      "provider event could not be safely projected",
      CANONICAL_HOME,
    );
  });

  it.each([
    { override: { code: "CHAIN_OF_THOUGHT_ATTACKER" }, forbidden: "CHAIN_OF_THOUGHT_ATTACKER" },
    {
      override: { message: "private chain-of-thought attacker payload" },
      forbidden: "attacker payload",
    },
    {
      override: { method: "chain-of-thought/attacker-update" },
      forbidden: "attacker-update",
    },
    {
      override: { shapeKeys: Object.freeze(["hidden_reasoning_attacker_value"]) },
      forbidden: "attacker_value",
    },
  ])("suppresses hidden diagnostic markers in %#", ({ override, forbidden }) => {
    const projected = projectIndexedProviderEvent(diagnosticEvent(override));
    expect(projected.type).toBe("diagnostic");
    if (projected.type !== "diagnostic") throw new Error("expected diagnostic");
    expect(projected.code).toBe("HIDDEN_PROVIDER_CONTENT_SUPPRESSED");
    expect(JSON.stringify(projected)).not.toContain(forbidden);
  });

  const pathSafeFamilies: readonly {
    readonly name: ProviderEvent["type"];
    readonly event: ProviderEvent;
    readonly redactsContent: boolean;
  }[] = [
    {
      name: "message",
      event: providerEvent({
        type: "message",
        role: "assistant",
        text: `before ${CANONICAL_HOME} middle ${CANONICAL_HOME} after`,
        turnId: "turn-1",
        itemId: "item-1",
      }),
      redactsContent: true,
    },
    {
      name: "message-delta",
      event: messageDelta(`delta ${CANONICAL_HOME}`),
      redactsContent: true,
    },
    {
      name: "plan",
      event: providerEvent({
        type: "plan",
        turnId: "turn-1",
        itemId: "plan-1",
        stepIndex: 0,
        text: `inspect ${CANONICAL_HOME}`,
        status: "running",
      }),
      redactsContent: true,
    },
    {
      name: "activity",
      event: providerEvent({
        type: "activity",
        turnId: "turn-1",
        itemId: "activity-1",
        activity: "command",
        status: `running ${CANONICAL_HOME}`,
        message: `cwd ${CANONICAL_HOME}`,
      }),
      redactsContent: true,
    },
    {
      name: "diff-summary",
      event: providerEvent({
        type: "diff-summary",
        turnId: "turn-1",
        changedFiles: 1,
        additions: 2,
        deletions: 0,
      }),
      redactsContent: false,
    },
    {
      name: "usage",
      event: providerEvent({
        type: "usage",
        turnId: "turn-1",
        inputTokens: 1,
        outputTokens: 2,
        cachedInputTokens: 0,
        totalTokens: 3,
      }),
      redactsContent: false,
    },
    {
      name: "status",
      event: providerEvent({
        type: "status",
        scope: "task",
        status: `working in ${CANONICAL_HOME}`,
        nativeId: "task-1",
      }),
      redactsContent: true,
    },
    {
      name: "request",
      event: providerEvent({
        type: "request",
        request: { kind: "permission", identity },
      }),
      redactsContent: false,
    },
    {
      name: "request-resolved",
      event: providerEvent({ type: "request-resolved", identity }),
      redactsContent: false,
    },
    {
      name: "diagnostic",
      event: diagnosticEvent({
        message: `provider home ${CANONICAL_HOME}`,
        shapeKeys: Object.freeze([`shape-${CANONICAL_HOME}`]),
      }),
      redactsContent: true,
    },
  ];

  it.each(pathSafeFamilies)(
    "removes the raw provider home from every $name projection",
    ({ event, redactsContent }) => {
      const projected = projectIndexedProviderEvent(event);
      const serialized = JSON.stringify(projected);
      expect(serialized).not.toContain(CANONICAL_HOME);
      if (redactsContent) expect(serialized).toContain("[PROVIDER_HOME]");
    },
  );

  const identityCollisionEvents: readonly {
    readonly name: string;
    readonly event: ProviderEvent;
  }[] = [
    {
      name: "task key nativeTaskId",
      event: normalizeProviderEvent(
        {
          type: "message",
          role: "assistant",
          text: "unsafe task identity",
          turnId: "turn-1",
          itemId: "item-1",
        },
        {
          provider: "openai",
          key: createNativeTaskKey("openai", CANONICAL_HOME, `task:${CANONICAL_HOME}`),
          occurredAt: OCCURRED_AT,
        },
      ),
    },
    {
      name: "turnId",
      event: providerEvent({
        type: "message",
        role: "assistant",
        text: "unsafe turn identity",
        turnId: `turn:${CANONICAL_HOME}`,
        itemId: "item-1",
      }),
    },
    {
      name: "itemId",
      event: messageDelta("unsafe item identity", `item:${CANONICAL_HOME}`),
    },
    {
      name: "status nativeId",
      event: providerEvent({
        type: "status",
        scope: "item",
        status: "unsafe native identity",
        nativeId: `native:${CANONICAL_HOME}`,
      }),
    },
    {
      name: "requestId",
      event: providerEvent({
        type: "request",
        request: {
          kind: "command-approval",
          identity: createProviderRequestIdentity({
            ...identity,
            requestId: `request:${CANONICAL_HOME}`,
          }),
        },
      }),
    },
    {
      name: "approvalId",
      event: providerEvent({
        type: "request-resolved",
        identity: createProviderRequestIdentity({
          ...identity,
          approvalId: `approval:${CANONICAL_HOME}`,
        }),
      }),
    },
  ];

  it.each(identityCollisionEvents)("rejects raw home collision in $name", ({ event }) => {
    expectValueFreeTypeError(
      () => projectIndexedProviderEvent(event),
      "provider event could not be safely projected",
      CANONICAL_HOME,
    );
  });

  it("keeps public provider events readable while hashing content injectively", () => {
    const eventWith = (text: string): ProviderEvent => providerEvent({
      type: "message",
      role: "assistant",
      text,
      turnId: "turn-injective",
      itemId: null,
    });
    const rawHome = eventWith(`prefix ${CANONICAL_HOME} suffix`);
    const literalMarker = eventWith("prefix [PROVIDER_HOME] suffix");
    const literalSentinel = eventWith("prefix \ue000 suffix");
    const rawProjection = projectIndexedProviderEvent(rawHome);
    const markerProjection = projectIndexedProviderEvent(literalMarker);
    const sentinelProjection = projectIndexedProviderEvent(literalSentinel);
    if (rawProjection.type !== "message" || markerProjection.type !== "message" ||
      sentinelProjection.type !== "message") {
      throw new Error("expected message projections");
    }

    expect(rawProjection.text).toBe("prefix [PROVIDER_HOME] suffix");
    expect(markerProjection.text).toBe("prefix [PROVIDER_HOME] suffix");
    expect(sentinelProjection.text).toBe("prefix \ue000 suffix");
    for (const projection of [rawProjection, markerProjection, sentinelProjection]) {
      expect(JSON.stringify(projection)).not.toContain(CANONICAL_HOME);
    }
    const replayKeys = [
      providerEventReplayKey(rawHome, 41),
      providerEventReplayKey(literalMarker, 41),
      providerEventReplayKey(literalSentinel, 41),
    ];
    const syntheticItemIds = [
      cachedEventItemId(rawHome, 41),
      cachedEventItemId(literalMarker, 41),
      cachedEventItemId(literalSentinel, 41),
    ];
    expect(new Set(replayKeys).size).toBe(3);
    expect(new Set(syntheticItemIds).size).toBe(3);
    for (const keyValue of [...replayKeys, ...syntheticItemIds]) {
      expect(keyValue).not.toContain(CANONICAL_HOME);
    }
  });

  it("rejects sparse diagnostic shape keys and always projects a dense frozen array", () => {
    const sparseShapeKeys = Array(1) as string[];
    Object.freeze(sparseShapeKeys);
    const dense = diagnosticEvent({ shapeKeys: Object.freeze([]) });
    const sparse = diagnosticEvent({ shapeKeys: sparseShapeKeys });
    const denseProjection = projectIndexedProviderEvent(dense);
    const sparseProjection = projectIndexedProviderEvent(sparse);
    expect(denseProjection.type).toBe("diagnostic");
    expect(sparseProjection.type).toBe("diagnostic");
    if (denseProjection.type !== "diagnostic" || sparseProjection.type !== "diagnostic") {
      throw new Error("expected diagnostic projections");
    }

    expect(denseProjection.code).toBe("SAFE_DIAGNOSTIC");
    expect(sparseProjection.code).toBe("UNKNOWN_PROVIDER_EVENT");
    expect(sparseProjection).not.toEqual(denseProjection);
    expect(Object.isFrozen(sparseProjection.shapeKeys)).toBe(true);
    for (let index = 0; index < sparseProjection.shapeKeys.length; index += 1) {
      expect(Object.prototype.hasOwnProperty.call(sparseProjection.shapeKeys, index)).toBe(true);
    }
    expect(providerEventReplayKey(sparse, 51)).not.toBe(providerEventReplayKey(dense, 51));
  });
});
