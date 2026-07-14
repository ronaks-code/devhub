import { createHash } from "node:crypto";
import type { NativeRevision } from "../types.js";

const PREFIX = "claude:v1:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_MESSAGES = 20_000;
const CONTENT_FREE_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "canceled",
  "cancelled",
  "complete",
  "error",
  "failed",
  "idle",
  "interrupted",
  "running",
  "starting",
  "stopped",
  "streaming",
  "success",
]);

export interface ClaudeNativeRevisionMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
}

export interface ClaudeNativeRevisionInput {
  readonly sessionId: string;
  readonly createdAt: string | null;
  readonly updatedAt: string;
  readonly fileSize: number | null;
  readonly status: string;
  readonly messages: readonly ClaudeNativeRevisionMessage[];
}

const invalid = (): never => {
  throw new TypeError("Claude native revision input is invalid");
};

const exactRecord = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    ) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return invalid();
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return invalid();
  }
};

const timestamp = (value: unknown, nullable: boolean): string | null => {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length > 32) return invalid();
  try {
    if (new Date(value).toISOString() !== value) return invalid();
  } catch {
    return invalid();
  }
  return value;
};

const messages = (value: unknown): readonly Readonly<ClaudeNativeRevisionMessage>[] => {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > MAX_MESSAGES) return invalid();
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) return invalid();
    const result: Readonly<ClaudeNativeRevisionMessage>[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return invalid();
      const item = exactRecord(descriptor.value, ["id", "role"]);
      if (typeof item.id !== "string" || !UUID.test(item.id)) return invalid();
      if (item.role !== "user" && item.role !== "assistant" && item.role !== "system") {
        return invalid();
      }
      result.push(Object.freeze({ id: item.id, role: item.role }));
    }
    return Object.freeze(result);
  } catch {
    return invalid();
  }
};

/**
 * Builds a content-free revision from official helper metadata and provider IDs.
 * Message text, tool payloads, reasoning, paths, and titles never enter the hash.
 */
export function buildClaudeNativeRevision(
  value: ClaudeNativeRevisionInput,
): Readonly<NativeRevision> {
  const input = exactRecord(value, [
    "sessionId",
    "createdAt",
    "updatedAt",
    "fileSize",
    "status",
    "messages",
  ]);
  if (typeof input.sessionId !== "string" || !UUID.test(input.sessionId)) return invalid();
  const createdAt = timestamp(input.createdAt, true);
  const updatedAt = timestamp(input.updatedAt, false)!;
  if (
    input.fileSize !== null &&
    (typeof input.fileSize !== "number" || !Number.isSafeInteger(input.fileSize) ||
      input.fileSize < 0)
  ) return invalid();
  if (
    typeof input.status !== "string" ||
    !CONTENT_FREE_STATUSES.has(input.status)
  ) return invalid();
  const topology = messages(input.messages);
  const lastItem = topology.at(-1) ?? null;
  let lastTurn: Readonly<ClaudeNativeRevisionMessage> | null = null;
  for (let index = topology.length - 1; index >= 0; index -= 1) {
    if (topology[index]!.role === "user") {
      lastTurn = topology[index]!;
      break;
    }
  }
  const canonical = JSON.stringify({
    v: 1,
    sessionId: input.sessionId,
    createdAt,
    updatedAt,
    fileSize: input.fileSize,
    status: input.status,
    topology,
  });
  const fingerprint = createHash("sha256").update(canonical, "utf8").digest("base64url");
  return Object.freeze({
    updatedAt: Date.parse(updatedAt),
    status: input.status,
    lastTurnId: lastTurn?.id ?? null,
    lastTurnStatus: lastTurn === null ? null : input.status,
    lastItemId: lastItem?.id ?? null,
    fingerprint: `${PREFIX}${fingerprint}`,
  });
}
