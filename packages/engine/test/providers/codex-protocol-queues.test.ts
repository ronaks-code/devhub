import { describe, expect, it, vi } from "vitest";
import {
  CODEX_DEFAULT_INGRESS_LIMITS,
  CODEX_DEFAULT_OUTBOUND_LIMITS,
  BoundedCodexIngressQueue,
  BoundedCodexJsonlWriter,
  CodexProtocolFault,
} from "../../src/providers/codex/protocol/index.js";

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("bounded Codex ingress queue", () => {
  it("publishes the conservative 1024/32 MiB watermarks", () => {
    expect(CODEX_DEFAULT_INGRESS_LIMITS).toEqual({
      maxItems: 1024,
      maxBytes: 32 * 1024 * 1024,
      pauseItems: 768,
      pauseBytes: 24 * 1024 * 1024,
      resumeItems: 512,
      resumeBytes: 16 * 1024 * 1024,
    });
  });

  it("pauses at a high watermark and resumes only below both low watermarks", () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const queue = new BoundedCodexIngressQueue<string>({
      limits: {
        maxItems: 4,
        maxBytes: 40,
        pauseItems: 3,
        pauseBytes: 30,
        resumeItems: 1,
        resumeBytes: 10,
      },
      onPause,
      onResume,
    });

    queue.enqueue("a", 10);
    queue.enqueue("b", 10);
    queue.enqueue("c", 10);
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(queue.paused).toBe(true);
    expect(queue.dequeue()).toEqual({ value: "a", bytes: 10 });
    expect(queue.dequeue()).toEqual({ value: "b", bytes: 10 });
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(queue.paused).toBe(false);
    expect(queue.length).toBe(1);
    expect(queue.byteLength).toBe(10);
  });

  it("rejects count and byte overflows before mutating retained state", () => {
    const byCount = new BoundedCodexIngressQueue<string>({
      limits: {
        maxItems: 1,
        maxBytes: 10,
        pauseItems: 1,
        pauseBytes: 10,
        resumeItems: 0,
        resumeBytes: 0,
      },
    });
    byCount.enqueue("kept", 1);

    expect(() => byCount.enqueue("rejected", 1)).toThrowError(CodexProtocolFault);
    expect(byCount.length).toBe(1);
    expect(byCount.dequeue()?.value).toBe("kept");

    const byBytes = new BoundedCodexIngressQueue<string>({
      limits: {
        maxItems: 2,
        maxBytes: 3,
        pauseItems: 2,
        pauseBytes: 3,
        resumeItems: 0,
        resumeBytes: 0,
      },
    });
    expect(() => byBytes.enqueue("too-big", 4)).toThrow(/3 bytes/i);
    expect(byBytes.byteLength).toBe(0);
  });

  it("pauses and resumes on byte watermarks while item counts stay below item watermarks", () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const queue = new BoundedCodexIngressQueue<string>({
      limits: {
        maxItems: 10,
        maxBytes: 10,
        pauseItems: 9,
        pauseBytes: 6,
        resumeItems: 8,
        resumeBytes: 2,
      },
      onPause,
      onResume,
    });

    queue.enqueue("first", 3);
    queue.enqueue("second", 3);
    expect(queue.length).toBe(2);
    expect(onPause).toHaveBeenCalledOnce();
    expect(queue.paused).toBe(true);

    queue.dequeue();
    expect(queue.byteLength).toBe(3);
    expect(onResume).not.toHaveBeenCalled();
    queue.dequeue();
    expect(onResume).toHaveBeenCalledOnce();
    expect(queue.paused).toBe(false);
  });

  it("rejects ingress byte overflow while the item count remains below its maximum", () => {
    const queue = new BoundedCodexIngressQueue<string>({
      limits: {
        maxItems: 10,
        maxBytes: 5,
        pauseItems: 9,
        pauseBytes: 4,
        resumeItems: 8,
        resumeBytes: 2,
      },
    });
    queue.enqueue("kept", 3);

    expect(() => queue.enqueue("rejected", 3)).toThrow(/5 bytes/i);
    expect(queue.length).toBe(1);
    expect(queue.byteLength).toBe(3);
    expect(queue.dequeue()?.value).toBe("kept");
  });

  it("retains processing bytes against the same cap and watermarks until explicitly released", () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const queue = new BoundedCodexIngressQueue<string>({
      limits: {
        maxItems: 4,
        maxBytes: 6,
        pauseItems: 3,
        pauseBytes: 4,
        resumeItems: 2,
        resumeBytes: 1,
      },
      onPause,
      onResume,
    });
    queue.enqueue("active", 4);
    const active = queue.dequeueRetained();

    expect(active).toEqual({ value: "active", bytes: 4 });
    expect(queue.length).toBe(0);
    expect(queue.byteLength).toBe(4);
    expect(queue.paused).toBe(true);
    expect(() => queue.enqueue("overflow", 3)).toThrow(/6 bytes/i);
    queue.releaseRetained(4);
    expect(queue.byteLength).toBe(0);
    expect(queue.paused).toBe(false);
    expect(onPause).toHaveBeenCalledOnce();
    expect(onResume).toHaveBeenCalledOnce();
  });
});

describe("bounded Codex JSONL writer", () => {
  it("publishes the conservative 1024/32 MiB outbound limits", () => {
    expect(CODEX_DEFAULT_OUTBOUND_LIMITS).toEqual({
      maxItems: 1024,
      maxBytes: 32 * 1024 * 1024,
    });
  });

  it("serializes writes and honors asynchronous transport backpressure", async () => {
    const first = deferred();
    const writes: string[] = [];
    const write = vi.fn(async (chunk: Uint8Array) => {
      writes.push(Buffer.from(chunk).toString("utf8"));
      if (writes.length === 1) await first.promise;
    });
    const writer = new BoundedCodexJsonlWriter(write, {
      maxItems: 3,
      maxBytes: 1024,
    });

    const firstSend = writer.send({ method: "initialized" });
    const secondSend = writer.send({ id: 1, result: { ok: true } });
    await Promise.resolve();
    expect(writes).toEqual(['{"method":"initialized"}\n']);
    expect(writer.length).toBe(2);

    first.resolve();
    await Promise.all([firstSend, secondSend]);
    expect(writes).toEqual([
      '{"method":"initialized"}\n',
      '{"id":1,"result":{"ok":true}}\n',
    ]);
    expect(writer.length).toBe(0);
    expect(writer.byteLength).toBe(0);
  });

  it("rejects overflow without writing or displacing accepted frames", async () => {
    const blocked = deferred();
    const writes: string[] = [];
    const writer = new BoundedCodexJsonlWriter(async (chunk) => {
      writes.push(Buffer.from(chunk).toString("utf8"));
      await blocked.promise;
    }, { maxItems: 1, maxBytes: 1024 });

    const accepted = writer.send({ method: "initialized" });
    await expect(writer.send({ method: "initialized" })).rejects.toMatchObject({
      code: "QUEUE_OVERFLOW",
    });
    expect(writes).toHaveLength(1);

    blocked.resolve();
    await accepted;
    expect(writes).toHaveLength(1);
  });

  it("fails closed on a transport error and never replays an uncertain write", async () => {
    const failure = new Error("pipe closed after partial write");
    const write = vi.fn(async () => {
      throw failure;
    });
    const writer = new BoundedCodexJsonlWriter(write);

    await expect(writer.send({ id: 1, method: "turn/start", params: {} })).rejects.toBe(failure);
    await expect(writer.send({ id: 2, method: "turn/start", params: {} })).rejects.toThrow(
      /closed/i,
    );
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("rejects non-JSON response values before writing an invalid frame", async () => {
    const write = vi.fn(async () => undefined);
    const writer = new BoundedCodexJsonlWriter(write);

    await expect(writer.send({ id: 1, result: undefined })).rejects.toMatchObject({
      code: "INVALID_ENVELOPE",
    });
    await expect(writer.send({ id: 2, result: Number.NaN })).rejects.toMatchObject({
      code: "INVALID_ENVELOPE",
    });
    expect(write).not.toHaveBeenCalled();
    expect(writer.length).toBe(0);
  });

  it("rejects outbound byte overflow while the item count remains below its maximum", async () => {
    const write = vi.fn(async () => undefined);
    const writer = new BoundedCodexJsonlWriter(write, {
      maxItems: 10,
      maxBytes: Buffer.byteLength('{"method":"initialized"}\n') - 1,
    });

    await expect(writer.send({ method: "initialized" })).rejects.toMatchObject({
      code: "QUEUE_OVERFLOW",
    });
    expect(writer.length).toBe(0);
    expect(writer.byteLength).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });
});
