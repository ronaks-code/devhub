import {
  assertNativeTaskKey,
  createNativeTaskKey,
  nativeTaskKeyId,
} from "./task-key.js";
import type {
  JsonRpcRequestId,
  NativeTaskKey,
  ProviderRequestIdentity,
} from "./types.js";
import { normalizeProviderNativeId } from "./native-id.js";

function nativeStringId(
  value: unknown,
  field: Exclude<keyof Omit<ProviderRequestIdentity, "key">, "generation">,
  nullable: boolean,
): string | null {
  if (value === null && nullable) return null;
  return normalizeProviderNativeId(value, field);
}

function processGeneration(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("generation must be a non-negative safe integer or null");
  }
  return value;
}

function jsonRpcId(
  value: unknown,
  field: "requestId" | "approvalId",
  nullable: boolean,
): JsonRpcRequestId | null {
  if (value === null && nullable) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`${field} must be a safe integer JSON-RPC id${nullable ? " or null" : ""}`);
    }
    return value;
  }
  return nativeStringId(value, field, nullable);
}

export function createProviderRequestIdentity(
  value: ProviderRequestIdentity,
): Readonly<ProviderRequestIdentity> {
  assertNativeTaskKey(value.key);
  return Object.freeze({
    key: createNativeTaskKey(
      value.key.provider,
      value.key.home,
      value.key.nativeTaskId,
    ),
    generation: processGeneration(value.generation),
    turnId: nativeStringId(value.turnId, "turnId", true),
    requestId: jsonRpcId(value.requestId, "requestId", false)!,
    itemId: nativeStringId(value.itemId, "itemId", true),
    approvalId: jsonRpcId(value.approvalId, "approvalId", true),
  });
}

export function assertProviderRequestIdentity(
  value: unknown,
  expectedKey?: NativeTaskKey,
): asserts value is ProviderRequestIdentity {
  if (!value || typeof value !== "object") {
    throw new TypeError("provider request identity must be an object");
  }
  const identity = value as Partial<ProviderRequestIdentity>;
  assertNativeTaskKey(identity.key);
  processGeneration(identity.generation);
  nativeStringId(identity.turnId, "turnId", true);
  jsonRpcId(identity.requestId, "requestId", false);
  nativeStringId(identity.itemId, "itemId", true);
  jsonRpcId(identity.approvalId, "approvalId", true);

  if (expectedKey) {
    assertNativeTaskKey(expectedKey);
    if (nativeTaskKeyId(identity.key) !== nativeTaskKeyId(expectedKey)) {
      throw new TypeError("provider request identity does not belong to the expected task context");
    }
  }
}

function taggedId(value: string | number | null): readonly ["null"] | readonly ["s", string] | readonly ["n", number] {
  if (value === null) return ["null"];
  return typeof value === "number" ? ["n", value] : ["s", value];
}

/** Collision-resistant serialization for exact pending-request correlation. */
export function serializeProviderRequestIdentity(value: ProviderRequestIdentity): string {
  const identity = createProviderRequestIdentity(value);
  return JSON.stringify([
    identity.key.provider,
    identity.key.home,
    identity.key.nativeTaskId,
    taggedId(identity.generation),
    taggedId(identity.turnId),
    taggedId(identity.requestId),
    taggedId(identity.itemId),
    taggedId(identity.approvalId),
  ]);
}
