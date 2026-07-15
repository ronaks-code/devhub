/**
 * Locator-only browser client for the unified provider task index (M5 Task 5).
 *
 * This is the facade the web app uses ONLY when the `unifiedTaskIndex` feature is applied true
 * (see `selectProviderTransport`). It speaks exclusively to `/api/provider-index/*` with opaque
 * `ProviderTaskLocator`s and never sends or receives a raw provider home: homes are backend-only
 * and cross the boundary as fingerprints. When the flag is off the app keeps using the existing
 * direct `providerApi` (key-based) routes unchanged, so rollback is instant.
 */
import type {
  DevHubFeatureFlags,
  IndexedProviderTask,
  IndexedProviderTaskSummary,
  JsonRpcRequestId,
  ProviderCapabilities,
  ProviderEvent,
  ProviderId,
  ProviderReconciliationState,
  ProviderTaskLocator,
  ProviderTaskMeta,
  ProviderTaskMetaPatch,
  UserInput,
} from "@devhub/engine/providers";
import { serializeTaskLocator } from "@devhub/engine/providers";
import { getToken, UnauthorizedError } from "./api.js";

const JSON_ACCEPT = "application/json";
const SSE_ACCEPT = "text/event-stream";

export interface PublicProviderHome {
  readonly provider: ProviderId;
  readonly homeFingerprint: string;
  readonly status: "available" | "unavailable";
  readonly capabilities: ProviderCapabilities | null;
}

export interface IndexListInput {
  readonly provider?: ProviderId;
  readonly homeFingerprint?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly includeArchived?: boolean;
}

export interface IndexListPage {
  readonly items: readonly IndexedProviderTaskSummary[];
  readonly nextCursor: string | null;
}

export interface IndexStartInput {
  readonly provider: ProviderId;
  readonly homeFingerprint: string;
  readonly cwd: string;
  readonly input?: UserInput;
  readonly model?: string;
  readonly mode?: string;
  readonly permissionMode?: string;
}

export interface IndexTaskOverrides {
  readonly model?: string;
  readonly mode?: string;
  readonly permissionMode?: string;
}

export interface IndexTurnRef {
  readonly taskKey: ProviderTaskLocator;
  readonly turnId: string;
}

export interface IndexForkResult {
  readonly source: ProviderTaskLocator;
  readonly target: ProviderTaskLocator;
  readonly link: unknown;
}

export interface IndexReadResult {
  readonly task: IndexedProviderTask;
  readonly freshness: "native" | "cache";
  readonly reconciliation: ProviderReconciliationState;
}

export type IndexResponseBody =
  | {
      kind: "command-approval" | "file-change-approval" | "mcp-elicitation";
      identity: IndexResponseIdentity;
      decision: "allow" | "deny" | "cancel";
    }
  | { kind: "permission"; identity: IndexResponseIdentity; permissions: readonly string[] }
  | { kind: "user-input"; identity: IndexResponseIdentity; answers: Record<string, string> };

export interface IndexResponseIdentity {
  readonly generation: number | null;
  readonly turnId: string | null;
  readonly requestId: JsonRpcRequestId;
  readonly itemId: string | null;
  readonly approvalId: JsonRpcRequestId | null;
}

export interface IndexRebuildResult {
  readonly activeGeneration: number;
  readonly taskCount: number;
  readonly eventCount: number;
}

export interface IndexSubscribeOptions {
  readonly signal?: AbortSignal;
  readonly onError?: (error: Error) => void;
}

export interface IndexEventSubscription {
  readonly closed: Promise<void>;
  unsubscribe(): Promise<void>;
}

export type IndexStreamFrame =
  | { readonly type: "snapshot"; readonly streamEpoch: string }
  | { readonly type: "event"; readonly event: ProviderEvent }
  | { readonly type: "live" }
  | { readonly type: "resync-required" };

export interface ProviderIndexApiClient {
  homes(): Promise<readonly PublicProviderHome[]>;
  list(input?: IndexListInput): Promise<IndexListPage>;
  read(locator: ProviderTaskLocator, freshness?: "native" | "cache"): Promise<IndexReadResult>;
  start(input: IndexStartInput): Promise<IndexedProviderTask>;
  resume(locator: ProviderTaskLocator, overrides?: IndexTaskOverrides): Promise<IndexedProviderTask>;
  fork(locator: ProviderTaskLocator, lastTurnId?: string): Promise<IndexForkResult>;
  send(locator: ProviderTaskLocator, input: UserInput): Promise<IndexTurnRef>;
  steer(locator: ProviderTaskLocator, expectedTurnId: string, input: UserInput): Promise<void>;
  interrupt(locator: ProviderTaskLocator, turnId: string): Promise<void>;
  respond(locator: ProviderTaskLocator, response: IndexResponseBody): Promise<void>;
  archive(locator: ProviderTaskLocator): Promise<void>;
  rename(locator: ProviderTaskLocator, name: string): Promise<void>;
  reconciliation(locator: ProviderTaskLocator): Promise<ProviderReconciliationState>;
  acknowledgeReconciliation(
    locator: ProviderTaskLocator,
    latchRevision: number,
    reviewedFingerprint: string | null,
  ): Promise<ProviderReconciliationState>;
  patchMeta(locator: ProviderTaskLocator, patch: ProviderTaskMetaPatch): Promise<ProviderTaskMeta>;
  rebuild(provider: ProviderId, homeFingerprint: string): Promise<IndexRebuildResult>;
  subscribe(
    locator: ProviderTaskLocator,
    sink: (frame: IndexStreamFrame) => void,
    options?: IndexSubscribeOptions,
  ): Promise<IndexEventSubscription>;
}

export class ProviderIndexHttpError extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(`Provider index request failed (${status})`);
    this.name = "ProviderIndexHttpError";
  }
}

export class ProviderIndexStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderIndexStreamError";
  }
}

const BASE = "/api/provider-index";

function authHeaders(accept: string, jsonBody = false): Record<string, string> {
  const headers: Record<string, string> = { accept };
  if (jsonBody) headers["content-type"] = "application/json";
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function locatorPath(locator: ProviderTaskLocator): string {
  return `${BASE}/tasks/${encodeURIComponent(serializeTaskLocator(locator))}`;
}

function query(entries: readonly (readonly [string, string | undefined])[]): string {
  const params = new URLSearchParams();
  for (const [name, value] of entries) {
    if (value !== undefined) params.set(name, value);
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

async function parseError(response: Response): Promise<never> {
  if (response.status === 401) {
    try { await response.body?.cancel(); } catch { /* already closed */ }
    throw new UnauthorizedError("provider index");
  }
  let code: string | null = null;
  try {
    const body = await response.json() as { code?: unknown; error?: unknown };
    if (typeof body.code === "string") code = body.code;
    else if (typeof body.error === "string") code = body.error;
  } catch { /* value-free */ }
  throw new ProviderIndexHttpError(response.status, code);
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  expectedStatus = 200,
): Promise<T> {
  const response = await fetch(url, init);
  if (response.status !== expectedStatus) return parseError(response);
  return await response.json() as T;
}

async function requestVoid(url: string, init: RequestInit): Promise<void> {
  const response = await fetch(url, init);
  if (response.status !== 204) return parseError(response);
  try { await response.body?.cancel(); } catch { /* no body */ }
}

/** Reject any object that (incorrectly) carries a raw home; the facade must stay path-free. */
function assertLocatorShape(value: unknown): void {
  if (value !== null && typeof value === "object" && "home" in (value as object)) {
    throw new ProviderIndexHttpError(500, "unexpected_home_field");
  }
}

export function createProviderIndexApiClient(): ProviderIndexApiClient {
  return {
    homes: () =>
      requestJson<readonly PublicProviderHome[]>(`${BASE}/homes`, {
        method: "GET",
        headers: authHeaders(JSON_ACCEPT),
      }),

    list: (input = {}) =>
      requestJson<IndexListPage>(
        `${BASE}/tasks${query([
          ["provider", input.provider],
          ["homeFingerprint", input.homeFingerprint],
          ["cursor", input.cursor],
          ["limit", input.limit === undefined ? undefined : String(input.limit)],
          ["includeArchived",
            input.includeArchived === undefined ? undefined : String(input.includeArchived)],
        ])}`,
        { method: "GET", headers: authHeaders(JSON_ACCEPT) },
      ),

    read: async (locator, freshness) => {
      const result = await requestJson<IndexReadResult>(
        `${locatorPath(locator)}${query([["freshness", freshness]])}`,
        { method: "GET", headers: authHeaders(JSON_ACCEPT) },
      );
      assertLocatorShape(result.task);
      return result;
    },

    start: async (input) => {
      const task = await requestJson<IndexedProviderTask>(
        `${BASE}/tasks`,
        {
          method: "POST",
          headers: authHeaders(JSON_ACCEPT, true),
          body: JSON.stringify(input),
        },
        201,
      );
      assertLocatorShape(task);
      return task;
    },

    resume: async (locator, overrides = {}) => {
      const task = await requestJson<IndexedProviderTask>(`${locatorPath(locator)}/resume`, {
        method: "POST",
        headers: authHeaders(JSON_ACCEPT, true),
        body: JSON.stringify(overrides),
      });
      assertLocatorShape(task);
      return task;
    },

    fork: (locator, lastTurnId) =>
      requestJson<IndexForkResult>(
        `${locatorPath(locator)}/fork`,
        {
          method: "POST",
          headers: authHeaders(JSON_ACCEPT, true),
          body: JSON.stringify(lastTurnId === undefined ? {} : { lastTurnId }),
        },
        201,
      ),

    send: (locator, input) =>
      requestJson<IndexTurnRef>(
        `${locatorPath(locator)}/send`,
        {
          method: "POST",
          headers: authHeaders(JSON_ACCEPT, true),
          body: JSON.stringify({ input }),
        },
        202,
      ),

    steer: (locator, expectedTurnId, input) =>
      requestVoid(`${locatorPath(locator)}/steer`, {
        method: "POST",
        headers: authHeaders(JSON_ACCEPT, true),
        body: JSON.stringify({ expectedTurnId, input }),
      }),

    interrupt: (locator, turnId) =>
      requestVoid(`${locatorPath(locator)}/interrupt`, {
        method: "POST",
        headers: authHeaders(JSON_ACCEPT, true),
        body: JSON.stringify({ turnId }),
      }),

    respond: (locator, response) =>
      requestVoid(`${locatorPath(locator)}/respond`, {
        method: "POST",
        headers: authHeaders(JSON_ACCEPT, true),
        body: JSON.stringify(response),
      }),

    archive: (locator) =>
      requestVoid(`${locatorPath(locator)}/archive`, {
        method: "POST",
        headers: authHeaders(JSON_ACCEPT, true),
        body: JSON.stringify({}),
      }),

    rename: (locator, name) =>
      requestVoid(`${locatorPath(locator)}/rename`, {
        method: "POST",
        headers: authHeaders(JSON_ACCEPT, true),
        body: JSON.stringify({ name }),
      }),

    reconciliation: (locator) =>
      requestJson<ProviderReconciliationState>(`${locatorPath(locator)}/reconciliation`, {
        method: "GET",
        headers: authHeaders(JSON_ACCEPT),
      }),

    acknowledgeReconciliation: (locator, latchRevision, reviewedFingerprint) =>
      requestJson<ProviderReconciliationState>(`${locatorPath(locator)}/reconciliation/ack`, {
        method: "POST",
        headers: authHeaders(JSON_ACCEPT, true),
        body: JSON.stringify({ latchRevision, reviewedFingerprint }),
      }),

    patchMeta: (locator, patch) =>
      requestJson<ProviderTaskMeta>(`${locatorPath(locator)}/meta`, {
        method: "PATCH",
        headers: authHeaders(JSON_ACCEPT, true),
        body: JSON.stringify(patch),
      }),

    rebuild: (provider, homeFingerprint) =>
      requestJson<IndexRebuildResult>(`${BASE}/rebuild`, {
        method: "POST",
        headers: authHeaders(JSON_ACCEPT, true),
        body: JSON.stringify({ provider, homeFingerprint }),
      }),

    subscribe: async (locator, sink, options = {}) => {
      const controller = new AbortController();
      const external = options.signal;
      if (external?.aborted) controller.abort();
      else external?.addEventListener("abort", () => controller.abort(), { once: true });

      const response = await fetch(`${locatorPath(locator)}/events`, {
        method: "GET",
        headers: authHeaders(SSE_ACCEPT),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        controller.abort();
        if (response.status === 401) throw new UnauthorizedError("provider index");
        throw new ProviderIndexStreamError(`stream failed (${response.status})`);
      }
      const reader = response.body.getReader();
      let resolveClosed!: () => void;
      let rejectClosed!: (error: Error) => void;
      const closed = new Promise<void>((resolve, reject) => {
        resolveClosed = resolve;
        rejectClosed = reject;
      });
      let stopped = false;
      const stop = async (error?: Error): Promise<void> => {
        if (stopped) return;
        stopped = true;
        controller.abort();
        try { await reader.cancel(); } catch { /* already closed */ }
        if (error) {
          try { options.onError?.(error); } catch { /* observer cannot break cleanup */ }
          rejectClosed(error);
        } else {
          resolveClosed();
        }
      };

      void (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!controller.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) { await stop(); return; }
            buffer += decoder.decode(chunk.value, { stream: true });
            let index = buffer.indexOf("\n\n");
            while (index !== -1) {
              const frame = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              for (const line of frame.split("\n")) {
                if (!line.startsWith("data:")) continue;
                const payload = line.slice(5).trim();
                if (payload.length === 0) continue;
                try {
                  const parsed = JSON.parse(payload) as IndexStreamFrame;
                  sink(parsed);
                  if (parsed.type === "resync-required") { await stop(); return; }
                } catch {
                  await stop(new ProviderIndexStreamError("invalid SSE frame"));
                  return;
                }
              }
              index = buffer.indexOf("\n\n");
            }
          }
          await stop();
        } catch (error) {
          if (controller.signal.aborted) { await stop(); return; }
          await stop(error instanceof Error ? error : new ProviderIndexStreamError("stream error"));
        }
      })();

      return { closed, unsubscribe: () => stop() };
    },
  };
}

export const providerIndexApi: ProviderIndexApiClient = createProviderIndexApiClient();

/** True only when the server reports `unifiedTaskIndex` as APPLIED (resolved) true. */
export function isUnifiedTaskIndexApplied(
  features: Partial<DevHubFeatureFlags> | undefined,
): boolean {
  return features?.unifiedTaskIndex === true;
}

export type ProviderTransport =
  | { readonly mode: "indexed"; readonly client: ProviderIndexApiClient }
  | { readonly mode: "direct" };

/**
 * Choose the transport for the web provider client. The locator facade is used ONLY when the
 * flag is applied true; otherwise the caller keeps the existing direct (key-based) `providerApi`.
 * The flag is never defaulted on here.
 */
export function selectProviderTransport(
  features: Partial<DevHubFeatureFlags> | undefined,
  indexed: ProviderIndexApiClient = providerIndexApi,
): ProviderTransport {
  return isUnifiedTaskIndexApplied(features)
    ? { mode: "indexed", client: indexed }
    : { mode: "direct" };
}
