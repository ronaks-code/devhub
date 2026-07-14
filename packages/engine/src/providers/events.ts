import { redactSecrets } from "../redact.js";
import {
  assertProviderRequestIdentity,
  createProviderRequestIdentity,
} from "./request-identity.js";
import {
  assertNativeTaskKey,
  nativeTaskKeyId,
  snapshotNativeTaskKey,
} from "./task-key.js";
import type {
  NativeTaskKey,
  ProviderId,
  ProviderRequestIdentity,
  ProviderRequestResponse,
} from "./types.js";

/** User-input auto-resolution is intentionally limited to the app's approved 60s-240s range. */
export const AUTO_RESOLUTION_MIN_MS = 60_000;
export const AUTO_RESOLUTION_MAX_MS = 240_000;
/** Provider usage counters must remain exactly representable in JavaScript. */
export const MAX_PROVIDER_USAGE_COUNT = Number.MAX_SAFE_INTEGER;

interface ProviderEventBase {
  provider: ProviderId;
  key: Readonly<NativeTaskKey>;
  occurredAt: string;
}

export type ProviderRequest =
  | { kind: "command-approval"; identity: Readonly<ProviderRequestIdentity> }
  | { kind: "file-change-approval"; identity: Readonly<ProviderRequestIdentity> }
  | { kind: "mcp-elicitation"; identity: Readonly<ProviderRequestIdentity> }
  | { kind: "permission"; identity: Readonly<ProviderRequestIdentity> }
  | {
      kind: "user-input";
      identity: Readonly<ProviderRequestIdentity>;
      /** A bounded value is the provider's declaration that empty auto-resolution is valid. */
      autoResolutionMs: number | null;
    };

export type ProviderEvent =
  | (ProviderEventBase & {
      type: "message";
      role: "user" | "assistant" | "system";
      text: string;
      turnId: string | null;
      itemId: string | null;
    })
  | (ProviderEventBase & {
      type: "message-delta";
      role: "user" | "assistant" | "system";
      delta: string;
      turnId: string | null;
      itemId: string | null;
    })
  | (ProviderEventBase & {
      type: "plan";
      turnId: string | null;
      itemId: string | null;
      /** Provider snapshot ordinal when no native plan item id exists. */
      stepIndex: number | null;
      text: string;
      status: string;
    })
  | (ProviderEventBase & {
      type: "activity";
      turnId: string | null;
      itemId: string | null;
      activity: string;
      status: string;
      message: string | null;
    })
  | (ProviderEventBase & {
      type: "diff-summary";
      turnId: string | null;
      changedFiles: number;
      additions: number;
      deletions: number;
    })
  | (ProviderEventBase & {
      type: "usage";
      turnId: string | null;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      totalTokens: number;
    })
  | (ProviderEventBase & {
      type: "status";
      scope: "task" | "turn" | "item";
      status: string;
      nativeId: string | null;
    })
  | (ProviderEventBase & {
      type: "request";
      request: ProviderRequest;
    })
  | (ProviderEventBase & {
      type: "request-resolved";
      identity: Readonly<ProviderRequestIdentity>;
    })
  | (ProviderEventBase & {
      type: "diagnostic";
      level: "warning" | "error";
      code: string;
      message: string;
      method: string | null;
      shapeKeys: readonly string[];
    });

export interface ProviderEventContext {
  provider: ProviderId;
  key: NativeTaskKey;
  occurredAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nullableNativeId(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty native id or null`);
  }
  const normalized = value.trim();
  if (normalized.includes("\u0000")) {
    throw new TypeError(`${field} must not contain a NUL character`);
  }
  return normalized;
}

function nonEmptyText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return redactSecrets(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return redactSecrets(value);
}

function boundedCount(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_PROVIDER_USAGE_COUNT
  ) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function diagnosticMetadata(input: unknown): {
  method: string | null;
  shapeKeys: readonly string[];
} {
  if (!isRecord(input)) return { method: null, shapeKeys: [] };
  const method = typeof input.method === "string" && input.method.trim().length > 0
    ? redactSecrets(input.method.trim()).slice(0, 256)
    : null;
  const shapeKeys = Object.freeze(
    Object.keys(input)
      .sort()
      .slice(0, 32)
      .map((key) => redactSecrets(key).slice(0, 64)),
  );
  return { method, shapeKeys };
}

function containsHiddenProviderContent(input: Record<string, unknown>): boolean {
  const marker = /(?:hidden|private|internal)[-_ ]?(?:reasoning|thought)|chain[-_ ]?of[-_ ]?thought/i;
  if (Object.keys(input).some((key) => marker.test(key))) return true;
  return [input.channel, input.contentType, input.method, input.kind, input.phase]
    .some((value) => typeof value === "string" && marker.test(value));
}

function diagnosticEvent(
  input: unknown,
  base: ProviderEventBase,
  code: string,
  message: string,
  level: "warning" | "error" = "warning",
): ProviderEvent {
  return {
    ...base,
    type: "diagnostic",
    level,
    code,
    message,
    ...diagnosticMetadata(input),
  };
}

function requestIdentity(
  value: unknown,
  expectedKey: NativeTaskKey,
): Readonly<ProviderRequestIdentity> {
  assertProviderRequestIdentity(value);
  if (nativeTaskKeyId(value.key) !== nativeTaskKeyId(expectedKey)) {
    throw new ProviderRequestOwnershipError();
  }
  return createProviderRequestIdentity(value);
}

class ProviderRequestOwnershipError extends Error {}

function normalizeRequest(
  value: unknown,
  expectedKey: NativeTaskKey,
): ProviderRequest {
  if (!isRecord(value)) throw new TypeError("provider request must be an object");
  const identity = requestIdentity(value.identity, expectedKey);
  switch (value.kind) {
    case "command-approval":
    case "file-change-approval":
    case "mcp-elicitation":
    case "permission":
      return { kind: value.kind, identity };
    case "user-input":
      if (value.autoResolutionMs !== null && !isAutoResolutionMs(value.autoResolutionMs)) {
        throw new TypeError("autoResolutionMs is outside the approved range");
      }
      return {
        kind: value.kind,
        identity,
        autoResolutionMs: value.autoResolutionMs,
      };
    default:
      throw new TypeError("unknown provider request kind");
  }
}

function isAutoResolutionMs(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= AUTO_RESOLUTION_MIN_MS &&
    value <= AUTO_RESOLUTION_MAX_MS;
}

function hasExactSuppliedOwnership(
  input: Record<string, unknown>,
  expectedKey: NativeTaskKey,
): boolean {
  if ("provider" in input && input.provider !== expectedKey.provider) return false;
  if (!("key" in input)) return true;
  try {
    assertNativeTaskKey(input.key);
    return nativeTaskKeyId(input.key) === nativeTaskKeyId(expectedKey);
  } catch {
    return false;
  }
}

function normalizeProviderEventUnsafe(
  input: unknown,
  context: ProviderEventContext,
): ProviderEvent {
  const key = snapshotNativeTaskKey(context.key);
  const base: ProviderEventBase = {
    provider: context.provider,
    key,
    occurredAt: context.occurredAt ?? new Date().toISOString(),
  };
  if (context.provider !== key.provider) {
    return diagnosticEvent(
      input,
      { ...base, provider: key.provider },
      "PROVIDER_EVENT_CONTEXT_MISMATCH",
      "Provider event context disagrees with immutable task ownership",
      "error",
    );
  }
  if (!isRecord(input)) {
    return diagnosticEvent(
      input,
      base,
      "UNKNOWN_PROVIDER_EVENT",
      "Provider emitted an unknown or unsafe event shape",
    );
  }
  if (!hasExactSuppliedOwnership(input, key)) {
    return diagnosticEvent(
      input,
      base,
      "PROVIDER_EVENT_OWNERSHIP_MISMATCH",
      "Provider event ownership disagrees with immutable task ownership",
      "error",
    );
  }

  if (containsHiddenProviderContent(input)) {
    return diagnosticEvent(
      input,
      base,
      "HIDDEN_PROVIDER_CONTENT_SUPPRESSED",
      "Provider content marked as hidden reasoning was suppressed",
      "warning",
    );
  }

  try {
    if (
      input.type === "message" &&
      (input.role === "user" || input.role === "assistant" || input.role === "system")
    ) {
      return {
        ...base,
        type: "message",
        role: input.role,
        text: text(input.text, "message text"),
        turnId: nullableNativeId(input.turnId, "turnId"),
        itemId: nullableNativeId(input.itemId, "itemId"),
      };
    }
    if (
      input.type === "message-delta" &&
      (input.role === "user" || input.role === "assistant" || input.role === "system")
    ) {
      return {
        ...base,
        type: "message-delta",
        role: input.role,
        delta: text(input.delta, "message delta"),
        turnId: nullableNativeId(input.turnId, "turnId"),
        itemId: nullableNativeId(input.itemId, "itemId"),
      };
    }
    if (input.type === "plan") {
      return {
        ...base,
        type: "plan",
        turnId: nullableNativeId(input.turnId, "turnId"),
        itemId: nullableNativeId(input.itemId, "itemId"),
        stepIndex: input.stepIndex === null || input.stepIndex === undefined
          ? null
          : boundedCount(input.stepIndex, "plan stepIndex"),
        text: text(input.text, "plan text"),
        status: nonEmptyText(input.status, "plan status"),
      };
    }
    if (input.type === "activity") {
      return {
        ...base,
        type: "activity",
        turnId: nullableNativeId(input.turnId, "turnId"),
        itemId: nullableNativeId(input.itemId, "itemId"),
        activity: nonEmptyText(input.activity, "activity kind"),
        status: nonEmptyText(input.status, "activity status"),
        message: input.message === null || input.message === undefined
          ? null
          : text(input.message, "activity message"),
      };
    }
    if (input.type === "diff-summary") {
      return {
        ...base,
        type: "diff-summary",
        turnId: nullableNativeId(input.turnId, "turnId"),
        changedFiles: boundedCount(input.changedFiles, "changedFiles"),
        additions: boundedCount(input.additions, "additions"),
        deletions: boundedCount(input.deletions, "deletions"),
      };
    }
    if (input.type === "usage") {
      return {
        ...base,
        type: "usage",
        turnId: nullableNativeId(input.turnId, "turnId"),
        inputTokens: boundedCount(input.inputTokens, "inputTokens"),
        outputTokens: boundedCount(input.outputTokens, "outputTokens"),
        cachedInputTokens: boundedCount(input.cachedInputTokens, "cachedInputTokens"),
        totalTokens: boundedCount(input.totalTokens, "totalTokens"),
      };
    }
    if (
      input.type === "status" &&
      (input.scope === "task" || input.scope === "turn" || input.scope === "item")
    ) {
      return {
        ...base,
        type: "status",
        scope: input.scope,
        status: nonEmptyText(input.status, "status"),
        nativeId: nullableNativeId(input.nativeId, "nativeId"),
      };
    }
    if (input.type === "request") {
      return {
        ...base,
        type: "request",
        request: normalizeRequest(input.request, key),
      };
    }
    if (input.type === "request-resolved") {
      return {
        ...base,
        type: "request-resolved",
        identity: requestIdentity(input.identity, key),
      };
    }
  } catch (error) {
    return diagnosticEvent(
      input,
      base,
      error instanceof ProviderRequestOwnershipError
        ? "PROVIDER_REQUEST_CONTEXT_MISMATCH"
        : "INVALID_PROVIDER_EVENT",
      error instanceof ProviderRequestOwnershipError
        ? "Provider request identity disagrees with immutable task ownership"
        : "Provider emitted an invalid event payload",
      "error",
    );
  }

  return diagnosticEvent(
    input,
    base,
    "UNKNOWN_PROVIDER_EVENT",
    "Provider emitted an unknown or unsafe event shape",
  );
}

function freezeProviderEvent(event: ProviderEvent): ProviderEvent {
  if (event.type === "request") Object.freeze(event.request);
  return Object.freeze(event);
}

/** Rebuild an untrusted provider event from the public allowlist and freeze its object graph. */
export function normalizeProviderEvent(
  input: unknown,
  context: ProviderEventContext,
): ProviderEvent {
  return freezeProviderEvent(normalizeProviderEventUnsafe(input, context));
}

export function timeoutResponseForRequest(
  request: ProviderRequest,
): ProviderRequestResponse | null {
  assertProviderRequestIdentity(request.identity);
  switch (request.kind) {
    case "command-approval":
    case "file-change-approval":
    case "mcp-elicitation":
      return { kind: request.kind, identity: request.identity, decision: "cancel" };
    case "permission":
      return { kind: request.kind, identity: request.identity, permissions: [] };
    case "user-input":
      if (!isAutoResolutionMs(request.autoResolutionMs)) return null;
      return { kind: request.kind, identity: request.identity, answers: {} };
  }
}
