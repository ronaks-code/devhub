import { CodexProtocolFault } from "./fault.js";

export interface CodexIngressLimits {
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly pauseItems: number;
  readonly pauseBytes: number;
  readonly resumeItems: number;
  readonly resumeBytes: number;
}

export const CODEX_DEFAULT_INGRESS_LIMITS: Readonly<CodexIngressLimits> = Object.freeze({
  maxItems: 1024,
  maxBytes: 32 * 1024 * 1024,
  pauseItems: 768,
  pauseBytes: 24 * 1024 * 1024,
  resumeItems: 512,
  resumeBytes: 16 * 1024 * 1024,
});

export interface CodexIngressQueueOptions {
  readonly limits?: CodexIngressLimits;
  readonly onPause?: () => void;
  readonly onResume?: () => void;
}

export interface CodexIngressQueueEntry<T> {
  readonly value: T;
  readonly bytes: number;
}

const assertLimit = (name: string, value: number, allowZero = false): void => {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new RangeError(`${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
};

const assertIngressLimits = (limits: CodexIngressLimits): void => {
  assertLimit("maxItems", limits.maxItems);
  assertLimit("maxBytes", limits.maxBytes);
  assertLimit("pauseItems", limits.pauseItems);
  assertLimit("pauseBytes", limits.pauseBytes);
  assertLimit("resumeItems", limits.resumeItems, true);
  assertLimit("resumeBytes", limits.resumeBytes, true);
  if (limits.resumeItems > limits.pauseItems || limits.pauseItems > limits.maxItems) {
    throw new RangeError("item watermarks must satisfy resume <= pause <= max");
  }
  if (limits.resumeBytes > limits.pauseBytes || limits.pauseBytes > limits.maxBytes) {
    throw new RangeError("byte watermarks must satisfy resume <= pause <= max");
  }
};

export class BoundedCodexIngressQueue<T> {
  readonly limits: Readonly<CodexIngressLimits>;
  private readonly entries: CodexIngressQueueEntry<T>[] = [];
  private readonly onPause?: () => void;
  private readonly onResume?: () => void;
  private retainedBytes = 0;
  private isPaused = false;

  constructor(options: CodexIngressQueueOptions = {}) {
    const limits = options.limits ?? CODEX_DEFAULT_INGRESS_LIMITS;
    assertIngressLimits(limits);
    this.limits = Object.freeze({ ...limits });
    this.onPause = options.onPause;
    this.onResume = options.onResume;
  }

  get length(): number {
    return this.entries.length;
  }

  get byteLength(): number {
    return this.retainedBytes;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  enqueue(value: T, bytes: number): void {
    assertLimit("queue entry bytes", bytes);
    if (this.length + 1 > this.limits.maxItems) {
      throw new CodexProtocolFault(
        "QUEUE_OVERFLOW",
        `Codex ingress queue exceeds ${this.limits.maxItems} items`,
      );
    }
    if (this.retainedBytes + bytes > this.limits.maxBytes) {
      throw new CodexProtocolFault(
        "QUEUE_OVERFLOW",
        `Codex ingress queue exceeds ${this.limits.maxBytes} bytes`,
      );
    }

    this.entries.push(Object.freeze({ value, bytes }));
    this.retainedBytes += bytes;
    if (
      !this.isPaused &&
      (this.length >= this.limits.pauseItems || this.retainedBytes >= this.limits.pauseBytes)
    ) {
      this.isPaused = true;
      this.onPause?.();
    }
  }

  dequeue(): CodexIngressQueueEntry<T> | undefined {
    const entry = this.entries.shift();
    if (!entry) return undefined;
    this.retainedBytes -= entry.bytes;
    this.maybeResume();
    return entry;
  }

  /**
   * Removes the next queued item while retaining its bytes against the shared
   * ingress budget. The caller must release exactly those bytes after all
   * processing which retains the decoded envelope has settled.
   */
  dequeueRetained(): CodexIngressQueueEntry<T> | undefined {
    const entry = this.entries.shift();
    if (!entry) return undefined;
    this.maybeResume();
    return entry;
  }

  releaseRetained(bytes: number): void {
    assertLimit("released queue entry bytes", bytes);
    if (bytes > this.retainedBytes) {
      throw new RangeError("released queue entry bytes exceed retained ingress bytes");
    }
    this.retainedBytes -= bytes;
    this.maybeResume();
  }

  clear(): void {
    for (const entry of this.entries) this.retainedBytes -= entry.bytes;
    this.entries.length = 0;
    this.maybeResume();
  }

  private maybeResume(): void {
    if (
      this.isPaused &&
      this.length <= this.limits.resumeItems &&
      this.retainedBytes <= this.limits.resumeBytes
    ) {
      this.isPaused = false;
      this.onResume?.();
    }
  }
}
