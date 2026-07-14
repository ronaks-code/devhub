import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CODEX_FALLBACK_PROTOCOL,
  CODEX_FALLBACK_METHOD_DESCRIPTORS,
  CODEX_PROTOCOL_METHODS,
  parseCodexEnvelope,
} from "../../src/providers/codex/protocol/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const bindingsRoot = path.join(
  repoRoot,
  ".planning/devhub-codex-parity/provider-bindings/codex-0.144.1/json-schema",
);

const readSchema = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(bindingsRoot, name), "utf8"));

const collectSchemaLiterals = (value: unknown, result = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaLiterals(item, result);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "const" && typeof child === "string") result.add(child);
      if (key === "enum" && Array.isArray(child)) {
        for (const item of child) if (typeof item === "string") result.add(item);
      }
      collectSchemaLiterals(child, result);
    }
  }
  return result;
};

describe("Codex 0.144.1 fallback protocol contract", () => {
  it("checks every stable fallback method against the generated binding schemas", () => {
    const clientRequestMethods = collectSchemaLiterals(readSchema("ClientRequest.json"));
    const clientNotificationMethods = collectSchemaLiterals(readSchema("ClientNotification.json"));
    const serverRequestMethods = collectSchemaLiterals(readSchema("ServerRequest.json"));
    const serverNotificationMethods = collectSchemaLiterals(readSchema("ServerNotification.json"));

    for (const method of CODEX_PROTOCOL_METHODS.clientRequests) {
      expect(clientRequestMethods, method).toContain(method);
    }
    for (const method of CODEX_PROTOCOL_METHODS.clientNotifications) {
      expect(clientNotificationMethods, method).toContain(method);
    }
    for (const method of CODEX_PROTOCOL_METHODS.serverRequests) {
      expect(serverRequestMethods, method).toContain(method);
    }
    for (const method of CODEX_PROTOCOL_METHODS.serverNotifications) {
      expect(serverNotificationMethods, method).toContain(method);
    }
  });

  it("checks fallback envelope and id shapes against the generated JSON-RPC schema", () => {
    const schema = readSchema("JSONRPCMessage.json") as {
      definitions: Record<string, { required?: string[]; anyOf?: Array<{ type?: string }> }>;
    };

    expect(schema.definitions.JSONRPCRequest?.required).toEqual(["id", "method"]);
    expect(schema.definitions.JSONRPCNotification?.required).toEqual(["method"]);
    expect(schema.definitions.JSONRPCResponse?.required).toEqual(["id", "result"]);
    expect(schema.definitions.JSONRPCError?.required).toEqual(["error", "id"]);
    expect(schema.definitions.RequestId?.anyOf?.map(({ type }) => type)).toEqual([
      "string",
      "integer",
    ]);
  });

  it("covers lifecycle, task mutation, notifications, approvals, user input, and MCP elicitation", () => {
    expect(CODEX_PROTOCOL_METHODS.clientRequests).toEqual([
      "initialize",
      "thread/list",
      "thread/read",
      "thread/start",
      "thread/resume",
      "thread/fork",
      "thread/archive",
      "thread/unsubscribe",
      "thread/name/set",
      "turn/start",
      "turn/steer",
      "turn/interrupt",
    ]);
    expect(CODEX_PROTOCOL_METHODS.clientNotifications).toEqual(["initialized"]);
    expect(CODEX_PROTOCOL_METHODS.serverRequests).toEqual([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "item/tool/requestUserInput",
      "mcpServer/elicitation/request",
    ]);
    expect(CODEX_PROTOCOL_METHODS.serverNotifications).toEqual(expect.arrayContaining([
      "thread/started",
      "thread/status/changed",
      "thread/archived",
      "thread/name/updated",
      "turn/started",
      "turn/completed",
      "turn/diff/updated",
      "turn/plan/updated",
      "item/started",
      "item/completed",
      "item/agentMessage/delta",
      "item/plan/delta",
      "serverRequest/resolved",
    ]));
  });

  it("keeps experimental methods isolated and disabled in the fallback", () => {
    expect(CODEX_FALLBACK_PROTOCOL.experimental.enabled).toBe(false);
    expect(CODEX_FALLBACK_PROTOCOL.experimental.clientRequests).toEqual([
      "experimentalFeature/list",
      "experimentalFeature/enablement/set",
    ]);
    for (const method of CODEX_FALLBACK_PROTOCOL.experimental.clientRequests) {
      expect(CODEX_PROTOCOL_METHODS.clientRequests).not.toContain(method);
    }
    expect(CODEX_FALLBACK_PROTOCOL.descriptors).toBe(CODEX_FALLBACK_METHOD_DESCRIPTORS);
  });

  it("rejects oversized, control-bearing, and credential-shaped wire ids and methods", () => {
    for (const id of [
      "x".repeat(513),
      "rpc\ncontrol",
      " request-1 ",
      "sk-proj-0123456789abcdefghijklmnop",
    ]) {
      expect(() => parseCodexEnvelope({ id, result: {} })).toThrow(/id/i);
    }
    for (const method of [
      "x".repeat(257),
      "thread/list\ncontrol",
      "future/sk-proj-0123456789abcdefghijklmnop",
    ]) {
      expect(() => parseCodexEnvelope({ method, params: {} })).toThrow(/method/i);
    }
  });

  it("accepts the four omitted-jsonrpc wire envelope shapes without coercing ids", () => {
    expect(parseCodexEnvelope({ id: 1, method: "thread/list", params: {} })).toEqual({
      id: 1,
      method: "thread/list",
      params: {},
    });
    expect(parseCodexEnvelope({ method: "initialized" })).toEqual({ method: "initialized" });
    expect(parseCodexEnvelope({ id: "1", result: { data: [] } })).toEqual({
      id: "1",
      result: { data: [] },
    });
    expect(parseCodexEnvelope({ id: 2, error: { code: -32_000, message: "failed" } })).toEqual({
      id: 2,
      error: { code: -32_000, message: "failed" },
    });
  });
});
