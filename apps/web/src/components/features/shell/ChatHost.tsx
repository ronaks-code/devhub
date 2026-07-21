import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PermissionMode } from "@devhub/engine/driver";
import type { NormalizedMessage } from "../../../lib/types.js";
import { openChat, type ChatConn } from "../../../lib/ws.js";
import { api } from "../../../lib/api.js";
import { useDraft } from "../../../hooks/useDraft.js";
import { buildFileChanges } from "../../FileChangeSummary.js";
import {
  buildChangedFiles,
  buildEnvironmentSummary,
  mapMessagesToThreadItems,
} from "../../../lib/m6-compose.js";
import { TaskHeader } from "./TaskHeader.js";
import { ThreadWorkspace, type ComposerSendState } from "./ThreadWorkspace.js";
import {
  Composer,
  composerFooterContext,
  computeSendDisabledReason,
  resolveSendState,
  type ComposerConnection,
} from "./Composer.js";
import { InspectorDock } from "../inspectors/InspectorDock.js";
import { ChatWorktreePanel } from "../../ChatWorktreePanel.js";

/**
 * ChatHost — the live Chat-tab composition of `TaskHeader` + `ThreadWorkspace` +
 * the canonical `Composer` (+ `InspectorDock`), M6 Task 9's "composer host" data-wire.
 *
 * This is a from-scratch adapter over the SAME real-time transport `ChatPane` uses
 * (`openChat` from `lib/ws.ts`) — it does NOT edit the user-owned `ChatPane.tsx`. It
 * only mounts when `taskHeaderSetup && threadWorkspace && composerSurface` are ALL
 * true together: those three slices bundle one inseparable region in the legacy
 * `ChatPane` (header + transcript + composer), so an explicit stored false on ANY ONE
 * of them restores `ChatPane` — the immediate, non-destructive rollback the slice
 * contract requires.
 *
 * SCOPE (honest): this proves the core real send/receive contract (prompt in,
 * `NormalizedMessage`s out, honest Stop-gating since `persistentClaude` stays
 * false) plus a real git-status/file-change-derived InspectorDock. It intentionally
 * does NOT reimplement every `ChatPane` richness (permission-card interactive
 * approval UI, image attach, mention/slash picker dropdown rendering, token meter):
 * those stay `ChatPane`-only capabilities. A message this host can't yet render
 * richly (a tool call, an image, etc.) becomes a bounded `raw` diagnostic — the
 * exact honest fallback `ThreadWorkspace`'s own model reserves for real data,
 * never a fabricated tool card.
 */

// Bounded history tail for the indexed-store hydrate of a resumed session (the
// same 2MB starting window Browse uses). Bounded on purpose: a huge session must
// never dump its whole file into one render (QA B1 crashed the renderer that way).
const HYDRATE_TAIL_BYTES = 2 * 1024 * 1024;
export interface ChatHostProps {
  cwd: string;
  projectId: string;
  /** Resume this legacy session id, when handed off from Browse's "Continue". */
  initialSessionId?: string;
  defaultModel?: string | null;
  defaultPermissionMode?: PermissionMode;
  /** Task title shown in `TaskHeader`. */
  title: string;
  /** Route a provider-change request to the (still-M7) fork flow. */
  onFork?: (sessionId: string | null) => void;
  /** Mount `InspectorDock` alongside the transcript (`inspectorDock` flag). */
  showInspector?: boolean;
  /**
   * Seed the composer draft on first mount (Aurora Cockpit §3.3b): the Launchpad
   * hero composer hands its typed job over here so the first thing the new task
   * shows is the user's own prompt, ready to send. Only seeds a fresh task whose
   * scoped draft is still empty — never clobbers a persisted in-progress draft.
   */
  initialDraft?: string;
  /** Report the live session id up to the shell so a new session becomes a chat tab (Aurora §3.2). */
  onSessionChange?: (sessionId: string) => void;
}

export function ChatHost({
  cwd,
  projectId,
  initialSessionId,
  defaultModel,
  defaultPermissionMode,
  title,
  onFork,
  showInspector = false,
  initialDraft,
  onSessionChange,
}: ChatHostProps) {
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);
  const [messages, setMessages] = useState<NormalizedMessage[]>([]);
  const [turnRunning, setTurnRunning] = useState(false);
  // Starts "reconnecting" (the socket is being opened), so the composer shows a
  // live connecting indicator instead of the dead-end "Reconnect to send" (F3).
  const [connection, setConnection] = useState<ComposerConnection>("reconnecting");
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  // The RESUMED session's own recorded model (from the indexed store), distinct
  // from `defaultModel` (the app's current default-model setting). Browse's
  // InspectorDock shows the session's real model; a resumed chat must too (QF3
  // — the dock fell back to the generic default and read "—" for a session that
  // shows a real model in Browse). Null until the hydrate below lands, or for a
  // brand-new task (nothing to hydrate).
  const [resumedModel, setResumedModel] = useState<string | null>(null);

  const { draft, setDraft, clearDraft } = useDraft(projectId, sessionId ?? initialSessionId);
  const connRef = useRef<ChatConn | null>(null);

  // Seed the Launchpad hero draft exactly once, on first mount, and only when this
  // task's own persisted draft is still empty — a resumed session with an
  // in-progress draft is never clobbered. A fresh Launch remounts this host (its
  // App key includes the chat nonce), so each launch seeds cleanly.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (initialDraft && !draft) setDraft(initialDraft);
    // Mount-only: the initial draft is a one-shot handoff, not a live binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open (or reopen) the live socket. `openChat` already auto-reconnects with
  // backoff on unexpected drops; we surface its liveness ("open"/"reconnecting")
  // so the composer can render a real connection indicator, and expose a manual
  // reconnect that tears the whole connection down and dials fresh (F3).
  const connect = useCallback(() => {
    connRef.current?.close();
    setConnection("reconnecting");
    connRef.current = openChat({
      onOpen: () => setConnection("connected"),
      onConnectionState: (s) => setConnection(s === "open" ? "connected" : "reconnecting"),
      onError: () => setConnection("disconnected"),
      onSession: (sid) => setSessionId(sid),
      onMessage: (m) => setMessages((prev) => [...prev, m]),
      onResult: () => setTurnRunning(false),
      onTurnEnd: () => setTurnRunning(false),
    });
  }, []);

  useEffect(() => {
    connect();
    return () => {
      connRef.current?.close();
      connRef.current = null;
    };
    // A fresh socket per mounted host (matches ChatPane: one WS per pane, torn
    // down on unmount). cwd changes remount this component via the caller's key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, connect]);

  // Hydrate a RESUMED session's transcript from the indexed store immediately
  // (bounded tail), so opening a session from the sidebar/tabs shows its real
  // history without waiting on the live socket (the no-fallback-hydration gap
  // behind QF3/F4 — a session that reads fine in Browse showed blank here).
  // Live WS messages only arrive after the user sends, so they append after
  // this seed; the functional update keeps ordering safe either way.
  useEffect(() => {
    if (!initialSessionId) return;
    let cancelled = false;
    api
      .messages(initialSessionId, HYDRATE_TAIL_BYTES)
      .then((p) => {
        if (cancelled) return;
        // The indexed page's `session.model` is the real model this session ran
        // on — set it even when the message tail comes back empty, so the dock
        // still reads the honest historical model rather than falling back.
        if (p.session.model) setResumedModel(p.session.model);
        if (p.messages.length === 0) return;
        setMessages((prev) => (prev.length > 0 ? [...p.messages, ...prev] : p.messages));
      })
      .catch(() => {
        /* index unavailable — the live path still works, just without history */
      });
    return () => {
      cancelled = true;
    };
  }, [initialSessionId]);

  // Report the live session id up to the shell (Aurora §3.2) so a newly created
  // session surfaces as a chat tab and the tab strip can track/switch it.
  useEffect(() => {
    if (sessionId) onSessionChange?.(sessionId);
  }, [sessionId, onSessionChange]);

  useEffect(() => {
    let cancelled = false;
    api
      .gitStatus(cwd)
      .then((s) => {
        if (!cancelled) setGitBranch(s?.branch ?? null);
      })
      .catch(() => {
        if (!cancelled) setGitBranch(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || !connRef.current) return;
    connRef.current.send({
      t: "prompt",
      cwd,
      prompt: text,
      sessionId: sessionId ?? undefined,
      model: defaultModel ?? undefined,
      permissionMode: defaultPermissionMode,
    });
    setTurnRunning(true);
    clearDraft();
  }, [draft, cwd, sessionId, defaultModel, defaultPermissionMode, clearDraft]);

  const items = useMemo(() => mapMessagesToThreadItems(messages), [messages]);
  // Claude has no native interrupt until M4 (`persistentClaude` stays false), so a
  // running turn correctly stays `send` — the honest gated state, not a faked Stop.
  const sendState: ComposerSendState = resolveSendState({
    turnRunning,
    nativeInterruptEnabled: false,
  });
  const disabledReason = computeSendDisabledReason({
    draft,
    connection,
  });
  const footer = composerFooterContext("anthropic", {
    model: defaultModel ?? undefined,
    permissionMode: defaultPermissionMode,
    folder: cwd,
  });

  const fileChanges = useMemo(() => buildFileChanges(messages), [messages]);

  return (
    <div className="flex min-h-0 flex-1 gap-0" data-dh-chat-host="">
      <div className="flex min-h-0 flex-1 flex-col">
        <TaskHeader
          title={title}
          provider="anthropic"
          onFork={() => onFork?.(sessionId)}
        />
        <ChatWorktreePanel cwd={cwd} />
        <ThreadWorkspace
          items={items}
          provider="anthropic"
          composerSlot={
            <Composer
              provider="anthropic"
              isNewTask={!sessionId}
              draft={draft}
              sendState={sendState}
              disabledReason={disabledReason}
              connection={connection}
              footer={{ model: footer.modelValue, permissionMode: footer.permissionValue, folder: footer.folderValue }}
              onDraftChange={setDraft}
              onSend={send}
              onReconnect={connect}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
          }
        />
      </div>
      {showInspector ? (
        <InspectorDock
          provider="anthropic"
          worktree={{
            branch: gitBranch ?? undefined,
            changesSummary: buildEnvironmentSummary(null, fileChanges).changes,
          }}
          session={{
            // The resumed session's own recorded model wins once hydrated; a
            // fresh new task (nothing to resume) falls back to the app's
            // current default — there's no session history to be honest about yet.
            model: resumedModel ?? defaultModel ?? undefined,
            permissionMode: defaultPermissionMode,
          }}
          changedFiles={buildChangedFiles(fileChanges)}
        />
      ) : null}
    </div>
  );
}
