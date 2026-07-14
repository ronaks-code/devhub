import { CodexProtocolFault } from "./fault.js";
import {
  isProviderNativeId,
  normalizeProviderNativeId,
} from "../../native-id.js";

export const MAX_CODEX_RPC_METHOD_CHARS = 256;

export type CodexRpcId = string | number;

export interface CodexRpcRequest {
  readonly id: CodexRpcId;
  readonly method: string;
  readonly params?: unknown;
  readonly trace?: unknown;
}

export interface CodexRpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexRpcSuccess {
  readonly id: CodexRpcId;
  readonly result: unknown;
}

export interface CodexRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface CodexRpcError {
  readonly id: CodexRpcId;
  readonly error: CodexRpcErrorBody;
}

export type CodexRpcEnvelope =
  | CodexRpcRequest
  | CodexRpcNotification
  | CodexRpcSuccess
  | CodexRpcError;

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const isCodexRpcId = (value: unknown): value is CodexRpcId =>
  (typeof value === "string" && isProviderNativeId(value) &&
    normalizeProviderNativeId(value, "Codex RPC id") === value) ||
  (typeof value === "number" && Number.isSafeInteger(value));

export function assertCodexRpcId(value: unknown): asserts value is CodexRpcId {
  if (!isCodexRpcId(value)) {
    throw new CodexProtocolFault(
      "INVALID_ID",
      "Codex RPC id must be a string or a safe integer",
    );
  }
}

export const serializeCodexRpcId = (id: CodexRpcId): string =>
  (assertCodexRpcId(id), typeof id === "number" ? `number:${id}` : `string:${id}`);

function assertCodexMethod(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 ||
    value.length > MAX_CODEX_RPC_METHOD_CHARS || value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new CodexProtocolFault(
      "INVALID_ENVELOPE",
      "Codex RPC method must be a bounded non-empty string",
    );
  }
  try {
    // Reuse the sensitive-value rejection while retaining the method's larger grammar.
    normalizeProviderNativeId(value, "Codex RPC method");
  } catch {
    throw new CodexProtocolFault(
      "INVALID_ENVELOPE",
      "Codex RPC method must be a bounded non-sensitive string",
    );
  }
}

/** Validate an omitted-jsonrpc Codex app-server wire envelope. */
export const parseCodexEnvelope = (value: unknown): CodexRpcEnvelope => {
  if (!isRecord(value)) {
    throw new CodexProtocolFault("INVALID_ENVELOPE", "Codex RPC envelope must be an object");
  }
  if (hasOwn(value, "jsonrpc")) {
    throw new CodexProtocolFault(
      "INVALID_ENVELOPE",
      "Codex app-server envelopes must omit the jsonrpc field",
    );
  }

  const hasMethod = hasOwn(value, "method");
  const hasId = hasOwn(value, "id");
  const hasResult = hasOwn(value, "result");
  const hasError = hasOwn(value, "error");

  if (hasMethod) {
    assertCodexMethod(value.method);
    if (hasResult || hasError) {
      throw new CodexProtocolFault(
        "INVALID_ENVELOPE",
        "Codex RPC method envelope cannot also be a response",
      );
    }
    if (hasId) assertCodexRpcId(value.id);
    return value as unknown as CodexRpcRequest | CodexRpcNotification;
  }

  if (!hasId) {
    throw new CodexProtocolFault(
      "INVALID_ENVELOPE",
      "Codex RPC response requires an id",
    );
  }
  assertCodexRpcId(value.id);
  if (hasResult === hasError) {
    throw new CodexProtocolFault(
      "INVALID_ENVELOPE",
      "Codex RPC response requires exactly one of result or error",
    );
  }
  if (hasError) {
    if (
      !isRecord(value.error) ||
      !Number.isSafeInteger(value.error.code) ||
      typeof value.error.message !== "string"
    ) {
      throw new CodexProtocolFault(
        "INVALID_ENVELOPE",
        "Codex RPC error requires a safe-integer code and string message",
      );
    }
  }
  return value as unknown as CodexRpcSuccess | CodexRpcError;
};

export const isCodexRpcRequest = (value: CodexRpcEnvelope): value is CodexRpcRequest =>
  "method" in value && "id" in value;

export const isCodexRpcNotification = (
  value: CodexRpcEnvelope,
): value is CodexRpcNotification => "method" in value && !("id" in value);

export const isCodexRpcError = (value: CodexRpcEnvelope): value is CodexRpcError =>
  "error" in value;
