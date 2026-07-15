import { afterEach, describe, expect, it, vi } from "vitest";
import { legacyKeyFor, readCompat, removeCompat, writeCompat } from "./compat-storage";

/**
 * The web unit suite runs in the `node` environment (see vitest.config.ts), so
 * there is no ambient `window`/`localStorage`. Each test installs exactly the
 * storage shape it needs on `globalThis.window` and tears it down after.
 */

interface FakeStore {
  readonly map: Map<string, string>;
  readonly store: Storage;
  readonly calls: { getItem: string[]; setItem: [string, string][]; removeItem: string[] };
}

function makeFakeStore(opts?: {
  throwOnGet?: boolean;
  throwOnSet?: boolean;
  throwOnRemove?: boolean;
  seed?: Record<string, string>;
}): FakeStore {
  const map = new Map<string, string>(Object.entries(opts?.seed ?? {}));
  const calls = { getItem: [] as string[], setItem: [] as [string, string][], removeItem: [] as string[] };
  const store = {
    getItem(key: string): string | null {
      calls.getItem.push(key);
      if (opts?.throwOnGet) throw new DOMException("denied", "SecurityError");
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      calls.setItem.push([key, value]);
      if (opts?.throwOnSet) throw new DOMException("quota", "QuotaExceededError");
      map.set(key, value);
    },
    removeItem(key: string): void {
      calls.removeItem.push(key);
      if (opts?.throwOnRemove) throw new DOMException("denied", "SecurityError");
      map.delete(key);
    },
    clear(): void {
      map.clear();
    },
    key(): string | null {
      return null;
    },
    get length(): number {
      return map.size;
    },
  } as Storage;
  return { map, store, calls };
}

function installStorage(store: Storage | (() => never)): void {
  if (typeof store === "function") {
    // A window whose `localStorage` getter itself throws (sandboxed iframe).
    vi.stubGlobal("window", Object.defineProperty({}, "localStorage", { get: store }));
  } else {
    vi.stubGlobal("window", { localStorage: store });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("legacyKeyFor", () => {
  it("maps the devhub namespace to the exact claude-ui namespace", () => {
    expect(legacyKeyFor("devhub:theme")).toBe("claude-ui:theme");
    expect(legacyKeyFor("devhub:draft:proj|sess")).toBe("claude-ui:draft:proj|sess");
  });

  it("maps the token key", () => {
    expect(legacyKeyFor("devhub-token")).toBe("claude-ui-token");
  });

  it("returns null for a key with no legacy predecessor", () => {
    expect(legacyKeyFor("random-key")).toBeNull();
    expect(legacyKeyFor("claude-ui:theme")).toBeNull();
    expect(legacyKeyFor("")).toBeNull();
  });
});

describe("readCompat", () => {
  it("returns the DevHub value and never consults the legacy key when present", () => {
    const fake = makeFakeStore({ seed: { "devhub:theme": "dark", "claude-ui:theme": "light" } });
    installStorage(fake.store);
    expect(readCompat("devhub:theme")).toBe("dark");
    expect(fake.calls.getItem).not.toContain("claude-ui:theme");
  });

  it("falls back to the legacy value when the DevHub key is empty", () => {
    const fake = makeFakeStore({ seed: { "claude-ui:theme": "light" } });
    installStorage(fake.store);
    expect(readCompat("devhub:theme")).toBe("light");
  });

  it("copies a legacy hit forward to the DevHub key WITHOUT deleting/rewriting legacy", () => {
    const fake = makeFakeStore({ seed: { "claude-ui:theme": "light" } });
    installStorage(fake.store);
    readCompat("devhub:theme");
    expect(fake.map.get("devhub:theme")).toBe("light");
    // Legacy value is untouched (still present, unchanged) and never removed.
    expect(fake.map.get("claude-ui:theme")).toBe("light");
    expect(fake.calls.removeItem).toHaveLength(0);
    // The only setItem was the copy to the DevHub key.
    expect(fake.calls.setItem).toEqual([["devhub:theme", "light"]]);
  });

  it("returns null when neither key holds a value", () => {
    const fake = makeFakeStore();
    installStorage(fake.store);
    expect(readCompat("devhub:theme")).toBeNull();
  });

  it("returns null (no fallback) for an unmapped key", () => {
    const fake = makeFakeStore({ seed: { "claude-ui:theme": "light" } });
    installStorage(fake.store);
    expect(readCompat("no-legacy-key")).toBeNull();
  });

  it("is non-fatal and returns the legacy value even if the forward copy throws (quota)", () => {
    const fake = makeFakeStore({ throwOnSet: true, seed: { "claude-ui:theme": "light" } });
    installStorage(fake.store);
    expect(readCompat("devhub:theme")).toBe("light");
  });

  it("returns null when getItem throws (private mode / disabled)", () => {
    const fake = makeFakeStore({ throwOnGet: true, seed: { "devhub:theme": "dark" } });
    installStorage(fake.store);
    expect(readCompat("devhub:theme")).toBeNull();
  });

  it("returns null under SSR (no window)", () => {
    // No window stubbed → typeof window === "undefined".
    expect(readCompat("devhub:theme")).toBeNull();
  });

  it("returns null when accessing window.localStorage itself throws", () => {
    installStorage(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(readCompat("devhub:theme")).toBeNull();
  });

  it("distinguishes two providers keyed under the same suffix (no collision)", () => {
    const fake = makeFakeStore({
      seed: { "claude-ui:draft:openai|t1": "a", "claude-ui:draft:anthropic|t1": "b" },
    });
    installStorage(fake.store);
    expect(readCompat("devhub:draft:openai|t1")).toBe("a");
    expect(readCompat("devhub:draft:anthropic|t1")).toBe("b");
  });
});

describe("writeCompat", () => {
  it("writes ONLY the DevHub key and never the legacy key", () => {
    const fake = makeFakeStore({ seed: { "claude-ui:theme": "light" } });
    installStorage(fake.store);
    writeCompat("devhub:theme", "dark");
    expect(fake.map.get("devhub:theme")).toBe("dark");
    // Legacy value preserved for rollback; the write did not touch it.
    expect(fake.map.get("claude-ui:theme")).toBe("light");
    expect(fake.calls.setItem).toEqual([["devhub:theme", "dark"]]);
  });

  it("shadows a stale legacy value on the next read", () => {
    const fake = makeFakeStore({ seed: { "claude-ui:theme": "light" } });
    installStorage(fake.store);
    writeCompat("devhub:theme", "dark");
    expect(readCompat("devhub:theme")).toBe("dark");
  });

  it("is non-fatal on a quota error", () => {
    const fake = makeFakeStore({ throwOnSet: true });
    installStorage(fake.store);
    expect(() => writeCompat("devhub:theme", "dark")).not.toThrow();
  });

  it("is a no-op under SSR", () => {
    expect(() => writeCompat("devhub:theme", "dark")).not.toThrow();
  });
});

describe("removeCompat", () => {
  it("clears BOTH the DevHub key and the legacy key so a read cannot resurrect it", () => {
    const fake = makeFakeStore({ seed: { "devhub-token": "t", "claude-ui-token": "old" } });
    installStorage(fake.store);
    removeCompat("devhub-token");
    expect(fake.map.has("devhub-token")).toBe(false);
    expect(fake.map.has("claude-ui-token")).toBe(false);
    expect(readCompat("devhub-token")).toBeNull();
  });

  it("only clears the DevHub key for an unmapped key", () => {
    const fake = makeFakeStore({ seed: { "no-legacy-key": "v" } });
    installStorage(fake.store);
    removeCompat("no-legacy-key");
    expect(fake.calls.removeItem).toEqual(["no-legacy-key"]);
  });

  it("is non-fatal when removeItem throws", () => {
    const fake = makeFakeStore({ throwOnRemove: true, seed: { "devhub-token": "t" } });
    installStorage(fake.store);
    expect(() => removeCompat("devhub-token")).not.toThrow();
  });

  it("is a no-op under SSR", () => {
    expect(() => removeCompat("devhub-token")).not.toThrow();
  });
});

describe("token migration end to end", () => {
  it("reads a legacy token, migrates it, then a logout removal clears both", () => {
    const fake = makeFakeStore({ seed: { "claude-ui-token": "secret" } });
    installStorage(fake.store);
    // First read migrates the legacy token onto the DevHub key.
    expect(readCompat("devhub-token")).toBe("secret");
    expect(fake.map.get("devhub-token")).toBe("secret");
    expect(fake.map.get("claude-ui-token")).toBe("secret");
    // Logout clears both so the token cannot come back.
    removeCompat("devhub-token");
    expect(readCompat("devhub-token")).toBeNull();
  });
});
