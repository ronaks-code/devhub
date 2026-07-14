/**
 * Compact stable compatibility surface for DevHub's Codex app-server peer.
 * Generated bindings remain authoritative for an exact installed version.
 */

export type RpcId = string | number;

export interface RpcRequest<P = unknown> {
  id: RpcId;
  method: StableClientMethod;
  params: P;
}

export interface RpcNotification<P = unknown> {
  method: StableClientNotification | StableServerNotification | string;
  params: P;
}

export type RpcResponse<R = unknown> =
  | { id: RpcId; result: R }
  | { id: RpcId; error: { code: number; message: string; data?: unknown } };

export type StableClientNotification = "initialized";

export type StableClientMethod =
  | "initialize"
  | "thread/start"
  | "thread/resume"
  | "thread/fork"
  | "thread/list"
  | "thread/loaded/list"
  | "thread/read"
  | "thread/archive"
  | "thread/unarchive"
  | "thread/delete"
  | "thread/unsubscribe"
  | "thread/name/set"
  | "thread/metadata/update"
  | "thread/compact/start"
  | "thread/rollback"
  | "thread/inject_items"
  | "thread/goal/set"
  | "thread/goal/get"
  | "thread/goal/clear"
  | "turn/start"
  | "turn/steer"
  | "turn/interrupt"
  | "model/list"
  | "modelProvider/capabilities/read"
  | "permissionProfile/list"
  | "experimentalFeature/list"
  | "skills/list"
  | "skills/extraRoots/set"
  | "skills/config/write"
  | "hooks/list"
  | "app/list"
  | "plugin/list"
  | "plugin/installed"
  | "plugin/read"
  | "plugin/skill/read"
  | "mcpServerStatus/list"
  | "mcpServer/resource/read"
  | "mcpServer/tool/call"
  | "mcpServer/oauth/login"
  | "config/mcpServer/reload"
  | "config/read"
  | "config/value/write"
  | "config/batchWrite"
  | "configRequirements/read"
  | "account/read"
  | "account/login/start"
  | "account/login/cancel"
  | "account/logout"
  | "account/rateLimits/read"
  | "account/usage/read"
  | "account/workspaceMessages/read"
  | "review/start"
  | "command/exec"
  | "command/exec/write"
  | "command/exec/resize"
  | "command/exec/terminate";

export type StableServerRequestMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/tool/requestUserInput"
  | "item/permissions/requestApproval"
  | "mcpServer/elicitation/request"
  | "item/tool/call"
  | "account/chatgptAuthTokens/refresh"
  | "attestation/generate"
  | "applyPatchApproval"
  | "execCommandApproval";

export type StableServerNotification =
  | "thread/started"
  | "thread/archived"
  | "thread/unarchived"
  | "thread/name/updated"
  | "thread/closed"
  | "turn/started"
  | "turn/completed"
  | "turn/diff/updated"
  | "turn/plan/updated"
  | "item/started"
  | "item/completed"
  | "item/agentMessage/delta"
  | "command/exec/outputDelta"
  | "serverRequest/resolved";

export interface InitializeParams {
  clientInfo: { name: "devhub"; title: "DevHub"; version: string };
  capabilities?: {
    experimentalApi?: false;
    optOutNotificationMethods?: string[];
    requestAttestation?: false;
    mcpServerOpenaiFormElicitation?: boolean;
  };
}

export type CommandApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

export type FileApprovalDecision = CommandApprovalDecision;

export type McpElicitationResponse =
  | { action: "accept"; content: unknown }
  | { action: "decline" | "cancel"; content: null };

export interface UserInputResponse {
  answers: Record<string, { answers: string[] }>;
}

export interface PermissionResponse {
  permissions: Record<string, unknown>;
  scope?: "turn" | "session";
}

export function isRpcResponse(value: unknown): value is RpcResponse {
  return Boolean(value && typeof value === "object" && "id" in value && ("result" in value || "error" in value));
}
