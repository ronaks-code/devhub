import path from "node:path";
import { listCodexSessions, type CodexSession } from "../../codex.js";
import {
  ProviderCapabilityError,
  defineProviderCapabilities,
} from "../capabilities.js";
import { createProviderRequestIdentity } from "../request-identity.js";
import {
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

export interface CodexHistoryFallbackAdapterOptions {
  home: string;
  listSessions?: () => Promise<CodexSession[]>;
}

const CAPABILITIES = defineProviderCapabilities({ list: true });

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

export class CodexHistoryFallbackAdapter implements ProviderAdapter {
  readonly provider = "openai" as const;
  readonly home: string;

  private readonly listSessions: () => Promise<CodexSession[]>;

  constructor(options: CodexHistoryFallbackAdapterOptions) {
    this.home = canonicalizeProviderHome(options.home);
    const home = this.home;
    this.listSessions = options.listSessions ?? (() => listCodexSessions(home));
  }

  async capabilities() {
    return CAPABILITIES;
  }

  async listTasks(input: ListTasksInput): Promise<Page<NativeTaskSummary>> {
    this.assertHome(input.home);
    const offset = pageOffset(input.cursor);
    const limit = pageLimit(input.limit);
    const sessions = await this.listSessions();
    const page = sessions.slice(offset, offset + limit);
    return {
      items: page.map((session) => this.toSummary(session)),
      nextCursor: offset + limit < sessions.length ? String(offset + limit) : null,
    };
  }

  async readTask(_key: NativeTaskKey, _includeTurns: boolean): Promise<NativeTask> {
    return this.unsupported("read");
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

  private toSummary(session: CodexSession): NativeTaskSummary {
    return {
      key: createNativeTaskKey(this.provider, this.home, session.id),
      title: session.cwd ? path.basename(session.cwd) : `Codex task ${session.id.slice(0, 8)}`,
      cwd: session.cwd,
      model: session.model,
      status: "complete",
      createdAt: session.startedAt,
      updatedAt: session.startedAt,
      archived: null,
      source: "degraded-fallback",
    };
  }

  private assertHome(home: string): void {
    if (canonicalizeProviderHome(home) !== this.home) {
      throw new TypeError("provider home does not match this Codex history adapter");
    }
  }

  private snapshotKey(key: NativeTaskKey): Readonly<NativeTaskKey> {
    const snapshot = snapshotNativeTaskKey(key);
    if (snapshot.provider !== this.provider || snapshot.home !== this.home) {
      throw new TypeError("native task key does not belong to this Codex history adapter");
    }
    return snapshot;
  }

  private unsupported(capability: keyof typeof CAPABILITIES): never {
    throw new ProviderCapabilityError(capability, this.provider);
  }
}
