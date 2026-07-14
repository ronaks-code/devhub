import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNativeTaskKey,
  canonicalizeProviderHome,
  createNativeTaskKey,
  nativeTaskKeyId,
  snapshotNativeTaskKey,
} from "../../src/providers/task-key.js";

describe("native task keys", () => {
  it("canonicalizes the home and freezes provider ownership", () => {
    const home = path.join(process.cwd(), "tmp", "..", "provider-home");
    const key = createNativeTaskKey("openai", home, " task-123 ");

    expect(key).toEqual({
      provider: "openai",
      home: path.resolve(process.cwd(), "provider-home"),
      nativeTaskId: "task-123",
    });
    expect(Object.isFrozen(key)).toBe(true);
    expect(nativeTaskKeyId(key)).toBe(
      `openai\u0000${path.resolve(process.cwd(), "provider-home")}\u0000task-123`,
    );
  });

  it("rejects empty homes and native ids", () => {
    expect(() => canonicalizeProviderHome("   ")).toThrow(/home/i);
    expect(() => createNativeTaskKey("anthropic", "/tmp/claude", "   ")).toThrow(
      /native task id/i,
    );
  });

  it("bounds native ids and rejects control or credential-shaped ownership", () => {
    for (const nativeTaskId of [
      "x".repeat(513),
      "task\ncontrol",
      "sk-proj-0123456789abcdefghijklmnop",
    ]) {
      expect(() => createNativeTaskKey("openai", "/tmp/codex", nativeTaskId))
        .toThrow(/bounded non-sensitive native id/i);
    }
  });

  it("rejects non-canonical or unsupported deserialized keys", () => {
    expect(() =>
      assertNativeTaskKey({
        provider: "anthropic",
        home: "/tmp/a/../claude",
        nativeTaskId: "session-1",
      }),
    ).toThrow(/canonical/i);
    expect(() =>
      assertNativeTaskKey({
        provider: "other",
        home: "/tmp/provider",
        nativeTaskId: "session-1",
      }),
    ).toThrow(/provider/i);
  });

  it("realpaths an existing provider home but only resolves a nonexistent home", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "devhub-provider-home-"));
    try {
      const actual = path.join(root, "actual");
      const link = path.join(root, "linked");
      mkdirSync(actual);
      symlinkSync(actual, link);

      expect(canonicalizeProviderHome(link)).toBe(realpathSync(actual));
      expect(canonicalizeProviderHome(path.join(root, "missing", "..", "future"))).toBe(
        path.resolve(root, "future"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("takes a frozen trust-boundary snapshot before caller-owned keys can mutate", () => {
    const callerKey = {
      provider: "openai" as const,
      home: path.resolve("/tmp/provider-home"),
      nativeTaskId: "task-1",
    };

    const snapshot = snapshotNativeTaskKey(callerKey);
    callerKey.nativeTaskId = "task-2";

    expect(snapshot).toEqual({
      provider: "openai",
      home: path.resolve("/tmp/provider-home"),
      nativeTaskId: "task-1",
    });
    expect(snapshot).not.toBe(callerKey);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});
