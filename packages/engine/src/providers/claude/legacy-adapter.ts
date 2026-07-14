import type {
  AgentDriver,
  RunningTurn,
  TurnHandlers,
  TurnRequest,
} from "../../driver/types.js";
import type { SessionMessagesPage, SessionSummary } from "../../types.js";
import {
  ProviderCapabilityError,
  defineProviderCapabilities,
} from "../capabilities.js";
import { normalizeProviderEvent, type ProviderEvent } from "../events.js";
import { createProviderRequestIdentity } from "../request-identity.js";
import {
  assertNativeTaskKey,
  canonicalizeProviderHome,
  createNativeTaskKey,
  snapshotNativeTaskKey,
} from "../task-key.js";
import type {
  ListTasksInput,
  NativeTask,
  NativeTaskKey,
  NativeTaskSummary,
  NativeTurnRef,
  Page,
  ProviderAdapter,
  ProviderEventSink,
  ProviderRequestResponse,
  StartTaskInput,
  TaskOverrides,
  Unsubscribe,
  UserInput,
} from "../types.js";

export interface LegacyClaudeHistory {
  listAllSessions(options?: {
    limit?: number;
    offset?: number;
    includeArchived?: boolean;
  }): SessionSummary[];
  getSession(sessionId: string): SessionSummary | undefined;
  getSessionMessages(sessionId: string): Promise<SessionMessagesPage | undefined>;
}

export interface LegacyClaudeAdapterOptions {
  home: string;
  driver: AgentDriver;
  history: LegacyClaudeHistory;
}

const CAPABILITIES = defineProviderCapabilities({ list: true, read: true });

function pageOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const parsed = Number(cursor);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError("cursor must be a non-negative integer");
  }
  return parsed;
}

function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError("limit must be a positive integer");
  }
  return Math.min(limit, 200);
}

export class LegacyClaudeAdapter implements ProviderAdapter {
  readonly provider = "anthropic" as const;
  readonly home: string;

  private readonly driver: AgentDriver;
  private readonly history: LegacyClaudeHistory;

  constructor(options: LegacyClaudeAdapterOptions) {
    this.home = canonicalizeProviderHome(options.home);
    this.driver = options.driver;
    this.history = options.history;
  }

  runTurn(request: TurnRequest, handlers: TurnHandlers): RunningTurn {
    return this.driver.runTurn(request, handlers);
  }

  async capabilities() {
    return CAPABILITIES;
  }

  async listTasks(input: ListTasksInput): Promise<Page<NativeTaskSummary>> {
    this.assertHome(input.home);
    const offset = pageOffset(input.cursor);
    const limit = pageLimit(input.limit);
    const rows = this.history.listAllSessions({
      offset,
      limit: limit + 1,
      includeArchived: input.includeArchived,
    });
    return {
      items: rows.slice(0, limit).map((summary) => this.toSummary(summary)),
      nextCursor: rows.length > limit ? String(offset + limit) : null,
    };
  }

  async readTask(key: NativeTaskKey, includeTurns: boolean): Promise<NativeTask> {
    const snapshot = this.snapshotKey(key);
    const summary = this.history.getSession(snapshot.nativeTaskId);
    if (!summary) throw new Error(`legacy Claude task not found: ${snapshot.nativeTaskId}`);

    const task = this.toSummary(summary);
    if (!includeTurns) return { ...task, turns: [] };

    const page = await this.history.getSessionMessages(snapshot.nativeTaskId);
    const events: ProviderEvent[] = [];
    for (const message of page?.messages ?? []) {
      const text = message.blocks
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (!text) continue;
      const role = message.role === "user" || message.role === "assistant"
        ? message.role
        : "system";
      events.push(
        normalizeProviderEvent(
          {
            type: "message",
            role,
            text,
            turnId: "legacy-history",
            itemId: message.uuid,
          },
          {
            provider: this.provider,
            key: task.key,
            occurredAt: message.timestamp ?? task.updatedAt ?? new Date(0).toISOString(),
          },
        ),
      );
    }
    return {
      ...task,
      turns: events.length === 0
        ? []
        : [
            {
              id: "legacy-history",
              status: "complete",
              startedAt: task.createdAt,
              completedAt: task.updatedAt,
              events,
            },
          ],
    };
  }

  async startTask(_input: StartTaskInput): Promise<NativeTask> {
    return this.unsupported("start");
  }

  async resumeTask(_key: NativeTaskKey, _overrides?: TaskOverrides): Promise<NativeTask> {
    return this.unsupported("resume");
  }

  async forkTask(_key: NativeTaskKey, _lastTurnId?: string): Promise<NativeTask> {
    return this.unsupported("fork");
  }

  async send(_key: NativeTaskKey, _input: UserInput): Promise<NativeTurnRef> {
    return this.unsupported("send");
  }

  async steer(
    _key: NativeTaskKey,
    _expectedTurnId: string,
    _input: UserInput,
  ): Promise<void> {
    return this.unsupported("steer");
  }

  async interrupt(_key: NativeTaskKey, _turnId: string): Promise<void> {
    return this.unsupported("interrupt");
  }

  async respond(request: ProviderRequestResponse): Promise<void> {
    const identity = createProviderRequestIdentity(request.identity);
    this.snapshotKey(identity.key);
    if (request.kind === "permission") {
      return this.unsupported("approvePermissions");
    }
    const capability = request.kind === "file-change-approval"
      ? "approveFileChange"
      : request.kind === "user-input"
        ? "requestUserInput"
        : request.kind === "mcp-elicitation"
          ? "mcpElicitation"
          : "approveCommand";
    return this.unsupported(capability);
  }

  async archive(_key: NativeTaskKey): Promise<void> {
    return this.unsupported("archive");
  }

  async rename(_key: NativeTaskKey, _name: string): Promise<void> {
    return this.unsupported("rename");
  }

  async subscribe(key: NativeTaskKey, _sink: ProviderEventSink): Promise<Unsubscribe> {
    this.snapshotKey(key);
    return this.unsupported("subscribe");
  }

  private toSummary(summary: SessionSummary): NativeTaskSummary {
    return {
      key: createNativeTaskKey(this.provider, this.home, summary.sessionId),
      title: summary.title,
      cwd: summary.cwd,
      model: summary.model,
      status: summary.archived ? "archived" : "complete",
      createdAt: summary.firstTimestamp,
      updatedAt: summary.lastTimestamp,
      archived: summary.archived,
      source: "legacy-history",
    };
  }

  private assertHome(home: string): void {
    if (canonicalizeProviderHome(home) !== this.home) {
      throw new TypeError("provider home does not match this legacy Claude adapter");
    }
  }

  private assertKey(key: NativeTaskKey): void {
    assertNativeTaskKey(key);
    if (key.provider !== this.provider || key.home !== this.home) {
      throw new TypeError("native task key does not belong to this legacy Claude adapter");
    }
  }

  private snapshotKey(key: NativeTaskKey): Readonly<NativeTaskKey> {
    const snapshot = snapshotNativeTaskKey(key);
    this.assertKey(snapshot);
    return snapshot;
  }

  private unsupported(capability: keyof typeof CAPABILITIES): never {
    throw new ProviderCapabilityError(capability, this.provider);
  }
}
