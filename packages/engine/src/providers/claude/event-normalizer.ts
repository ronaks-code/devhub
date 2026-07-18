import { createHash } from "node:crypto";
import path from "node:path";
import { redactSecrets } from "../../redact.js";
import {
  normalizeProviderEventWithBackendDiagnostics,
  type BackendRawDiagnostic,
} from "../backend-diagnostics.js";
import type { ProviderEvent } from "../events.js";
import { normalizeProviderNativeId } from "../native-id.js";
import {
  canonicalizeProviderHome,
  createNativeTaskKey,
} from "../task-key.js";
import {
  buildClaudeModelObservation,
  type ClaudeModelEvidenceSource,
  type ClaudeModelObservation,
  type ClaudeModelUsageEvidence,
} from "./model-evidence.js";
import {
  classifyClaudeControlEnvelope,
  type ClaudeControlJsonObject,
} from "./protocol/control-shapes.js";

export const CLAUDE_EVENT_MAX_CONTENT_BLOCKS = 256;
export const CLAUDE_EVENT_MAX_MODEL_USAGE_ENTRIES = 256;
export const CLAUDE_EVENT_MAX_MESSAGE_STARTS = 4_096;
export const CLAUDE_EVENT_MAX_TEXT_DELTAS = 100_000;
export const CLAUDE_EVENT_MAX_TEXT_CHARS = 65_536;
export const CLAUDE_EVENT_MAX_RUNTIME_CAPABILITIES = 256;
export const CLAUDE_EVENT_MAX_TRACKED_TOOL_ACTIVITIES = 4_096;

const NATIVE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ClaudeEventNormalizerErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_CONTEXT";

export class ClaudeEventNormalizerError extends Error {
  readonly code: ClaudeEventNormalizerErrorCode;

  constructor(code: ClaudeEventNormalizerErrorCode, message: string) {
    super(message);
    this.name = "ClaudeEventNormalizerError";
    this.code = code;
    Object.freeze(this);
  }
}

export interface ClaudeEventNormalizerOptions {
  readonly home: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly canonicalizeHome?: (home: string) => string;
}

export interface ClaudeEventNormalizationContext {
  readonly turnId: string | null;
  readonly occurredAt: string;
}

export interface ClaudeNormalizedBackendEvent {
  readonly eventId: string;
  readonly event: ProviderEvent;
  readonly rawDiagnostic: BackendRawDiagnostic | null;
}

export interface ClaudeNormalizedEventBatch {
  readonly nativeEventId: string | null;
  readonly replayKey: string;
  readonly fingerprint: string;
  readonly events: readonly ClaudeNormalizedBackendEvent[];
  readonly modelObservations: readonly Readonly<ClaudeModelObservation>[];
  readonly runtimeCapabilities: readonly string[] | null;
}

class ProjectionFailure extends Error {}

const projectionFail = (): never => {
  throw new ProjectionFailure("Claude provider event is invalid");
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const record = (value: unknown): ClaudeControlJsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return projectionFail();
  return value as ClaudeControlJsonObject;
};

const optionalRecord = (value: unknown): ClaudeControlJsonObject | null =>
  value === undefined || value === null ? null : record(value);

const safeId = (value: unknown): string => {
  try {
    return normalizeProviderNativeId(value, "Claude provider event id");
  } catch {
    return projectionFail();
  }
};

const safeModel = (value: unknown): string | null =>
  value === undefined || value === null ? null : safeId(value);

const safeText = (value: unknown): string => {
  if (typeof value !== "string" || value.length > CLAUDE_EVENT_MAX_TEXT_CHARS ||
    value.includes("\u0000")) return projectionFail();
  return redactSecrets(value);
};

const boundedActivityMessage = (value: unknown): string => {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof serialized !== "string") return "";
  return redactSecrets(serialized)
    .replaceAll("\u0000", "")
    .slice(0, CLAUDE_EVENT_MAX_TEXT_CHARS);
};

const safeRuntimeCapabilities = (value: unknown): readonly string[] => {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > CLAUDE_EVENT_MAX_RUNTIME_CAPABILITIES) {
    return projectionFail();
  }
  const capabilities = value.map((capability) => safeId(capability));
  if (new Set(capabilities).size !== capabilities.length) return projectionFail();
  return Object.freeze(capabilities);
};

const count = (value: unknown): number => {
  const resolved = value ?? 0;
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved < 0) {
    return projectionFail();
  }
  return resolved === 0 ? 0 : resolved;
};

const cost = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return projectionFail();
  }
  return value === 0 ? 0 : value;
};

const sumCounts = (...values: readonly number[]): number => {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return projectionFail();
  }
  return total;
};

const usage = (
  value: unknown,
  kind: "reported" | "billed",
  style: "snake" | "camel",
  costUsd?: unknown,
): Readonly<ClaudeModelUsageEvidence> | null => {
  if (value === undefined || value === null) return null;
  const raw = record(value);
  const inputTokens = count(style === "snake" ? raw.input_tokens : raw.inputTokens);
  const outputTokens = count(style === "snake" ? raw.output_tokens : raw.outputTokens);
  const cacheReadTokens = count(
    style === "snake" ? raw.cache_read_input_tokens : raw.cacheReadInputTokens,
  );
  const cacheCreationTokens = count(
    style === "snake" ? raw.cache_creation_input_tokens : raw.cacheCreationInputTokens,
  );
  return Object.freeze({
    kind,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd: cost(costUsd),
  });
};

const strictTimestamp = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 32) {
    throw new ClaudeEventNormalizerError("INVALID_CONTEXT", "Claude event context is invalid");
  }
  try {
    if (new Date(value).toISOString() !== value) {
      throw new ClaudeEventNormalizerError("INVALID_CONTEXT", "Claude event context is invalid");
    }
  } catch (error) {
    if (error instanceof ClaudeEventNormalizerError) throw error;
    throw new ClaudeEventNormalizerError("INVALID_CONTEXT", "Claude event context is invalid");
  }
  return value;
};

const strictTurnId = (value: unknown): string | null => {
  if (value === null) return null;
  try {
    return normalizeProviderNativeId(value, "Claude turn id");
  } catch {
    throw new ClaudeEventNormalizerError("INVALID_CONTEXT", "Claude event context is invalid");
  }
};

const knownFrame = (raw: ClaudeControlJsonObject): boolean => {
  if (raw.type === "assistant" || raw.type === "user" || raw.type === "result") return true;
  if (raw.type === "system") {
    return raw.subtype === "init" || raw.subtype === "status" ||
      raw.subtype === "hook_started" || raw.subtype === "hook_response";
  }
  if (raw.type !== "stream_event") return false;
  const event = optionalRecord(raw.event);
  if (!event || typeof event.type !== "string") return true;
  return event.type === "message_start" || event.type === "message_delta" ||
    event.type === "message_stop" || event.type === "content_block_start" ||
    event.type === "content_block_delta" || event.type === "content_block_stop";
};

const boundaryRecord = (
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  code: ClaudeEventNormalizerErrorCode,
): Readonly<Record<string, unknown>> => {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const keys = Reflect.ownKeys(value);
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    if (
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      requiredKeys.some((key) => !keys.includes(key))
    ) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key as string];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error();
      snapshot[key as string] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    throw new ClaudeEventNormalizerError(
      code,
      code === "INVALID_CONTEXT"
        ? "Claude event context is invalid"
        : "Claude event normalizer configuration is invalid",
    );
  }
};

export class ClaudeEventNormalizer {
  private readonly homeValue: string;
  private readonly sessionIdValue: string;
  private readonly generationValue: number;
  private readonly taskKey;
  private readonly messageIdByStream = new Map<string, string>();
  private readonly messageStartByEventId = new Map<
    string,
    { readonly fingerprint: string; readonly messageId: string; readonly streamKey: string }
  >();
  private readonly textDeltaByEventId = new Map<
    string,
    { readonly fingerprint: string; readonly messageId: string | null; readonly streamKey: string }
  >();
  private readonly trackedToolActivities = new Map<string, "subagent" | "background-task">();

  constructor(options: ClaudeEventNormalizerOptions) {
    const supplied = boundaryRecord(
      options,
      ["home", "sessionId", "generation"],
      ["canonicalizeHome"],
      "INVALID_CONFIGURATION",
    );
    const canonicalizer = supplied.canonicalizeHome ?? canonicalizeProviderHome;
    if (typeof canonicalizer !== "function") {
      throw new ClaudeEventNormalizerError(
        "INVALID_CONFIGURATION",
        "Claude event normalizer configuration is invalid",
      );
    }
    let home: string;
    try {
      home = typeof supplied.home === "string"
        ? (canonicalizer as (home: string) => string)(supplied.home)
        : "";
    } catch {
      throw new ClaudeEventNormalizerError(
        "INVALID_CONFIGURATION",
        "Claude event normalizer configuration is invalid",
      );
    }
    if (
      typeof supplied.home !== "string" ||
      supplied.home.trim() !== supplied.home ||
      supplied.home.includes("\u0000") ||
      !path.isAbsolute(supplied.home) ||
      home !== supplied.home ||
      typeof supplied.sessionId !== "string" ||
      !NATIVE_UUID.test(supplied.sessionId) ||
      !Number.isSafeInteger(supplied.generation) ||
      (supplied.generation as number) < 1
    ) {
      throw new ClaudeEventNormalizerError(
        "INVALID_CONFIGURATION",
        "Claude event normalizer configuration is invalid",
      );
    }
    try {
      this.taskKey = createNativeTaskKey("anthropic", home, supplied.sessionId);
    } catch {
      throw new ClaudeEventNormalizerError(
        "INVALID_CONFIGURATION",
        "Claude event normalizer configuration is invalid",
      );
    }
    this.homeValue = home;
    this.sessionIdValue = supplied.sessionId;
    this.generationValue = supplied.generation as number;
  }

  normalize(decodedObject: unknown, context: ClaudeEventNormalizationContext): ClaudeNormalizedEventBatch {
    const suppliedContext = boundaryRecord(
      context,
      ["turnId", "occurredAt"],
      [],
      "INVALID_CONTEXT",
    );
    const occurredAt = strictTimestamp(suppliedContext.occurredAt);
    const turnId = strictTurnId(suppliedContext.turnId);
    let raw: ClaudeControlJsonObject;
    let fingerprint: string;
    try {
      const classified = classifyClaudeControlEnvelope(decodedObject);
      if (classified.kind !== "not-control") return projectionFail();
      raw = classified.raw;
      fingerprint = sha256(JSON.stringify(raw));
    } catch {
      fingerprint = sha256("unsafe-decoded-claude-event");
      return this.diagnosticBatch(
        null,
        fingerprint,
        { type: "unsafe-decoded-claude-event" },
        turnId,
        occurredAt,
      );
    }

    let isKnown: boolean;
    try {
      isKnown = knownFrame(raw);
    } catch {
      const candidateId = typeof raw.uuid === "string" && NATIVE_UUID.test(raw.uuid)
        ? raw.uuid
        : null;
      return this.diagnosticBatch(candidateId, fingerprint, raw, turnId, occurredAt);
    }
    if (!isKnown) {
      return this.diagnosticBatch(null, fingerprint, raw, turnId, occurredAt);
    }
    const nativeEventId = typeof raw.uuid === "string" && NATIVE_UUID.test(raw.uuid)
      ? raw.uuid
      : null;
    if (nativeEventId === null) {
      return this.diagnosticBatch(null, fingerprint, raw, turnId, occurredAt);
    }
    if (raw.session_id !== this.sessionIdValue) {
      return this.diagnosticBatch(nativeEventId, fingerprint, raw, turnId, occurredAt);
    }

    try {
      return this.projectKnown(raw, nativeEventId, fingerprint, turnId, occurredAt);
    } catch {
      return this.diagnosticBatch(nativeEventId, fingerprint, raw, turnId, occurredAt);
    }
  }

  private projectKnown(
    raw: ClaudeControlJsonObject,
    nativeEventId: string,
    fingerprint: string,
    turnId: string | null,
    occurredAt: string,
  ): ClaudeNormalizedEventBatch {
    const events: ClaudeNormalizedBackendEvent[] = [];
    const models: Readonly<ClaudeModelObservation>[] = [];
    let runtimeCapabilities: readonly string[] | null = null;
    let commitState: (() => void) | null = null;
    const addEvent = (input: unknown): void => {
      const normalized = normalizeProviderEventWithBackendDiagnostics(input, {
        provider: "anthropic",
        key: this.taskKey,
        occurredAt,
      });
      if (normalized.event.type === "diagnostic") return projectionFail();
      events.push(Object.freeze({
        eventId: `${nativeEventId}:event:${events.length}`,
        event: normalized.event,
        rawDiagnostic: normalized.rawDiagnostic,
      }));
    };
    const addModel = (
      source: Exclude<ClaudeModelEvidenceSource, "requested">,
      model: string | null,
      modelUsage: Readonly<ClaudeModelUsageEvidence> | null,
    ): void => {
      models.push(buildClaudeModelObservation({
        id: `${nativeEventId}:model:${source}:${models.length}`,
        source,
        sourceEventId: nativeEventId,
        sessionId: this.sessionIdValue,
        generation: this.generationValue,
        turnId,
        occurredAt,
        model,
        usage: modelUsage,
      }));
    };

    if (raw.type === "system") {
      if (raw.subtype === "init") {
        runtimeCapabilities = safeRuntimeCapabilities(raw.capabilities);
        addEvent({
          type: "status",
          scope: "task",
          status: "initialized",
          nativeId: this.sessionIdValue,
        });
        addModel("system-init", safeModel(raw.model), null);
      } else if (raw.subtype === "status") {
        if (raw.status !== null) {
          addEvent({
            type: "status",
            scope: "task",
            status: safeText(raw.status),
            nativeId: this.sessionIdValue,
          });
        }
      } else {
        const hookId = safeId(raw.hook_id);
        const hookName = safeId(raw.hook_name);
        const hookEvent = safeId(raw.hook_event);
        const failed = raw.subtype === "hook_response" &&
          (raw.is_error === true || (typeof raw.exit_code === "number" && raw.exit_code !== 0));
        addEvent({
          type: "activity",
          turnId,
          itemId: hookId,
          activity: `hook:${hookEvent}`,
          status: raw.subtype === "hook_started" ? "running" : failed ? "error" : "completed",
          message: hookName,
        });
      }
    } else if (raw.type === "stream_event") {
      const event = record(raw.event);
      const streamKey = this.streamCorrelationKey(raw, turnId);
      if (event.type === "message_start") {
        const message = record(event.message);
        const messageId = safeId(message.id);
        const prior = this.messageStartByEventId.get(nativeEventId);
        if (
          prior &&
          (prior.fingerprint !== fingerprint ||
            prior.messageId !== messageId ||
            prior.streamKey !== streamKey)
        ) return projectionFail();
        if (!prior && this.messageStartByEventId.size >= CLAUDE_EVENT_MAX_MESSAGE_STARTS) {
          return projectionFail();
        }
        const reported = usage(message.usage, "reported", "snake");
        addModel("stream-message-start", safeModel(message.model), reported);
        if (reported) addEvent(this.usageEvent(reported, turnId));
        if (!prior) {
          commitState = () => {
            this.messageStartByEventId.set(nativeEventId, {
              fingerprint,
              messageId,
              streamKey,
            });
            this.messageIdByStream.set(streamKey, messageId);
          };
        }
      } else if (event.type === "content_block_delta") {
        const delta = record(event.delta);
        if (delta.type === "text_delta") {
          const prior = this.textDeltaByEventId.get(nativeEventId);
          if (
            prior &&
            (prior.fingerprint !== fingerprint || prior.streamKey !== streamKey)
          ) return projectionFail();
          if (!prior && this.textDeltaByEventId.size >= CLAUDE_EVENT_MAX_TEXT_DELTAS) {
            return projectionFail();
          }
          const messageId = prior
            ? prior.messageId
            : this.messageIdByStream.get(streamKey) ?? null;
          if (messageId === null) {
            if (!prior) {
              this.textDeltaByEventId.set(nativeEventId, {
                fingerprint,
                messageId: null,
                streamKey,
              });
            }
            return projectionFail();
          }
          addEvent({
            type: "message-delta",
            role: "assistant",
            delta: safeText(delta.text),
            turnId,
            itemId: messageId,
          });
          if (!prior) {
            commitState = () => {
              this.textDeltaByEventId.set(nativeEventId, {
                fingerprint,
                messageId,
                streamKey,
              });
            };
          }
        }
      }
      // Other partial-message frames intentionally carry no browser content.
    } else if (raw.type === "assistant" || raw.type === "user") {
      const message = record(raw.message);
      let itemId: string | null = null;
      if (message.id !== undefined && message.id !== null) itemId = safeId(message.id);
      if (raw.type === "assistant") {
        itemId ??= this.messageIdByStream.get(this.streamCorrelationKey(raw, turnId)) ?? null;
      }
      const content = message.content;
      if (!Array.isArray(content) || content.length > CLAUDE_EVENT_MAX_CONTENT_BLOCKS) {
        return projectionFail();
      }
      for (const blockValue of content) {
        const block = record(blockValue);
        if (block.type === "text") {
          addEvent({
            type: "message",
            role: raw.type,
            text: safeText(block.text),
            turnId,
            itemId,
          });
        } else if (raw.type === "assistant" && block.type === "tool_use") {
          const toolUseId = safeId(block.id);
          const toolName = safeId(block.name);
          const input = optionalRecord(block.input);
          const activity = toolName === "Task" || toolName === "Agent"
            ? "subagent" as const
            : input?.run_in_background === true
              ? "background-task" as const
              : null;
          if (activity) {
            if (
              !this.trackedToolActivities.has(toolUseId) &&
              this.trackedToolActivities.size >= CLAUDE_EVENT_MAX_TRACKED_TOOL_ACTIVITIES
            ) return projectionFail();
            this.trackedToolActivities.set(toolUseId, activity);
            addEvent({
              type: "activity",
              turnId,
              itemId: toolUseId,
              activity,
              status: "running",
              message: boundedActivityMessage({
                label: input?.description ?? input?.prompt ?? toolName,
                description: input?.description ?? null,
                agentType: input?.subagent_type ?? null,
                prompt: input?.prompt ?? null,
              }),
            });
          } else {
            addEvent({
              type: "activity",
              turnId,
              itemId: toolUseId,
              activity: "tool-use",
              status: "requested",
              message: toolName,
            });
          }
        } else if (raw.type === "user" && block.type === "tool_result") {
          const toolUseId = safeId(block.tool_use_id);
          const activity = this.trackedToolActivities.get(toolUseId);
          if (activity) {
            addEvent({
              type: "activity",
              turnId,
              itemId: toolUseId,
              activity,
              status: block.is_error === true ? "failed" : "completed",
              message: boundedActivityMessage(block.content),
            });
          }
        }
      }
      if (raw.type === "assistant") {
        addModel(
          "assistant-message",
          safeModel(message.model),
          usage(message.usage, "reported", "snake"),
        );
      }
    } else if (raw.type === "result") {
      addEvent({
        type: "status",
        scope: "turn",
        status: safeId(raw.subtype),
        nativeId: turnId,
      });
      const totalUsage = usage(raw.usage, "billed", "snake", raw.total_cost_usd);
      if (totalUsage) addEvent(this.usageEvent(totalUsage, turnId));
      const modelUsage = optionalRecord(raw.modelUsage);
      if (modelUsage) {
        const modelNames = Object.keys(modelUsage).sort();
        if (modelNames.length > CLAUDE_EVENT_MAX_MODEL_USAGE_ENTRIES) return projectionFail();
        for (const modelName of modelNames) {
          const model = safeId(modelName);
          const value = record(modelUsage[modelName]);
          addModel(
            "result-model-usage",
            model,
            usage(value, "billed", "camel", value.costUSD),
          );
        }
      }
      if (totalUsage) addModel("result-total-usage", null, totalUsage);
    }

    const batch = Object.freeze({
      nativeEventId,
      replayKey: nativeEventId,
      fingerprint,
      events: Object.freeze(events),
      modelObservations: Object.freeze(models),
      runtimeCapabilities,
    });
    commitState?.();
    return batch;
  }

  private usageEvent(
    value: Readonly<ClaudeModelUsageEvidence>,
    turnId: string | null,
  ): unknown {
    const cachedInputTokens = sumCounts(value.cacheReadTokens, value.cacheCreationTokens);
    return {
      type: "usage",
      turnId,
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      cachedInputTokens,
      totalTokens: sumCounts(value.inputTokens, value.outputTokens, cachedInputTokens),
    };
  }

  private streamCorrelationKey(
    raw: ClaudeControlJsonObject,
    turnId: string | null,
  ): string {
    const parentToolUseId = raw.parent_tool_use_id === undefined || raw.parent_tool_use_id === null
      ? null
      : safeId(raw.parent_tool_use_id);
    return JSON.stringify([turnId, parentToolUseId]);
  }

  private diagnosticBatch(
    nativeEventId: string | null,
    fingerprint: string,
    raw: unknown,
    turnId: string | null,
    occurredAt: string,
  ): ClaudeNormalizedEventBatch {
    const replayKey = nativeEventId ?? `diagnostic:${fingerprint}`;
    const normalized = normalizeProviderEventWithBackendDiagnostics({
      type: "claude-event-diagnostic",
      turnId,
      raw,
    }, {
      provider: "anthropic",
      key: this.taskKey,
      occurredAt,
    });
    const event = Object.freeze({
      eventId: `${replayKey}:event:0`,
      event: normalized.event,
      rawDiagnostic: normalized.rawDiagnostic,
    });
    return Object.freeze({
      nativeEventId,
      replayKey,
      fingerprint,
      events: Object.freeze([event]),
      modelObservations: Object.freeze([]),
      runtimeCapabilities: null,
    });
  }
}
