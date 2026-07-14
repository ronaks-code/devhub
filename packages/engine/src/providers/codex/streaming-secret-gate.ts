import {
  hasUnclosedSensitiveQuotedAssignment,
  redactSecrets,
} from "../../redact.js";

export const CODEX_STREAM_MAX_ITEM_BUFFER_CHARS = 64 * 1_024;
export const CODEX_STREAM_MAX_TOTAL_BUFFER_CHARS = 2 * 1_024 * 1_024;
export const CODEX_STREAM_MAX_ITEMS = 256;
export const CODEX_STREAM_MAX_NO_PROGRESS_INSPECTION_CHARS =
  CODEX_STREAM_MAX_ITEM_BUFFER_CHARS * 4;

const MAX_CONFIGURED_ITEM_BUFFER_CHARS = 2 * 1_024 * 1_024;
const MAX_CONFIGURED_TOTAL_BUFFER_CHARS = 16 * 1_024 * 1_024;
const MAX_CONFIGURED_ITEMS = 4_096;
const MAX_CONFIGURED_INSPECTION_CHARS = 16 * 1_024 * 1_024;

const SECRET_KEY_WORDS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "access_key",
  "secret_key",
  "private_key",
  "client_secret",
  "auth",
  "credential",
  "credentials",
];

/**
 * Whitespace can separate an authorization scheme from its credential and a
 * secret-key assignment from its separator/value. Retain those suffixes until
 * the following lexical token is complete; every other credential shape in
 * redactSecrets is non-whitespace and therefore completes at whitespace.
 */
const INCOMPLETE_AUTH = /\b(?:Bearer|Basic|Token)\s+$/iu;

const isKeyCharacter = (value: string): boolean =>
  value === "." || value === "-" || value === "_" ||
  (value >= "0" && value <= "9") ||
  (value >= "A" && value <= "Z") ||
  (value >= "a" && value <= "z");

const skipWhitespaceBackward = (value: string, from: number): number => {
  let index = from;
  while (index >= 0 && /\s/u.test(value[index]!)) index -= 1;
  return index;
};

/** Linear suffix parser for a possibly split secret assignment prefix. */
const incompleteAssignment = (value: string): boolean => {
  let index = skipWhitespaceBackward(value, value.length - 1);
  if (index < 0) return false;

  // A trailing quote may be either the opening value quote after a separator or
  // the closing key quote before one. Both are safe to peel for suffix parsing.
  if (value[index] === "\"" || value[index] === "'") {
    index = skipWhitespaceBackward(value, index - 1);
  }
  if (value[index] === ":" || value[index] === "=") {
    index = skipWhitespaceBackward(value, index - 1);
    if (value[index] === "\"" || value[index] === "'") index -= 1;
  }

  const keyEnd = index + 1;
  while (index >= 0 && isKeyCharacter(value[index]!)) index -= 1;
  if (keyEnd === index + 1) return false;
  const key = value.slice(index + 1, keyEnd).toLowerCase();
  return SECRET_KEY_WORDS.some((word) => key.endsWith(word));
};

export interface StreamingSecretKey {
  readonly generation: number;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly kind: "message" | "plan";
}

export interface StreamingSecretGateOptions {
  readonly maxItemBufferChars?: number;
  readonly maxTotalBufferChars?: number;
  readonly maxItems?: number;
  readonly maxNoProgressInspectionChars?: number;
}

export interface StreamingSecretGateResult {
  readonly chunks: readonly string[];
  /** True only when this call newly crosses a safety/capacity boundary. */
  readonly suppressed: boolean;
}

interface StreamState {
  readonly key: Readonly<StreamingSecretKey>;
  buffer: string;
  suppressed: boolean;
  noProgressInspections: number;
}

function positiveBounded(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`${label} must be a positive safe integer at most ${maximum}`);
  }
  return resolved;
}

function nativeId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 ||
    value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a bounded native id`);
  }
  return value;
}

function snapshotKey(value: StreamingSecretKey): Readonly<StreamingSecretKey> {
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw new TypeError("generation must be a positive safe integer");
  }
  if (value.kind !== "message" && value.kind !== "plan") {
    throw new TypeError("stream kind must be message or plan");
  }
  return Object.freeze({
    generation: value.generation,
    threadId: nativeId(value.threadId, "threadId"),
    turnId: nativeId(value.turnId, "turnId"),
    itemId: nativeId(value.itemId, "itemId"),
    kind: value.kind,
  });
}

function keyId(key: StreamingSecretKey): string {
  return JSON.stringify([key.generation, key.threadId, key.turnId, key.itemId, key.kind]);
}

function incompleteSensitivePrefix(value: string): boolean {
  return INCOMPLETE_AUTH.test(value) || incompleteAssignment(value);
}

function result(chunks: readonly string[], suppressed: boolean): StreamingSecretGateResult {
  return Object.freeze({ chunks: Object.freeze([...chunks]), suppressed });
}

/**
 * Stateful lexical gate for provider text deltas.
 *
 * Raw fragments never cross this boundary. It emits only whitespace-terminated
 * lexical segments after whole-segment redaction, while retaining authorization
 * and assignment prefixes that legally span whitespace. Unterminated or
 * capacity-exceeding items switch to suppression until their canonical completed
 * item arrives. Completion is intentionally not flushed: the full provider item
 * is normalized and redacted as the authoritative final text.
 */
export class StreamingSecretGate {
  private readonly maxItemBufferChars: number;
  private readonly maxTotalBufferChars: number;
  private readonly maxItems: number;
  private readonly maxNoProgressInspectionChars: number;
  private readonly states = new Map<string, StreamState>();
  private readonly suppressedGenerations = new Set<number>();
  private totalBuffered = 0;
  private totalInspected = 0;
  private closed = false;

  constructor(options: StreamingSecretGateOptions = {}) {
    this.maxItemBufferChars = positiveBounded(
      options.maxItemBufferChars,
      CODEX_STREAM_MAX_ITEM_BUFFER_CHARS,
      MAX_CONFIGURED_ITEM_BUFFER_CHARS,
      "maxItemBufferChars",
    );
    this.maxTotalBufferChars = positiveBounded(
      options.maxTotalBufferChars,
      CODEX_STREAM_MAX_TOTAL_BUFFER_CHARS,
      MAX_CONFIGURED_TOTAL_BUFFER_CHARS,
      "maxTotalBufferChars",
    );
    if (this.maxTotalBufferChars < this.maxItemBufferChars) {
      throw new RangeError("maxTotalBufferChars must be at least maxItemBufferChars");
    }
    this.maxItems = positiveBounded(
      options.maxItems,
      CODEX_STREAM_MAX_ITEMS,
      MAX_CONFIGURED_ITEMS,
      "maxItems",
    );
    this.maxNoProgressInspectionChars = positiveBounded(
      options.maxNoProgressInspectionChars,
      CODEX_STREAM_MAX_NO_PROGRESS_INSPECTION_CHARS,
      MAX_CONFIGURED_INSPECTION_CHARS,
      "maxNoProgressInspectionChars",
    );
  }

  get bufferedCharacters(): number {
    return this.totalBuffered;
  }

  get activeItems(): number {
    return this.states.size;
  }

  /** Monotonic deterministic work counter used by budget tests/diagnostics. */
  get inspectedCharacters(): number {
    return this.totalInspected;
  }

  feed(keyValue: StreamingSecretKey, fragment: string): StreamingSecretGateResult {
    if (this.closed) return result([], false);
    const key = snapshotKey(keyValue);
    if (typeof fragment !== "string") throw new TypeError("stream fragment must be a string");
    if (fragment.length === 0 || this.suppressedGenerations.has(key.generation)) {
      return result([], false);
    }
    const id = keyId(key);
    let state = this.states.get(id);
    if (!state) {
      if (this.states.size >= this.maxItems) {
        this.suppressGeneration(key.generation);
        return result([], true);
      }
      state = { key, buffer: "", suppressed: false, noProgressInspections: 0 };
      this.states.set(id, state);
    }
    if (state.suppressed) return result([], false);

    state.buffer += fragment;
    this.totalBuffered += fragment.length;
    if (
      state.buffer.length > this.maxItemBufferChars ||
      this.totalBuffered > this.maxTotalBufferChars ||
      state.noProgressInspections + state.buffer.length > this.maxNoProgressInspectionChars
    ) {
      this.totalBuffered -= state.buffer.length;
      state.buffer = "";
      state.suppressed = true;
      return result([], true);
    }
    const chunks: string[] = [];
    state.noProgressInspections += state.buffer.length;
    this.totalInspected += state.buffer.length;
    let finalWhitespace = -1;
    for (let index = 0; index < state.buffer.length; index += 1) {
      if (/\s/u.test(state.buffer[index]!)) finalWhitespace = index;
    }
    if (finalWhitespace >= 0) {
      const candidate = state.buffer.slice(0, finalWhitespace + 1);
      if (
        !incompleteSensitivePrefix(candidate) &&
        !hasUnclosedSensitiveQuotedAssignment(candidate)
      ) {
        const safe = redactSecrets(candidate);
        if (safe.length > 0) chunks.push(safe);
        state.buffer = state.buffer.slice(finalWhitespace + 1);
        this.totalBuffered -= finalWhitespace + 1;
        state.noProgressInspections = 0;
      }
    }
    return result(chunks, false);
  }

  complete(keyValue: StreamingSecretKey): void {
    const key = snapshotKey(keyValue);
    this.deleteState(keyId(key));
  }

  cancelTask(generation: number, threadId: string): void {
    if (!Number.isSafeInteger(generation) || generation < 1) return;
    let exactThreadId: string;
    try { exactThreadId = nativeId(threadId, "threadId"); } catch { return; }
    for (const [id, state] of [...this.states]) {
      if (state.key.generation === generation && state.key.threadId === exactThreadId) {
        this.deleteState(id);
      }
    }
  }

  cancelTurn(generation: number, threadId: string, turnId: string): void {
    if (!Number.isSafeInteger(generation) || generation < 1) return;
    let exactThreadId: string;
    let exactTurnId: string;
    try {
      exactThreadId = nativeId(threadId, "threadId");
      exactTurnId = nativeId(turnId, "turnId");
    } catch {
      return;
    }
    for (const [id, state] of [...this.states]) {
      if (
        state.key.generation === generation &&
        state.key.threadId === exactThreadId &&
        state.key.turnId === exactTurnId
      ) {
        this.deleteState(id);
      }
    }
  }

  cancelGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 1) return;
    for (const [id, state] of [...this.states]) {
      if (state.key.generation === generation) this.deleteState(id);
    }
    this.suppressedGenerations.delete(generation);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.states.clear();
    this.suppressedGenerations.clear();
    this.totalBuffered = 0;
  }

  private deleteState(id: string): void {
    const state = this.states.get(id);
    if (!state) return;
    this.totalBuffered -= state.buffer.length;
    this.states.delete(id);
  }

  private suppressGeneration(generation: number): void {
    this.suppressedGenerations.add(generation);
    for (const [id, state] of [...this.states]) {
      if (state.key.generation === generation) this.deleteState(id);
    }
  }
}
