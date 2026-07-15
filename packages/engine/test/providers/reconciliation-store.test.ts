import { describe, expect, it } from "vitest";
import { taskLocator } from "../../src/provider-index/identity.js";
import type { ProviderTaskLocator } from "../../src/provider-index/identity.js";
import type {
  ProviderReconciliationState,
  ProviderReconciliationStore,
  ReconciliationLatchInput,
} from "../../src/provider-index/store-types.js";
import { createNativeTaskKey } from "../../src/providers/task-key.js";
import {
  ProviderReconciliationStoreError,
  createAdapterReconciliationStore,
  type AdapterReconciliationStore,
} from "../../src/providers/reconciliation-store.js";

const SESSION = "019f5b78-18c0-7b60-8f0c-6afc120ecd7d";
const OPENAI_HOME = "/tmp/devhub-reconciliation-openai-home";
const ANTHROPIC_HOME = "/tmp/devhub-reconciliation-anthropic-home";
const REVIEWED = "reviewed-fingerprint";
const NATIVE = "native-fingerprint";

const keyFor = (provider: "openai" | "anthropic", home: string, id = SESSION) =>
  createNativeTaskKey(provider, home, id);

const stateFor = (
  locator: ProviderTaskLocator,
  overrides: Partial<ProviderReconciliationState> = {},
): Readonly<ProviderReconciliationState> =>
  Object.freeze({
    locator,
    required: false,
    latchRevision: 0,
    reviewedFingerprint: null,
    nativeFingerprint: null,
    writerEpoch: 0,
    reason: null,
    updatedAt: null,
    ...overrides,
  });

interface Recorded {
  readonly method: "get" | "require" | "acknowledge";
  readonly locator: ProviderTaskLocator;
  readonly args: readonly unknown[];
}

interface FakeOptions {
  readonly throwOn?: ReadonlySet<"get" | "require" | "acknowledge">;
  readonly reject?: boolean;
}

class FakeReconciliationStore implements ProviderReconciliationStore {
  readonly calls: Recorded[] = [];
  private readonly throwOn: ReadonlySet<"get" | "require" | "acknowledge">;
  private readonly reject: boolean;

  constructor(options: FakeOptions = {}) {
    this.throwOn = options.throwOn ?? new Set();
    this.reject = options.reject ?? false;
  }

  getReconciliation(locator: ProviderTaskLocator): Readonly<ProviderReconciliationState> {
    this.calls.push({ method: "get", locator, args: [] });
    if (this.throwOn.has("get")) throw this.fault();
    return stateFor(locator);
  }

  requireReconciliation(
    locator: ProviderTaskLocator,
    input: ReconciliationLatchInput,
  ): Readonly<ProviderReconciliationState> {
    this.calls.push({ method: "require", locator, args: [input] });
    if (this.throwOn.has("require")) throw this.fault();
    return stateFor(locator, {
      required: true,
      latchRevision: 1,
      reviewedFingerprint: input.reviewedFingerprint,
      nativeFingerprint: input.nativeFingerprint,
      writerEpoch: input.writerEpoch,
      reason: input.reason,
      updatedAt: 99,
    });
  }

  acknowledgeReconciliation(
    locator: ProviderTaskLocator,
    expectedLatchRevision: number,
    reviewedFingerprint: string | null,
    observedNativeFingerprint: string | null,
  ): Readonly<ProviderReconciliationState> {
    this.calls.push({
      method: "acknowledge",
      locator,
      args: [expectedLatchRevision, reviewedFingerprint, observedNativeFingerprint],
    });
    if (this.throwOn.has("acknowledge")) throw this.fault();
    return stateFor(locator, {
      required: false,
      latchRevision: expectedLatchRevision,
      reviewedFingerprint,
      nativeFingerprint: observedNativeFingerprint,
      updatedAt: 100,
    });
  }

  private fault(): unknown {
    // A hostile durable store might throw a rich value (e.g. containing paths).
    return this.reject
      ? { message: OPENAI_HOME, secret: SESSION }
      : new Error(`durable failure for ${OPENAI_HOME} ${SESSION}`);
  }
}

const build = (
  options?: FakeOptions,
): { store: AdapterReconciliationStore; fake: FakeReconciliationStore } => {
  const fake = new FakeReconciliationStore(options);
  return { store: createAdapterReconciliationStore(fake), fake };
};

describe("AdapterReconciliationStore (narrow fail-closed durable seam)", () => {
  it("delegates getReconciliation with the exact locator derived from the key", () => {
    const { store, fake } = build();
    const key = keyFor("openai", OPENAI_HOME);
    const snapshot = store.getReconciliation(key);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.method).toBe("get");
    expect(fake.calls[0]!.locator).toEqual(taskLocator(key));
    expect(snapshot).toEqual({
      required: false,
      latchRevision: 0,
      reviewedFingerprint: null,
      nativeFingerprint: null,
      writerEpoch: 0,
      reason: null,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(store.unavailable).toBe(false);
  });

  it("delegates requireReconciliation with the exact minimal latch input", () => {
    const { store, fake } = build();
    const key = keyFor("openai", OPENAI_HOME);
    const snapshot = store.requireReconciliation(key, {
      reviewedFingerprint: REVIEWED,
      nativeFingerprint: NATIVE,
      writerEpoch: 7,
      reason: "NATIVE_REVISION_MISMATCH",
    });
    expect(fake.calls[0]!.method).toBe("require");
    expect(fake.calls[0]!.args[0]).toEqual({
      reviewedFingerprint: REVIEWED,
      nativeFingerprint: NATIVE,
      writerEpoch: 7,
      reason: "NATIVE_REVISION_MISMATCH",
    });
    expect(snapshot.required).toBe(true);
    expect(snapshot.latchRevision).toBe(1);
    expect(snapshot.reason).toBe("NATIVE_REVISION_MISMATCH");
    expect(snapshot.writerEpoch).toBe(7);
  });

  it("delegates acknowledgeReconciliation with the exact CAS arguments", () => {
    const { store, fake } = build();
    const key = keyFor("openai", OPENAI_HOME);
    const snapshot = store.acknowledgeReconciliation(key, 3, REVIEWED, REVIEWED);
    expect(fake.calls[0]!.method).toBe("acknowledge");
    expect(fake.calls[0]!.args).toEqual([3, REVIEWED, REVIEWED]);
    expect(snapshot.required).toBe(false);
    expect(snapshot.latchRevision).toBe(3);
  });

  it("does not persist any field beyond the minimal restart-safe latch set", () => {
    const { store } = build();
    const key = keyFor("openai", OPENAI_HOME);
    const snapshot = store.requireReconciliation(key, {
      reviewedFingerprint: REVIEWED,
      nativeFingerprint: NATIVE,
      writerEpoch: 2,
      reason: "WRITER_LEASE_LOST",
    });
    expect(Object.keys(snapshot).sort()).toEqual([
      "latchRevision",
      "nativeFingerprint",
      "reason",
      "required",
      "reviewedFingerprint",
      "writerEpoch",
    ]);
    // No locator / updatedAt / prompts / events cross the seam.
    expect("locator" in snapshot).toBe(false);
    expect("updatedAt" in snapshot).toBe(false);
  });

  it("rejects an invalid key without calling the delegate and without failing closed", () => {
    const { store, fake } = build();
    const bogus = { provider: "openai", home: OPENAI_HOME } as never;
    expect(() => store.getReconciliation(bogus)).toThrow(ProviderReconciliationStoreError);
    try {
      store.getReconciliation(bogus);
    } catch (error) {
      expect((error as ProviderReconciliationStoreError).code).toBe("INVALID_KEY");
    }
    expect(fake.calls).toHaveLength(0);
    expect(store.unavailable).toBe(false);
    // A valid call still works afterwards.
    expect(() => store.getReconciliation(keyFor("openai", OPENAI_HOME))).not.toThrow();
  });

  it("rejects a malformed latch input as INVALID_KEY without touching the delegate", () => {
    const { store, fake } = build();
    const key = keyFor("openai", OPENAI_HOME);
    expect(() => store.requireReconciliation(key, {
      reviewedFingerprint: REVIEWED,
      nativeFingerprint: NATIVE,
      writerEpoch: -1,
      reason: "WRITER_LEASE_LOST",
    })).toThrow(/invalid/i);
    expect(() => store.requireReconciliation(key, {
      reviewedFingerprint: REVIEWED,
      nativeFingerprint: NATIVE,
      writerEpoch: 1,
      reason: 42 as never,
    })).toThrow(ProviderReconciliationStoreError);
    expect(fake.calls).toHaveLength(0);
    expect(store.unavailable).toBe(false);
  });

  it("fails closed on a getReconciliation store fault and latches every later call", () => {
    const { store, fake } = build({ throwOn: new Set(["get"]) });
    const key = keyFor("openai", OPENAI_HOME);
    let thrown: unknown;
    try {
      store.getReconciliation(key);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderReconciliationStoreError);
    expect((thrown as ProviderReconciliationStoreError).code).toBe("UNAVAILABLE");
    expect(store.unavailable).toBe(true);
    // The delegate saw the one failing call.
    expect(fake.calls).toHaveLength(1);
    // A subsequent require never reaches the delegate: stays UNAVAILABLE.
    expect(() => store.requireReconciliation(key, {
      reviewedFingerprint: REVIEWED,
      nativeFingerprint: NATIVE,
      writerEpoch: 1,
      reason: "WRITER_LEASE_LOST",
    })).toThrow(ProviderReconciliationStoreError);
    expect(fake.calls).toHaveLength(1);
  });

  it("fails closed on a requireReconciliation store fault", () => {
    const { store } = build({ throwOn: new Set(["require"]) });
    const key = keyFor("openai", OPENAI_HOME);
    expect(() => store.requireReconciliation(key, {
      reviewedFingerprint: REVIEWED,
      nativeFingerprint: NATIVE,
      writerEpoch: 1,
      reason: "MUTATION_OUTCOME_UNCERTAIN",
    })).toThrow(ProviderReconciliationStoreError);
    expect(store.unavailable).toBe(true);
  });

  it("fails closed on an acknowledgeReconciliation store fault", () => {
    const { store } = build({ throwOn: new Set(["acknowledge"]) });
    const key = keyFor("openai", OPENAI_HOME);
    expect(() => store.acknowledgeReconciliation(key, 1, REVIEWED, REVIEWED))
      .toThrow(ProviderReconciliationStoreError);
    expect(store.unavailable).toBe(true);
  });

  it("never recovers: a previously healthy key stays UNAVAILABLE after any fault", () => {
    const { store } = build({ throwOn: new Set(["get"]) });
    const key = keyFor("openai", OPENAI_HOME);
    expect(() => store.getReconciliation(key)).toThrow();
    // Same key, many retries, all UNAVAILABLE.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let code: string | undefined;
      try {
        store.getReconciliation(key);
      } catch (error) {
        code = (error as ProviderReconciliationStoreError).code;
      }
      expect(code).toBe("UNAVAILABLE");
    }
  });

  it("emits value-free failures that never leak home paths, ids, or secrets", () => {
    for (const reject of [false, true]) {
      const { store } = build({ throwOn: new Set(["get"]), reject });
      const key = keyFor("openai", OPENAI_HOME);
      try {
        store.getReconciliation(key);
        throw new Error("expected a fail-closed throw");
      } catch (error) {
        const message = (error as Error).message;
        expect(error).toBeInstanceOf(ProviderReconciliationStoreError);
        expect(message).not.toContain(OPENAI_HOME);
        expect(message).not.toContain(SESSION);
        expect(message).toBe("Provider reconciliation store is unavailable");
      }
    }
  });

  it("isolates providers sharing one native task id via distinct locators", () => {
    const { store, fake } = build();
    const openaiKey = keyFor("openai", OPENAI_HOME);
    const anthropicKey = keyFor("anthropic", ANTHROPIC_HOME);
    store.getReconciliation(openaiKey);
    store.getReconciliation(anthropicKey);
    expect(fake.calls[0]!.locator.provider).toBe("openai");
    expect(fake.calls[1]!.locator.provider).toBe("anthropic");
    expect(fake.calls[0]!.locator.homeFingerprint)
      .not.toBe(fake.calls[1]!.locator.homeFingerprint);
    expect(fake.calls[0]!.locator).toEqual(taskLocator(openaiKey));
    expect(fake.calls[1]!.locator).toEqual(taskLocator(anthropicKey));
  });

  it("isolates two homes for the same provider and id", () => {
    const { store, fake } = build();
    store.getReconciliation(keyFor("openai", OPENAI_HOME));
    store.getReconciliation(keyFor("openai", ANTHROPIC_HOME));
    expect(fake.calls[0]!.locator.homeFingerprint)
      .not.toBe(fake.calls[1]!.locator.homeFingerprint);
  });

  it("rejects a store dependency missing required methods", () => {
    expect(() => createAdapterReconciliationStore({} as never))
      .toThrow(ProviderReconciliationStoreError);
    expect(() => createAdapterReconciliationStore({
      getReconciliation: () => undefined,
      requireReconciliation: () => undefined,
    } as never)).toThrow(ProviderReconciliationStoreError);
    try {
      createAdapterReconciliationStore(null as never);
    } catch (error) {
      expect((error as ProviderReconciliationStoreError).code).toBe("STORE_REJECTED");
    }
  });

  it("passes a null-fingerprint acknowledge through unchanged", () => {
    const { store, fake } = build();
    const key = keyFor("openai", OPENAI_HOME);
    const snapshot = store.acknowledgeReconciliation(key, 4, null, null);
    expect(fake.calls[0]!.args).toEqual([4, null, null]);
    expect(snapshot.reviewedFingerprint).toBeNull();
    expect(snapshot.nativeFingerprint).toBeNull();
  });
});
