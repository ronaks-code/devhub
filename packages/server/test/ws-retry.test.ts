/**
 * Unit coverage for the rate-limit AUTO-RETRY wiring in src/ws.ts.
 *
 * The full live-turn retry loop drives a real `claude` CLI (via the engine's
 * `createDriver()`), so it can't run hermetically here — it's exercised by the
 * `wsdelta` smoke against a live server. What we CAN (and must) pin down hermetically
 * is the load-bearing seam: the duck-typed bridge to the engine lane's
 * `engine.computeRetry(...)`, whose return TYPE this package can't import. These tests
 * lock in exactly how that opaque return value is interpreted, and that an absent /
 * throwing policy degrades to "no retry" (i.e. today's behavior is preserved).
 */
import { describe, expect, it } from "vitest";
import { readRetryDecision, resolveComputeRetry } from "../src/ws.js";
import type { Engine } from "@claude-ui/engine";

/** Build a fake Engine carrying just the field(s) the lookup probes. */
const fakeEngine = (props: Record<string, unknown>) => props as unknown as Engine;

describe("readRetryDecision — interpreting the engine policy's opaque return", () => {
  it("treats a truthy `retry` + finite delay as retryable, clamping the delay to an int", () => {
    expect(readRetryDecision({ retry: true, delayMs: 1500 })).toEqual({
      retry: true,
      delayMs: 1500,
    });
    // Floored to an integer of milliseconds.
    expect(readRetryDecision({ retry: true, delayMs: 1500.9 })).toEqual({
      retry: true,
      delayMs: 1500,
    });
  });

  it("accepts the tolerated field spellings (retryable/shouldRetry, delay)", () => {
    expect(readRetryDecision({ retryable: true, delay: 2000 })).toEqual({
      retry: true,
      delayMs: 2000,
    });
    expect(readRetryDecision({ shouldRetry: true, delayMs: 0 })).toEqual({
      retry: true,
      delayMs: 0,
    });
  });

  it("clamps an absurdly large delay to the 10-minute safety ceiling", () => {
    const { retry, delayMs } = readRetryDecision({ retry: true, delayMs: 9_999_999_999 });
    expect(retry).toBe(true);
    expect(delayMs).toBe(10 * 60_000);
  });

  it("reads anything untrusted as NO retry (so a rate-limited turn just ends, as today)", () => {
    // Falsy / missing flag.
    expect(readRetryDecision({ retry: false, delayMs: 1000 }).retry).toBe(false);
    expect(readRetryDecision({ delayMs: 1000 }).retry).toBe(false);
    // A truthy flag but a missing / NaN / negative / non-numeric delay is not trusted.
    expect(readRetryDecision({ retry: true }).retry).toBe(false);
    expect(readRetryDecision({ retry: true, delayMs: NaN }).retry).toBe(false);
    expect(readRetryDecision({ retry: true, delayMs: -5 }).retry).toBe(false);
    expect(readRetryDecision({ retry: true, delayMs: "1000" }).retry).toBe(false);
    // A non-boolean-true flag (e.g. a truthy string) is not "=== true".
    expect(readRetryDecision({ retry: "yes", delayMs: 1000 }).retry).toBe(false);
    // Non-object shapes.
    expect(readRetryDecision(null).retry).toBe(false);
    expect(readRetryDecision(undefined).retry).toBe(false);
    expect(readRetryDecision(true).retry).toBe(false);
    expect(readRetryDecision(42).retry).toBe(false);
  });
});

describe("resolveComputeRetry — the runtime capability guard", () => {
  it("returns undefined when the engine has no computeRetry (=> no auto-retry)", () => {
    expect(resolveComputeRetry(fakeEngine({}))).toBeUndefined();
    // A non-function value on the field is also ignored.
    expect(resolveComputeRetry(fakeEngine({ computeRetry: 123 }))).toBeUndefined();
  });

  it("binds and forwards args when computeRetry is a function", () => {
    const calls: Array<{ self: unknown; args: unknown[] }> = [];
    const engine = fakeEngine({
      marker: "self",
      computeRetry(this: unknown, ...args: unknown[]) {
        calls.push({ self: (this as { marker?: string })?.marker, args });
        return { retry: true, delayMs: 750 };
      },
    });
    const fn = resolveComputeRetry(engine);
    expect(fn).toBeTypeOf("function");
    const out = readRetryDecision(fn!("rate_limit_exceeded", 1, {}));
    expect(out).toEqual({ retry: true, delayMs: 750 });
    // Bound to the engine (so the real method can reach its own state).
    expect(calls).toEqual([{ self: "self", args: ["rate_limit_exceeded", 1, {}] }]);
  });
});
