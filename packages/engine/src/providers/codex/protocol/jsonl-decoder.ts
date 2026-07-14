import { CodexProtocolFault } from "./fault.js";
import { parseCodexEnvelope, type CodexRpcEnvelope } from "./envelope.js";

export const CODEX_DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;

export interface CodexJsonlDecoderOptions {
  readonly maxLineBytes?: number;
}

export interface DecodedCodexEnvelope {
  readonly envelope: CodexRpcEnvelope;
  readonly lineBytes: number;
  readonly frameBytes: number;
}

const EMPTY_BUFFER = Buffer.alloc(0);

export class CodexJsonlDecoder {
  readonly maxLineBytes: number;
  private buffered = EMPTY_BUFFER;
  private fault: CodexProtocolFault | null = null;
  private finished = false;

  constructor(options: CodexJsonlDecoderOptions = {}) {
    const maxLineBytes = options.maxLineBytes ?? CODEX_DEFAULT_MAX_LINE_BYTES;
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new RangeError("maxLineBytes must be a positive safe integer");
    }
    this.maxLineBytes = maxLineBytes;
  }

  get bufferedBytes(): number {
    return this.buffered.length;
  }

  push(
    chunk: string | Uint8Array,
    onEnvelope?: (decoded: DecodedCodexEnvelope) => void,
  ): readonly DecodedCodexEnvelope[] {
    if (this.fault) {
      throw new CodexProtocolFault(
        "DECODER_FAULTED",
        `Codex JSONL decoder is faulted after ${this.fault.code}`,
        { cause: this.fault },
      );
    }
    if (this.finished) {
      throw new CodexProtocolFault(
        "DECODER_FINISHED",
        "Codex JSONL decoder is finished after EOF",
      );
    }

    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    const decoded: DecodedCodexEnvelope[] = [];
    let offset = 0;

    try {
      while (offset < bytes.length) {
        const newline = bytes.indexOf(0x0a, offset);
        if (newline === -1) {
          this.appendPartial(bytes.subarray(offset));
          break;
        }

        const segment = bytes.subarray(offset, newline);
        this.assertWithinLineBound(this.buffered.length + segment.length);
        let line = this.buffered.length === 0
          ? segment
          : Buffer.concat([this.buffered, segment], this.buffered.length + segment.length);
        this.buffered = EMPTY_BUFFER;
        const frameBytes = line.length + 1;
        if (line.at(-1) === 0x0d) line = line.subarray(0, -1);

        const item = this.decodeLine(line, frameBytes);
        if (onEnvelope) onEnvelope(item);
        else decoded.push(item);
        offset = newline + 1;
      }
    } catch (error) {
      const protocolFault = error instanceof CodexProtocolFault
        ? error
        : new CodexProtocolFault("MALFORMED_JSON", "Malformed Codex JSONL input", {
          cause: error,
        });
      this.buffered = EMPTY_BUFFER;
      this.fault = protocolFault;
      throw protocolFault;
    }

    return decoded;
  }

  finish(): void {
    if (this.fault) {
      throw new CodexProtocolFault(
        "DECODER_FAULTED",
        `Codex JSONL decoder is faulted after ${this.fault.code}`,
        { cause: this.fault },
      );
    }
    if (this.finished) return;
    this.finished = true;
    if (this.buffered.length === 0) return;

    const truncatedBytes = this.buffered.length;
    this.buffered = EMPTY_BUFFER;
    this.fault = new CodexProtocolFault(
      "TRUNCATED_FRAME",
      `Codex stdout ended with a truncated ${truncatedBytes}-byte JSONL frame`,
    );
    throw this.fault;
  }

  private appendPartial(segment: Buffer): void {
    this.assertWithinLineBound(this.buffered.length + segment.length);
    if (segment.length === 0) return;
    this.buffered = this.buffered.length === 0
      ? Buffer.from(segment)
      : Buffer.concat([this.buffered, segment], this.buffered.length + segment.length);
  }

  private assertWithinLineBound(bytes: number): void {
    if (bytes > this.maxLineBytes) {
      throw new CodexProtocolFault(
        "LINE_TOO_LARGE",
        `Codex JSONL line exceeds ${this.maxLineBytes} bytes`,
      );
    }
  }

  private decodeLine(line: Buffer, frameBytes: number): DecodedCodexEnvelope {
    if (line.length === 0) {
      throw new CodexProtocolFault("MALFORMED_JSON", "Empty Codex JSONL line");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    } catch (error) {
      throw new CodexProtocolFault("MALFORMED_JSON", "Invalid UTF-8 in Codex JSONL line", {
        cause: error,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new CodexProtocolFault("MALFORMED_JSON", "Malformed JSON in Codex JSONL line", {
        cause: error,
      });
    }
    return Object.freeze({
      envelope: parseCodexEnvelope(parsed),
      lineBytes: line.length,
      frameBytes,
    });
  }
}
