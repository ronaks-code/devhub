import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import type {
  IndexedProviderEvent,
  IndexedProviderRequestIdentity,
  ProviderTaskLocator,
} from "@devhub/engine/providers";
import {
  ProviderIndexHttpError,
  type IndexResponseBody,
  type ProviderIndexApiClient,
  type PublicProviderHome,
} from "../lib/provider-index-api.js";

type IndexedRequest = Extract<IndexedProviderEvent, { type: "request" }>["request"];
type IndexedApprovalRequest = Extract<
  IndexedRequest,
  { kind: "command-approval" | "file-change-approval" }
>;

export interface PendingIndexedApproval {
  readonly key: string;
  readonly locator: ProviderTaskLocator;
  readonly request: IndexedApprovalRequest;
  readonly detail: string | null;
}

export interface IndexedApprovalState {
  readonly pending: readonly PendingIndexedApproval[];
  readonly details: Readonly<Record<string, string>>;
}

export const EMPTY_INDEXED_APPROVAL_STATE: IndexedApprovalState = Object.freeze({
  pending: Object.freeze([]),
  details: Object.freeze({}),
});

function locatorKey(locator: ProviderTaskLocator): string {
  return JSON.stringify([
    locator.version,
    locator.provider,
    locator.homeFingerprint,
    locator.nativeTaskId,
  ]);
}

function sameLocator(left: ProviderTaskLocator, right: ProviderTaskLocator): boolean {
  return locatorKey(left) === locatorKey(right);
}

function detailKey(
  locator: ProviderTaskLocator,
  turnId: string | null,
  itemId: string | null,
): string {
  return JSON.stringify([locatorKey(locator), turnId, itemId]);
}

function identityKey(identity: IndexedProviderRequestIdentity): string {
  return JSON.stringify([
    locatorKey(identity.locator),
    identity.generation,
    identity.turnId,
    typeof identity.requestId,
    identity.requestId,
    identity.itemId,
    typeof identity.approvalId,
    identity.approvalId,
  ]);
}

function removeIdentity(
  state: IndexedApprovalState,
  identity: IndexedProviderRequestIdentity,
): IndexedApprovalState {
  const key = identityKey(identity);
  const pending = state.pending.filter((entry) => entry.key !== key);
  return pending.length === state.pending.length ? state : { ...state, pending };
}

/** Exact, locator-locked reducer for indexed approval activity and resolution events. */
export function reduceIndexedApprovalState(
  state: IndexedApprovalState,
  event: IndexedProviderEvent,
): IndexedApprovalState {
  if (event.type === "activity" && event.message !== null && event.itemId !== null) {
    const key = detailKey(event.locator, event.turnId, event.itemId);
    const details = { ...state.details, [key]: event.message };
    return {
      details,
      pending: state.pending.map((entry) =>
        sameLocator(entry.locator, event.locator) &&
          entry.request.identity.turnId === event.turnId &&
          entry.request.identity.itemId === event.itemId
          ? { ...entry, detail: event.message }
          : entry),
    };
  }
  if (event.type === "request") {
    if (
      event.request.kind !== "command-approval" &&
      event.request.kind !== "file-change-approval"
    ) return state;
    if (!sameLocator(event.locator, event.request.identity.locator)) return state;
    const key = identityKey(event.request.identity);
    if (state.pending.some((entry) => entry.key === key)) return state;
    const detail = state.details[
      detailKey(event.locator, event.request.identity.turnId, event.request.identity.itemId)
    ] ?? null;
    return {
      ...state,
      pending: [...state.pending, {
        key,
        locator: event.locator,
        request: event.request,
        detail,
      }],
    };
  }
  return event.type === "request-resolved" ? removeIdentity(state, event.identity) : state;
}

function responseBody(
  pending: PendingIndexedApproval,
  decision: "allow" | "deny",
): IndexResponseBody {
  const source = pending.request.identity;
  const identity = {
    generation: source.generation,
    turnId: source.turnId,
    requestId: source.requestId,
    itemId: source.itemId,
    approvalId: source.approvalId,
  };
  return { kind: pending.request.kind, identity, decision };
}

export function CodexApprovalCard({
  pending,
  disabled,
  onDecision,
}: {
  readonly pending: PendingIndexedApproval;
  readonly disabled: boolean;
  readonly onDecision: (pending: PendingIndexedApproval, decision: "allow" | "deny") => void;
}) {
  const command = pending.request.kind === "command-approval";
  const label = command ? "Command approval requested" : "File-change approval requested";
  return (
    <section
      role="status"
      aria-label={label}
      className="rounded-xl border border-amber-800/50 bg-amber-500/5 px-3 py-2.5"
    >
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-amber-200">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{label}</span>
      </div>
      {pending.detail ? (
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-950 p-2 font-mono text-[11px] leading-relaxed text-zinc-300">
          {pending.detail}
        </pre>
      ) : (
        <p className="mt-1.5 text-[11.5px] text-zinc-500">
          Codex did not provide displayable details. Deny unless this request is expected.
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          aria-label={command ? "Approve command" : "Approve file change"}
          onClick={() => onDecision(pending, "allow")}
          disabled={disabled}
          className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:pointer-events-none disabled:opacity-40"
        >
          Allow
        </button>
        <button
          type="button"
          aria-label={command ? "Deny command" : "Deny file change"}
          onClick={() => onDecision(pending, "deny")}
          disabled={disabled}
          className="rounded-md bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:pointer-events-none disabled:opacity-40"
        >
          Deny
        </button>
      </div>
    </section>
  );
}

export function IndexedApprovalInbox({
  home,
  client,
}: {
  readonly home: PublicProviderHome;
  readonly client: ProviderIndexApiClient;
}) {
  const [state, setState] = useState<IndexedApprovalState>(EMPTY_INDEXED_APPROVAL_STATE);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [responding, setResponding] = useState<string | null>(null);
  const canApprove = home.provider === "openai" && (
    home.capabilities?.approveCommand === true ||
    home.capabilities?.approveFileChange === true
  );

  useEffect(() => {
    const controller = new AbortController();
    const subscriptions: { unsubscribe(): Promise<void> }[] = [];
    let active = true;
    let failed = false;
    setState(EMPTY_INDEXED_APPROVAL_STATE);
    setConnected(false);
    setError(null);
    if (!canApprove) return () => controller.abort();

    const failClosed = (): void => {
      if (!active) return;
      failed = true;
      setConnected(false);
      setError("Approval connection closed. Requests remain denied unless an exact response succeeds.");
    };

    void client.list({
      provider: home.provider,
      homeFingerprint: home.homeFingerprint,
      includeArchived: false,
      limit: 200,
    }).then(async (page) => {
      const activeTasks = page.items.filter((task) => task.status === "active");
      await Promise.all(activeTasks.map(async (task) => {
        const subscription = await client.subscribe(task.locator, (frame) => {
          if (!active) return;
          if (frame.type === "event") {
            if (!sameLocator(frame.event.locator, task.locator)) {
              failClosed();
              return;
            }
            setState((current) => reduceIndexedApprovalState(current, frame.event));
          } else if (frame.type === "resync-required") {
            failClosed();
          }
        }, { signal: controller.signal, onError: failClosed });
        subscriptions.push(subscription);
        void subscription.closed.catch(failClosed);
      }));
      if (active && !failed) setConnected(true);
    }).catch(failClosed);

    return () => {
      active = false;
      controller.abort();
      for (const subscription of subscriptions) void subscription.unsubscribe();
    };
  }, [canApprove, client, home.homeFingerprint, home.provider]);

  const pending = useMemo(() => state.pending.filter((entry) =>
    entry.request.kind === "command-approval"
      ? home.capabilities?.approveCommand === true
      : home.capabilities?.approveFileChange === true), [home.capabilities, state.pending]);
  const decide = (entry: PendingIndexedApproval, decision: "allow" | "deny"): void => {
    if (!connected || responding !== null) return;
    setResponding(entry.key);
    void client.respond(entry.locator, responseBody(entry, decision)).then(() => {
      setState((current) => removeIdentity(current, entry.request.identity));
      setResponding(null);
    }).catch((cause: unknown) => {
      if (
        cause instanceof ProviderIndexHttpError && cause.status === 409 &&
        (cause.code === "STALE" || cause.code === "provider_response_stale")
      ) {
        setState((current) => removeIdentity(current, entry.request.identity));
        setResponding(null);
        return;
      }
      setConnected(false);
      setResponding(null);
      setError("Approval response was not confirmed. The request remains fail-closed.");
    });
  };

  if (!canApprove) return null;
  return (
    <div className="border-t border-[var(--dh-border-subtle)] p-3" aria-live="polite">
      {error ? <p role="alert" className="mb-2 text-[11px] text-amber-300">{error}</p> : null}
      {pending.length === 0 ? (
        // A real empty state (M5) — the bare one-liner in a dark void read as an
        // unfinished debug page rather than "nothing needs you".
        <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
          <ShieldCheck className="h-8 w-8 text-[var(--dh-text-faint)]" aria-hidden />
          <p className="text-[12.5px] font-medium text-[var(--dh-text)]">
            {connected ? "No approvals waiting" : "Connecting…"}
          </p>
          <p className="max-w-xs text-[11.5px] leading-relaxed text-[var(--dh-text-muted)]">
            {connected
              ? "When a running Codex task asks to run a command or change files, the request shows up here for you to allow or deny."
              : "Waiting for Codex approval requests."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {pending.map((entry) => (
            <CodexApprovalCard
              key={entry.key}
              pending={entry}
              disabled={!connected || responding !== null}
              onDecision={decide}
            />
          ))}
        </div>
      )}
    </div>
  );
}
