import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";

export const CODEX_DEVHUB_SOURCE_KINDS = Object.freeze(["vscode", "appServer"] as const);
export const MAX_CODEX_LIST_CURSOR_CHARS = 8_192;
export const MAX_CODEX_PROVIDER_CURSOR_CHARS = 2_048;
export const MAX_CODEX_LIST_LIMIT = 256;

const CURSOR_PREFIX = "dhlc1";
const MIN_SECRET_BYTES = 32;

export interface CodexListScope {
  readonly home: string;
  readonly includeArchived: boolean;
  readonly limit: number;
}

export interface CodexListCursorState {
  readonly activeCursor: string | null;
  readonly activeDone: boolean;
  readonly archivedCursor: string | null;
  readonly archivedDone: boolean;
  /** Receives the odd request-quota remainder while both lanes remain active. */
  readonly nextLane: CodexListLane;
}

export type CodexListLane = "active" | "archived";

export interface CodexThreadListRequest {
  readonly lane: CodexListLane;
  readonly params: Readonly<{
    archived: boolean;
    cursor: string | null;
    limit: number;
    sourceKinds: typeof CODEX_DEVHUB_SOURCE_KINDS;
    sortKey: "updated_at";
    sortDirection: "desc";
  }>;
}

export interface CodexThreadListLaneResult {
  readonly lane: CodexListLane;
  readonly nextCursor: string | null;
}

export type CodexListCursorErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_CURSOR_STATE"
  | "INVALID_CURSOR"
  | "CURSOR_SCOPE_MISMATCH";

/** Cursor errors never reflect cursor, home, filter, or secret material. */
export class CodexListCursorError extends Error {
  readonly code: CodexListCursorErrorCode;

  constructor(code: CodexListCursorErrorCode) {
    const message = code === "CURSOR_SCOPE_MISMATCH"
      ? "Codex list cursor does not belong to this list scope"
      : code === "INVALID_CONFIGURATION"
        ? "Codex list cursor configuration is invalid"
        : code === "INVALID_CURSOR_STATE"
          ? "Codex list cursor state is invalid"
          : "Codex list cursor is invalid";
    super(message);
    this.name = "CodexListCursorError";
    this.code = code;
  }
}

interface CursorPayload {
  readonly v: 1;
  readonly s: string;
  readonly a: readonly [string | null, boolean];
  readonly r: readonly [string | null, boolean];
  readonly n: "a" | "r";
}

function fail(code: CodexListCursorErrorCode): never {
  throw new CodexListCursorError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateScope(scope: CodexListScope): void {
  if (
    typeof scope.home !== "string" ||
    scope.home.length === 0 ||
    scope.home.length > 16_384 ||
    scope.home.includes("\u0000") ||
    !path.isAbsolute(scope.home) ||
    typeof scope.includeArchived !== "boolean" ||
    !Number.isSafeInteger(scope.limit) ||
    scope.limit < 1 ||
    scope.limit > MAX_CODEX_LIST_LIMIT
  ) {
    fail("INVALID_CONFIGURATION");
  }
}

function validateNativeCursor(value: string | null, code: CodexListCursorErrorCode): void {
  if (value === null) return;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CODEX_PROVIDER_CURSOR_CHARS ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(code);
  }
}

function validateState(
  scope: CodexListScope,
  state: CodexListCursorState,
  code: CodexListCursorErrorCode,
): void {
  if (
    typeof state.activeDone !== "boolean" ||
    typeof state.archivedDone !== "boolean" ||
    (state.nextLane !== "active" && state.nextLane !== "archived")
  ) {
    fail(code);
  }
  validateNativeCursor(state.activeCursor, code);
  validateNativeCursor(state.archivedCursor, code);
  if (state.activeDone && state.activeCursor !== null) fail(code);
  if (state.archivedDone && state.archivedCursor !== null) fail(code);
  if (!scope.includeArchived && (!state.archivedDone || state.archivedCursor !== null)) fail(code);
}

function canonicalScope(scope: CodexListScope): string {
  return JSON.stringify({
    home: scope.home,
    includeArchived: scope.includeArchived,
    limit: scope.limit,
    sourceKinds: CODEX_DEVHUB_SOURCE_KINDS,
    sortKey: "updated_at",
    sortDirection: "desc",
  });
}

function scopeDigest(scope: CodexListScope): string {
  return createHash("sha256").update(canonicalScope(scope), "utf8").digest("base64url");
}

function canonicalPayload(payload: CursorPayload): string {
  return JSON.stringify({ v: payload.v, s: payload.s, a: payload.a, r: payload.r, n: payload.n });
}

function snapshotState(state: CodexListCursorState): Readonly<CodexListCursorState> {
  return Object.freeze({
    activeCursor: state.activeCursor,
    activeDone: state.activeDone,
    archivedCursor: state.archivedCursor,
    archivedDone: state.archivedDone,
    nextLane: state.nextLane,
  });
}

function parseLane(value: unknown): readonly [string | null, boolean] {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[1] !== "boolean") {
    return fail("INVALID_CURSOR");
  }
  const cursor = value[0];
  if (cursor !== null && typeof cursor !== "string") return fail("INVALID_CURSOR");
  validateNativeCursor(cursor, "INVALID_CURSOR");
  return Object.freeze([cursor, value[1]] as const);
}

function parsePayload(value: unknown): CursorPayload {
  if (!isPlainRecord(value)) return fail("INVALID_CURSOR");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "a,n,r,s,v" || value.v !== 1) return fail("INVALID_CURSOR");
  if (typeof value.s !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.s)) {
    return fail("INVALID_CURSOR");
  }
  if (value.n !== "a" && value.n !== "r") return fail("INVALID_CURSOR");
  return Object.freeze({
    v: 1,
    s: value.s,
    a: parseLane(value.a),
    r: parseLane(value.r),
    n: value.n,
  });
}

export function initialCodexListCursorState(
  includeArchived: boolean,
): Readonly<CodexListCursorState> {
  if (typeof includeArchived !== "boolean") fail("INVALID_CONFIGURATION");
  return Object.freeze({
    activeCursor: null,
    activeDone: false,
    archivedCursor: null,
    archivedDone: !includeArchived,
    nextLane: "active",
  });
}

/**
 * Builds a lossless request quota: issued native limits sum to at most the
 * public page limit. Callers must return every fetched item (they may sort the
 * fetched page, but must not trim it) before advancing with the matching lane
 * results. This avoids embedding transcript summaries or leftovers in cursors.
 * It does not claim a globally merged order across future native pages.
 */
export function createCodexThreadListRequests(
  scope: CodexListScope,
  state: CodexListCursorState,
): readonly CodexThreadListRequest[] {
  validateScope(scope);
  validateState(scope, state, "INVALID_CURSOR_STATE");
  const requests: CodexThreadListRequest[] = [];
  const request = (
    lane: CodexListLane,
    archived: boolean,
    cursor: string | null,
    limit: number,
  ): CodexThreadListRequest => Object.freeze({
    lane,
    params: Object.freeze({
      archived,
      cursor,
      limit,
      sourceKinds: CODEX_DEVHUB_SOURCE_KINDS,
      sortKey: "updated_at" as const,
      sortDirection: "desc" as const,
    }),
  });
  const activeAvailable = !state.activeDone;
  const archivedAvailable = scope.includeArchived && !state.archivedDone;
  if (activeAvailable && archivedAvailable) {
    const preferredLimit = Math.ceil(scope.limit / 2);
    const otherLimit = Math.floor(scope.limit / 2);
    const activeLimit = state.nextLane === "active" ? preferredLimit : otherLimit;
    const archivedLimit = state.nextLane === "archived" ? preferredLimit : otherLimit;
    if (activeLimit > 0) {
      requests.push(request("active", false, state.activeCursor, activeLimit));
    }
    if (archivedLimit > 0) {
      requests.push(request("archived", true, state.archivedCursor, archivedLimit));
    }
  } else if (activeAvailable) {
    requests.push(request("active", false, state.activeCursor, scope.limit));
  } else if (archivedAvailable) {
    requests.push(request("archived", true, state.archivedCursor, scope.limit));
  }
  return Object.freeze(requests);
}

/**
 * Advances only after every quota-issued lane has responded exactly once.
 * A null provider cursor closes that lane; unissued lanes remain untouched.
 */
export function advanceCodexListCursorState(
  scope: CodexListScope,
  state: CodexListCursorState,
  results: readonly CodexThreadListLaneResult[],
): Readonly<CodexListCursorState> {
  const requests = createCodexThreadListRequests(scope, state);
  if (!Array.isArray(results) || results.length !== requests.length) {
    return fail("INVALID_CURSOR_STATE");
  }
  const issued = new Map(requests.map((request) => [request.lane, request]));
  const resultByLane = new Map<CodexListLane, CodexThreadListLaneResult>();
  for (const result of results) {
    if (
      !result ||
      (result.lane !== "active" && result.lane !== "archived") ||
      !issued.has(result.lane) ||
      resultByLane.has(result.lane)
    ) {
      return fail("INVALID_CURSOR_STATE");
    }
    validateNativeCursor(result.nextCursor, "INVALID_CURSOR_STATE");
    const priorCursor = result.lane === "active" ? state.activeCursor : state.archivedCursor;
    if (result.nextCursor !== null && result.nextCursor === priorCursor) {
      return fail("INVALID_CURSOR_STATE");
    }
    resultByLane.set(result.lane, result);
  }
  if ([...issued.keys()].some((lane) => !resultByLane.has(lane))) {
    return fail("INVALID_CURSOR_STATE");
  }

  const active = resultByLane.get("active");
  const archived = resultByLane.get("archived");
  const bothAvailableBefore = !state.activeDone && scope.includeArchived && !state.archivedDone;
  const next: CodexListCursorState = {
    activeCursor: active ? active.nextCursor : state.activeCursor,
    activeDone: active ? active.nextCursor === null : state.activeDone,
    archivedCursor: archived ? archived.nextCursor : state.archivedCursor,
    archivedDone: archived ? archived.nextCursor === null : state.archivedDone,
    nextLane: bothAvailableBefore
      ? state.nextLane === "active" ? "archived" : "active"
      : state.nextLane,
  };
  validateState(scope, next, "INVALID_CURSOR_STATE");
  return snapshotState(next);
}

export class CodexListCursorCodec {
  readonly #secret: Buffer;

  constructor(secret: string | Uint8Array) {
    const bytes = typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);
    if (bytes.byteLength < MIN_SECRET_BYTES) fail("INVALID_CONFIGURATION");
    this.#secret = Buffer.from(bytes);
  }

  encode(scope: CodexListScope, state: CodexListCursorState): string {
    validateScope(scope);
    validateState(scope, state, "INVALID_CURSOR_STATE");
    const payload: CursorPayload = {
      v: 1,
      s: scopeDigest(scope),
      a: [state.activeCursor, state.activeDone],
      r: [state.archivedCursor, state.archivedDone],
      n: state.nextLane === "active" ? "a" : "r",
    };
    const encodedPayload = Buffer.from(canonicalPayload(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.#secret)
      .update(`${CURSOR_PREFIX}.${encodedPayload}`, "utf8")
      .digest("base64url");
    const cursor = `${CURSOR_PREFIX}.${encodedPayload}.${signature}`;
    if (cursor.length > MAX_CODEX_LIST_CURSOR_CHARS) fail("INVALID_CURSOR_STATE");
    return cursor;
  }

  decode(cursor: string, scope: CodexListScope): Readonly<CodexListCursorState> {
    validateScope(scope);
    if (
      typeof cursor !== "string" ||
      cursor.length === 0 ||
      cursor.length > MAX_CODEX_LIST_CURSOR_CHARS ||
      /[^A-Za-z0-9_.-]/u.test(cursor)
    ) {
      return fail("INVALID_CURSOR");
    }
    const parts = cursor.split(".");
    if (
      parts.length !== 3 ||
      parts[0] !== CURSOR_PREFIX ||
      !parts[1] ||
      !parts[2] ||
      !/^[A-Za-z0-9_-]+$/u.test(parts[1]) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(parts[2])
    ) {
      return fail("INVALID_CURSOR");
    }
    const expected = createHmac("sha256", this.#secret)
      .update(`${CURSOR_PREFIX}.${parts[1]}`, "utf8")
      .digest();
    const received = Buffer.from(parts[2], "base64url");
    if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) {
      return fail("INVALID_CURSOR");
    }

    let decoded: unknown;
    try {
      const json = Buffer.from(parts[1], "base64url").toString("utf8");
      if (Buffer.from(json, "utf8").toString("base64url") !== parts[1]) {
        return fail("INVALID_CURSOR");
      }
      decoded = JSON.parse(json) as unknown;
    } catch (error) {
      if (error instanceof CodexListCursorError) throw error;
      return fail("INVALID_CURSOR");
    }
    const payload = parsePayload(decoded);
    if (canonicalPayload(payload) !== Buffer.from(parts[1], "base64url").toString("utf8")) {
      return fail("INVALID_CURSOR");
    }
    if (payload.s !== scopeDigest(scope)) return fail("CURSOR_SCOPE_MISMATCH");
    const state: CodexListCursorState = {
      activeCursor: payload.a[0],
      activeDone: payload.a[1],
      archivedCursor: payload.r[0],
      archivedDone: payload.r[1],
      nextLane: payload.n === "a" ? "active" : "archived",
    };
    validateState(scope, state, "INVALID_CURSOR");
    return snapshotState(state);
  }
}
