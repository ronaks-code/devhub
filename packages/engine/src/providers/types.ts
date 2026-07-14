import type { ProviderEvent } from "./events.js";

export type ProviderId = "openai" | "anthropic";

export interface NativeTaskKey {
  readonly provider: ProviderId;
  readonly home: string;
  readonly nativeTaskId: string;
}

export interface ProviderRequestIdentity {
  readonly key: Readonly<NativeTaskKey>;
  /** App-server process generation; legacy/non-process providers use null. */
  readonly generation: number | null;
  readonly turnId: string | null;
  readonly requestId: JsonRpcRequestId;
  readonly itemId: string | null;
  readonly approvalId: JsonRpcRequestId | null;
}

/** JSON-RPC request ids are type-sensitive: numeric `1` is not string `"1"`. */
export type JsonRpcRequestId = string | number;

export interface ProviderCapabilities {
  list: boolean;
  read: boolean;
  start: boolean;
  resume: boolean;
  fork: boolean;
  send: boolean;
  steer: boolean;
  interrupt: boolean;
  subscribe: boolean;
  approveCommand: boolean;
  approveFileChange: boolean;
  approvePermissions: boolean;
  requestUserInput: boolean;
  mcpElicitation: boolean;
  archive: boolean;
  rename: boolean;
  skills: boolean;
  plugins: boolean;
  hooks: boolean;
  mcp: boolean;
  backgroundWork: boolean;
}

export interface NativeRevision {
  updatedAt: number | null;
  status: string;
  lastTurnId: string | null;
  lastTurnStatus: string | null;
  lastItemId: string | null;
  fingerprint: string;
}

export type NativeTaskSource = "native" | "legacy-history" | "degraded-fallback";

export interface NativeTaskSummary {
  key: NativeTaskKey;
  title: string;
  cwd: string | null;
  model: string | null;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** null means the provider surface cannot truthfully determine archive state. */
  archived: boolean | null;
  source: NativeTaskSource;
  revision?: NativeRevision;
}

export interface NativeTurn {
  id: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  events: readonly ProviderEvent[];
}

export interface NativeTask extends NativeTaskSummary {
  turns: readonly NativeTurn[];
}

export interface Page<T> {
  items: readonly T[];
  nextCursor: string | null;
}

export interface ListTasksInput {
  home: string;
  cursor?: string;
  limit?: number;
  includeArchived?: boolean;
}

export interface TaskOverrides {
  model?: string;
  mode?: string;
  permissionMode?: string;
}

export interface UserInput {
  text: string;
  attachments?: readonly {
    name: string;
    path: string;
    mediaType?: string;
  }[];
}

export interface StartTaskInput extends TaskOverrides {
  home: string;
  cwd: string;
  input?: UserInput;
}

export interface NativeTurnRef {
  taskKey: NativeTaskKey;
  turnId: string;
}

export type ProviderRequestResponse =
  | {
      kind: "command-approval" | "file-change-approval" | "mcp-elicitation";
      identity: Readonly<ProviderRequestIdentity>;
      decision: "allow" | "deny" | "cancel";
    }
  | {
      kind: "permission";
      identity: Readonly<ProviderRequestIdentity>;
      permissions: readonly string[];
    }
  | {
      kind: "user-input";
      identity: Readonly<ProviderRequestIdentity>;
      answers: Readonly<Record<string, string>>;
    };

export type ProviderEventSink = (event: ProviderEvent) => void;
export type Unsubscribe = () => void | Promise<void>;

export interface ProviderAdapter {
  readonly provider: ProviderId;
  capabilities(): Promise<ProviderCapabilities>;
  listTasks(input: ListTasksInput): Promise<Page<NativeTaskSummary>>;
  readTask(key: NativeTaskKey, includeTurns: boolean): Promise<NativeTask>;
  startTask(input: StartTaskInput): Promise<NativeTask>;
  resumeTask(key: NativeTaskKey, overrides?: TaskOverrides): Promise<NativeTask>;
  forkTask(key: NativeTaskKey, lastTurnId?: string): Promise<NativeTask>;
  send(key: NativeTaskKey, input: UserInput): Promise<NativeTurnRef>;
  steer(key: NativeTaskKey, expectedTurnId: string, input: UserInput): Promise<void>;
  interrupt(key: NativeTaskKey, turnId: string): Promise<void>;
  respond(request: ProviderRequestResponse): Promise<void>;
  archive(key: NativeTaskKey): Promise<void>;
  rename(key: NativeTaskKey, name: string): Promise<void>;
  /** Clear a provider-private reconciliation latch only for an exact reviewed revision. */
  acknowledgeReconciliation?(
    key: NativeTaskKey,
    reviewedFingerprint: string,
  ): Promise<void>;
  subscribe(key: NativeTaskKey, sink: ProviderEventSink): Promise<Unsubscribe>;
}
