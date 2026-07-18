import { redactSecrets } from "../../redact.js";
import {
  AUTO_RESOLUTION_MAX_MS,
  AUTO_RESOLUTION_MIN_MS,
  normalizeProviderEvent,
  type ProviderEvent,
  type ProviderRequest,
} from "../events.js";
import { createProviderRequestIdentity } from "../request-identity.js";
import { createNativeTaskKey } from "../task-key.js";
import type { ProviderEventContext } from "../events.js";
import type { JsonRpcRequestId } from "../types.js";
import { normalizeProviderNativeId } from "../native-id.js";
import {
  assertCodexFallbackParams,
  assertCodexRpcId,
  type CodexRpcNotification,
  type CodexRpcRequest,
} from "./protocol/index.js";

export const CODEX_DIAGNOSTIC_MAX_SHAPE_KEYS = 32;
export const CODEX_DIAGNOSTIC_MAX_METHOD_LENGTH = 256;
export const CODEX_DIAGNOSTIC_MAX_KEY_LENGTH = 64;
export const CODEX_MAX_USER_INPUT_QUESTIONS = 64;
/** Leaves 32 KiB of headroom inside the direct provider stream's 256 KiB frame cap. */
export const CODEX_MAX_ACTIVITY_BODY_JSON_BYTES = 224 * 1_024;

export interface CodexNormalizationContext {
  readonly home: string;
  readonly generation: number;
  readonly occurredAt?: string;
}

export type CodexNormalizationErrorCode =
  | "INVALID_CONTEXT"
  | "INVALID_REQUEST"
  | "UNSUPPORTED_REQUEST";

export class CodexNormalizationError extends Error {
  readonly code: CodexNormalizationErrorCode;

  constructor(code: CodexNormalizationErrorCode, message: string) {
    super(message);
    this.name = "CodexNormalizationError";
    this.code = code;
  }
}

export interface NormalizedCodexServerRequest {
  readonly request: ProviderRequest;
  readonly event: ProviderEvent;
  /** Safe provider-neutral context rendered beside the exact approval card. */
  readonly detailEvents: readonly ProviderEvent[];
  /** Stable question ids retained backend-only for exact answer validation. */
  readonly questionIds: readonly string[];
}

const KNOWN_NOTIFICATIONS: ReadonlySet<string> = new Set([
  "error",
  "thread/started",
  "thread/status/changed",
  "thread/archived",
  "thread/name/updated",
  "thread/tokenUsage/updated",
  "turn/started",
  "turn/completed",
  "turn/diff/updated",
  "turn/plan/updated",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "serverRequest/resolved",
]);

const SUPPORTED_REQUESTS: ReadonlySet<string> = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

const ACTIVITY_ITEM_TYPES: ReadonlySet<string> = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction",
  "hookPrompt",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const own = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const nativeId = (value: unknown, field: string): string => {
  const normalized = normalizeProviderNativeId(value, field);
  if (value !== normalized) throw new TypeError(`${field} must already be canonical`);
  return normalized;
};

const optionalNativeId = (value: unknown, field: string): string | null =>
  value === null || value === undefined ? null : nativeId(value, field);

const text = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value;
};

const status = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;

const record = (value: unknown, field: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  return value;
};

const array = (value: unknown, field: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
};

const generation = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new CodexNormalizationError(
      "INVALID_CONTEXT",
      "Codex app-server generation must be a positive safe integer",
    );
  }
  return value as number;
};

const eventContext = (
  threadId: string,
  context: CodexNormalizationContext,
): ProviderEventContext => ({
  provider: "openai",
  key: createNativeTaskKey("openai", context.home, threadId),
  ...(context.occurredAt === undefined ? {} : { occurredAt: context.occurredAt }),
});

const normalizedEvent = (
  input: unknown,
  threadId: string,
  context: CodexNormalizationContext,
): ProviderEvent => normalizeProviderEvent(input, eventContext(threadId, context));

const diagnostic = (
  notification: CodexRpcNotification,
  context: CodexNormalizationContext,
  code: string,
  message: string,
  threadId?: string,
): ProviderEvent => {
  const params = isRecord(notification.params) ? notification.params : null;
  let safeThreadId = "unknown";
  try {
    safeThreadId = nativeId(
      threadId ?? params?.threadId ?? "unknown",
      "diagnostic threadId",
    );
  } catch {
    // Diagnostics never trust malformed provider ownership metadata.
  }
  const key = createNativeTaskKey("openai", context.home, safeThreadId);
  const method = typeof notification.method === "string" && notification.method.length > 0
    ? redactSecrets(notification.method)
      .replace(/[\u0000-\u001f\u007f]/gu, "�")
      .slice(0, CODEX_DIAGNOSTIC_MAX_METHOD_LENGTH)
    : null;
  const shapeKeys = Object.freeze((params ? Object.keys(params) : [])
    .sort()
    .slice(0, CODEX_DIAGNOSTIC_MAX_SHAPE_KEYS)
    .map((keyName) => redactSecrets(keyName)
      .replace(/[\u0000-\u001f\u007f]/gu, "�")
      .slice(0, CODEX_DIAGNOSTIC_MAX_KEY_LENGTH)));
  return Object.freeze({
    type: "diagnostic" as const,
    provider: "openai" as const,
    key,
    occurredAt: context.occurredAt ?? new Date().toISOString(),
    level: code === "INVALID_CODEX_NOTIFICATION" ? "error" as const : "warning" as const,
    code,
    message,
    method,
    shapeKeys,
  });
};

const frozenEvents = (events: readonly ProviderEvent[]): readonly ProviderEvent[] =>
  Object.freeze([...events]);

const diffCounts = (diff: string): { additions: number; deletions: number; files: number } => {
  let additions = 0;
  let deletions = 0;
  let gitHeaders = 0;
  let plusHeaders = 0;
  for (const rawLine of diff.split(/\r?\n/u)) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("diff --git ")) gitHeaders += 1;
    else if (line.startsWith("+++ ") && !line.endsWith("/dev/null")) plusHeaders += 1;
    else if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return {
    additions,
    deletions,
    files: gitHeaders > 0 ? gitHeaders : plusHeaders,
  };
};

const itemStatusEvent = (
  threadId: string,
  turnId: string,
  item: Record<string, unknown>,
  fallback: "started" | "completed",
  context: CodexNormalizationContext,
): ProviderEvent => normalizedEvent({
  type: "status",
  scope: "item",
  status: status(item.status, fallback),
  nativeId: nativeId(item.id, "item.id"),
}, threadId, context);

const extractUserText = (item: Record<string, unknown>): string | null => {
  const content = array(item.content, "item.content");
  const chunks: string[] = [];
  for (const entry of content) {
    if (!isRecord(entry) || entry.type !== "text") continue;
    chunks.push(text(entry.text, "user input text"));
  }
  return chunks.length > 0 ? chunks.join("\n") : null;
};

const boundedActivityBody = (value: string): string => {
  // Redact the complete provider value first. Truncating first could expose a
  // credential prefix whose suffix fell just beyond the display boundary.
  const redacted = redactSecrets(value);
  if (Buffer.byteLength(JSON.stringify(redacted), "utf8") <= CODEX_MAX_ACTIVITY_BODY_JSON_BYTES) {
    return redacted;
  }
  const suffix = "\n… [output truncated at safe UI boundary]";
  let lower = 0;
  let upper = redacted.length;
  while (lower < upper) {
    const midpoint = Math.ceil((lower + upper) / 2);
    const candidate = `${redacted.slice(0, midpoint)}${suffix}`;
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= CODEX_MAX_ACTIVITY_BODY_JSON_BYTES) {
      lower = midpoint;
    } else {
      upper = midpoint - 1;
    }
  }
  // Avoid ending the visible prefix with one half of a UTF-16 surrogate pair.
  const end = lower > 0 && /[\uD800-\uDBFF]/u.test(redacted[lower - 1]!) ? lower - 1 : lower;
  return `${redacted.slice(0, end)}${suffix}`;
};

const optionalText = (
  value: unknown,
  field: string,
): string | null => value === null || value === undefined
  ? null
  : boundedActivityBody(text(value, field));

const fileChangeBody = (
  changesValue: unknown,
  field: string,
): string | null => {
  const changes = array(changesValue, field);
  if (changes.length === 0) return null;
  return boundedActivityBody(changes.map((entry, index) => {
    const change = record(entry, `${field}[${index}]`);
    return text(change.diff, `${field}[${index}].diff`);
  }).join("\n"));
};

const activityMessage = (
  item: Record<string, unknown>,
  itemType: string,
): string | null => {
  if (itemType === "commandExecution") {
    return optionalText(item.aggregatedOutput, "item.aggregatedOutput");
  }
  if (itemType === "fileChange") return fileChangeBody(item.changes, "item.changes");
  if (itemType === "collabAgentToolCall") {
    return boundedActivityBody(JSON.stringify({
      tool: item.tool,
      prompt: item.prompt ?? null,
      receiverThreadIds: item.receiverThreadIds,
      agentsStates: item.agentsStates,
    }));
  }
  if (itemType === "subAgentActivity") {
    return boundedActivityBody(JSON.stringify({
      kind: item.kind,
      agentThreadId: item.agentThreadId,
      agentPath: item.agentPath,
    }));
  }
  return null;
};

const normalizeItemNotification = (
  params: Record<string, unknown>,
  context: CodexNormalizationContext,
  phase: "started" | "completed",
): readonly ProviderEvent[] => {
  const threadId = nativeId(params.threadId, "threadId");
  const turnId = nativeId(params.turnId, "turnId");
  const item = record(params.item, "item");
  const itemId = nativeId(item.id, "item.id");
  const itemType = nativeId(item.type, "item.type");
  const events: ProviderEvent[] = [itemStatusEvent(threadId, turnId, item, phase, context)];

  if (phase === "started" && itemType === "userMessage") {
    const userText = extractUserText(item);
    if (userText !== null) {
      events.push(normalizedEvent({
        type: "message",
        role: "user",
        text: userText,
        turnId,
        itemId,
      }, threadId, context));
    }
  } else if (phase === "completed" && itemType === "agentMessage") {
    events.push(normalizedEvent({
      type: "message",
      role: "assistant",
      text: text(item.text, "agent message text"),
      turnId,
      itemId,
    }, threadId, context));
  } else if (phase === "completed" && itemType === "plan") {
    events.push(normalizedEvent({
      type: "plan",
      text: text(item.text, "plan text"),
      status: "completed",
      turnId,
      itemId,
      stepIndex: null,
    }, threadId, context));
  } else if (ACTIVITY_ITEM_TYPES.has(itemType)) {
    events.push(normalizedEvent({
      type: "activity",
      turnId,
      itemId,
      activity: itemType,
      status: status(item.status, phase),
      message: activityMessage(item, itemType),
    }, threadId, context));
  }
  return frozenEvents(events);
};

const normalizeTurnLifecycle = (
  params: Record<string, unknown>,
  context: CodexNormalizationContext,
): readonly ProviderEvent[] => {
  const threadId = nativeId(params.threadId, "threadId");
  const turn = record(params.turn, "turn");
  return frozenEvents([normalizedEvent({
    type: "status",
    scope: "turn",
    status: nativeId(turn.status, "turn.status"),
    nativeId: nativeId(turn.id, "turn.id"),
  }, threadId, context)]);
};

const normalizeKnownNotification = (
  notification: CodexRpcNotification,
  context: CodexNormalizationContext,
): readonly ProviderEvent[] => {
  const params = record(notification.params, "notification.params");
  switch (notification.method) {
    case "thread/started": {
      const thread = record(params.thread, "thread");
      const threadId = nativeId(thread.id, "thread.id");
      const threadStatus = record(thread.status, "thread.status");
      return frozenEvents([normalizedEvent({
        type: "status",
        scope: "task",
        status: nativeId(threadStatus.type, "thread.status.type"),
        nativeId: threadId,
      }, threadId, context)]);
    }
    case "thread/status/changed": {
      const threadId = nativeId(params.threadId, "threadId");
      const threadStatus = record(params.status, "status");
      return frozenEvents([normalizedEvent({
        type: "status",
        scope: "task",
        status: nativeId(threadStatus.type, "status.type"),
        nativeId: threadId,
      }, threadId, context)]);
    }
    case "thread/archived":
    case "thread/name/updated": {
      const threadId = nativeId(params.threadId, "threadId");
      return frozenEvents([normalizedEvent({
        type: "status",
        scope: "task",
        status: notification.method === "thread/archived" ? "archived" : "nameUpdated",
        nativeId: threadId,
      }, threadId, context)]);
    }
    case "thread/tokenUsage/updated": {
      const threadId = nativeId(params.threadId, "threadId");
      const turnId = nativeId(params.turnId, "turnId");
      const usage = record(params.tokenUsage, "tokenUsage");
      const total = record(usage.total, "tokenUsage.total");
      return frozenEvents([normalizedEvent({
        type: "usage",
        turnId,
        inputTokens: total.inputTokens,
        outputTokens: total.outputTokens,
        cachedInputTokens: total.cachedInputTokens,
        totalTokens: total.totalTokens,
      }, threadId, context)]);
    }
    case "turn/started":
    case "turn/completed":
      return normalizeTurnLifecycle(params, context);
    case "turn/diff/updated": {
      const threadId = nativeId(params.threadId, "threadId");
      const turnId = nativeId(params.turnId, "turnId");
      const diff = text(params.diff, "diff");
      const counts = diffCounts(diff);
      return frozenEvents([
        normalizedEvent({
          type: "diff-summary",
          turnId,
          changedFiles: counts.files,
          additions: counts.additions,
          deletions: counts.deletions,
        }, threadId, context),
        normalizedEvent({
          type: "activity",
          turnId,
          itemId: null,
          activity: "fileChange",
          status: "updated",
          message: boundedActivityBody(diff),
        }, threadId, context),
      ]);
    }
    case "turn/plan/updated": {
      const threadId = nativeId(params.threadId, "threadId");
      const turnId = nativeId(params.turnId, "turnId");
      return frozenEvents(array(params.plan, "plan").map((entry, index) => {
        const step = record(entry, `plan[${index}]`);
        return normalizedEvent({
          type: "plan",
          turnId,
          itemId: null,
          stepIndex: index,
          text: text(step.step, `plan[${index}].step`),
          status: nativeId(step.status, `plan[${index}].status`),
        }, threadId, context);
      }));
    }
    case "item/started":
      return normalizeItemNotification(params, context, "started");
    case "item/completed":
      return normalizeItemNotification(params, context, "completed");
    case "item/agentMessage/delta":
    case "item/plan/delta": {
      const threadId = nativeId(params.threadId, "threadId");
      const turnId = nativeId(params.turnId, "turnId");
      const itemId = nativeId(params.itemId, "itemId");
      const delta = text(params.delta, "delta");
      return frozenEvents([normalizedEvent(notification.method === "item/agentMessage/delta"
        ? {
          type: "message-delta",
          role: "assistant",
          delta,
          turnId,
          itemId,
        }
        : {
          type: "plan",
          text: delta,
          status: "streaming",
          turnId,
          itemId,
          stepIndex: null,
        }, threadId, context)]);
    }
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
      // Per-fragment redaction can leak credentials split across chunks. The
      // canonical completed item below is redacted as a whole and authoritative.
      return frozenEvents([]);
    case "item/fileChange/patchUpdated": {
      const threadId = nativeId(params.threadId, "threadId");
      const turnId = nativeId(params.turnId, "turnId");
      const itemId = nativeId(params.itemId, "itemId");
      const changes = array(params.changes, "changes");
      const body = fileChangeBody(changes, "changes");
      let additions = 0;
      let deletions = 0;
      changes.forEach((entry, index) => {
        const change = record(entry, `changes[${index}]`);
        const counts = diffCounts(text(change.diff, `changes[${index}].diff`));
        additions += counts.additions;
        deletions += counts.deletions;
      });
      return frozenEvents([
        normalizedEvent({
          type: "diff-summary",
          turnId,
          changedFiles: changes.length,
          additions,
          deletions,
        }, threadId, context),
        normalizedEvent({
          type: "activity",
          turnId,
          itemId,
          activity: "fileChange",
          status: "updated",
          message: body,
        }, threadId, context),
      ]);
    }
    case "error": {
      const threadId = nativeId(params.threadId, "threadId");
      const turnId = nativeId(params.turnId, "turnId");
      return frozenEvents([
        normalizedEvent({
          type: "status",
          scope: "turn",
          status: params.willRetry === true ? "retrying" : "failed",
          nativeId: turnId,
        }, threadId, context),
        diagnostic(notification, context, "CODEX_TURN_ERROR", "Codex reported a turn error", threadId),
      ]);
    }
    case "serverRequest/resolved":
      // Full turn/item/generation identity lives in CodexRequestBroker's bounded ledger.
      return frozenEvents([diagnostic(
        notification,
        context,
        "UNMATCHED_CODEX_REQUEST_RESOLUTION",
        "Codex request resolution requires broker correlation",
      )]);
    default:
      return frozenEvents([diagnostic(
        notification,
        context,
        "UNKNOWN_CODEX_NOTIFICATION",
        "Codex emitted an unknown notification",
      )]);
  }
};

/** Convert a stable Codex app-server notification into the browser-safe provider event union. */
export function normalizeCodexNotification(
  notification: CodexRpcNotification,
  context: CodexNormalizationContext,
): readonly ProviderEvent[] {
  generation(context.generation);
  if (!KNOWN_NOTIFICATIONS.has(notification.method)) {
    return frozenEvents([diagnostic(
      notification,
      context,
      "UNKNOWN_CODEX_NOTIFICATION",
      "Codex emitted an unknown notification",
    )]);
  }
  try {
    assertCodexFallbackParams("server-notification", notification.method, notification.params);
    return normalizeKnownNotification(notification, context);
  } catch {
    return frozenEvents([diagnostic(
      notification,
      context,
      "INVALID_CODEX_NOTIFICATION",
      "Codex emitted an invalid notification shape",
    )]);
  }
}

const requestIdentity = (
  requestId: JsonRpcRequestId,
  params: Record<string, unknown>,
  context: CodexNormalizationContext,
  options: { readonly itemId: string | null; readonly approvalId: JsonRpcRequestId | null },
) => createProviderRequestIdentity({
  key: createNativeTaskKey("openai", context.home, nativeId(params.threadId, "threadId")),
  generation: generation(context.generation),
  turnId: optionalNativeId(params.turnId, "turnId"),
  requestId,
  itemId: options.itemId,
  approvalId: options.approvalId,
});

const requestEvent = (
  request: ProviderRequest,
  context: CodexNormalizationContext,
): ProviderEvent => normalizeProviderEvent({ type: "request", request }, {
  provider: "openai",
  key: request.identity.key,
  ...(context.occurredAt === undefined ? {} : { occurredAt: context.occurredAt }),
});

const requestDetailEvents = (
  request: ProviderRequest,
  params: Record<string, unknown>,
  context: CodexNormalizationContext,
): readonly ProviderEvent[] => {
  if (request.kind !== "command-approval" || params.command === null || params.command === undefined) {
    return Object.freeze([]);
  }
  const command = boundedActivityBody(text(params.command, "command"));
  return frozenEvents([normalizedEvent({
    type: "activity",
    turnId: request.identity.turnId,
    itemId: request.identity.itemId,
    activity: "commandApproval",
    status: "waitingOnApproval",
    message: command,
  }, request.identity.key.nativeTaskId, context)]);
};

const inputQuestionIds = (params: Record<string, unknown>): readonly string[] => {
  const questions = array(params.questions, "questions");
  if (questions.length > CODEX_MAX_USER_INPUT_QUESTIONS) {
    throw new TypeError(`questions must contain at most ${CODEX_MAX_USER_INPUT_QUESTIONS} items`);
  }
  const seen = new Set<string>();
  const ids = questions.map((question, index) => {
    const value = record(question, `questions[${index}]`);
    const id = nativeId(value.id, `questions[${index}].id`);
    if (seen.has(id)) throw new TypeError("question ids must be unique");
    seen.add(id);
    return id;
  });
  return Object.freeze(ids);
};

const mcpApprovalId = (params: Record<string, unknown>): string | null => {
  const mode = nativeId(params.mode, "mode");
  nativeId(params.serverName, "serverName");
  text(params.message, "message");
  if (mode === "form") {
    record(params.requestedSchema, "requestedSchema");
    return null;
  }
  if (mode === "openai/form") {
    if (!own(params, "requestedSchema")) throw new TypeError("requestedSchema is required");
    return null;
  }
  if (mode === "url") {
    nativeId(params.url, "url");
    return nativeId(params.elicitationId, "elicitationId");
  }
  throw new TypeError("invalid MCP elicitation mode");
};

/** Strictly normalize one supported request plus bounded, redacted approval display context. */
export function normalizeCodexServerRequest(
  request: CodexRpcRequest,
  context: CodexNormalizationContext,
): Readonly<NormalizedCodexServerRequest> {
  generation(context.generation);
  try { assertCodexRpcId(request.id); } catch {
    throw new CodexNormalizationError(
      "INVALID_REQUEST",
      "Codex server request has an invalid or unsafe id",
    );
  }
  if (!SUPPORTED_REQUESTS.has(request.method)) {
    throw new CodexNormalizationError(
      "UNSUPPORTED_REQUEST",
      "Unsupported Codex server request method",
    );
  }
  try {
    assertCodexFallbackParams("server-request", request.method, request.params);
    const params = record(request.params, "request.params");
    let providerRequest: ProviderRequest;
    let questionIds: readonly string[] = Object.freeze([]);
    switch (request.method) {
      case "item/commandExecution/requestApproval": {
        const itemId = nativeId(params.itemId, "itemId");
        const approvalId = params.approvalId === null || params.approvalId === undefined
          ? null
          : nativeId(params.approvalId, "approvalId");
        providerRequest = {
          kind: "command-approval",
          identity: requestIdentity(request.id, params, context, { itemId, approvalId }),
        };
        break;
      }
      case "item/fileChange/requestApproval": {
        providerRequest = {
          kind: "file-change-approval",
          identity: requestIdentity(request.id, params, context, {
            itemId: nativeId(params.itemId, "itemId"),
            approvalId: null,
          }),
        };
        break;
      }
      case "item/permissions/requestApproval": {
        providerRequest = {
          kind: "permission",
          identity: requestIdentity(request.id, params, context, {
            itemId: nativeId(params.itemId, "itemId"),
            approvalId: null,
          }),
        };
        break;
      }
      case "item/tool/requestUserInput": {
        questionIds = inputQuestionIds(params);
        const declared = params.autoResolutionMs;
        const autoResolutionMs = typeof declared === "number" &&
            Number.isInteger(declared) &&
            declared >= AUTO_RESOLUTION_MIN_MS &&
            declared <= AUTO_RESOLUTION_MAX_MS
          ? declared
          : null;
        providerRequest = {
          kind: "user-input",
          identity: requestIdentity(request.id, params, context, {
            itemId: nativeId(params.itemId, "itemId"),
            approvalId: null,
          }),
          autoResolutionMs,
        };
        break;
      }
      case "mcpServer/elicitation/request": {
        providerRequest = {
          kind: "mcp-elicitation",
          identity: requestIdentity(request.id, params, context, {
            itemId: null,
            approvalId: mcpApprovalId(params),
          }),
        };
        break;
      }
      default:
        throw new TypeError("unsupported Codex server request method");
    }
    const event = requestEvent(providerRequest, context);
    if (event.type !== "request") throw new TypeError("request normalization failed");
    return Object.freeze({
      request: event.request,
      event,
      detailEvents: requestDetailEvents(event.request, params, context),
      questionIds,
    });
  } catch (error) {
    if (error instanceof CodexNormalizationError) throw error;
    throw new CodexNormalizationError(
      "INVALID_REQUEST",
      "Codex server request has an invalid or unsafe shape",
    );
  }
}
