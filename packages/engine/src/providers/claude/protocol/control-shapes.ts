export const CLAUDE_CONTROL_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const CLAUDE_CONTROL_MAX_IDENTIFIER_CHARS = 512;
export const CLAUDE_CONTROL_MAX_PERMISSION_SUGGESTIONS = 64;
export const CLAUDE_CONTROL_MAX_PENDING_REQUESTS = 256;
export const CLAUDE_CONTROL_MAX_JSON_ARRAY_ITEMS = 4_096;
export const CLAUDE_CONTROL_MAX_JSON_OBJECT_KEYS = 256;
export const CLAUDE_CONTROL_MAX_JSON_DEPTH = 32;
export const CLAUDE_CONTROL_MAX_JSON_NODES = 100_000;

const MAX_TEXT_CHARS = 32_768;
const MAX_PATH_CHARS = 16_384;

const DECISION_REASON_TYPES = Object.freeze([
  "rule",
  "mode",
  "subcommandResults",
  "permissionPromptTool",
  "hook",
  "asyncAgent",
  "sandboxOverride",
  "workingDir",
  "safetyCheck",
  "classifier",
  "other",
] as const);

export type ClaudeDecisionReasonType = (typeof DECISION_REASON_TYPES)[number];

export type ClaudeControlJsonValue =
  | null
  | boolean
  | number
  | string
  | ClaudeControlJsonObject
  | readonly ClaudeControlJsonValue[];

export interface ClaudeControlJsonObject {
  readonly [key: string]: ClaudeControlJsonValue;
}

export interface ClaudeCanUseToolRequest {
  readonly kind: "can-use-tool";
  readonly subtype: "can_use_tool";
  readonly toolName: string;
  readonly input: ClaudeControlJsonObject;
  readonly toolUseId: string;
  readonly permissionSuggestions?: readonly ClaudeControlJsonObject[];
  readonly blockedPath?: string;
  readonly decisionReason?: string;
  readonly decisionReasonType?: ClaudeDecisionReasonType;
  readonly classifierApprovable?: boolean;
  readonly title?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly agentId?: string;
  readonly requiresUserInteraction?: boolean;
  readonly raw: ClaudeControlJsonObject;
}

export interface ClaudeInterruptControlRequest {
  readonly kind: "interrupt";
  readonly subtype: "interrupt";
  readonly raw: ClaudeControlJsonObject;
}

export interface ClaudeUnknownControlRequest {
  readonly kind: "unknown";
  readonly subtype: string;
  readonly raw: ClaudeControlJsonObject;
}

export type ClaudeParsedInnerControlRequest =
  | ClaudeCanUseToolRequest
  | ClaudeInterruptControlRequest
  | ClaudeUnknownControlRequest;

export interface ClaudeParsedControlRequest {
  readonly requestId: string;
  readonly request: ClaudeParsedInnerControlRequest;
  readonly raw: ClaudeControlJsonObject;
}

export interface ClaudeControlSuccessResponse {
  readonly kind: "success";
  readonly requestId: string;
  readonly response?: ClaudeControlJsonObject;
  readonly pendingPermissionRequests?: readonly ClaudeParsedControlRequest[];
  readonly pendingUserDialogRequests?: readonly ClaudeParsedControlRequest[];
}

export interface ClaudeControlErrorResponse {
  readonly kind: "error";
  readonly requestId: string;
  readonly error: string;
  readonly pendingPermissionRequests?: readonly ClaudeParsedControlRequest[];
  readonly pendingUserDialogRequests?: readonly ClaudeParsedControlRequest[];
}

export type ClaudeParsedControlResponse =
  | ClaudeControlSuccessResponse
  | ClaudeControlErrorResponse;

export interface ClaudeNotControlClassification {
  readonly kind: "not-control";
  readonly raw: ClaudeControlJsonObject;
}

export interface ClaudeControlRequestClassification extends ClaudeParsedControlRequest {
  readonly kind: "control-request";
}

export interface ClaudeControlCancelClassification {
  readonly kind: "control-cancel-request";
  readonly requestId: string;
  readonly raw: ClaudeControlJsonObject;
}

export interface ClaudeControlResponseClassification {
  readonly kind: "control-response";
  readonly response: ClaudeParsedControlResponse;
  readonly raw: ClaudeControlJsonObject;
}

export type ClaudeControlClassification =
  | ClaudeNotControlClassification
  | ClaudeControlRequestClassification
  | ClaudeControlCancelClassification
  | ClaudeControlResponseClassification;

export interface ClaudeControlRequestWire extends ClaudeControlJsonObject {
  readonly type: "control_request";
  readonly request_id: string;
  readonly request: ClaudeControlJsonObject;
}

export interface ClaudeControlSuccessResponseWire extends ClaudeControlJsonObject {
  readonly type: "control_response";
  readonly response: ClaudeControlJsonObject & {
    readonly subtype: "success";
    readonly request_id: string;
  };
}

export interface ClaudeControlErrorResponseWire extends ClaudeControlJsonObject {
  readonly type: "control_response";
  readonly response: ClaudeControlJsonObject & {
    readonly subtype: "error";
    readonly request_id: string;
    readonly error: string;
  };
}

export interface ClaudeControlSuccessBuildOptions {
  readonly response?: unknown;
  readonly pending_permission_requests?: unknown;
  readonly pending_user_dialog_requests?: unknown;
}

export interface ClaudeControlErrorBuildOptions {
  readonly pending_permission_requests?: unknown;
  readonly pending_user_dialog_requests?: unknown;
}

export type ClaudeControlShapeErrorCode = "INVALID_CONTROL_SHAPE";

/** A value-free wire-boundary error. Provider-controlled values are never reflected. */
export class ClaudeControlShapeError extends Error {
  readonly code: ClaudeControlShapeErrorCode = "INVALID_CONTROL_SHAPE";
  readonly field: string;

  constructor(field: string) {
    super(`Claude control frame has an incompatible shape at ${field}`);
    this.name = "ClaudeControlShapeError";
    this.field = field;
  }
}

const INTERNAL_SHAPE_ERRORS = new WeakSet<ClaudeControlShapeError>();

function fail(field: string): never {
  const error = new ClaudeControlShapeError(field);
  INTERNAL_SHAPE_ERRORS.add(error);
  throw error;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function jsonStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
      continue;
    }
    if (code <= 0x1f) {
      bytes += code === 0x08 || code === 0x09 || code === 0x0a ||
        code === 0x0c || code === 0x0d ? 2 : 6;
      continue;
    }
    if (code <= 0x7f) {
      bytes += 1;
      continue;
    }
    if (code <= 0x7ff) {
      bytes += 2;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
      continue;
    }
    bytes += code >= 0xdc00 && code <= 0xdfff ? 6 : 3;
  }
  return bytes;
}

type MutableJsonContainer =
  | Record<string, ClaudeControlJsonValue>
  | ClaudeControlJsonValue[];

interface JsonVisitTask {
  readonly kind: "visit";
  readonly value: unknown;
  readonly depth: number;
  readonly parent: MutableJsonContainer | null;
  readonly key: string | number | null;
}

interface JsonLeaveTask {
  readonly kind: "leave";
  readonly source: object;
  readonly target: MutableJsonContainer;
}

type JsonSnapshotTask = JsonVisitTask | JsonLeaveTask;

function setSnapshotValue(
  parent: MutableJsonContainer | null,
  key: string | number | null,
  value: ClaudeControlJsonValue,
  setRoot: (root: ClaudeControlJsonValue) => void,
): void {
  if (parent === null) {
    setRoot(value);
    return;
  }
  if (Array.isArray(parent)) {
    parent[key as number] = value;
    return;
  }
  Object.defineProperty(parent, key as string, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function snapshotJsonUnsafe(value: unknown, field: string): ClaudeControlJsonValue {
  let bytes = 0;
  let nodes = 0;
  let root: ClaudeControlJsonValue | undefined;
  let rootSet = false;
  const ancestors = new Set<object>();
  const tasks: JsonSnapshotTask[] = [{
    kind: "visit",
    value,
    depth: 0,
    parent: null,
    key: null,
  }];

  const addBytes = (amount: number): void => {
    bytes += amount;
    if (bytes > CLAUDE_CONTROL_MAX_FRAME_BYTES) fail(`${field}.$size`);
  };
  const setRoot = (nextRoot: ClaudeControlJsonValue): void => {
    root = nextRoot;
    rootSet = true;
  };

  while (tasks.length > 0) {
    const task = tasks.pop();
    if (!task) break;
    if (task.kind === "leave") {
      ancestors.delete(task.source);
      Object.freeze(task.target);
      continue;
    }

    nodes += 1;
    if (nodes > CLAUDE_CONTROL_MAX_JSON_NODES || task.depth > CLAUDE_CONTROL_MAX_JSON_DEPTH) {
      fail(`${field}.$size`);
    }

    const current = task.value;
    if (current === null) {
      addBytes(4);
      setSnapshotValue(task.parent, task.key, null, setRoot);
      continue;
    }
    if (typeof current === "boolean") {
      addBytes(current ? 4 : 5);
      setSnapshotValue(task.parent, task.key, current, setRoot);
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail(`${field}.$number`);
      addBytes(String(current).length);
      setSnapshotValue(task.parent, task.key, current, setRoot);
      continue;
    }
    if (typeof current === "string") {
      if (current.length > CLAUDE_CONTROL_MAX_FRAME_BYTES) fail(`${field}.$size`);
      addBytes(jsonStringByteLength(current));
      setSnapshotValue(task.parent, task.key, current, setRoot);
      continue;
    }
    if (typeof current !== "object") fail(`${field}.$json`);
    if (ancestors.has(current)) fail(`${field}.$cycle`);

    if (Array.isArray(current)) {
      if (
        Object.getPrototypeOf(current) !== Array.prototype ||
        current.length > CLAUDE_CONTROL_MAX_JSON_ARRAY_ITEMS
      ) {
        fail(`${field}.$size`);
      }
      const ownKeys = Reflect.ownKeys(current);
      if (ownKeys.length !== current.length + 1 || !ownKeys.includes("length")) {
        fail(`${field}.$json`);
      }
      const values: unknown[] = [];
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          fail(`${field}.$json`);
        }
        values.push(descriptor.value);
      }
      addBytes(2 + Math.max(0, current.length - 1));
      const target: ClaudeControlJsonValue[] = [];
      setSnapshotValue(task.parent, task.key, target, setRoot);
      ancestors.add(current);
      tasks.push({ kind: "leave", source: current, target });
      for (let index = values.length - 1; index >= 0; index -= 1) {
        tasks.push({
          kind: "visit",
          value: values[index],
          depth: task.depth + 1,
          parent: target,
          key: index,
        });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) fail(`${field}.$json`);
    const ownKeys = Reflect.ownKeys(current);
    if (ownKeys.length > CLAUDE_CONTROL_MAX_JSON_OBJECT_KEYS) fail(`${field}.$size`);
    const entries: Array<readonly [string, unknown]> = [];
    for (const key of ownKeys) {
      if (typeof key !== "string") fail(`${field}.$json`);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        fail(`${field}.$json`);
      }
      if (key.length > CLAUDE_CONTROL_MAX_FRAME_BYTES) fail(`${field}.$size`);
      addBytes(jsonStringByteLength(key) + 1);
      entries.push([key, descriptor.value]);
    }
    addBytes(2 + Math.max(0, entries.length - 1));
    const target: Record<string, ClaudeControlJsonValue> = {};
    setSnapshotValue(task.parent, task.key, target, setRoot);
    ancestors.add(current);
    tasks.push({ kind: "leave", source: current, target });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry) continue;
      tasks.push({
        kind: "visit",
        value: entry[1],
        depth: task.depth + 1,
        parent: target,
        key: entry[0],
      });
    }
  }

  if (!rootSet || root === undefined) fail(`${field}.$json`);
  return root;
}

function snapshotJson(value: unknown, field: string): ClaudeControlJsonValue {
  try {
    return snapshotJsonUnsafe(value, field);
  } catch (error) {
    if (
      error !== null &&
      (typeof error === "object" || typeof error === "function") &&
      INTERNAL_SHAPE_ERRORS.has(error as ClaudeControlShapeError)
    ) {
      throw error;
    }
    return fail(`${field}.$json`);
  }
}

function jsonObject(value: unknown, field: string): ClaudeControlJsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail(field);
  return value as ClaudeControlJsonObject;
}

function snapshotJsonObject(value: unknown, field: string): ClaudeControlJsonObject {
  return jsonObject(snapshotJson(value, field), field);
}

function jsonArray(
  value: unknown,
  field: string,
  maxItems: number,
): readonly ClaudeControlJsonValue[] {
  if (!Array.isArray(value) || value.length > maxItems) return fail(field);
  return value as readonly ClaudeControlJsonValue[];
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CLAUDE_CONTROL_MAX_IDENTIFIER_CHARS ||
    value.trim() !== value ||
    value.includes("\u0000")
  ) {
    return fail(field);
  }
  return value;
}

function boundedText(
  value: unknown,
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
    return fail(field);
  }
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") return fail(field);
  return value;
}

function assertExactKeys(
  value: ClaudeControlJsonObject,
  allowed: readonly string[],
  field: string,
): void {
  const allowedKeys = new Set(allowed);
  const keys = Object.keys(value);
  if (keys.length > allowed.length || keys.some((key) => !allowedKeys.has(key))) {
    fail(`${field}.$keys`);
  }
}

function decisionReasonType(value: unknown, field: string): ClaudeDecisionReasonType {
  if (typeof value !== "string" || !DECISION_REASON_TYPES.includes(value as ClaudeDecisionReasonType)) {
    return fail(field);
  }
  return value as ClaudeDecisionReasonType;
}

function parsePermissionSuggestions(
  value: unknown,
  field: string,
): readonly ClaudeControlJsonObject[] {
  const suggestions = jsonArray(value, field, CLAUDE_CONTROL_MAX_PERMISSION_SUGGESTIONS);
  const parsed: ClaudeControlJsonObject[] = [];
  for (let index = 0; index < suggestions.length; index += 1) {
    parsed.push(jsonObject(suggestions[index], `${field}[]`));
  }
  return Object.freeze(parsed);
}

function parseInnerControlRequest(
  value: ClaudeControlJsonObject,
  field: string,
): ClaudeParsedInnerControlRequest {
  const subtype = identifier(value.subtype, `${field}.subtype`);

  if (subtype === "interrupt") {
    assertExactKeys(value, ["subtype"], field);
    return Object.freeze({ kind: "interrupt", subtype, raw: value });
  }

  if (subtype !== "can_use_tool") {
    return Object.freeze({ kind: "unknown", subtype, raw: value });
  }

  const toolName = identifier(value.tool_name, `${field}.tool_name`);
  const input = jsonObject(value.input, `${field}.input`);
  const toolUseId = identifier(value.tool_use_id, `${field}.tool_use_id`);
  const hasPermissionSuggestions = hasOwn(value, "permission_suggestions");
  const hasBlockedPath = hasOwn(value, "blocked_path");
  const hasDecisionReason = hasOwn(value, "decision_reason");
  const hasDecisionReasonType = hasOwn(value, "decision_reason_type");
  const hasClassifierApprovable = hasOwn(value, "classifier_approvable");
  const hasTitle = hasOwn(value, "title");
  const hasDisplayName = hasOwn(value, "display_name");
  const hasDescription = hasOwn(value, "description");
  const hasAgentId = hasOwn(value, "agent_id");
  const hasRequiresUserInteraction = hasOwn(value, "requires_user_interaction");

  const permissionSuggestions = hasPermissionSuggestions
    ? parsePermissionSuggestions(
      value.permission_suggestions,
      `${field}.permission_suggestions`,
    )
    : undefined;
  const blockedPath = hasBlockedPath
    ? boundedText(value.blocked_path, `${field}.blocked_path`, MAX_PATH_CHARS)
    : undefined;
  const parsedDecisionReason = hasDecisionReason
    ? boundedText(value.decision_reason, `${field}.decision_reason`, MAX_TEXT_CHARS)
    : undefined;
  const parsedDecisionReasonType = hasDecisionReasonType
    ? decisionReasonType(value.decision_reason_type, `${field}.decision_reason_type`)
    : undefined;
  const classifierApprovable = hasClassifierApprovable
    ? booleanValue(value.classifier_approvable, `${field}.classifier_approvable`)
    : undefined;
  const title = hasTitle
    ? boundedText(value.title, `${field}.title`, MAX_TEXT_CHARS)
    : undefined;
  const displayName = hasDisplayName
    ? boundedText(value.display_name, `${field}.display_name`, MAX_TEXT_CHARS)
    : undefined;
  const description = hasDescription
    ? boundedText(value.description, `${field}.description`, MAX_TEXT_CHARS)
    : undefined;
  const agentId = hasAgentId ? identifier(value.agent_id, `${field}.agent_id`) : undefined;
  const requiresUserInteraction = hasRequiresUserInteraction
    ? booleanValue(value.requires_user_interaction, `${field}.requires_user_interaction`)
    : undefined;

  return Object.freeze({
    kind: "can-use-tool" as const,
    subtype: "can_use_tool" as const,
    toolName,
    input,
    toolUseId,
    ...(hasPermissionSuggestions ? { permissionSuggestions } : {}),
    ...(hasBlockedPath ? { blockedPath } : {}),
    ...(hasDecisionReason ? { decisionReason: parsedDecisionReason } : {}),
    ...(hasDecisionReasonType ? { decisionReasonType: parsedDecisionReasonType } : {}),
    ...(hasClassifierApprovable ? { classifierApprovable } : {}),
    ...(hasTitle ? { title } : {}),
    ...(hasDisplayName ? { displayName } : {}),
    ...(hasDescription ? { description } : {}),
    ...(hasAgentId ? { agentId } : {}),
    ...(hasRequiresUserInteraction ? { requiresUserInteraction } : {}),
    raw: value,
  });
}

function parseControlRequestSnapshot(
  raw: ClaudeControlJsonObject,
  field: string,
): ClaudeParsedControlRequest {
  assertExactKeys(raw, ["type", "request_id", "request"], field);
  if (raw.type !== "control_request") fail(`${field}.type`);
  const requestId = identifier(raw.request_id, `${field}.request_id`);
  const requestRaw = jsonObject(raw.request, `${field}.request`);
  const request = parseInnerControlRequest(requestRaw, `${field}.request`);
  return Object.freeze({ requestId, request, raw });
}

function parsePendingRequests(
  value: unknown,
  field: string,
): readonly ClaudeParsedControlRequest[] {
  const requests = jsonArray(value, field, CLAUDE_CONTROL_MAX_PENDING_REQUESTS);
  const parsed: ClaudeParsedControlRequest[] = [];
  for (let index = 0; index < requests.length; index += 1) {
    parsed.push(parseControlRequestSnapshot(
      jsonObject(requests[index], `${field}[]`),
      `${field}[]`,
    ));
  }
  return Object.freeze(parsed);
}

function parseControlResponseSnapshot(
  raw: ClaudeControlJsonObject,
): ClaudeControlResponseClassification {
  assertExactKeys(raw, ["type", "response"], "$control_response");
  const responseRaw = jsonObject(raw.response, "$control_response.response");
  const subtype = identifier(responseRaw.subtype, "$control_response.response.subtype");
  const requestId = identifier(
    responseRaw.request_id,
    "$control_response.response.request_id",
  );
  const hasPermissionRequests = hasOwn(responseRaw, "pending_permission_requests");
  const hasUserDialogRequests = hasOwn(responseRaw, "pending_user_dialog_requests");
  const pendingPermissionRequests = hasPermissionRequests
    ? parsePendingRequests(
      responseRaw.pending_permission_requests,
      "$control_response.response.pending_permission_requests",
    )
    : undefined;
  const pendingUserDialogRequests = hasUserDialogRequests
    ? parsePendingRequests(
      responseRaw.pending_user_dialog_requests,
      "$control_response.response.pending_user_dialog_requests",
    )
    : undefined;

  if (subtype === "success") {
    assertExactKeys(responseRaw, [
      "subtype",
      "request_id",
      "response",
      "pending_permission_requests",
      "pending_user_dialog_requests",
    ], "$control_response.response");
    const hasResponse = hasOwn(responseRaw, "response");
    const response = hasResponse
      ? jsonObject(responseRaw.response, "$control_response.response.response")
      : undefined;
    return Object.freeze({
      kind: "control-response",
      response: Object.freeze({
        kind: "success" as const,
        requestId,
        ...(hasResponse ? { response } : {}),
        ...(hasPermissionRequests ? { pendingPermissionRequests } : {}),
        ...(hasUserDialogRequests ? { pendingUserDialogRequests } : {}),
      }),
      raw,
    });
  }

  if (subtype === "error") {
    assertExactKeys(responseRaw, [
      "subtype",
      "request_id",
      "error",
      "pending_permission_requests",
      "pending_user_dialog_requests",
    ], "$control_response.response");
    const error = boundedText(
      responseRaw.error,
      "$control_response.response.error",
      MAX_TEXT_CHARS,
      false,
    );
    return Object.freeze({
      kind: "control-response",
      response: Object.freeze({
        kind: "error" as const,
        requestId,
        error,
        ...(hasPermissionRequests ? { pendingPermissionRequests } : {}),
        ...(hasUserDialogRequests ? { pendingUserDialogRequests } : {}),
      }),
      raw,
    });
  }

  return fail("$control_response.response.subtype");
}

export function classifyClaudeControlEnvelope(value: unknown): ClaudeControlClassification {
  const raw = snapshotJsonObject(value, "$frame");
  const type = raw.type;
  if (typeof type !== "string" || !type.startsWith("control_")) {
    return Object.freeze({ kind: "not-control", raw });
  }

  if (type === "control_request") {
    const parsed = parseControlRequestSnapshot(raw, "$control_request");
    return Object.freeze({ kind: "control-request", ...parsed });
  }

  if (type === "control_cancel_request") {
    assertExactKeys(raw, ["type", "request_id"], "$control_cancel_request");
    const requestId = identifier(raw.request_id, "$control_cancel_request.request_id");
    return Object.freeze({ kind: "control-cancel-request", requestId, raw });
  }

  if (type === "control_response") return parseControlResponseSnapshot(raw);
  return fail("$frame.type");
}

export function parseClaudeControlEnvelope(value: unknown): ClaudeControlClassification {
  return classifyClaudeControlEnvelope(value);
}

const EMPTY_BUILD_OPTIONS: ClaudeControlJsonObject = Object.freeze({});

function buildOptions(
  supplied: boolean,
  value: unknown,
  allowedKeys: readonly string[],
  field: string,
): ClaudeControlJsonObject {
  const options = supplied ? snapshotJsonObject(value, field) : EMPTY_BUILD_OPTIONS;
  assertExactKeys(options, allowedKeys, field);
  return options;
}

export function buildClaudeControlRequest(
  requestId: unknown,
  request: unknown,
): ClaudeControlRequestWire {
  const classified = classifyClaudeControlEnvelope({
    type: "control_request",
    request_id: requestId,
    request,
  });
  if (classified.kind !== "control-request") return fail("$builder");
  return classified.raw as ClaudeControlRequestWire;
}

export function buildClaudeControlSuccessResponse(
  requestId: unknown,
  options?: ClaudeControlSuccessBuildOptions,
): ClaudeControlSuccessResponseWire {
  const parsedOptions = buildOptions(
    options !== undefined,
    options,
    ["response", "pending_permission_requests", "pending_user_dialog_requests"],
    "$options",
  );
  const response: Record<string, unknown> = {
    subtype: "success",
    request_id: requestId,
  };
  if (hasOwn(parsedOptions, "response")) response.response = parsedOptions.response;
  if (hasOwn(parsedOptions, "pending_permission_requests")) {
    response.pending_permission_requests = parsedOptions.pending_permission_requests;
  }
  if (hasOwn(parsedOptions, "pending_user_dialog_requests")) {
    response.pending_user_dialog_requests = parsedOptions.pending_user_dialog_requests;
  }
  const classified = classifyClaudeControlEnvelope({ type: "control_response", response });
  if (classified.kind !== "control-response" || classified.response.kind !== "success") {
    return fail("$builder");
  }
  return classified.raw as ClaudeControlSuccessResponseWire;
}

export function buildClaudeControlErrorResponse(
  requestId: unknown,
  error: unknown,
  options?: ClaudeControlErrorBuildOptions,
): ClaudeControlErrorResponseWire {
  const parsedOptions = buildOptions(
    options !== undefined,
    options,
    ["pending_permission_requests", "pending_user_dialog_requests"],
    "$options",
  );
  const response: Record<string, unknown> = {
    subtype: "error",
    request_id: requestId,
    error,
  };
  if (hasOwn(parsedOptions, "pending_permission_requests")) {
    response.pending_permission_requests = parsedOptions.pending_permission_requests;
  }
  if (hasOwn(parsedOptions, "pending_user_dialog_requests")) {
    response.pending_user_dialog_requests = parsedOptions.pending_user_dialog_requests;
  }
  const classified = classifyClaudeControlEnvelope({ type: "control_response", response });
  if (classified.kind !== "control-response" || classified.response.kind !== "error") {
    return fail("$builder");
  }
  return classified.raw as ClaudeControlErrorResponseWire;
}
