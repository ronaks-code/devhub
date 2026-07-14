import { CODEX_FALLBACK_METHOD_DESCRIPTORS } from "./fallback-shapes.js";

const clientRequests = Object.freeze([
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
] as const);

const clientNotifications = Object.freeze(["initialized"] as const);

const serverRequests = Object.freeze([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
] as const);

const serverNotifications = Object.freeze([
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
] as const);

const experimentalClientRequests = Object.freeze([
  "experimentalFeature/list",
  "experimentalFeature/enablement/set",
] as const);

/**
 * Small, checked fallback surface used when generated Codex bindings are not
 * available at runtime. Generated bindings remain the compatibility oracle in
 * tests; this fallback deliberately excludes experimental APIs.
 */
export const CODEX_PROTOCOL_METHODS = Object.freeze({
  clientRequests,
  clientNotifications,
  serverRequests,
  serverNotifications,
});

export const CODEX_FALLBACK_PROTOCOL = Object.freeze({
  methods: CODEX_PROTOCOL_METHODS,
  descriptors: CODEX_FALLBACK_METHOD_DESCRIPTORS,
  experimental: Object.freeze({
    enabled: false as const,
    clientRequests: experimentalClientRequests,
  }),
});

export type CodexClientRequestMethod = (typeof clientRequests)[number];
export type CodexClientNotificationMethod = (typeof clientNotifications)[number];
export type CodexServerRequestMethod = (typeof serverRequests)[number];
export type CodexServerNotificationMethod = (typeof serverNotifications)[number];

const serverRequestSet: ReadonlySet<string> = new Set(serverRequests);
const serverNotificationSet: ReadonlySet<string> = new Set(serverNotifications);

export const isCodexServerRequestMethod = (method: string): method is CodexServerRequestMethod =>
  serverRequestSet.has(method);

export const isCodexServerNotificationMethod = (
  method: string,
): method is CodexServerNotificationMethod => serverNotificationSet.has(method);
