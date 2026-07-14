import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  normalizeProviderIndexListOptions,
  parseProviderIndexCursor,
  serializeProviderIndexCursor,
  type ProviderIndexCursorPosition,
  type ProviderIndexListScope,
} from "../../src/provider-index/cursor.js";
import * as providersIndex from "../../src/providers/index.js";

const OPENAI_HOME = "a".repeat(64);
const ANTHROPIC_HOME = "b".repeat(64);
const CURSOR_HASH_DOMAIN = "devhub-provider-index-cursor-v1\0";

function checksumForJson(json: string): string {
  return createHash("sha256")
    .update(`${CURSOR_HASH_DOMAIN}${json}`, "utf8")
    .digest("hex");
}

function cursorWithValidChecksum(json: string): string {
  const payload = Buffer.from(json, "utf8").toString("base64url");
  return `pi1.${payload}.${checksumForJson(json)}`;
}

function cursorWithEncodedPayload(payload: string, decodedJson: string): string {
  return `pi1.${payload}.${checksumForJson(decodedJson)}`;
}

function cursorWithLossyUtf8(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  return cursorWithEncodedPayload(buffer.toString("base64url"), buffer.toString("utf8"));
}

const scope = (overrides: Partial<ProviderIndexListScope> = {}): ProviderIndexListScope => ({
  provider: "openai",
  homeFingerprint: OPENAI_HOME,
  includeArchived: false,
  ...overrides,
});

const position = (
  overrides: Partial<ProviderIndexCursorPosition> = {},
): ProviderIndexCursorPosition => ({
  updatedAt: "2026-07-13T20:24:37.000Z",
  provider: "openai",
  homeFingerprint: OPENAI_HOME,
  nativeTaskId: "任务/🧪",
  ...overrides,
});

describe("provider index cursors", () => {
  it("round-trips the complete stable sort tuple and exact scope", () => {
    const encoded = serializeProviderIndexCursor(scope(), position());
    expect(encoded).toMatch(/^pi1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/u);
    expect(parseProviderIndexCursor(encoded, scope())).toEqual(position());
  });

  it("keeps the public pi1 wire encoding byte-stable", () => {
    const expected = [
      "pi1.WzEsIm9wZW5haSIsImFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh",
      "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLDAsIjIwMjYt",
      "MDctMTNUMjA6MjQ6MzcuMDAwWiIsIm9wZW5haSIsImFhYWFhYWFhYWFhYWFh",
      "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh",
      "YWFhYWEiLCLku7vliqEv8J-nqiJd.37783b04c1159b201e4fc3e04ac0783",
      "d1cd6d26faae2b1eb7676b78b4598cdc6",
    ].join("");
    expect(serializeProviderIndexCursor(scope(), position())).toBe(expected);
    expect(parseProviderIndexCursor(expected, scope())).toEqual(position());
  });

  it("is deterministic, opaque, bounded, and frozen", () => {
    const encoded = serializeProviderIndexCursor(scope(), position());
    expect(encoded).toBe(serializeProviderIndexCursor(scope(), position()));
    expect(encoded.length).toBeLessThanOrEqual(2_048);
    expect(encoded).not.toContain("任务");

    const parsed = parseProviderIndexCursor(encoded, scope());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(providersIndex.serializeProviderIndexCursor).toBe(serializeProviderIndexCursor);
  });

  it("supports a null updatedAt position and cross-home provider scope", () => {
    const broad = scope({ homeFingerprint: null, includeArchived: true });
    const last = position({ updatedAt: null, homeFingerprint: ANTHROPIC_HOME });
    expect(parseProviderIndexCursor(serializeProviderIndexCursor(broad, last), broad)).toEqual(last);
  });

  it("supports the unscoped all-provider list", () => {
    const all = scope({ provider: null, homeFingerprint: null });
    const last = position({ provider: "anthropic", homeFingerprint: ANTHROPIC_HOME });
    expect(parseProviderIndexCursor(serializeProviderIndexCursor(all, last), all)).toEqual(last);
  });

  it("rejects cursor reuse under any different scope", () => {
    const encoded = serializeProviderIndexCursor(scope(), position());
    for (const other of [
      scope({ includeArchived: true }),
      scope({ homeFingerprint: null }),
      scope({ provider: "anthropic", homeFingerprint: ANTHROPIC_HOME }),
      scope({ provider: null, homeFingerprint: null }),
    ]) {
      expect(() => parseProviderIndexCursor(encoded, other)).toThrow(
        "provider index cursor is invalid",
      );
    }
  });

  it("rejects a position outside its declared provider or home scope", () => {
    expect(() => serializeProviderIndexCursor(
      scope(),
      position({ provider: "anthropic", homeFingerprint: ANTHROPIC_HOME }),
    )).toThrow("provider index cursor is invalid");
    expect(() => serializeProviderIndexCursor(
      scope(),
      position({ homeFingerprint: ANTHROPIC_HOME }),
    )).toThrow("provider index cursor is invalid");
  });

  it.each([
    "",
    "pi2.payload." + "a".repeat(64),
    "PI1.payload." + "a".repeat(64),
    "pi1.only-two",
    "pi1.too.many.parts",
    "pi1.***." + "a".repeat(64),
    "pi1.e30=." + "a".repeat(64),
    "pi1.e30." + "A".repeat(64),
    " pi1.e30." + "a".repeat(64),
    "pi1.e30." + "a".repeat(64) + "\n",
    "x".repeat(2_049),
  ])("rejects a malformed/noncanonical cursor %#", (value) => {
    expect(() => parseProviderIndexCursor(value, scope())).toThrow(
      "provider index cursor is invalid",
    );
  });

  it("rejects payload and checksum tampering", () => {
    const encoded = serializeProviderIndexCursor(scope(), position());
    const [prefix, payload, checksum] = encoded.split(".") as [string, string, string];
    const changedPayload = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`;
    const changedChecksum = `${checksum.slice(0, -1)}${checksum.endsWith("a") ? "b" : "a"}`;

    expect(() => parseProviderIndexCursor(
      `${prefix}.${changedPayload}.${checksum}`,
      scope(),
    )).toThrow("provider index cursor is invalid");
    expect(() => parseProviderIndexCursor(
      `${prefix}.${payload}.${changedChecksum}`,
      scope(),
    )).toThrow("provider index cursor is invalid");
  });

  it.each([
    "[",
    "{}",
    JSON.stringify([
      2, "openai", OPENAI_HOME, 0, "2026-07-13T20:24:37.000Z",
      "openai", OPENAI_HOME, "task-1",
    ]),
    JSON.stringify([
      1, "openai", OPENAI_HOME, 2, "2026-07-13T20:24:37.000Z",
      "openai", OPENAI_HOME, "task-1",
    ]),
    JSON.stringify([
      1, "openai", OPENAI_HOME, 0, "2026-07-13T20:24:37Z",
      "openai", OPENAI_HOME, "task-1",
    ]),
    JSON.stringify([
      1, null, OPENAI_HOME, 0, "2026-07-13T20:24:37.000Z",
      "openai", OPENAI_HOME, "task-1",
    ]),
    JSON.stringify([
      1, "openai", OPENAI_HOME, 0, "2026-07-13T20:24:37.000Z",
      "anthropic", ANTHROPIC_HOME, "task-1",
    ]),
    JSON.stringify([
      1, "other", OPENAI_HOME, 0, "2026-07-13T20:24:37.000Z",
      "openai", OPENAI_HOME, "task-1",
    ]),
    JSON.stringify([
      1, "openai", "A".repeat(64), 0, "2026-07-13T20:24:37.000Z",
      "openai", OPENAI_HOME, "task-1",
    ]),
    JSON.stringify([
      1, "openai", OPENAI_HOME, 0, "2026-07-13T20:24:37.000Z",
      "openai", OPENAI_HOME, " task-1 ",
    ]),
    `${JSON.stringify([
      1, "openai", OPENAI_HOME, 0, "2026-07-13T20:24:37.000Z",
      "openai", OPENAI_HOME, "task-1",
    ])} `,
    `[1,"openai","${OPENAI_HOME}",0,"2026-07-13T20:24:37.000Z",` +
      `"openai","${OPENAI_HOME}","task\\u002d1"]`,
    JSON.stringify([
      1, "openai", OPENAI_HOME, 0, "2026-07-13T20:24:37.000Z",
      "openai", OPENAI_HOME, "task-1", "extra",
    ]),
  ])("rejects malformed or noncanonical payloads with a valid checksum %#", (json) => {
    expect(() => parseProviderIndexCursor(cursorWithValidChecksum(json), scope())).toThrow(
      "provider index cursor is invalid",
    );
  });

  it("rejects lossy UTF-8 and noncanonical base64url even with matching checksums", () => {
    expect(() => parseProviderIndexCursor(
      cursorWithLossyUtf8(Uint8Array.from([0xff, 0xfe, 0xfd])),
      scope(),
    )).toThrow("provider index cursor is invalid");
    expect(() => parseProviderIndexCursor(
      cursorWithEncodedPayload("e31", "{}"),
      scope(),
    )).toThrow("provider index cursor is invalid");
  });

  it.each([
    position({ updatedAt: "2026-07-13T20:24:37Z" }),
    position({ updatedAt: "not-a-time" }),
    position({ provider: "other" as "openai" }),
    position({ homeFingerprint: "A".repeat(64) }),
    position({ homeFingerprint: "a".repeat(63) }),
    position({ nativeTaskId: " task " }),
    position({ nativeTaskId: "\ud800" }),
    position({ nativeTaskId: "x".repeat(513) }),
  ])("rejects an invalid cursor position %#", (last) => {
    expect(() => serializeProviderIndexCursor(
      scope({ provider: null, homeFingerprint: null }),
      last,
    )).toThrow("provider index cursor is invalid");
  });
});

describe("provider index list option normalization", () => {
  it("applies bounded defaults and returns immutable snapshots", () => {
    const normalized = normalizeProviderIndexListOptions({});
    expect(normalized).toEqual({
      scope: { provider: null, homeFingerprint: null, includeArchived: false },
      limit: 50,
      position: null,
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.scope)).toBe(true);
  });

  it("normalizes a scoped cursor and enforces its exact scope", () => {
    const exactScope = scope();
    const cursor = serializeProviderIndexCursor(exactScope, position());
    expect(normalizeProviderIndexListOptions({
      provider: "openai",
      homeFingerprint: OPENAI_HOME,
      includeArchived: false,
      limit: 200,
      cursor,
    })).toEqual({ scope: exactScope, limit: 200, position: position() });

    expect(() => normalizeProviderIndexListOptions({
      provider: "openai",
      homeFingerprint: OPENAI_HOME,
      includeArchived: true,
      cursor,
    })).toThrow("provider index list options are invalid");
  });

  it.each([
    { provider: undefined },
    { homeFingerprint: undefined },
    { includeArchived: undefined },
    { limit: undefined },
    { cursor: undefined },
  ])("treats an explicitly undefined optional field as omitted: %#", (input) => {
    expect(normalizeProviderIndexListOptions(input)).toEqual({
      scope: { provider: null, homeFingerprint: null, includeArchived: false },
      limit: 50,
      position: null,
    });
  });

  it("treats undefined option fields as omitted when mixed with a valid scope", () => {
    expect(normalizeProviderIndexListOptions({
      provider: "openai",
      homeFingerprint: OPENAI_HOME,
      includeArchived: undefined,
      limit: undefined,
      cursor: undefined,
    })).toEqual({
      scope: { provider: "openai", homeFingerprint: OPENAI_HOME, includeArchived: false },
      limit: 50,
      position: null,
    });
  });

  it.each([0, -1, 1.5, 201, Number.MAX_SAFE_INTEGER])(
    "rejects an invalid limit %s",
    (limit) => {
      expect(() => normalizeProviderIndexListOptions({ limit })).toThrow(
        "provider index list options are invalid",
      );
    },
  );

  it.each([
    { provider: "other" },
    { provider: null, homeFingerprint: OPENAI_HOME },
    { provider: "openai", homeFingerprint: "A".repeat(64) },
    { includeArchived: "yes" },
    { cursor: 7 },
    { extra: true },
  ])("rejects malformed option object %#", (input) => {
    expect(() => normalizeProviderIndexListOptions(input as never)).toThrow(
      "provider index list options are invalid",
    );
  });

  it("rejects inherited/accessor/proxy option fields without leaking values", () => {
    const inherited = Object.create({ provider: "openai" }) as Record<string, unknown>;
    const accessor = Object.defineProperty({}, "provider", {
      enumerable: true,
      get() {
        throw new Error("cursor-option-secret");
      },
    });
    const proxied = new Proxy({}, {
      ownKeys() {
        throw new Error("cursor-proxy-secret");
      },
    });

    for (const input of [inherited, accessor, proxied]) {
      let thrown: unknown;
      try {
        normalizeProviderIndexListOptions(input as never);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      expect(String(thrown)).toBe("TypeError: provider index list options are invalid");
      expect(String(thrown)).not.toMatch(/secret/u);
    }
  });
});
