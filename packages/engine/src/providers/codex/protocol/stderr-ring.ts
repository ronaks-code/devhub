import { StringDecoder } from "node:string_decoder";

export const CODEX_DEFAULT_STDERR_RING_BYTES = 4 * 1024 * 1024;

export interface RedactedCodexStderrRingOptions {
  readonly maxBytes?: number;
}

const REDACTION = "[REDACTED]";
const OVERSIZED_LINE_MARKER = "[stderr line omitted]\n";
const STDERR_SEGMENT_BYTES = 64 * 1024;

interface StderrSegment {
  readonly storage: Buffer;
  start: number;
  end: number;
}

const redactSecrets = (value: string): string => value
  .replace(
    /^(\s*(?:(?:proxy-)?authorization|(?:set-)?cookie)\s*:\s*)[^\r\n]*/gim,
    `$1${REDACTION}`,
  )
  .replace(
    /("(?:(?:proxy-)?authorization|(?:set-)?cookie)"\s*:\s*")(?:\\.|[^"\\])*"/gi,
    `$1${REDACTION}"`,
  )
  .replace(
    /("(?:api[_-]?key|key|token|secret|password)"\s*:\s*")[^"]+"/gi,
    `$1${REDACTION}"`,
  )
  .replace(
    /([?&](?:access_token|api_key|key|token|secret|password)=)[^&\s]+/gi,
    `$1${REDACTION}`,
  )
  .replace(
    /\b((?:proxy-)?authorization|(?:set-)?cookie)(\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^\r\n,}]+)/gi,
    `$1$2${REDACTION}`,
  )
  .replace(
    /\b((?:[A-Za-z][A-Za-z0-9_]*)?(?:API_KEY|KEY|TOKEN|SECRET|PASSWORD))\s*[:=]\s*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s"'`,;&]+)/gi,
    `$1=${REDACTION}`,
  )
  .replace(/\bBearer\s+[^\s"'`,;]+/gi, `Bearer ${REDACTION}`)
  .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, REDACTION);

const newestUtf8Suffix = (value: string, maxBytes: number): string => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let offset = bytes.length - maxBytes;
  while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset += 1;
  return bytes.subarray(offset).toString("utf8");
};

/**
 * Bounded stderr diagnostics. Complete lines are redacted before retention;
 * the one incomplete line is redacted on read so secrets split across chunks
 * never leave this class. Oversized unterminated lines are omitted wholesale.
 */
export class RedactedCodexStderrRing {
  readonly maxBytes: number;
  private readonly decoder = new StringDecoder("utf8");
  private readonly committed: StderrSegment[] = [];
  private readonly segmentBytes: number;
  private committedBytes = 0;
  private pendingLine = "";
  private discardingOversizedLine = false;

  constructor(options: RedactedCodexStderrRingOptions = {}) {
    const maxBytes = options.maxBytes ?? CODEX_DEFAULT_STDERR_RING_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError("maxBytes must be a positive safe integer");
    }
    this.maxBytes = maxBytes;
    this.segmentBytes = Math.min(maxBytes, STDERR_SEGMENT_BYTES);
  }

  get byteLength(): number {
    return Buffer.byteLength(this.snapshot(), "utf8");
  }

  /** Diagnostic allocation bound used by protocol regression tests. */
  get retainedSegments(): number {
    return this.committed.length;
  }

  /** Total backing-buffer capacity retained by the bounded segment deque. */
  get retainedCapacityBytes(): number {
    return this.committed.reduce((total, { storage }) => total + storage.length, 0);
  }

  append(chunk: string | Uint8Array): void {
    let decoded = this.decoder.write(
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk),
    );
    if (decoded.length === 0) return;

    if (this.discardingOversizedLine) {
      const newline = decoded.indexOf("\n");
      if (newline === -1) return;
      this.discardingOversizedLine = false;
      decoded = decoded.slice(newline + 1);
    }

    let value = this.pendingLine + decoded;
    let newline = value.indexOf("\n");
    while (newline !== -1) {
      this.appendCommitted(redactSecrets(value.slice(0, newline + 1)));
      value = value.slice(newline + 1);
      newline = value.indexOf("\n");
    }
    this.pendingLine = value;

    const pendingBytes = Buffer.byteLength(this.pendingLine, "utf8");
    if (pendingBytes > this.maxBytes) {
      this.pendingLine = "";
      this.discardingOversizedLine = true;
      this.appendCommitted(OVERSIZED_LINE_MARKER);
      return;
    }
    this.trimCommitted(this.maxBytes - pendingBytes);
  }

  snapshot(): string {
    const pending = Buffer.from(redactSecrets(this.pendingLine), "utf8");
    const committed = this.committed.length === 0
      ? Buffer.alloc(0)
      : Buffer.concat(
        this.committed.map(({ storage, start, end }) => storage.subarray(start, end)),
        this.committedBytes,
      );
    return newestUtf8Suffix(Buffer.concat([committed, pending]).toString("utf8"), this.maxBytes);
  }

  private appendCommitted(value: string): void {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length === 0) return;
    let offset = 0;
    while (offset < bytes.length) {
      let tail = this.committed.at(-1);
      if (!tail || tail.end === tail.storage.length) {
        const storage = Buffer.allocUnsafe(this.segmentBytes);
        tail = { storage, start: 0, end: 0 };
        this.committed.push(tail);
      }
      const copied = Math.min(tail.storage.length - tail.end, bytes.length - offset);
      bytes.copy(tail.storage, tail.end, offset, offset + copied);
      tail.end += copied;
      offset += copied;
      this.committedBytes += copied;
      this.trimCommitted(this.maxBytes);
    }
  }

  private trimCommitted(maxBytes: number): void {
    while (this.committedBytes > maxBytes && this.committed.length > 0) {
      const first = this.committed[0]!;
      const excess = this.committedBytes - maxBytes;
      const retained = first.end - first.start;
      if (retained <= excess) {
        this.committed.shift();
        this.committedBytes -= retained;
        continue;
      }
      let offset = first.start + excess;
      while (
        offset < first.end &&
        (first.storage[offset]! & 0xc0) === 0x80
      ) offset += 1;
      this.committedBytes -= offset - first.start;
      first.start = offset;
    }
    this.dropLeadingUtf8Continuations();
  }

  private dropLeadingUtf8Continuations(): void {
    while (this.committed.length > 0) {
      const first = this.committed[0]!;
      while (
        first.start < first.end &&
        (first.storage[first.start]! & 0xc0) === 0x80
      ) {
        first.start += 1;
        this.committedBytes -= 1;
      }
      if (first.start < first.end) return;
      this.committed.shift();
    }
  }
}
