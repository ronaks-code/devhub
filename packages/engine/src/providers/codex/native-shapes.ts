import { redactSecrets } from "../../redact.js";
import { assertCodexFallbackResult } from "./protocol/fallback-shapes.js";

export const MAX_CODEX_LIST_THREADS = 256;
export const MAX_CODEX_THREAD_TURNS = 2_048;
export const MAX_CODEX_TURN_ITEMS = 4_096;

const MAX_NATIVE_ID_CHARS = 512;
const MAX_PROVIDER_CURSOR_CHARS = 2_048;
const MAX_PATH_CHARS = 16_384;
const MAX_DISPLAY_TEXT_CHARS = 32_768;
const MAX_CONTENT_STRING_CHARS = 1_048_576;
const MAX_GENERIC_ARRAY_ITEMS = 10_000;
const MAX_GENERIC_OBJECT_KEYS = 256;
const MAX_GENERIC_DEPTH = 32;
const MAX_GENERIC_NODES = 200_000;

const THREAD_STATUSES = ["notLoaded", "idle", "systemError", "active"] as const;
const THREAD_ACTIVE_FLAGS = ["waitingOnApproval", "waitingOnUserInput"] as const;
const TURN_STATUSES = ["completed", "interrupted", "failed", "inProgress"] as const;
const TURN_ITEM_VIEWS = ["notLoaded", "summary", "full"] as const;
const SESSION_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "unknown"] as const;
const ITEM_TYPES = [
  "userMessage",
  "hookPrompt",
  "agentMessage",
  "plan",
  "reasoning",
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
] as const;

export type CodexThreadStatus = (typeof THREAD_STATUSES)[number];
export type CodexThreadActiveFlag = (typeof THREAD_ACTIVE_FLAGS)[number];
export type CodexTurnStatus = (typeof TURN_STATUSES)[number];
export type CodexTurnItemsView = (typeof TURN_ITEM_VIEWS)[number];
export type CodexNativeItemType = (typeof ITEM_TYPES)[number];
export type CodexSessionSourceKind =
  | (typeof SESSION_SOURCE_KINDS)[number]
  | "custom"
  | "subAgent";

export interface CodexNativeItemMetadata {
  readonly id: string;
  readonly type: CodexNativeItemType;
  readonly status: string | null;
}

export interface CodexNativeTurnMetadata {
  readonly id: string;
  readonly status: CodexTurnStatus;
  readonly itemsView: CodexTurnItemsView;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly durationMs: number | null;
  readonly items: readonly CodexNativeItemMetadata[];
}

export interface CodexNativeThreadMetadata {
  readonly id: string;
  readonly sessionId: string;
  readonly forkedFromId: string | null;
  readonly parentThreadId: string | null;
  readonly name: string | null;
  readonly preview: string;
  readonly cwd: string;
  readonly cliVersion: string;
  readonly modelProvider: string;
  readonly sourceKind: CodexSessionSourceKind;
  readonly ephemeral: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly recencyAt: number | null;
  readonly status: CodexThreadStatus;
  readonly activeFlags: readonly CodexThreadActiveFlag[];
  /** List responses establish archive state; other methods cannot prove it. */
  readonly archived: boolean | null;
  readonly turns: readonly CodexNativeTurnMetadata[];
}

export interface CodexNativeThreadListResult {
  readonly threads: readonly CodexNativeThreadMetadata[];
  readonly nextCursor: string | null;
  readonly backwardsCursor: string | null;
}

export interface CodexNativeThreadResult {
  readonly thread: CodexNativeThreadMetadata;
}

export type CodexApprovalPolicyKind = "untrusted" | "on-request" | "never" | "granular";
export type CodexApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
export type CodexSandboxType =
  | "dangerFullAccess"
  | "readOnly"
  | "externalSandbox"
  | "workspaceWrite";

export interface CodexNativeConfiguredThreadResult extends CodexNativeThreadResult {
  readonly model: string;
  readonly modelProvider: string;
  readonly cwd: string;
  readonly approvalPolicy: CodexApprovalPolicyKind;
  readonly approvalsReviewer: CodexApprovalsReviewer;
  readonly sandboxType: CodexSandboxType;
  readonly reasoningEffort: string | null;
}

export interface CodexNativeTurnStartResult {
  readonly turn: CodexNativeTurnMetadata;
}

export type CodexNativeShapeErrorCode = "INVALID_NATIVE_SHAPE";

/** A value-free boundary error: provider payload values are never reflected. */
export class CodexNativeShapeError extends Error {
  readonly code: CodexNativeShapeErrorCode = "INVALID_NATIVE_SHAPE";
  readonly method: string;
  readonly field: string;

  constructor(method: string, field: string) {
    super(`${method} returned an incompatible native shape at ${field}`);
    this.name = "CodexNativeShapeError";
    this.method = method;
    this.field = field;
  }
}

function fail(method: string, field: string): never {
  throw new CodexNativeShapeError(method, field);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function record(value: unknown, method: string, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(method, field);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail(method, field);
  return value as Record<string, unknown>;
}

function array(
  value: unknown,
  method: string,
  field: string,
  maxItems: number,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maxItems) return fail(method, field);
  return value;
}

function boundedString(
  value: unknown,
  method: string,
  field: string,
  maxChars: number,
  allowEmpty = true,
): string {
  if (
    typeof value !== "string" ||
    value.length > maxChars ||
    value.includes("\u0000") ||
    (!allowEmpty && value.length === 0)
  ) {
    return fail(method, field);
  }
  return value;
}

function redactedString(
  value: unknown,
  method: string,
  field: string,
  maxChars: number,
  allowEmpty = true,
): string {
  return redactSecrets(boundedString(value, method, field, maxChars, allowEmpty));
}

function nativeId(value: unknown, method: string, field: string): string {
  const parsed = boundedString(value, method, field, MAX_NATIVE_ID_CHARS, false);
  if (
    parsed.trim() !== parsed ||
    /[\u0000-\u001f\u007f]/u.test(parsed) ||
    redactSecrets(parsed) !== parsed
  ) {
    return fail(method, field);
  }
  return parsed;
}

function nullableNativeId(value: unknown, method: string, field: string): string | null {
  return value === null ? null : nativeId(value, method, field);
}

function nullableString(
  value: unknown,
  method: string,
  field: string,
  maxChars: number,
  redact: boolean,
): string | null {
  if (value === null) return null;
  return redact
    ? redactedString(value, method, field, maxChars)
    : boundedString(value, method, field, maxChars);
}

function safeInteger(
  value: unknown,
  method: string,
  field: string,
  nullable: false,
): number;
function safeInteger(
  value: unknown,
  method: string,
  field: string,
  nullable: true,
): number | null;
function safeInteger(
  value: unknown,
  method: string,
  field: string,
  nullable: boolean,
): number | null {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) return fail(method, field);
  return value as number;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  method: string,
  field: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) return fail(method, field);
  return value as Values[number];
}

function assertBoolean(value: unknown, method: string, field: string): boolean {
  if (typeof value !== "boolean") return fail(method, field);
  return value;
}

function assertBoundedJson(value: unknown, method: string): void {
  let nodes = 0;
  const ancestors = new Set<object>();

  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_GENERIC_NODES || depth > MAX_GENERIC_DEPTH) return fail(method, "$size");
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "string") {
      if (current.length > MAX_CONTENT_STRING_CHARS || current.includes("\u0000")) {
        return fail(method, "$size");
      }
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return fail(method, "$number");
      return;
    }
    if (typeof current !== "object") return fail(method, "$json");
    const prototype = Object.getPrototypeOf(current);
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
      return fail(method, "$json");
    }
    if (ancestors.has(current)) return fail(method, "$cycle");
    ancestors.add(current);
    if (Array.isArray(current)) {
      if (current.length > MAX_GENERIC_ARRAY_ITEMS) return fail(method, "$size");
      for (const child of current) visit(child, depth + 1);
    } else {
      const keys = Reflect.ownKeys(current);
      if (keys.length > MAX_GENERIC_OBJECT_KEYS) return fail(method, "$size");
      for (const key of keys) {
        if (typeof key !== "string" || key.length > 256) return fail(method, "$json");
        visit((current as Record<string, unknown>)[key], depth + 1);
      }
    }
    ancestors.delete(current);
  };

  visit(value, 0);
}

function validateFallback(method: string, value: unknown): void {
  try {
    assertBoundedJson(value, method);
    assertCodexFallbackResult("client-request", method, value);
  } catch (error) {
    if (error instanceof CodexNativeShapeError) throw error;
    throw new CodexNativeShapeError(method, "$schema");
  }
}

function parseSource(value: unknown, method: string, field: string): CodexSessionSourceKind {
  if (typeof value === "string") {
    return enumValue(value, SESSION_SOURCE_KINDS, method, field);
  }
  const source = record(value, method, field);
  const hasCustom = hasOwn(source, "custom");
  const hasSubAgent = hasOwn(source, "subAgent");
  if (hasCustom === hasSubAgent) return fail(method, field);
  if (Object.keys(source).length !== 1) return fail(method, field);
  if (hasCustom) {
    boundedString(source.custom, method, `${field}.custom`, MAX_DISPLAY_TEXT_CHARS);
    return "custom";
  }
  const subAgent = source.subAgent;
  if (typeof subAgent === "string") {
    enumValue(
      subAgent,
      ["review", "compact", "memory_consolidation"] as const,
      method,
      `${field}.subAgent`,
    );
    return "subAgent";
  }
  const variant = record(subAgent, method, `${field}.subAgent`);
  const hasThreadSpawn = hasOwn(variant, "thread_spawn");
  const hasOther = hasOwn(variant, "other");
  if (hasThreadSpawn === hasOther || Object.keys(variant).length !== 1) return fail(method, field);
  if (hasOther) {
    boundedString(variant.other, method, `${field}.subAgent.other`, MAX_DISPLAY_TEXT_CHARS);
    return "subAgent";
  }
  const spawn = record(variant.thread_spawn, method, `${field}.subAgent.thread_spawn`);
  nativeId(
    spawn.parent_thread_id,
    method,
    `${field}.subAgent.thread_spawn.parent_thread_id`,
  );
  safeInteger(spawn.depth, method, `${field}.subAgent.thread_spawn.depth`, false);
  return "subAgent";
}

function parseThreadStatus(
  value: unknown,
  method: string,
  field: string,
): { status: CodexThreadStatus; activeFlags: readonly CodexThreadActiveFlag[] } {
  const status = record(value, method, field);
  const type = enumValue(status.type, THREAD_STATUSES, method, `${field}.type`);
  if (type !== "active") return { status: type, activeFlags: Object.freeze([]) };
  const flags = array(status.activeFlags, method, `${field}.activeFlags`, 8).map((flag, index) =>
    enumValue(flag, THREAD_ACTIVE_FLAGS, method, `${field}.activeFlags[${index}]`));
  if (new Set(flags).size !== flags.length) return fail(method, `${field}.activeFlags`);
  return { status: type, activeFlags: Object.freeze(flags) };
}

function requiredArray(
  item: Record<string, unknown>,
  name: string,
  method: string,
  field: string,
  maxItems = MAX_GENERIC_ARRAY_ITEMS,
): readonly unknown[] {
  if (!hasOwn(item, name)) return fail(method, `${field}.${name}`);
  return array(item[name], method, `${field}.${name}`, maxItems);
}

function requiredText(
  item: Record<string, unknown>,
  name: string,
  method: string,
  field: string,
): string {
  if (!hasOwn(item, name)) return fail(method, `${field}.${name}`);
  return boundedString(item[name], method, `${field}.${name}`, MAX_CONTENT_STRING_CHARS);
}

function itemStatus(
  item: Record<string, unknown>,
  method: string,
  field: string,
  values: readonly string[] | null,
): string | null {
  if (values === null) return null;
  if (!hasOwn(item, "status")) return fail(method, `${field}.status`);
  if (values.length === 0) {
    return redactedString(item.status, method, `${field}.status`, 64, false);
  }
  return enumValue(item.status, values, method, `${field}.status`);
}

function parseItem(value: unknown, method: string, field: string): CodexNativeItemMetadata {
  const item = record(value, method, field);
  const id = nativeId(item.id, method, `${field}.id`);
  const type = enumValue(item.type, ITEM_TYPES, method, `${field}.type`);
  let status: string | null = null;

  switch (type) {
    case "userMessage":
      requiredArray(item, "content", method, field, 256);
      break;
    case "hookPrompt":
      requiredArray(item, "fragments", method, field, 256);
      break;
    case "agentMessage":
    case "plan":
      requiredText(item, "text", method, field);
      break;
    case "reasoning":
      if (hasOwn(item, "summary")) requiredArray(item, "summary", method, field, 1_024);
      if (hasOwn(item, "content")) requiredArray(item, "content", method, field, 1_024);
      break;
    case "commandExecution":
      requiredText(item, "command", method, field);
      requiredText(item, "cwd", method, field);
      requiredArray(item, "commandActions", method, field, 2_048);
      status = itemStatus(
        item,
        method,
        field,
        ["inProgress", "completed", "failed", "declined"],
      );
      break;
    case "fileChange":
      requiredArray(item, "changes", method, field, 4_096);
      status = itemStatus(
        item,
        method,
        field,
        ["inProgress", "completed", "failed", "declined"],
      );
      break;
    case "mcpToolCall":
      requiredText(item, "server", method, field);
      requiredText(item, "tool", method, field);
      if (!hasOwn(item, "arguments")) return fail(method, `${field}.arguments`);
      status = itemStatus(item, method, field, ["inProgress", "completed", "failed"]);
      break;
    case "dynamicToolCall":
      requiredText(item, "tool", method, field);
      if (!hasOwn(item, "arguments")) return fail(method, `${field}.arguments`);
      status = itemStatus(item, method, field, ["inProgress", "completed", "failed"]);
      break;
    case "collabAgentToolCall":
      requiredText(item, "tool", method, field);
      requiredText(item, "senderThreadId", method, field);
      requiredArray(item, "receiverThreadIds", method, field, 1_024);
      if (!hasOwn(item, "agentsStates")) return fail(method, `${field}.agentsStates`);
      record(item.agentsStates, method, `${field}.agentsStates`);
      status = itemStatus(item, method, field, ["inProgress", "completed", "failed"]);
      break;
    case "subAgentActivity":
      requiredText(item, "kind", method, field);
      requiredText(item, "agentThreadId", method, field);
      requiredText(item, "agentPath", method, field);
      break;
    case "webSearch":
      requiredText(item, "query", method, field);
      break;
    case "imageView":
      requiredText(item, "path", method, field);
      break;
    case "sleep":
      safeInteger(item.durationMs, method, `${field}.durationMs`, false);
      break;
    case "imageGeneration":
      requiredText(item, "result", method, field);
      status = itemStatus(item, method, field, []);
      break;
    case "enteredReviewMode":
    case "exitedReviewMode":
      requiredText(item, "review", method, field);
      break;
    case "contextCompaction":
      break;
  }

  return Object.freeze({ id, type, status });
}

function parseTurn(value: unknown, method: string, field: string): CodexNativeTurnMetadata {
  const turn = record(value, method, field);
  const id = nativeId(turn.id, method, `${field}.id`);
  const status = enumValue(turn.status, TURN_STATUSES, method, `${field}.status`);
  const itemsView = hasOwn(turn, "itemsView")
    ? enumValue(turn.itemsView, TURN_ITEM_VIEWS, method, `${field}.itemsView`)
    : "full";
  const startedAt = hasOwn(turn, "startedAt")
    ? safeInteger(turn.startedAt, method, `${field}.startedAt`, true)
    : null;
  const completedAt = hasOwn(turn, "completedAt")
    ? safeInteger(turn.completedAt, method, `${field}.completedAt`, true)
    : null;
  const durationMs = hasOwn(turn, "durationMs")
    ? safeInteger(turn.durationMs, method, `${field}.durationMs`, true)
    : null;
  const items = array(turn.items, method, `${field}.items`, MAX_CODEX_TURN_ITEMS).map(
    (item, index) => parseItem(item, method, `${field}.items[${index}]`),
  );
  return Object.freeze({
    id,
    status,
    itemsView,
    startedAt,
    completedAt,
    durationMs,
    items: Object.freeze(items),
  });
}

function parseThread(
  value: unknown,
  method: string,
  field: string,
  archived: boolean | null,
): CodexNativeThreadMetadata {
  const thread = record(value, method, field);
  const parsedStatus = parseThreadStatus(thread.status, method, `${field}.status`);
  const turns = array(thread.turns, method, `${field}.turns`, MAX_CODEX_THREAD_TURNS).map(
    (turn, index) => parseTurn(turn, method, `${field}.turns[${index}]`),
  );
  return Object.freeze({
    id: nativeId(thread.id, method, `${field}.id`),
    sessionId: nativeId(thread.sessionId, method, `${field}.sessionId`),
    forkedFromId: hasOwn(thread, "forkedFromId")
      ? nullableNativeId(thread.forkedFromId, method, `${field}.forkedFromId`)
      : null,
    parentThreadId: hasOwn(thread, "parentThreadId")
      ? nullableNativeId(thread.parentThreadId, method, `${field}.parentThreadId`)
      : null,
    name: hasOwn(thread, "name")
      ? nullableString(thread.name, method, `${field}.name`, MAX_DISPLAY_TEXT_CHARS, true)
      : null,
    preview: redactedString(thread.preview, method, `${field}.preview`, MAX_DISPLAY_TEXT_CHARS),
    cwd: redactedString(thread.cwd, method, `${field}.cwd`, MAX_PATH_CHARS, false),
    cliVersion: redactedString(
      thread.cliVersion,
      method,
      `${field}.cliVersion`,
      MAX_DISPLAY_TEXT_CHARS,
      false,
    ),
    modelProvider: redactedString(
      thread.modelProvider,
      method,
      `${field}.modelProvider`,
      MAX_DISPLAY_TEXT_CHARS,
      false,
    ),
    sourceKind: parseSource(thread.source, method, `${field}.source`),
    ephemeral: assertBoolean(thread.ephemeral, method, `${field}.ephemeral`),
    createdAt: safeInteger(thread.createdAt, method, `${field}.createdAt`, false),
    updatedAt: safeInteger(thread.updatedAt, method, `${field}.updatedAt`, false),
    recencyAt: hasOwn(thread, "recencyAt")
      ? safeInteger(thread.recencyAt, method, `${field}.recencyAt`, true)
      : null,
    status: parsedStatus.status,
    activeFlags: parsedStatus.activeFlags,
    archived,
    turns: Object.freeze(turns),
  });
}

function nullableProviderCursor(value: unknown, method: string, field: string): string | null {
  return value === null || value === undefined
    ? null
    : boundedString(value, method, field, MAX_PROVIDER_CURSOR_CHARS);
}

function parseConfiguredThreadResult(
  method: "thread/start" | "thread/resume" | "thread/fork",
  value: unknown,
): CodexNativeConfiguredThreadResult {
  validateFallback(method, value);
  const result = record(value, method, "$result");
  const approvalPolicy = typeof result.approvalPolicy === "string"
    ? enumValue(
      result.approvalPolicy,
      ["untrusted", "on-request", "never"] as const,
      method,
      "$result.approvalPolicy",
    )
    : (record(result.approvalPolicy, method, "$result.approvalPolicy"), "granular" as const);
  const sandbox = record(result.sandbox, method, "$result.sandbox");
  const reasoningEffort = hasOwn(result, "reasoningEffort")
    ? nullableString(
      result.reasoningEffort,
      method,
      "$result.reasoningEffort",
      MAX_DISPLAY_TEXT_CHARS,
      true,
    )
    : null;
  return Object.freeze({
    thread: parseThread(result.thread, method, "$result.thread", null),
    model: redactedString(result.model, method, "$result.model", MAX_DISPLAY_TEXT_CHARS, false),
    modelProvider: redactedString(
      result.modelProvider,
      method,
      "$result.modelProvider",
      MAX_DISPLAY_TEXT_CHARS,
      false,
    ),
    cwd: redactedString(result.cwd, method, "$result.cwd", MAX_PATH_CHARS, false),
    approvalPolicy,
    approvalsReviewer: enumValue(
      result.approvalsReviewer,
      ["user", "auto_review", "guardian_subagent"] as const,
      method,
      "$result.approvalsReviewer",
    ),
    sandboxType: enumValue(
      sandbox.type,
      ["dangerFullAccess", "readOnly", "externalSandbox", "workspaceWrite"] as const,
      method,
      "$result.sandbox.type",
    ),
    reasoningEffort,
  });
}

export function parseCodexThreadListResult(
  value: unknown,
  context: { readonly archived: boolean },
): CodexNativeThreadListResult {
  const method = "thread/list";
  validateFallback(method, value);
  if (typeof context.archived !== "boolean") return fail(method, "$context.archived");
  const result = record(value, method, "$result");
  const threads = array(result.data, method, "$result.data", MAX_CODEX_LIST_THREADS).map(
    (thread, index) => parseThread(
      thread,
      method,
      `$result.data[${index}]`,
      context.archived,
    ),
  );
  return Object.freeze({
    threads: Object.freeze(threads),
    nextCursor: nullableProviderCursor(result.nextCursor, method, "$result.nextCursor"),
    backwardsCursor: nullableProviderCursor(
      result.backwardsCursor,
      method,
      "$result.backwardsCursor",
    ),
  });
}

export function parseCodexThreadReadResult(value: unknown): CodexNativeThreadResult {
  const method = "thread/read";
  validateFallback(method, value);
  const result = record(value, method, "$result");
  return Object.freeze({ thread: parseThread(result.thread, method, "$result.thread", null) });
}

export function parseCodexThreadStartResult(value: unknown): CodexNativeConfiguredThreadResult {
  return parseConfiguredThreadResult("thread/start", value);
}

export function parseCodexThreadResumeResult(value: unknown): CodexNativeConfiguredThreadResult {
  return parseConfiguredThreadResult("thread/resume", value);
}

export function parseCodexThreadForkResult(value: unknown): CodexNativeConfiguredThreadResult {
  return parseConfiguredThreadResult("thread/fork", value);
}

export function parseCodexTurnStartResult(value: unknown): CodexNativeTurnStartResult {
  const method = "turn/start";
  validateFallback(method, value);
  const result = record(value, method, "$result");
  return Object.freeze({ turn: parseTurn(result.turn, method, "$result.turn") });
}
