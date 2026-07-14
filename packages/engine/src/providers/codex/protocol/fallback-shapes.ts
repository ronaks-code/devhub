import { CodexProtocolFault } from "./fault.js";

export type CodexFallbackShapeKind =
  | "object"
  | "array"
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "null"
  | "rpc-id"
  | "unknown";

export interface CodexFallbackShape {
  readonly kinds: readonly CodexFallbackShapeKind[];
  readonly enumValues?: readonly string[];
  readonly constValue?: boolean;
  readonly required?: Readonly<Record<string, CodexFallbackShape>>;
  readonly optional?: Readonly<Record<string, CodexFallbackShape>>;
  readonly items?: CodexFallbackShape;
  readonly alternatives?: readonly CodexFallbackShape[];
  readonly additionalProperties?: boolean;
}

export type CodexFallbackDirection =
  | "client-request"
  | "client-notification"
  | "server-request"
  | "server-notification";

export interface CodexFallbackMethodDescriptor {
  readonly method: string;
  readonly params: CodexFallbackShape | null;
  readonly result: CodexFallbackShape | null;
  readonly resultSchema: string | null;
}

const fields = (
  value: Record<string, CodexFallbackShape>,
): Readonly<Record<string, CodexFallbackShape>> => Object.freeze(value);

const scalar = (...kinds: CodexFallbackShapeKind[]): CodexFallbackShape =>
  Object.freeze({ kinds: Object.freeze(kinds) });

// JSON Schema objects are forward-compatible by default. Containers which
// carry approval, sandbox, or permission decisions use closedObject below so
// unknown fields cannot silently weaken a safety decision.
const object = (
  required: Record<string, CodexFallbackShape> = {},
  optional: Record<string, CodexFallbackShape> = {},
  alternatives: readonly CodexFallbackShape[] = [],
): CodexFallbackShape => Object.freeze({
  kinds: Object.freeze(["object"] as const),
  required: fields(required),
  optional: fields(optional),
  ...(alternatives.length > 0 ? { alternatives: Object.freeze([...alternatives]) } : {}),
});

const closedObject = (
  required: Record<string, CodexFallbackShape> = {},
  optional: Record<string, CodexFallbackShape> = {},
  alternatives: readonly CodexFallbackShape[] = [],
): CodexFallbackShape => Object.freeze({
  ...object(required, optional, alternatives),
  additionalProperties: false,
});

const array = (items?: CodexFallbackShape): CodexFallbackShape => Object.freeze({
  kinds: Object.freeze(["array"] as const),
  ...(items ? { items } : {}),
});

const arrayOrNull = (items?: CodexFallbackShape): CodexFallbackShape => Object.freeze({
  kinds: Object.freeze(["array", "null"] as const),
  ...(items ? { items } : {}),
});

const union = (...kinds: CodexFallbackShapeKind[]): CodexFallbackShape =>
  Object.freeze({ kinds: Object.freeze(kinds) });

const stringEnum = (...enumValues: string[]): CodexFallbackShape => Object.freeze({
  kinds: Object.freeze(["string"] as const),
  enumValues: Object.freeze(enumValues),
});

const falseBoolean = (): CodexFallbackShape => Object.freeze({
  kinds: Object.freeze(["boolean"] as const),
  constValue: false,
});

const nullableObject = (
  required: Record<string, CodexFallbackShape> = {},
  optional: Record<string, CodexFallbackShape> = {},
): CodexFallbackShape => Object.freeze({
  kinds: Object.freeze(["object", "null"] as const),
  required: fields(required),
  optional: fields(optional),
});

const alternatives = (
  kinds: readonly CodexFallbackShapeKind[],
  variants: readonly CodexFallbackShape[],
): CodexFallbackShape => Object.freeze({
  kinds: Object.freeze([...kinds]),
  alternatives: Object.freeze([...variants]),
});

const nullableShape = (shape: CodexFallbackShape): CodexFallbackShape => alternatives(
  [...new Set([...shape.kinds.filter((kind) => kind !== "null"), "null" as const])],
  [shape, scalar("null")],
);

const STRING = scalar("string");
const NULLABLE_STRING = union("string", "null");
const INTEGER = scalar("integer");
const NULLABLE_INTEGER = union("integer", "null");
const BOOLEAN = scalar("boolean");
const NULLABLE_BOOLEAN = union("boolean", "null");
const RPC_ID = scalar("rpc-id");
const UNKNOWN = scalar("unknown");
const STRING_OR_OBJECT = union("string", "object");

const APPROVALS_REVIEWER = stringEnum("user", "auto_review", "guardian_subagent");
const SANDBOX_MODE = stringEnum("read-only", "workspace-write", "danger-full-access");
const GRANULAR_APPROVAL = closedObject({
  granular: closedObject(
    {
      mcp_elicitations: BOOLEAN,
      rules: BOOLEAN,
      sandbox_approval: BOOLEAN,
    },
    {
      request_permissions: BOOLEAN,
      skill_approval: BOOLEAN,
    },
  ),
});
const ASK_FOR_APPROVAL = alternatives(
  ["string", "object"],
  [stringEnum("untrusted", "on-request", "never"), GRANULAR_APPROVAL],
);
const NULLABLE_ASK_FOR_APPROVAL = nullableShape(ASK_FOR_APPROVAL);
const NULLABLE_APPROVALS_REVIEWER = nullableShape(APPROVALS_REVIEWER);
const NULLABLE_SANDBOX_MODE = nullableShape(SANDBOX_MODE);

const SANDBOX_POLICY = alternatives(
  ["object"],
  [
    closedObject({ type: stringEnum("dangerFullAccess") }),
    closedObject(
      { type: stringEnum("readOnly") },
      { networkAccess: BOOLEAN },
    ),
    closedObject(
      { type: stringEnum("externalSandbox") },
      { networkAccess: stringEnum("restricted", "enabled") },
    ),
    closedObject(
      { type: stringEnum("workspaceWrite") },
      {
        excludeSlashTmp: BOOLEAN,
        excludeTmpdirEnvVar: BOOLEAN,
        networkAccess: BOOLEAN,
        writableRoots: array(STRING),
      },
    ),
  ],
);
const NULLABLE_SANDBOX_POLICY = nullableShape(SANDBOX_POLICY);

const FILE_SYSTEM_SPECIAL_PATH = alternatives(
  ["object"],
  [
    closedObject({ kind: stringEnum("root") }),
    closedObject({ kind: stringEnum("minimal") }),
    closedObject(
      { kind: stringEnum("project_roots") },
      { subpath: NULLABLE_STRING },
    ),
    closedObject({ kind: stringEnum("tmpdir") }),
    closedObject({ kind: stringEnum("slash_tmp") }),
    closedObject(
      { kind: stringEnum("unknown"), path: STRING },
      { subpath: NULLABLE_STRING },
    ),
  ],
);
const FILE_SYSTEM_PATH = alternatives(
  ["object"],
  [
    closedObject({ path: STRING, type: stringEnum("path") }),
    closedObject({ pattern: STRING, type: stringEnum("glob_pattern") }),
    closedObject({ type: stringEnum("special"), value: FILE_SYSTEM_SPECIAL_PATH }),
  ],
);
const FILE_SYSTEM_ENTRY = closedObject({
  access: stringEnum("read", "write", "deny"),
  path: FILE_SYSTEM_PATH,
});
const ADDITIONAL_FILE_SYSTEM_PERMISSIONS = closedObject({}, {
  entries: arrayOrNull(FILE_SYSTEM_ENTRY),
  globScanMaxDepth: NULLABLE_INTEGER,
  read: arrayOrNull(STRING),
  write: arrayOrNull(STRING),
});
const ADDITIONAL_NETWORK_PERMISSIONS = closedObject({}, {
  enabled: NULLABLE_BOOLEAN,
});
const PERMISSION_PROFILE = closedObject({}, {
  fileSystem: nullableShape(ADDITIONAL_FILE_SYSTEM_PERMISSIONS),
  network: nullableShape(ADDITIONAL_NETWORK_PERMISSIONS),
});

const THREAD_STATUS = object({ type: STRING }, { activeFlags: array() });
const THREAD_ITEM = object({ id: STRING, type: STRING });
const TURN = object(
  { id: STRING, items: array(THREAD_ITEM), status: STRING },
  {
    completedAt: NULLABLE_INTEGER,
    durationMs: NULLABLE_INTEGER,
    startedAt: NULLABLE_INTEGER,
  },
);
const THREAD = object(
  {
    cliVersion: STRING,
    createdAt: INTEGER,
    cwd: STRING,
    ephemeral: BOOLEAN,
    id: STRING,
    modelProvider: STRING,
    preview: STRING,
    sessionId: STRING,
    source: STRING_OR_OBJECT,
    status: THREAD_STATUS,
    turns: array(TURN),
    updatedAt: INTEGER,
  },
  {
    forkedFromId: NULLABLE_STRING,
    name: NULLABLE_STRING,
    parentThreadId: NULLABLE_STRING,
    path: NULLABLE_STRING,
    recencyAt: NULLABLE_INTEGER,
  },
);

const CLIENT_INFO = object(
  { name: STRING, version: STRING },
  { title: NULLABLE_STRING },
);
const THREAD_RESPONSE = object({ thread: THREAD });
const THREAD_START_RESULT = object({
  approvalPolicy: ASK_FOR_APPROVAL,
  approvalsReviewer: APPROVALS_REVIEWER,
  cwd: STRING,
  model: STRING,
  modelProvider: STRING,
  sandbox: SANDBOX_POLICY,
  thread: THREAD,
});
const EMPTY_OBJECT = object();
const TURN_RESULT = object({ turn: TURN });

const THREAD_CONFIG_OPTIONALS = {
  approvalPolicy: NULLABLE_ASK_FOR_APPROVAL,
  approvalsReviewer: NULLABLE_APPROVALS_REVIEWER,
  config: union("object", "null"),
  cwd: NULLABLE_STRING,
  model: NULLABLE_STRING,
  modelProvider: NULLABLE_STRING,
  sandbox: NULLABLE_SANDBOX_MODE,
} satisfies Record<string, CodexFallbackShape>;

const REQUEST_IDENTITY = {
  itemId: STRING,
  threadId: STRING,
  turnId: STRING,
} satisfies Record<string, CodexFallbackShape>;

const TOKEN_USAGE_BREAKDOWN = object({
  cachedInputTokens: INTEGER,
  inputTokens: INTEGER,
  outputTokens: INTEGER,
  reasoningOutputTokens: INTEGER,
  totalTokens: INTEGER,
});
const THREAD_TOKEN_USAGE = object({
  last: TOKEN_USAGE_BREAKDOWN,
  total: TOKEN_USAGE_BREAKDOWN,
}, { modelContextWindow: NULLABLE_INTEGER });
const TURN_ERROR = object({ message: STRING }, { additionalDetails: NULLABLE_STRING });
const PLAN_STEP = object({ status: STRING, step: STRING });
const FILE_UPDATE = object({
  diff: STRING,
  kind: object({ type: STRING }, { move_path: NULLABLE_STRING }),
  path: STRING,
});
const USER_INPUT_QUESTION = object(
  { header: STRING, id: STRING, question: STRING },
  { isOther: BOOLEAN, isSecret: BOOLEAN, options: union("array", "null") },
);
const INITIALIZE_CAPABILITIES = nullableObject({}, {
  experimentalApi: falseBoolean(),
  mcpServerOpenaiFormElicitation: falseBoolean(),
  optOutNotificationMethods: arrayOrNull(STRING),
  requestAttestation: falseBoolean(),
});
const MCP_FORM_SCHEMA = object(
  { properties: object(), type: stringEnum("object") },
  { $schema: NULLABLE_STRING, required: arrayOrNull(STRING) },
);
const COMMAND_DECISION = alternatives(
  ["string", "object"],
  [
    stringEnum("accept"),
    stringEnum("acceptForSession"),
    closedObject({
      acceptWithExecpolicyAmendment: closedObject({ execpolicy_amendment: array(STRING) }),
    }),
    closedObject({
      applyNetworkPolicyAmendment: closedObject({
        network_policy_amendment: closedObject({
          action: stringEnum("allow", "deny"),
          host: STRING,
        }),
      }),
    }),
    stringEnum("decline"),
    stringEnum("cancel"),
  ],
);
const FILE_CHANGE_DECISION = stringEnum("accept", "acceptForSession", "decline", "cancel");

const descriptor = (
  method: string,
  params: CodexFallbackShape | null,
  result: CodexFallbackShape | null,
  resultSchema: string | null,
): CodexFallbackMethodDescriptor => Object.freeze({ method, params, result, resultSchema });

const clientRequests = Object.freeze({
  initialize: descriptor(
    "initialize",
    object({ clientInfo: CLIENT_INFO }, { capabilities: INITIALIZE_CAPABILITIES }),
    object({
      codexHome: STRING,
      platformFamily: STRING,
      platformOs: STRING,
      userAgent: STRING,
    }),
    "v1/InitializeResponse.json",
  ),
  "thread/list": descriptor(
    "thread/list",
    object({}, {
      archived: NULLABLE_BOOLEAN,
      cursor: NULLABLE_STRING,
      limit: NULLABLE_INTEGER,
      modelProviders: union("array", "null"),
      searchTerm: NULLABLE_STRING,
      useStateDbOnly: BOOLEAN,
    }),
    object(
      { data: array(THREAD) },
      { backwardsCursor: NULLABLE_STRING, nextCursor: NULLABLE_STRING },
    ),
    "v2/ThreadListResponse.json",
  ),
  "thread/read": descriptor(
    "thread/read",
    object({ threadId: STRING }, { includeTurns: BOOLEAN }),
    THREAD_RESPONSE,
    "v2/ThreadReadResponse.json",
  ),
  "thread/start": descriptor(
    "thread/start",
    object({}, { ...THREAD_CONFIG_OPTIONALS, ephemeral: NULLABLE_BOOLEAN }),
    THREAD_START_RESULT,
    "v2/ThreadStartResponse.json",
  ),
  "thread/resume": descriptor(
    "thread/resume",
    object({ threadId: STRING }, THREAD_CONFIG_OPTIONALS),
    THREAD_START_RESULT,
    "v2/ThreadResumeResponse.json",
  ),
  "thread/fork": descriptor(
    "thread/fork",
    object(
      { threadId: STRING },
      { ...THREAD_CONFIG_OPTIONALS, ephemeral: BOOLEAN, lastTurnId: NULLABLE_STRING },
    ),
    THREAD_START_RESULT,
    "v2/ThreadForkResponse.json",
  ),
  "thread/archive": descriptor(
    "thread/archive",
    object({ threadId: STRING }),
    EMPTY_OBJECT,
    "v2/ThreadArchiveResponse.json",
  ),
  "thread/unsubscribe": descriptor(
    "thread/unsubscribe",
    object({ threadId: STRING }),
    closedObject({ status: stringEnum("notLoaded", "notSubscribed", "unsubscribed") }),
    "v2/ThreadUnsubscribeResponse.json",
  ),
  "thread/name/set": descriptor(
    "thread/name/set",
    object({ name: STRING, threadId: STRING }),
    EMPTY_OBJECT,
    "v2/ThreadSetNameResponse.json",
  ),
  "turn/start": descriptor(
    "turn/start",
    object(
      { input: array(), threadId: STRING },
      {
        approvalPolicy: NULLABLE_ASK_FOR_APPROVAL,
        approvalsReviewer: NULLABLE_APPROVALS_REVIEWER,
        clientUserMessageId: NULLABLE_STRING,
        cwd: NULLABLE_STRING,
        model: NULLABLE_STRING,
        sandboxPolicy: NULLABLE_SANDBOX_POLICY,
      },
    ),
    TURN_RESULT,
    "v2/TurnStartResponse.json",
  ),
  "turn/steer": descriptor(
    "turn/steer",
    object(
      { expectedTurnId: STRING, input: array(), threadId: STRING },
      { clientUserMessageId: NULLABLE_STRING },
    ),
    object({ turnId: STRING }),
    "v2/TurnSteerResponse.json",
  ),
  "turn/interrupt": descriptor(
    "turn/interrupt",
    object({ threadId: STRING, turnId: STRING }),
    EMPTY_OBJECT,
    "v2/TurnInterruptResponse.json",
  ),
});

const clientNotifications = Object.freeze({
  initialized: descriptor("initialized", null, null, null),
});

const serverRequests = Object.freeze({
  "item/commandExecution/requestApproval": descriptor(
    "item/commandExecution/requestApproval",
    object(
      { ...REQUEST_IDENTITY, startedAtMs: INTEGER },
      { approvalId: NULLABLE_STRING, command: NULLABLE_STRING, cwd: NULLABLE_STRING },
    ),
    closedObject({ decision: COMMAND_DECISION }),
    "CommandExecutionRequestApprovalResponse.json",
  ),
  "item/fileChange/requestApproval": descriptor(
    "item/fileChange/requestApproval",
    object({ ...REQUEST_IDENTITY, startedAtMs: INTEGER }),
    closedObject({ decision: FILE_CHANGE_DECISION }),
    "FileChangeRequestApprovalResponse.json",
  ),
  "item/permissions/requestApproval": descriptor(
    "item/permissions/requestApproval",
    object(
      {
        ...REQUEST_IDENTITY,
        cwd: STRING,
        permissions: PERMISSION_PROFILE,
        startedAtMs: INTEGER,
      },
      {
        environmentId: NULLABLE_STRING,
        reason: NULLABLE_STRING,
      },
    ),
    closedObject(
      { permissions: PERMISSION_PROFILE },
      {
        scope: stringEnum("turn", "session"),
        strictAutoReview: NULLABLE_BOOLEAN,
      },
    ),
    "PermissionsRequestApprovalResponse.json",
  ),
  "item/tool/requestUserInput": descriptor(
    "item/tool/requestUserInput",
    object(
      { ...REQUEST_IDENTITY, questions: array(USER_INPUT_QUESTION) },
      { autoResolutionMs: NULLABLE_INTEGER },
    ),
    object({ answers: object() }),
    "ToolRequestUserInputResponse.json",
  ),
  "mcpServer/elicitation/request": descriptor(
    "mcpServer/elicitation/request",
    object(
      { serverName: STRING, threadId: STRING },
      { turnId: NULLABLE_STRING },
      [
        object(
          { message: STRING, mode: stringEnum("form"), requestedSchema: MCP_FORM_SCHEMA },
          { _meta: UNKNOWN },
        ),
        object(
          { message: STRING, mode: stringEnum("openai/form"), requestedSchema: UNKNOWN },
          { _meta: UNKNOWN },
        ),
        object(
          {
            elicitationId: STRING,
            message: STRING,
            mode: stringEnum("url"),
            url: STRING,
          },
          { _meta: UNKNOWN },
        ),
      ],
    ),
    closedObject(
      { action: stringEnum("accept", "decline", "cancel") },
      { _meta: UNKNOWN, content: UNKNOWN },
    ),
    "McpServerElicitationRequestResponse.json",
  ),
});

const serverNotifications = Object.freeze({
  error: descriptor(
    "error",
    object({ error: TURN_ERROR, threadId: STRING, turnId: STRING, willRetry: BOOLEAN }),
    null,
    null,
  ),
  "thread/started": descriptor("thread/started", object({ thread: THREAD }), null, null),
  "thread/status/changed": descriptor(
    "thread/status/changed",
    object({ status: THREAD_STATUS, threadId: STRING }),
    null,
    null,
  ),
  "thread/archived": descriptor(
    "thread/archived",
    object({ threadId: STRING }),
    null,
    null,
  ),
  "thread/name/updated": descriptor(
    "thread/name/updated",
    object({ threadId: STRING }, { threadName: NULLABLE_STRING }),
    null,
    null,
  ),
  "thread/tokenUsage/updated": descriptor(
    "thread/tokenUsage/updated",
    object({ threadId: STRING, tokenUsage: THREAD_TOKEN_USAGE, turnId: STRING }),
    null,
    null,
  ),
  "turn/started": descriptor(
    "turn/started",
    object({ threadId: STRING, turn: TURN }),
    null,
    null,
  ),
  "turn/completed": descriptor(
    "turn/completed",
    object({ threadId: STRING, turn: TURN }),
    null,
    null,
  ),
  "turn/diff/updated": descriptor(
    "turn/diff/updated",
    object({ diff: STRING, threadId: STRING, turnId: STRING }),
    null,
    null,
  ),
  "turn/plan/updated": descriptor(
    "turn/plan/updated",
    object(
      { plan: array(PLAN_STEP), threadId: STRING, turnId: STRING },
      { explanation: NULLABLE_STRING },
    ),
    null,
    null,
  ),
  "item/started": descriptor(
    "item/started",
    object({ item: THREAD_ITEM, startedAtMs: INTEGER, threadId: STRING, turnId: STRING }),
    null,
    null,
  ),
  "item/completed": descriptor(
    "item/completed",
    object({ completedAtMs: INTEGER, item: THREAD_ITEM, threadId: STRING, turnId: STRING }),
    null,
    null,
  ),
  "item/agentMessage/delta": descriptor(
    "item/agentMessage/delta",
    object({ delta: STRING, itemId: STRING, threadId: STRING, turnId: STRING }),
    null,
    null,
  ),
  "item/plan/delta": descriptor(
    "item/plan/delta",
    object({ delta: STRING, itemId: STRING, threadId: STRING, turnId: STRING }),
    null,
    null,
  ),
  "item/commandExecution/outputDelta": descriptor(
    "item/commandExecution/outputDelta",
    object({ delta: STRING, itemId: STRING, threadId: STRING, turnId: STRING }),
    null,
    null,
  ),
  "item/fileChange/outputDelta": descriptor(
    "item/fileChange/outputDelta",
    object({ delta: STRING, itemId: STRING, threadId: STRING, turnId: STRING }),
    null,
    null,
  ),
  "item/fileChange/patchUpdated": descriptor(
    "item/fileChange/patchUpdated",
    object({ changes: array(FILE_UPDATE), itemId: STRING, threadId: STRING, turnId: STRING }),
    null,
    null,
  ),
  "serverRequest/resolved": descriptor(
    "serverRequest/resolved",
    object({ requestId: RPC_ID, threadId: STRING }),
    null,
    null,
  ),
});

export const CODEX_FALLBACK_METHOD_DESCRIPTORS = Object.freeze({
  clientRequests,
  clientNotifications,
  serverRequests,
  serverNotifications,
});

const groups: Readonly<Record<
  CodexFallbackDirection,
  Readonly<Record<string, CodexFallbackMethodDescriptor>>
>> = Object.freeze({
  "client-request": clientRequests,
  "client-notification": clientNotifications,
  "server-request": serverRequests,
  "server-notification": serverNotifications,
});

type ActualShapeKind = Exclude<CodexFallbackShapeKind, "rpc-id" | "unknown"> | "invalid";

const assertJsonValue = (
  value: unknown,
  path: string,
  ancestors = new Set<object>(),
): void => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new CodexProtocolFault("INVALID_ENVELOPE", `${path} must be a finite JSON number`);
  }
  if (typeof value !== "object") {
    throw new CodexProtocolFault("INVALID_ENVELOPE", `${path} contains a non-JSON value`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new CodexProtocolFault("INVALID_ENVELOPE", `${path} contains a non-JSON object`);
  }
  if (ancestors.has(value)) {
    throw new CodexProtocolFault("INVALID_ENVELOPE", `${path} contains a cyclic JSON value`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      assertJsonValue(child, `${path}[${index}]`, ancestors);
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new CodexProtocolFault("INVALID_ENVELOPE", `${path} contains a non-JSON key`);
      }
      assertJsonValue((value as Record<string, unknown>)[key], `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
};

const kindOf = (value: unknown): ActualShapeKind => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "invalid";
    return Number.isSafeInteger(value) ? "integer" : "number";
  }
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value !== "object") return "invalid";
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? "object" : "invalid";
};

const assertShape = (shape: CodexFallbackShape, value: unknown, path: string): void => {
  const actual = kindOf(value);
  const matchesRpcId = shape.kinds.includes("rpc-id") &&
    (typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)));
  const matchesKind = actual !== "invalid" && shape.kinds.includes(actual);
  if (!shape.kinds.includes("unknown") && !matchesKind && !matchesRpcId) {
    throw new CodexProtocolFault(
      "INVALID_ENVELOPE",
      `${path} must be ${shape.kinds.join(" or ")}; received ${actual}`,
    );
  }
  if (shape.enumValues && !shape.enumValues.includes(value as string)) {
    throw new CodexProtocolFault(
      "INVALID_ENVELOPE",
      `${path} must be one of ${shape.enumValues.join(", ")}`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(shape, "constValue") && value !== shape.constValue) {
    throw new CodexProtocolFault(
      "INVALID_ENVELOPE",
      `${path} must be ${String(shape.constValue)}`,
    );
  }

  if (actual === "object" && shape.kinds.includes("object")) {
    const record = value as Record<string, unknown>;
    for (const [name, child] of Object.entries(shape.required ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(record, name)) {
        throw new CodexProtocolFault("INVALID_ENVELOPE", `${path}.${name} is required`);
      }
      assertShape(child, record[name], `${path}.${name}`);
    }
    for (const [name, child] of Object.entries(shape.optional ?? {})) {
      if (Object.prototype.hasOwnProperty.call(record, name)) {
        assertShape(child, record[name], `${path}.${name}`);
      }
    }
    if (shape.additionalProperties === false) {
      const known = new Set([
        ...Object.keys(shape.required ?? {}),
        ...Object.keys(shape.optional ?? {}),
      ]);
      for (const name of Object.keys(record)) {
        if (!known.has(name)) {
          throw new CodexProtocolFault(
            "INVALID_ENVELOPE",
            `${path}.${name} is an unsupported additional property`,
          );
        }
      }
    }
  }
  if (actual === "array" && shape.kinds.includes("array") && shape.items) {
    for (const [index, item] of (value as unknown[]).entries()) {
      assertShape(shape.items, item, `${path}[${index}]`);
    }
  }
  if (shape.alternatives) {
    let matches = 0;
    for (const alternative of shape.alternatives) {
      try {
        assertShape(alternative, value, path);
        matches += 1;
      } catch (error) {
        if (!(error instanceof CodexProtocolFault)) throw error;
      }
    }
    if (matches !== 1) {
      throw new CodexProtocolFault(
        "INVALID_ENVELOPE",
        `${path} must match exactly one installed protocol variant`,
      );
    }
  }
};

const lookupDescriptor = (
  direction: CodexFallbackDirection,
  method: string,
): CodexFallbackMethodDescriptor => {
  const descriptorForMethod = groups[direction][method];
  if (!descriptorForMethod) {
    throw new CodexProtocolFault(
      "INVALID_ENVELOPE",
      `Unsupported ${direction} fallback method ${method}`,
    );
  }
  return descriptorForMethod;
};

const assertPayload = (
  phase: "params" | "result",
  direction: CodexFallbackDirection,
  method: string,
  value: unknown,
): void => {
  const shape = lookupDescriptor(direction, method)[phase];
  if (shape === null) {
    if (value !== undefined) {
      throw new CodexProtocolFault(
        "INVALID_ENVELOPE",
        `${direction} ${method} does not accept ${phase}`,
      );
    }
    return;
  }
  assertJsonValue(value, `${method}.${phase}`);
  assertShape(shape, value, `${method}.${phase}`);
};

export const assertCodexFallbackParams = (
  direction: CodexFallbackDirection,
  method: string,
  value: unknown,
): void => assertPayload("params", direction, method, value);

export const assertCodexFallbackResult = (
  direction: CodexFallbackDirection,
  method: string,
  value: unknown,
): void => assertPayload("result", direction, method, value);
