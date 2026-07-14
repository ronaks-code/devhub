import { parseCodexEnvelope, type CodexRpcEnvelope } from "./envelope.js";
import { CodexProtocolFault } from "./fault.js";
import { CODEX_DEFAULT_MAX_LINE_BYTES } from "./jsonl-decoder.js";

export interface CodexOutboundLimits {
  readonly maxItems: number;
  readonly maxBytes: number;
}

export const CODEX_DEFAULT_OUTBOUND_LIMITS: Readonly<CodexOutboundLimits> = Object.freeze({
  maxItems: 1024,
  maxBytes: 32 * 1024 * 1024,
});

export type CodexAsyncWrite = (chunk: Uint8Array) => Promise<void>;

interface OutboundEntry {
  readonly bytes: Buffer;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  settled: boolean;
}

const createEntry = (bytes: Buffer): OutboundEntry => {
  let resolvePromise!: () => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    bytes,
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    settled: false,
  };
};

const assertOutboundLimits = (limits: CodexOutboundLimits): void => {
  if (!Number.isSafeInteger(limits.maxItems) || limits.maxItems < 1) {
    throw new RangeError("maxItems must be a positive safe integer");
  }
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
};

const encodeEnvelope = (envelope: CodexRpcEnvelope): Buffer => {
  try {
    const checked = parseCodexEnvelope(envelope);
    const json = JSON.stringify(checked, (_key, value: unknown) => {
      if (
        value === undefined ||
        typeof value === "function" ||
        typeof value === "symbol" ||
        typeof value === "bigint" ||
        (typeof value === "number" && !Number.isFinite(value))
      ) {
        throw new TypeError("Codex RPC envelope contains a non-JSON value");
      }
      return value;
    });
    if (json === undefined) throw new TypeError("Codex RPC envelope is not JSON serializable");
    parseCodexEnvelope(JSON.parse(json));
    return Buffer.from(`${json}\n`, "utf8");
  } catch (error) {
    if (error instanceof CodexProtocolFault) throw error;
    throw new CodexProtocolFault(
      "INVALID_ENVELOPE",
      "Codex RPC envelope must contain only JSON values",
      { cause: error },
    );
  }
};

export class BoundedCodexJsonlWriter {
  readonly limits: Readonly<CodexOutboundLimits>;
  readonly maxLineBytes: number;
  private readonly write: CodexAsyncWrite;
  private readonly entries: OutboundEntry[] = [];
  private readonly idleWaiters = new Set<() => void>();
  private active: OutboundEntry | null = null;
  private retainedItems = 0;
  private retainedBytes = 0;
  private draining = false;
  private closedReason: CodexProtocolFault | null = null;

  constructor(
    write: CodexAsyncWrite,
    limits: CodexOutboundLimits = CODEX_DEFAULT_OUTBOUND_LIMITS,
    maxLineBytes = CODEX_DEFAULT_MAX_LINE_BYTES,
  ) {
    assertOutboundLimits(limits);
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new RangeError("maxLineBytes must be a positive safe integer");
    }
    this.write = write;
    this.limits = Object.freeze({ ...limits });
    this.maxLineBytes = maxLineBytes;
  }

  get length(): number {
    return this.retainedItems;
  }

  get byteLength(): number {
    return this.retainedBytes;
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  send(envelope: CodexRpcEnvelope): Promise<void> {
    if (this.closedReason) return Promise.reject(this.closedReason);

    let bytes: Buffer;
    try {
      bytes = encodeEnvelope(envelope);
    } catch (error) {
      return Promise.reject(error);
    }
    const lineBytes = bytes.length - 1;
    if (lineBytes > this.maxLineBytes) {
      return Promise.reject(new CodexProtocolFault(
        "LINE_TOO_LARGE",
        `Codex outbound JSONL line exceeds ${this.maxLineBytes} bytes`,
      ));
    }
    if (this.retainedItems + 1 > this.limits.maxItems) {
      return Promise.reject(new CodexProtocolFault(
        "QUEUE_OVERFLOW",
        `Codex outbound queue exceeds ${this.limits.maxItems} items`,
      ));
    }
    if (this.retainedBytes + bytes.length > this.limits.maxBytes) {
      return Promise.reject(new CodexProtocolFault(
        "QUEUE_OVERFLOW",
        `Codex outbound queue exceeds ${this.limits.maxBytes} bytes`,
      ));
    }

    const entry = createEntry(bytes);
    this.entries.push(entry);
    this.retainedItems += 1;
    this.retainedBytes += bytes.length;
    void this.drain();
    return entry.promise;
  }

  close(cause?: unknown): void {
    if (this.closedReason) return;
    this.closedReason = cause instanceof CodexProtocolFault
      ? cause
      : new CodexProtocolFault("PEER_CLOSED", "Codex JSONL writer is closed", { cause });
    if (this.active) this.finish(this.active, this.closedReason);
    for (const entry of this.entries.splice(0)) this.finish(entry, this.closedReason);
    this.resolveIdleIfNeeded();
  }

  idle(): Promise<void> {
    if (this.retainedItems === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  private async drain(): Promise<void> {
    if (this.draining || this.closedReason) return;
    this.draining = true;
    try {
      while (!this.closedReason) {
        const entry = this.entries.shift();
        if (!entry) break;
        this.active = entry;
        try {
          await this.write(entry.bytes);
          this.finish(entry);
        } catch (error) {
          this.finish(entry, error);
          this.close(error);
        } finally {
          if (this.active === entry) this.active = null;
        }
      }
    } finally {
      this.draining = false;
      this.resolveIdleIfNeeded();
    }
  }

  private finish(entry: OutboundEntry, error?: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    this.retainedItems -= 1;
    this.retainedBytes -= entry.bytes.length;
    if (error === undefined) entry.resolve();
    else entry.reject(error);
  }

  private resolveIdleIfNeeded(): void {
    if (this.retainedItems !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
