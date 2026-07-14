import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CODEX_FALLBACK_METHOD_DESCRIPTORS,
  CODEX_PROTOCOL_METHODS,
  assertCodexFallbackParams,
  assertCodexFallbackResult,
  type CodexFallbackMethodDescriptor,
  type CodexFallbackShape,
  type CodexFallbackShapeKind,
  type CodexFallbackDirection,
} from "../../src/providers/codex/protocol/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const bindingsRoot = path.join(
  repoRoot,
  ".planning/devhub-codex-parity/provider-bindings/codex-0.144.1/json-schema",
);

type JsonSchema = boolean | {
  readonly title?: string;
  readonly type?: string | readonly string[];
  readonly $ref?: string;
  readonly allOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly items?: JsonSchema;
  readonly definitions?: Readonly<Record<string, JsonSchema>>;
  readonly enum?: readonly unknown[];
};

const readSchema = (relativePath: string): Exclude<JsonSchema, boolean> =>
  JSON.parse(readFileSync(path.join(bindingsRoot, relativePath), "utf8"));

const aggregateSchemas: Readonly<Record<CodexFallbackDirection, string>> = {
  "client-request": "ClientRequest.json",
  "client-notification": "ClientNotification.json",
  "server-request": "ServerRequest.json",
  "server-notification": "ServerNotification.json",
};

const generatedResultSchemas: Readonly<Record<string, string>> = {
  initialize: "v1/InitializeResponse.json",
  "thread/list": "v2/ThreadListResponse.json",
  "thread/read": "v2/ThreadReadResponse.json",
  "thread/start": "v2/ThreadStartResponse.json",
  "thread/resume": "v2/ThreadResumeResponse.json",
  "thread/fork": "v2/ThreadForkResponse.json",
  "thread/archive": "v2/ThreadArchiveResponse.json",
  "thread/unsubscribe": "v2/ThreadUnsubscribeResponse.json",
  "thread/name/set": "v2/ThreadSetNameResponse.json",
  "turn/start": "v2/TurnStartResponse.json",
  "turn/steer": "v2/TurnSteerResponse.json",
  "turn/interrupt": "v2/TurnInterruptResponse.json",
  "item/commandExecution/requestApproval": "CommandExecutionRequestApprovalResponse.json",
  "item/fileChange/requestApproval": "FileChangeRequestApprovalResponse.json",
  "item/permissions/requestApproval": "PermissionsRequestApprovalResponse.json",
  "item/tool/requestUserInput": "ToolRequestUserInputResponse.json",
  "mcpServer/elicitation/request": "McpServerElicitationRequestResponse.json",
};

const descriptorGroups = (): Array<{
  direction: CodexFallbackDirection;
  descriptors: Readonly<Record<string, CodexFallbackMethodDescriptor>>;
}> => [
  { direction: "client-request", descriptors: CODEX_FALLBACK_METHOD_DESCRIPTORS.clientRequests },
  {
    direction: "client-notification",
    descriptors: CODEX_FALLBACK_METHOD_DESCRIPTORS.clientNotifications,
  },
  { direction: "server-request", descriptors: CODEX_FALLBACK_METHOD_DESCRIPTORS.serverRequests },
  {
    direction: "server-notification",
    descriptors: CODEX_FALLBACK_METHOD_DESCRIPTORS.serverNotifications,
  },
];

const resolveSchema = (schema: JsonSchema, root: Exclude<JsonSchema, boolean>): JsonSchema => {
  if (typeof schema === "boolean") return schema;
  if (schema.$ref) {
    const prefix = "#/definitions/";
    if (!schema.$ref.startsWith(prefix)) throw new Error(`non-local ref ${schema.$ref}`);
    const resolved = root.definitions?.[schema.$ref.slice(prefix.length)];
    if (resolved === undefined) throw new Error(`missing ref ${schema.$ref}`);
    return resolveSchema(resolved, root);
  }
  if (schema.allOf?.length === 1) return resolveSchema(schema.allOf[0]!, root);
  return schema;
};

const schemaKinds = (
  schema: JsonSchema,
  root: Exclude<JsonSchema, boolean>,
): readonly CodexFallbackShapeKind[] => {
  const resolved = resolveSchema(schema, root);
  if (resolved === true) return ["unknown"];
  if (resolved === false) return [];
  const alternatives = resolved.anyOf ?? resolved.oneOf;
  if (alternatives) {
    return [...new Set(alternatives.flatMap((child) => schemaKinds(child, root)))].sort();
  }
  const types = Array.isArray(resolved.type)
    ? resolved.type
    : resolved.type
      ? [resolved.type]
      : resolved.properties
        ? ["object"]
        : ["unknown"];
  return types.map((type) => type as CodexFallbackShapeKind).sort();
};

const schemaEnumValues = (
  schema: JsonSchema,
  root: Exclude<JsonSchema, boolean>,
): readonly string[] | undefined => {
  const resolved = resolveSchema(schema, root);
  if (resolved === true || resolved === false) return undefined;
  if (resolved.enum) return resolved.enum.filter((value): value is string => typeof value === "string");
  const schemaAlternatives = resolved.oneOf ?? resolved.anyOf;
  if (schemaAlternatives) {
    const values = schemaAlternatives.flatMap((alternative) =>
      schemaEnumValues(alternative, root) ?? []);
    return values.length > 0 ? values : undefined;
  }
  return undefined;
};

const schemaRequired = (
  schema: Exclude<JsonSchema, boolean>,
  root: Exclude<JsonSchema, boolean>,
): readonly string[] => {
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (!alternatives || alternatives.length === 0) return schema.required ?? [];
  const requiredSets = alternatives.map((candidate) => {
    const resolved = resolveSchema(candidate, root);
    return new Set(
      resolved === true || resolved === false ? [] : schemaRequired(resolved, root),
    );
  });
  const commonAlternativeFields = [...(requiredSets[0] ?? new Set<string>())].filter((name) =>
    requiredSets.every((set) => set.has(name)));
  return [...new Set([...(schema.required ?? []), ...commonAlternativeFields])];
};

const schemaProperty = (
  schema: Exclude<JsonSchema, boolean>,
  name: string,
  root: Exclude<JsonSchema, boolean>,
): JsonSchema | undefined => {
  if (schema.properties?.[name] !== undefined) return schema.properties[name];
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (!alternatives) return undefined;
  const candidates = alternatives.flatMap((candidate) => {
    const resolved = resolveSchema(candidate, root);
    if (resolved === true || resolved === false) return [];
    const property = schemaProperty(resolved, name, root);
    return property === undefined ? [] : [property];
  });
  if (candidates.length === 0) return undefined;
  return candidates.length === 1 ? candidates[0] : { oneOf: candidates };
};

const compareShapeToSchema = (
  shape: CodexFallbackShape,
  schema: JsonSchema,
  root: Exclude<JsonSchema, boolean>,
  pathLabel: string,
): void => {
  if (shape.kinds.includes("unknown")) return;
  const expectedKinds = shape.kinds.includes("rpc-id")
    ? ["integer", "string"]
    : [...shape.kinds].sort();
  expect(schemaKinds(schema, root), `${pathLabel} kinds`).toEqual(expectedKinds);
  if (shape.enumValues) {
    expect(schemaEnumValues(schema, root), `${pathLabel} enum`).toEqual(shape.enumValues);
  }

  const resolved = resolveSchema(schema, root);
  if (resolved === true || resolved === false) return;
  if (shape.items) {
    expect(resolved.items, `${pathLabel} items schema`).toBeDefined();
    compareShapeToSchema(shape.items, resolved.items!, root, `${pathLabel}[]`);
  }
  if (shape.alternatives) {
    const schemaAlternatives = resolved.oneOf ?? resolved.anyOf;
    expect(schemaAlternatives, `${pathLabel} alternatives`).toHaveLength(shape.alternatives.length);
    for (const [index, alternative] of shape.alternatives.entries()) {
      compareShapeToSchema(
        alternative,
        schemaAlternatives![index]!,
        root,
        `${pathLabel}.variant[${index}]`,
      );
    }
  }
  if (!shape.kinds.includes("object")) return;
  const required = [...(
    shape.alternatives ? resolved.required ?? [] : schemaRequired(resolved, root)
  )].sort();
  expect(Object.keys(shape.required ?? {}).sort(), `${pathLabel} required`).toEqual(required);
  for (const [name, child] of Object.entries(shape.required ?? {})) {
    const childSchema = schemaProperty(resolved, name, root);
    expect(childSchema, `${pathLabel}.${name} schema`).toBeDefined();
    compareShapeToSchema(child, childSchema!, root, `${pathLabel}.${name}`);
  }
  for (const [name, child] of Object.entries(shape.optional ?? {})) {
    const childSchema = schemaProperty(resolved, name, root);
    expect(childSchema, `${pathLabel}.${name} optional schema`).toBeDefined();
    compareShapeToSchema(child, childSchema!, root, `${pathLabel}.${name}`);
  }

};

const findMethodVariant = (
  aggregate: Exclude<JsonSchema, boolean>,
  method: string,
): Exclude<JsonSchema, boolean> => {
  const variant = aggregate.oneOf?.find((candidate) => {
    if (typeof candidate === "boolean") return false;
    const methodSchema = candidate.properties?.method;
    if (typeof methodSchema === "boolean" || methodSchema === undefined) return false;
    return methodSchema.enum?.includes(method) ?? false;
  });
  if (!variant || typeof variant === "boolean") throw new Error(`missing method variant ${method}`);
  return variant;
};

const validForShape = (shape: CodexFallbackShape): unknown => {
  if (Object.prototype.hasOwnProperty.call(shape, "constValue")) return shape.constValue;
  if (shape.enumValues) return shape.enumValues[0];
  const kind = shape.kinds.find((candidate) => candidate !== "null") ?? "null";
  if (kind !== "object" && shape.alternatives?.[0]) {
    return validForShape(shape.alternatives[0]);
  }
  switch (kind) {
    case "object":
      return Object.assign(Object.fromEntries(
        Object.entries(shape.required ?? {}).map(([name, child]) => [name, validForShape(child)]),
      ), shape.alternatives?.[0] ? validForShape(shape.alternatives[0]) : {});
    case "array":
      return shape.items ? [validForShape(shape.items)] : [];
    case "string":
    case "rpc-id":
      return "value";
    case "integer":
      return 1;
    case "number":
      return 1.5;
    case "boolean":
      return true;
    case "null":
      return null;
    case "unknown":
      return { value: true };
  }
};

const wrongForShape = (shape: CodexFallbackShape): unknown => {
  for (const candidate of [null, {}, [], "wrong", 1, true]) {
    const candidateKind = candidate === null
      ? "null"
      : Array.isArray(candidate)
        ? "array"
        : typeof candidate === "number"
          ? "integer"
          : typeof candidate;
    if (
      !shape.kinds.includes(candidateKind as CodexFallbackShapeKind) &&
      !(shape.kinds.includes("rpc-id") && (candidateKind === "string" || candidateKind === "integer"))
    ) return candidate;
  }
  return undefined;
};

describe("Codex method-specific fallback shapes", () => {
  it("covers every stable fallback method and no experimental method", () => {
    expect(Object.keys(CODEX_FALLBACK_METHOD_DESCRIPTORS.clientRequests)).toEqual(
      CODEX_PROTOCOL_METHODS.clientRequests,
    );
    expect(Object.keys(CODEX_FALLBACK_METHOD_DESCRIPTORS.clientNotifications)).toEqual(
      CODEX_PROTOCOL_METHODS.clientNotifications,
    );
    expect(Object.keys(CODEX_FALLBACK_METHOD_DESCRIPTORS.serverRequests)).toEqual(
      CODEX_PROTOCOL_METHODS.serverRequests,
    );
    expect(Object.keys(CODEX_FALLBACK_METHOD_DESCRIPTORS.serverNotifications)).toEqual(
      CODEX_PROTOCOL_METHODS.serverNotifications,
    );
  });

  it("derives every matching 0.144.1 method variant and compares required fields and kinds", () => {
    for (const { direction, descriptors } of descriptorGroups()) {
      const aggregate = readSchema(aggregateSchemas[direction]);
      for (const descriptor of Object.values(descriptors)) {
        const variant = findMethodVariant(aggregate, descriptor.method);
        const paramsSchema = variant.properties?.params;
        if (descriptor.params === null) {
          expect(paramsSchema, `${descriptor.method} has no params`).toBeUndefined();
        } else {
          expect(paramsSchema, `${descriptor.method} params`).toBeDefined();
          compareShapeToSchema(
            descriptor.params,
            paramsSchema!,
            aggregate,
            `${descriptor.method}.params`,
          );
        }

        if (descriptor.result === null) {
          expect(descriptor.resultSchema, `${descriptor.method} has no result schema`).toBeNull();
        } else {
          expect(descriptor.resultSchema, `${descriptor.method} result schema`).not.toBeNull();
          expect(descriptor.resultSchema, `${descriptor.method} generated result mapping`).toBe(
            generatedResultSchemas[descriptor.method],
          );
          const resultRoot = readSchema(descriptor.resultSchema!);
          compareShapeToSchema(
            descriptor.result,
            resultRoot,
            resultRoot,
            `${descriptor.method}.result`,
          );
        }
      }
    }
  });

  it("keeps every installed optional safety field represented by the fallback", () => {
    const clientAggregate = readSchema(aggregateSchemas["client-request"]);
    const criticalClientFields = [
      ["thread/start", "approvalPolicy"],
      ["thread/start", "approvalsReviewer"],
      ["thread/start", "sandbox"],
      ["thread/resume", "approvalPolicy"],
      ["thread/resume", "approvalsReviewer"],
      ["thread/resume", "sandbox"],
      ["thread/fork", "approvalPolicy"],
      ["thread/fork", "approvalsReviewer"],
      ["thread/fork", "sandbox"],
      ["turn/start", "approvalPolicy"],
      ["turn/start", "approvalsReviewer"],
      ["turn/start", "sandboxPolicy"],
    ] as const;

    for (const [method, field] of criticalClientFields) {
      const descriptor = CODEX_FALLBACK_METHOD_DESCRIPTORS.clientRequests[method];
      const fallbackField = descriptor.params?.required?.[field] ?? descriptor.params?.optional?.[field];
      expect(fallbackField, `${method}.params.${field} fallback coverage`).toBeDefined();
      const variant = findMethodVariant(clientAggregate, method);
      const paramsSchema = resolveSchema(variant.properties!.params!, clientAggregate);
      expect(paramsSchema).not.toBeTypeOf("boolean");
      const generatedField = schemaProperty(
        paramsSchema as Exclude<JsonSchema, boolean>,
        field,
        clientAggregate,
      );
      expect(generatedField, `${method}.params.${field} generated coverage`).toBeDefined();
      compareShapeToSchema(
        fallbackField!,
        generatedField!,
        clientAggregate,
        `${method}.params.${field}`,
      );
    }

    const permissionResult = CODEX_FALLBACK_METHOD_DESCRIPTORS.serverRequests[
      "item/permissions/requestApproval"
    ].result!;
    const permissionRoot = readSchema("PermissionsRequestApprovalResponse.json");
    for (const field of ["scope", "strictAutoReview"] as const) {
      const fallbackField = permissionResult.optional?.[field];
      expect(fallbackField, `permissions result ${field} fallback coverage`).toBeDefined();
      const generatedField = schemaProperty(permissionRoot, field, permissionRoot);
      expect(generatedField, `permissions result ${field} generated coverage`).toBeDefined();
      compareShapeToSchema(
        fallbackField!,
        generatedField!,
        permissionRoot,
        `item/permissions/requestApproval.result.${field}`,
      );
    }
  });

  it("runtime guards accept materialized schema-valid required shapes", () => {
    for (const { direction, descriptors } of descriptorGroups()) {
      for (const descriptor of Object.values(descriptors)) {
        const params = descriptor.params === null ? undefined : validForShape(descriptor.params);
        expect(() => assertCodexFallbackParams(direction, descriptor.method, params)).not.toThrow();
        const result = descriptor.result === null ? undefined : validForShape(descriptor.result);
        expect(() => assertCodexFallbackResult(direction, descriptor.method, result)).not.toThrow();
      }
    }
  });

  it("runtime guards reject every missing or wrongly typed top-level required field", () => {
    for (const { direction, descriptors } of descriptorGroups()) {
      for (const descriptor of Object.values(descriptors)) {
        for (const [phase, shape] of [
          ["params", descriptor.params],
          ["result", descriptor.result],
        ] as const) {
          if (shape === null || !shape.kinds.includes("object")) continue;
          const assertPayload = phase === "params" ? assertCodexFallbackParams : assertCodexFallbackResult;
          const valid = validForShape(shape) as Record<string, unknown>;
          for (const [name, fieldShape] of Object.entries(shape.required ?? {})) {
            const missing = structuredClone(valid);
            delete missing[name];
            expect(
              () => assertPayload(direction, descriptor.method, missing),
              `${descriptor.method}.${phase}.${name} missing`,
            ).toThrow(new RegExp(name, "i"));

            const wrong = structuredClone(valid);
            wrong[name] = wrongForShape(fieldShape);
            expect(
              () => assertPayload(direction, descriptor.method, wrong),
              `${descriptor.method}.${phase}.${name} kind`,
            ).toThrow(new RegExp(name, "i"));
          }
        }
      }
    }
  });

  it("rejects critical nested identity and lifecycle shape drift", () => {
    expect(() => assertCodexFallbackParams("client-request", "initialize", {
      clientInfo: { name: "DevHub" },
    })).toThrow(/version/i);
    expect(() => assertCodexFallbackResult("client-request", "thread/read", {
      thread: { id: 7 },
    })).toThrow(/thread|id/i);
    expect(() => assertCodexFallbackParams("server-request", "item/tool/requestUserInput", {
      threadId: "thread-1",
      turnId: "turn-1",
      questions: [],
    })).toThrow(/itemId/i);
    expect(() => assertCodexFallbackParams("server-notification", "serverRequest/resolved", {
      threadId: "thread-1",
      requestId: {},
    })).toThrow(/requestId/i);
  });

  it("rejects non-JSON values that only masquerade as objects", () => {
    expect(() => assertCodexFallbackResult("client-request", "thread/archive", () => undefined))
      .toThrow(/thread\/archive|object/i);
    expect(() => assertCodexFallbackParams(
      "server-request",
      "item/permissions/requestApproval",
      {
        cwd: "/tmp",
        itemId: "item-1",
        permissions: () => undefined,
        startedAtMs: 1,
        threadId: "thread-1",
        turnId: "turn-1",
      },
    )).toThrow(/permissions/i);
  });

  it("enforces the installed MCP elicitation mode-specific required shapes", () => {
    const base = {
      message: "Choose",
      serverName: "example",
      threadId: "thread-1",
    };
    expect(() => assertCodexFallbackParams(
      "server-request",
      "mcpServer/elicitation/request",
      { ...base, mode: "form" },
    )).toThrow(/requestedSchema|variant/i);
    expect(() => assertCodexFallbackParams(
      "server-request",
      "mcpServer/elicitation/request",
      { ...base, mode: "form", requestedSchema: { properties: {}, type: "object" } },
    )).not.toThrow();
    expect(() => assertCodexFallbackParams(
      "server-request",
      "mcpServer/elicitation/request",
      { ...base, mode: "url", url: "https://example.com" },
    )).toThrow(/elicitationId|variant/i);
    expect(() => assertCodexFallbackParams(
      "server-request",
      "mcpServer/elicitation/request",
      {
        ...base,
        elicitationId: "elicit-1",
        mode: "url",
        url: "https://example.com",
      },
    )).not.toThrow();
    expect(() => assertCodexFallbackParams(
      "server-request",
      "mcpServer/elicitation/request",
      { ...base, mode: "unexpected", requestedSchema: {} },
    )).toThrow(/mode|variant/i);
  });

  it("rejects unsafe approval, elicitation, and fallback opt-in values", () => {
    expect(() => assertCodexFallbackResult(
      "server-request",
      "mcpServer/elicitation/request",
      { action: "bogus" },
    )).toThrow(/action/i);
    expect(() => assertCodexFallbackResult(
      "server-request",
      "item/fileChange/requestApproval",
      { decision: "bogus" },
    )).toThrow(/decision/i);
    expect(() => assertCodexFallbackResult(
      "server-request",
      "item/commandExecution/requestApproval",
      { decision: {} },
    )).toThrow(/decision|variant/i);
    expect(() => assertCodexFallbackParams(
      "server-request",
      "mcpServer/elicitation/request",
      {
        message: "Choose",
        mode: "form",
        requestedSchema: 42,
        serverName: "example",
        threadId: "thread-1",
      },
    )).toThrow(/requestedSchema|variant/i);

    for (const capability of [
      "experimentalApi",
      "mcpServerOpenaiFormElicitation",
      "requestAttestation",
    ]) {
      expect(() => assertCodexFallbackParams("client-request", "initialize", {
        capabilities: { [capability]: true },
        clientInfo: { name: "devhub", version: "1.0.0" },
      }), capability).toThrow(new RegExp(capability, "i"));
    }
  });

  it("enforces exact installed approval reviewer, approval policy, and sandbox-mode values", () => {
    const granular = {
      mcp_elicitations: true,
      request_permissions: false,
      rules: true,
      sandbox_approval: false,
      skill_approval: true,
    };

    for (const approvalPolicy of ["untrusted", "on-request", "never", { granular }]) {
      expect(() => assertCodexFallbackParams("client-request", "thread/start", {
        approvalPolicy,
      })).not.toThrow();
    }
    for (const approvalsReviewer of ["user", "auto_review", "guardian_subagent"]) {
      expect(() => assertCodexFallbackParams("client-request", "thread/start", {
        approvalsReviewer,
      })).not.toThrow();
    }
    for (const sandbox of ["read-only", "workspace-write", "danger-full-access"]) {
      expect(() => assertCodexFallbackParams("client-request", "thread/start", {
        sandbox,
      })).not.toThrow();
    }

    expect(() => assertCodexFallbackParams("client-request", "thread/start", {
      approvalPolicy: "always",
    })).toThrow(/approvalPolicy/i);
    expect(() => assertCodexFallbackParams("client-request", "thread/start", {
      approvalPolicy: { granular: { rules: true } },
    })).toThrow(/granular|mcp_elicitations|sandbox_approval|variant/i);
    expect(() => assertCodexFallbackParams("client-request", "thread/start", {
      approvalPolicy: { granular, unexpected: true },
    })).toThrow(/approvalPolicy|unexpected|additional|variant/i);
    expect(() => assertCodexFallbackParams("client-request", "thread/start", {
      approvalsReviewer: "system",
    })).toThrow(/approvalsReviewer/i);
    expect(() => assertCodexFallbackParams("client-request", "thread/start", {
      sandbox: "externalSandbox",
    })).toThrow(/sandbox/i);
  });

  it("enforces exact installed sandbox-policy variants and container kinds", () => {
    const validPolicies = [
      { type: "dangerFullAccess" },
      { networkAccess: true, type: "readOnly" },
      { networkAccess: "restricted", type: "externalSandbox" },
      {
        excludeSlashTmp: false,
        excludeTmpdirEnvVar: true,
        networkAccess: false,
        type: "workspaceWrite",
        writableRoots: ["/workspace", "/tmp/safe"],
      },
    ];
    for (const sandboxPolicy of validPolicies) {
      expect(() => assertCodexFallbackParams("client-request", "turn/start", {
        input: [],
        sandboxPolicy,
        threadId: "thread-1",
      })).not.toThrow();
    }

    for (const sandboxPolicy of [
      { type: "workspace-write" },
      { networkAccess: "enabled", type: "readOnly" },
      { networkAccess: true, type: "externalSandbox" },
      { type: "workspaceWrite", writableRoots: "/workspace" },
      { type: "dangerFullAccess", writableRoots: [] },
    ]) {
      expect(() => assertCodexFallbackParams("client-request", "turn/start", {
        input: [],
        sandboxPolicy,
        threadId: "thread-1",
      }), JSON.stringify(sandboxPolicy)).toThrow(/sandboxPolicy|variant|networkAccess|writableRoots/i);
    }
  });

  it("validates permission request and response scope/profile structures", () => {
    const request = {
      cwd: "/workspace",
      environmentId: null,
      itemId: "item-1",
      permissions: {
        fileSystem: {
          entries: [{ access: "write", path: { path: "/workspace/out", type: "path" } }],
          globScanMaxDepth: 3,
          read: ["/workspace/input"],
          write: null,
        },
        network: { enabled: true },
      },
      reason: "write output",
      startedAtMs: 1,
      threadId: "thread-1",
      turnId: "turn-1",
    };
    expect(() => assertCodexFallbackParams(
      "server-request",
      "item/permissions/requestApproval",
      request,
    )).not.toThrow();
    expect(() => assertCodexFallbackResult(
      "server-request",
      "item/permissions/requestApproval",
      {
        permissions: request.permissions,
        scope: "session",
        strictAutoReview: true,
      },
    )).not.toThrow();

    expect(() => assertCodexFallbackParams(
      "server-request",
      "item/permissions/requestApproval",
      { ...request, permissions: { arbitrary: true } },
    )).toThrow(/permissions|arbitrary|additional/i);
    expect(() => assertCodexFallbackParams(
      "server-request",
      "item/permissions/requestApproval",
      {
        ...request,
        permissions: {
          fileSystem: { entries: [{ access: "execute", path: { path: "/tmp", type: "path" } }] },
        },
      },
    )).toThrow(/access|variant/i);
    expect(() => assertCodexFallbackResult(
      "server-request",
      "item/permissions/requestApproval",
      { permissions: {}, scope: "process" },
    )).toThrow(/scope/i);
    expect(() => assertCodexFallbackResult(
      "server-request",
      "item/permissions/requestApproval",
      { permissions: {}, strictAutoReview: "yes" },
    )).toThrow(/strictAutoReview/i);
    expect(() => assertCodexFallbackResult(
      "server-request",
      "item/permissions/requestApproval",
      { permissions: { arbitrary: true } },
    )).toThrow(/permissions|arbitrary|additional/i);
  });

  it("rejects unknown properties on safety-critical response containers", () => {
    expect(() => assertCodexFallbackResult(
      "server-request",
      "item/commandExecution/requestApproval",
      {
        decision: {
          acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git status"] },
          arbitrary: true,
        },
      },
    )).toThrow(/decision|arbitrary|additional|variant/i);
    expect(() => assertCodexFallbackResult(
      "server-request",
      "item/permissions/requestApproval",
      { permissions: {}, arbitrary: true },
    )).toThrow(/arbitrary|additional/i);
    expect(() => assertCodexFallbackResult(
      "server-request",
      "mcpServer/elicitation/request",
      { action: "accept", content: {}, arbitrary: true },
    )).toThrow(/arbitrary|additional/i);
  });

  it("recursively rejects every non-JSON value in open JSON fields", () => {
    expect(() => assertCodexFallbackResult(
      "server-request",
      "mcpServer/elicitation/request",
      { action: "accept", content: { nested: () => undefined } },
    )).toThrow(/content|nested|JSON|invalid/i);
    expect(() => assertCodexFallbackParams("client-request", "thread/start", {
      config: { values: [undefined] },
    })).toThrow(/config|values|JSON|invalid/i);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertCodexFallbackResult(
      "server-request",
      "mcpServer/elicitation/request",
      { action: "accept", content: cyclic },
    )).toThrow(/content|cyclic|JSON|invalid/i);
  });

  it("supports the installed stable thread unsubscribe request and status result", () => {
    expect(() => assertCodexFallbackParams("client-request", "thread/unsubscribe", {
      threadId: "thread-1",
    })).not.toThrow();
    for (const status of ["notLoaded", "notSubscribed", "unsubscribed"]) {
      expect(() => assertCodexFallbackResult("client-request", "thread/unsubscribe", {
        status,
      })).not.toThrow();
    }
    expect(() => assertCodexFallbackParams("client-request", "thread/unsubscribe", {}))
      .toThrow(/threadId/i);
    expect(() => assertCodexFallbackResult("client-request", "thread/unsubscribe", {
      status: "subscribed",
    })).toThrow(/status/i);
  });
});
