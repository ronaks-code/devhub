import { redactSecrets } from "../redact.js";
import {
  DEFAULT_PROVIDER_CAPABILITIES,
  ProviderCapabilityError,
  requireProviderCapability,
  type ProviderCapability,
} from "./capabilities.js";
import {
  assertNativeTaskKey,
  canonicalizeProviderHome,
  snapshotNativeTaskKey,
} from "./task-key.js";
import {
  normalizeProviderEvent,
  type ProviderEvent,
  type ProviderRequest,
} from "./events.js";
import {
  createProviderRequestIdentity,
  serializeProviderRequestIdentity,
} from "./request-identity.js";
import type {
  ListTasksInput,
  NativeTask,
  NativeTaskKey,
  NativeTaskSummary,
  NativeTurnRef,
  Page,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderEventSink,
  ProviderId,
  ProviderRequestResponse,
  StartTaskInput,
  TaskOverrides,
  Unsubscribe,
  UserInput,
} from "./types.js";
import {
  ProviderOperationError,
  safeProviderOperationMessage,
} from "./operation-error.js";

export class ProviderRegistryNotFoundError extends Error {
  readonly code = "PROVIDER_ADAPTER_NOT_FOUND";

  constructor(
    readonly provider: ProviderId,
    readonly home: string,
  ) {
    super(`no ${provider} provider adapter is registered for ${home}`);
    this.name = "ProviderRegistryNotFoundError";
  }
}

export class ProviderAdapterError extends Error {
  readonly code = "PROVIDER_ADAPTER_FAILURE";

  constructor(
    readonly provider: ProviderId,
    readonly home: string,
    cause: unknown,
  ) {
    super(`${provider} provider adapter failed for ${home}`, { cause });
    this.name = "ProviderAdapterError";
  }
}

export type ProviderDescriptorCensus =
  | {
      provider: ProviderId;
      home: string;
      status: "available";
      capabilities: Readonly<ProviderCapabilities>;
    }
  | {
      provider: ProviderId;
      home: string;
      status: "unavailable";
      error: {
        code: "PROVIDER_ADAPTER_FAILURE";
        message: string;
      };
    };

export type ProviderResponseDispatchResult = "dispatched" | "stale";

export const MAX_PENDING_PROVIDER_REQUESTS = 512;
export const MAX_TERMINAL_PROVIDER_REQUESTS = 4_096;

interface RegistryEntry {
  provider: ProviderId;
  home: string;
  adapter: ProviderAdapter;
}

interface SubscriptionRequestLedger {
  active: boolean;
  readonly requestKeys: Set<string>;
}

const CAPABILITY_NAMES = Object.keys(DEFAULT_PROVIDER_CAPABILITIES) as ProviderCapability[];

function entryId(provider: ProviderId, home: string): string {
  return `${provider}\u0000${home}`;
}

function checkedCapabilities(value: ProviderCapabilities): Readonly<ProviderCapabilities> {
  if (!value || typeof value !== "object") {
    throw new TypeError("provider capabilities must be an object");
  }
  const capabilities = {} as ProviderCapabilities;
  for (const capability of CAPABILITY_NAMES) {
    if (typeof value[capability] !== "boolean") {
      throw new TypeError(`provider capability ${capability} must be an explicit boolean`);
    }
    capabilities[capability] = value[capability];
  }
  return Object.freeze(capabilities);
}

function safeErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return redactSecrets(message).slice(0, 512);
}

function nonEmptyNativeId(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty native id`);
  }
  const normalized = value.trim();
  if (normalized.includes("\u0000")) {
    throw new TypeError(`${label} must not contain a NUL character`);
  }
  return normalized;
}

function exactRevisionFingerprint(value: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 512 ||
    value !== value.trim() || value.includes("\u0000")
  ) {
    throw new TypeError("reviewed fingerprint must be an exact bounded string");
  }
  return value;
}

function responseCapability(response: ProviderRequestResponse): ProviderCapability {
  switch (response.kind) {
    case "command-approval":
      return "approveCommand";
    case "file-change-approval":
      return "approveFileChange";
    case "permission":
      return "approvePermissions";
    case "user-input":
      return "requestUserInput";
    case "mcp-elicitation":
      return "mcpElicitation";
  }
}

function snapshotResponse(response: ProviderRequestResponse): ProviderRequestResponse {
  const identity = createProviderRequestIdentity(response.identity);
  switch (response.kind) {
    case "command-approval":
    case "file-change-approval":
    case "mcp-elicitation":
      return Object.freeze({ kind: response.kind, identity, decision: response.decision });
    case "permission":
      return Object.freeze({
        kind: response.kind,
        identity,
        permissions: Object.freeze([...response.permissions]),
      });
    case "user-input":
      return Object.freeze({
        kind: response.kind,
        identity,
        answers: Object.freeze({ ...response.answers }),
      });
  }
}

function snapshotTaskSummary(summary: NativeTaskSummary): Readonly<NativeTaskSummary> {
  if (summary.archived !== null && typeof summary.archived !== "boolean") {
    throw new TypeError("provider task archived state must be a boolean or null");
  }
  const revision = summary.revision
    ? Object.freeze({
        updatedAt: summary.revision.updatedAt,
        status: summary.revision.status,
        lastTurnId: summary.revision.lastTurnId,
        lastTurnStatus: summary.revision.lastTurnStatus,
        lastItemId: summary.revision.lastItemId,
        fingerprint: summary.revision.fingerprint,
      })
    : undefined;
  return Object.freeze({
    key: snapshotNativeTaskKey(summary.key),
    title: summary.title,
    cwd: summary.cwd,
    model: summary.model,
    status: summary.status,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    archived: summary.archived,
    source: summary.source,
    ...(revision ? { revision } : {}),
  });
}

function snapshotTask(task: NativeTask): Readonly<NativeTask> {
  const summary = snapshotTaskSummary(task);
  const turns = Object.freeze(task.turns.map((turn) => Object.freeze({
    id: turn.id,
    status: turn.status,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    events: Object.freeze(turn.events.map((event) => snapshotProviderEvent(event, summary.key))),
  })));
  return Object.freeze({ ...summary, turns });
}

function eventOccurredAt(event: unknown): string | undefined {
  if (!event || typeof event !== "object" || !("occurredAt" in event)) return undefined;
  const occurredAt = (event as { occurredAt?: unknown }).occurredAt;
  if (typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt))) return undefined;
  return occurredAt;
}

function snapshotProviderEvent(event: unknown, key: NativeTaskKey): ProviderEvent {
  const occurredAt = eventOccurredAt(event);
  return normalizeProviderEvent(event, {
    provider: key.provider,
    key,
    ...(occurredAt ? { occurredAt } : {}),
  });
}

export class ProviderRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly pendingRequests = new Map<string, ProviderRequest["kind"]>();
  private readonly pendingRequestSubscriptions = new Map<
    string,
    Set<SubscriptionRequestLedger>
  >();
  private readonly terminalRequests = new Set<string>();

  register(home: string, adapter: ProviderAdapter): void {
    const canonicalHome = canonicalizeProviderHome(home);
    const id = entryId(adapter.provider, canonicalHome);
    if (this.entries.has(id)) {
      throw new Error(`${adapter.provider} provider adapter already registered for ${canonicalHome}`);
    }
    this.entries.set(id, {
      provider: adapter.provider,
      home: canonicalHome,
      adapter,
    });
  }

  lookup(provider: ProviderId, home: string): ProviderAdapter {
    const canonicalHome = canonicalizeProviderHome(home);
    const entry = this.entries.get(entryId(provider, canonicalHome));
    if (!entry) throw new ProviderRegistryNotFoundError(provider, canonicalHome);
    return entry.adapter;
  }

  async descriptorCensus(): Promise<readonly ProviderDescriptorCensus[]> {
    const entries = [...this.entries.values()];
    const settled = await Promise.allSettled(
      entries.map(async (entry) => checkedCapabilities(await entry.adapter.capabilities())),
    );
    return settled.map((result, index) => {
      const entry = entries[index]!;
      if (result.status === "fulfilled") {
        return {
          provider: entry.provider,
          home: entry.home,
          status: "available" as const,
          capabilities: result.value,
        };
      }
      return {
        provider: entry.provider,
        home: entry.home,
        status: "unavailable" as const,
        error: {
          code: "PROVIDER_ADAPTER_FAILURE" as const,
          message: safeErrorMessage(result.reason),
        },
      };
    });
  }

  async listTasks(
    provider: ProviderId,
    input: ListTasksInput,
  ): Promise<Page<NativeTaskSummary>> {
    const home = canonicalizeProviderHome(input.home);
    return this.invoke(provider, home, "list", async (adapter) => {
      const page = await adapter.listTasks({ ...input, home });
      if (!page || !Array.isArray(page.items)) {
        throw new TypeError("provider list response must contain an items array");
      }
      for (const item of page.items) this.assertOwnership(item.key, provider, home);
      return Object.freeze({
        items: Object.freeze(page.items.map(snapshotTaskSummary)),
        nextCursor: page.nextCursor,
      });
    });
  }

  async readTask(key: NativeTaskKey, includeTurns = false): Promise<NativeTask> {
    const snapshot = snapshotNativeTaskKey(key);
    return this.invoke(snapshot.provider, snapshot.home, "read", async (adapter) => {
      const task = await adapter.readTask(snapshot, includeTurns);
      this.assertOwnership(task.key, snapshot.provider, snapshot.home);
      if (task.key.nativeTaskId !== snapshot.nativeTaskId) {
        throw new TypeError("provider returned a different native task id");
      }
      return snapshotTask(task);
    });
  }

  async acknowledgeReconciliation(
    key: NativeTaskKey,
    reviewedFingerprint: string,
  ): Promise<void> {
    const snapshot = snapshotNativeTaskKey(key);
    const fingerprint = exactRevisionFingerprint(reviewedFingerprint);
    return this.invoke(snapshot.provider, snapshot.home, "read", async (adapter) => {
      const current = await adapter.readTask(snapshot, true);
      this.assertOwnership(current.key, snapshot.provider, snapshot.home);
      if (
        current.key.nativeTaskId !== snapshot.nativeTaskId ||
        current.revision?.fingerprint !== fingerprint
      ) {
        throw new ProviderOperationError(
          "RECONCILIATION_REQUIRED",
          "Provider task requires authoritative reconciliation",
        );
      }
      await adapter.acknowledgeReconciliation?.(snapshot, fingerprint);
    });
  }

  async startTask(provider: ProviderId, input: StartTaskInput): Promise<NativeTask> {
    const home = canonicalizeProviderHome(input.home);
    return this.invoke(provider, home, "start", async (adapter) => {
      const task = await adapter.startTask({ ...input, home });
      this.assertOwnership(task.key, provider, home);
      return snapshotTask(task);
    });
  }

  async resumeTask(key: NativeTaskKey, overrides?: TaskOverrides): Promise<NativeTask> {
    const snapshot = snapshotNativeTaskKey(key);
    return this.invoke(snapshot.provider, snapshot.home, "resume", async (adapter) => {
      const task = await adapter.resumeTask(snapshot, overrides);
      this.assertOwnership(task.key, snapshot.provider, snapshot.home);
      if (task.key.nativeTaskId !== snapshot.nativeTaskId) {
        throw new TypeError("provider resumed a different native task id");
      }
      return snapshotTask(task);
    });
  }

  async forkTask(key: NativeTaskKey, lastTurnId?: string): Promise<NativeTask> {
    const snapshot = snapshotNativeTaskKey(key);
    const turnId = lastTurnId === undefined
      ? undefined
      : nonEmptyNativeId(lastTurnId, "last turn id");
    return this.invoke(snapshot.provider, snapshot.home, "fork", async (adapter) => {
      const task = await adapter.forkTask(snapshot, turnId);
      this.assertOwnership(task.key, snapshot.provider, snapshot.home);
      if (task.key.nativeTaskId === snapshot.nativeTaskId) {
        throw new TypeError("provider fork reused the source native task id");
      }
      return snapshotTask(task);
    }, { partialForkSourceTaskId: snapshot.nativeTaskId });
  }

  async send(key: NativeTaskKey, input: UserInput): Promise<NativeTurnRef> {
    const snapshot = snapshotNativeTaskKey(key);
    return this.invoke(snapshot.provider, snapshot.home, "send", async (adapter) => {
      const ref = await adapter.send(snapshot, input);
      this.assertOwnership(ref.taskKey, snapshot.provider, snapshot.home);
      if (ref.taskKey.nativeTaskId !== snapshot.nativeTaskId) {
        throw new TypeError("provider returned a turn for a different native task id");
      }
      return {
        taskKey: snapshotNativeTaskKey(ref.taskKey),
        turnId: nonEmptyNativeId(ref.turnId, "turn id"),
      };
    });
  }

  async steer(
    key: NativeTaskKey,
    expectedTurnId: string,
    input: UserInput,
  ): Promise<void> {
    const snapshot = snapshotNativeTaskKey(key);
    const turnId = nonEmptyNativeId(expectedTurnId, "expected turn id");
    return this.invoke(snapshot.provider, snapshot.home, "steer", (adapter) =>
      adapter.steer(snapshot, turnId, input));
  }

  async interrupt(key: NativeTaskKey, turnId: string): Promise<void> {
    const snapshot = snapshotNativeTaskKey(key);
    const nativeTurnId = nonEmptyNativeId(turnId, "turn id");
    return this.invoke(snapshot.provider, snapshot.home, "interrupt", (adapter) =>
      adapter.interrupt(snapshot, nativeTurnId));
  }

  async respond(response: ProviderRequestResponse): Promise<ProviderResponseDispatchResult> {
    const safeResponse = snapshotResponse(response);
    const key = safeResponse.identity.key;
    const requestKey = serializeProviderRequestIdentity(safeResponse.identity);
    if (this.pendingRequests.get(requestKey) !== safeResponse.kind) return "stale";

    // Consume before any capability or adapter await so concurrent, duplicate, and
    // uncertain responses cannot be dispatched twice.
    this.pendingRequests.delete(requestKey);
    this.detachRequestFromSubscriptions(requestKey);
    this.markRequestTerminal(requestKey);
    await this.invoke(key.provider, key.home, responseCapability(safeResponse), (adapter) =>
      adapter.respond(safeResponse));
    return "dispatched";
  }

  async archive(key: NativeTaskKey): Promise<void> {
    const snapshot = snapshotNativeTaskKey(key);
    return this.invoke(snapshot.provider, snapshot.home, "archive", (adapter) =>
      adapter.archive(snapshot));
  }

  async rename(key: NativeTaskKey, name: string): Promise<void> {
    const snapshot = snapshotNativeTaskKey(key);
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new TypeError("task name must be a non-empty string");
    }
    return this.invoke(snapshot.provider, snapshot.home, "rename", (adapter) =>
      adapter.rename(snapshot, name.trim()));
  }

  async subscribe(key: NativeTaskKey, sink: ProviderEventSink): Promise<Unsubscribe> {
    const snapshot = snapshotNativeTaskKey(key);
    if (typeof sink !== "function") throw new TypeError("provider event sink must be a function");
    return this.invoke(snapshot.provider, snapshot.home, "subscribe", async (adapter) => {
      const subscription: SubscriptionRequestLedger = {
        active: true,
        requestKeys: new Set<string>(),
      };
      const safeSink: ProviderEventSink = (event) => {
        if (!subscription.active) return;
        const safeEvent = snapshotProviderEvent(event, snapshot);
        this.observeRequestEvent(safeEvent, subscription);
        sink(safeEvent);
      };
      let unsubscribe: Unsubscribe;
      try {
        unsubscribe = await adapter.subscribe(snapshot, safeSink);
        if (typeof unsubscribe !== "function") {
          throw new TypeError("provider subscribe must return an unsubscribe function");
        }
      } catch (error) {
        subscription.active = false;
        this.detachSubscription(subscription);
        throw error;
      }
      let unsubscribePromise: Promise<void> | undefined;
      return () => {
        if (unsubscribePromise) return unsubscribePromise;
        subscription.active = false;
        this.detachSubscription(subscription);
        try {
          unsubscribePromise = Promise.resolve(unsubscribe()).then(() => undefined);
        } catch (error) {
          unsubscribePromise = Promise.reject(error);
        }
        return unsubscribePromise;
      };
    });
  }

  private async invoke<T>(
    provider: ProviderId,
    home: string,
    capability: ProviderCapability,
    operation: (adapter: ProviderAdapter) => Promise<T>,
    options: { readonly partialForkSourceTaskId?: string } = {},
  ): Promise<T> {
    const adapter = this.lookup(provider, home);
    let capabilities: Readonly<ProviderCapabilities>;
    try {
      capabilities = checkedCapabilities(await adapter.capabilities());
    } catch (error) {
      throw new ProviderAdapterError(provider, home, error);
    }
    requireProviderCapability(capabilities, capability, provider);
    try {
      return await operation(adapter);
    } catch (error) {
      if (
        error instanceof ProviderCapabilityError ||
        error instanceof ProviderRegistryNotFoundError ||
        error instanceof ProviderAdapterError
      ) {
        throw error;
      }
      if (error instanceof ProviderOperationError) {
        const partial = error.code === "PARTIAL_START" || error.code === "PARTIAL_FORK";
        const partialForOperation =
          (error.code === "PARTIAL_START" && capability === "start") ||
          (error.code === "PARTIAL_FORK" && capability === "fork");
        if (partial !== (error.task !== undefined) || (partial && !partialForOperation)) {
          throw new ProviderAdapterError(provider, home, new TypeError(
            "provider partial-operation failure has an invalid task projection",
          ));
        }
        let task: Readonly<NativeTask> | undefined;
        if (error.task !== undefined) {
          try {
            this.assertOwnership(error.task.key, provider, home);
            if (error.code === "PARTIAL_FORK") {
              if (
                options.partialForkSourceTaskId === undefined ||
                error.task.key.nativeTaskId === options.partialForkSourceTaskId
              ) {
                throw new TypeError("provider partial fork did not prove a distinct task id");
              }
            }
            task = snapshotTask(error.task);
          } catch (projectionError) {
            throw new ProviderAdapterError(provider, home, projectionError);
          }
        }
        throw new ProviderOperationError(
          error.code,
          safeProviderOperationMessage(error.code),
          task === undefined ? {} : { task },
        );
      }
      throw new ProviderAdapterError(provider, home, error);
    }
  }

  private assertOwnership(key: NativeTaskKey, provider: ProviderId, home: string): void {
    assertNativeTaskKey(key);
    if (key.provider !== provider || key.home !== home) {
      throw new TypeError("provider returned a task owned by a different provider or home");
    }
  }

  private observeRequestEvent(
    event: ProviderEvent,
    subscription: SubscriptionRequestLedger,
  ): void {
    if (event.type === "request") {
      const requestKey = serializeProviderRequestIdentity(event.request.identity);
      if (this.terminalRequests.has(requestKey)) return;
      const pendingKind = this.pendingRequests.get(requestKey);
      if (pendingKind !== undefined) {
        if (pendingKind === event.request.kind) {
          this.attachRequestToSubscription(requestKey, subscription);
        }
        return;
      }
      if (this.pendingRequests.size >= MAX_PENDING_PROVIDER_REQUESTS) {
        this.markRequestTerminal(requestKey);
        return;
      }
      this.pendingRequests.set(requestKey, event.request.kind);
      this.attachRequestToSubscription(requestKey, subscription);
      return;
    }
    if (event.type === "request-resolved") {
      const requestKey = serializeProviderRequestIdentity(event.identity);
      this.pendingRequests.delete(requestKey);
      this.detachRequestFromSubscriptions(requestKey);
      this.markRequestTerminal(requestKey);
    }
  }

  private attachRequestToSubscription(
    requestKey: string,
    subscription: SubscriptionRequestLedger,
  ): void {
    subscription.requestKeys.add(requestKey);
    let subscriptions = this.pendingRequestSubscriptions.get(requestKey);
    if (!subscriptions) {
      subscriptions = new Set<SubscriptionRequestLedger>();
      this.pendingRequestSubscriptions.set(requestKey, subscriptions);
    }
    subscriptions.add(subscription);
  }

  private detachSubscription(subscription: SubscriptionRequestLedger): void {
    for (const requestKey of subscription.requestKeys) {
      const subscriptions = this.pendingRequestSubscriptions.get(requestKey);
      if (!subscriptions) continue;
      subscriptions.delete(subscription);
      if (subscriptions.size === 0) {
        this.pendingRequestSubscriptions.delete(requestKey);
        this.pendingRequests.delete(requestKey);
      }
    }
    subscription.requestKeys.clear();
  }

  private detachRequestFromSubscriptions(requestKey: string): void {
    const subscriptions = this.pendingRequestSubscriptions.get(requestKey);
    if (!subscriptions) return;
    for (const subscription of subscriptions) {
      subscription.requestKeys.delete(requestKey);
    }
    this.pendingRequestSubscriptions.delete(requestKey);
  }

  private markRequestTerminal(requestKey: string): void {
    if (this.terminalRequests.has(requestKey)) this.terminalRequests.delete(requestKey);
    while (this.terminalRequests.size >= MAX_TERMINAL_PROVIDER_REQUESTS) {
      const oldest = this.terminalRequests.values().next();
      if (oldest.done) break;
      this.terminalRequests.delete(oldest.value);
    }
    this.terminalRequests.add(requestKey);
  }
}
