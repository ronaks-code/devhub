import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
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
import { ThreadWorkspace, type ComposerSendState, type QueuedMessage } from "./ThreadWorkspace.js";
import {
  Composer,
  composerFooterContext,
  computeSendDisabledReason,
  isBuiltinCommand,
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

// Initial history tail for the indexed-store hydrate of a resumed session (#12).
// Deliberately SMALL — Browse opens the full 2MB window, but a chat wants to
// paint fast: a small recent-tail fetch returns/parses/renders quickly so opening
// a session shows its latest messages near-instantly, then "load older" (below)
// doubles the window on demand. Still bounded on purpose: a huge session must
// never dump its whole file into one render (QA B1 crashed the renderer that way).
const HYDRATE_INITIAL_TAIL_BYTES = 384 * 1024;
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
  /** True when this session is in the app-root running set (driven by an EXTERNAL
   *  process, e.g. the CLI) — so the TaskHeader "● running" pill reflects it even
   *  when this panel isn't the one driving the turn (QA: pill absent for a session
   *  the sidebar shows as running). */
  externallyRunning?: boolean;
  /**
   * Open the app's keyboard-shortcuts / help overlay — invoked when the user runs
   * the built-in `/help` slash command. App owns that overlay (`shortcutOpen`), so
   * it must pass this (e.g. `() => setShortcutOpen(true)`); omitted → `/help` is a
   * no-op here rather than a broken agent prompt.
   */
  onShowShortcuts?: () => void;
  /**
   * Open a model picker — invoked when the user runs the built-in `/model` slash
   * command. There is no ChatHost-route model picker overlay today (unlike the
   * legacy `ChatPane`, which owns its own), so App must wire this to a real picker;
   * omitted → `/model` is a no-op here rather than fabricating a picker that does
   * nothing.
   */
  onOpenModelPicker?: () => void;
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
  externallyRunning = false,
  onShowShortcuts,
  onOpenModelPicker,
}: ChatHostProps) {
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);
  // History (from the indexed store's bounded tail) and live (pushed over the
  // socket) are tracked SEPARATELY so "load older" (W3-TX) can re-fetch a bigger
  // history window and REPLACE just that half without duplicating/dropping the
  // live messages a running turn already appended. `messages` (below) is the
  // combined, rendered view.
  const [history, setHistory] = useState<NormalizedMessage[]>([]);
  const [live, setLive] = useState<NormalizedMessage[]>([]);
  const messages = useMemo(() => [...history, ...live], [history, live]);
  // Grown (doubled) by "load older", mirroring Browse's `handleLoadMore` — the
  // same bytes-window pagination legacy `TranscriptPane` already uses, just
  // applied to this host's hydrate fetch instead of App.tsx's `tailBytes` state.
  const [hydrateTailBytes, setHydrateTailBytes] = useState(HYDRATE_INITIAL_TAIL_BYTES);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [turnRunning, setTurnRunning] = useState(false);
  // Starts "reconnecting" (the socket is being opened), so the composer shows a
  // live connecting indicator instead of the dead-end "Reconnect to send" (F3).
  const [connection, setConnection] = useState<ComposerConnection>("reconnecting");
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  // Whether `cwd` is itself a (non-main) git worktree, and its path — derived by
  // matching `cwd` against the real worktree list, so the header chip can honestly
  // prefix `wt/` only when we ARE in a worktree (Aurora §3.3). Absent → plain branch.
  const [isWorktree, setIsWorktree] = useState(false);
  // The resumed session's own recorded cost (SessionSummary.costUsd, a display
  // estimate). Null for a brand-new task with nothing to price yet — the chip
  // omits rather than showing a fabricated $0.
  const [sessionCost, setSessionCost] = useState<number | null>(null);
  // The RESUMED session's own recorded model (from the indexed store), distinct
  // from `defaultModel` (the app's current default-model setting). Browse's
  // InspectorDock shows the session's real model; a resumed chat must too (QF3
  // — the dock fell back to the generic default and read "—" for a session that
  // shows a real model in Browse). Null until the hydrate below lands, or for a
  // brand-new task (nothing to hydrate).
  const [resumedModel, setResumedModel] = useState<string | null>(null);
  // The session-advertised slash commands (from the `session` init frame): the
  // CLI's built-ins (/compact …) PLUS any project skills. Fed to the Composer so
  // typing "/" shows the session's ACTUAL commands, not just the 3 hardcoded
  // built-ins (#5). Empty until the first `session` frame lands.
  const [slashCommands, setSlashCommands] = useState<string[]>([]);

  const { draft, setDraft, clearDraft } = useDraft(projectId, sessionId ?? initialSessionId);
  const connRef = useRef<ChatConn | null>(null);
  // Set when the socket DROPS unexpectedly (auto-reconnect pending). On recovery
  // this tells us the server canceled the in-flight turn on close — so its
  // turn-end will never arrive and a stuck `turnRunning` must be force-cleared.
  const reconnectedRef = useRef(false);

  // ── Queued follow-ups (0.1.6 queued-messages) ─────────────────────────────
  // Messages typed while a turn is running are QUEUED (not dropped) and run as
  // their own turns as the current one finishes — ported from ChatPane's proven
  // queue. Rendered as a dimmed "pending" tray by ThreadWorkspace (its `queued` /
  // `onCancelQueued` props). The queue is held entirely client-side: today's
  // per-turn server only ever sees one prompt at a time (the head is dispatched
  // on turn-end), so cancelling is purely a local drop.
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  // A ref mirror of `queued` so the turn-end dispatch (fired from the stable
  // socket closure) reads the CURRENT queue, not a stale render's snapshot.
  const queueRef = useRef<QueuedMessage[]>([]);
  useEffect(() => {
    queueRef.current = queued;
  }, [queued]);
  // Monotonic id source for queued messages (React keys + cancellation targets).
  const queueIdRef = useRef(0);
  // Latest runPrompt, so a queued dispatch picks up the CURRENT sessionId/model
  // (a new chat only learns its id after the first turn's `session` frame).
  const runPromptRef = useRef<(text: string) => void>(() => {});

  // Dispatch the head of the queue as its own turn — called on a clean turn-end.
  // Shifting the head and clearing its pending bubble in the same commit reads as
  // the queued message simply starting. No-op when the queue is empty.
  const dispatchNext = useCallback(() => {
    const head = queueRef.current[0];
    if (!head) return;
    const rest = queueRef.current.slice(1);
    queueRef.current = rest;
    setQueued(rest);
    runPromptRef.current(head.text);
  }, []);

  // Cancel a single queued follow-up before it is sent (local drop; see above).
  const cancelQueued = useCallback((id: string) => {
    setQueued((q) => {
      const next = q.filter((it) => it.id !== id);
      queueRef.current = next;
      return next;
    });
  }, []);

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
      onConnectionState: (s) => {
        if (s === "open") {
          setConnection("connected");
          // Recovered after a mid-turn DROP: the server canceled the in-flight
          // turn on socket close, so its turn-end will NEVER arrive. Force-clear
          // the stuck running gate (otherwise every later message would queue
          // forever behind a turn that can't end — the reported HIGH bug), then
          // flush any follow-ups the user queued during the outage. The dispatched
          // prompt re-sends the live sessionId, continuing the same CLI session.
          // Mirrors ChatPane's reconnect-after-drop recovery.
          if (reconnectedRef.current) {
            reconnectedRef.current = false;
            setTurnRunning(false);
            dispatchNext();
          }
          return;
        }
        // s === "reconnecting": an unexpected drop; the socket is auto-redialing.
        // Remember it so the recovery branch above clears the canceled turn.
        reconnectedRef.current = true;
        setConnection("reconnecting");
      },
      onError: () => {
        setConnection("disconnected");
        // A server error frame ends the turn; clear the running gate so the user
        // isn't stuck (and a queue behind it isn't stranded). Deliberately does
        // NOT dispatchNext — an errored turn keeps its follow-ups pending.
        setTurnRunning(false);
      },
      onSession: (sid, init) => {
        setSessionId(sid);
        // Capture the session's advertised slash commands so the composer's "/"
        // menu lists real skills/commands, not just the built-ins (#5).
        if (Array.isArray(init?.slashCommands)) setSlashCommands(init.slashCommands);
      },
      onMessage: (m) => setLive((prev) => [...prev, m]),
      onResult: () => setTurnRunning(false),
      onTurnEnd: () => {
        setTurnRunning(false);
        // Clean finish → kick off the next queued follow-up, if any. A failed
        // turn ends via onError (below) and deliberately does NOT auto-fire the
        // queue (matching ChatPane): the pending messages stay for the user.
        dispatchNext();
      },
    });
    // dispatchNext is stable (its deps are [] — it reads refs), so listing it
    // here never re-creates connect or churns the socket.
  }, [dispatchNext]);

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
  // Re-runs whenever `hydrateTailBytes` grows (W3-TX "load older") and REPLACES
  // `history` wholesale — the fetch is always the full window from the file's
  // end, a superset of the previous one, so replacing (not prepending again)
  // is what avoids duplicating the overlap. `live` (WS-pushed) is untouched.
  useEffect(() => {
    if (!initialSessionId) return;
    let cancelled = false;
    setLoadingOlder(true);
    api
      .messages(initialSessionId, hydrateTailBytes)
      .then((p) => {
        if (cancelled) return;
        // The indexed page's `session.model` is the real model this session ran
        // on — set it even when the message tail comes back empty, so the dock
        // still reads the honest historical model rather than falling back.
        if (p.session.model) setResumedModel(p.session.model);
        // The session's own recorded cost estimate (may be 0 before pricing lands).
        if (typeof p.session.costUsd === "number") setSessionCost(p.session.costUsd);
        setHistory(p.messages);
        setHistoryTruncated(p.truncatedFromStart);
      })
      .catch(() => {
        /* index unavailable — the live path still works, just without history */
      })
      .finally(() => {
        if (!cancelled) setLoadingOlder(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialSessionId, hydrateTailBytes]);

  // "Load older history" (W3-TX): grow the hydrate window and re-fetch, same
  // doubling strategy App.tsx's Browse `handleLoadMore` already uses.
  const loadOlderHistory = useCallback(() => setHydrateTailBytes((b) => b * 2), []);

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

  // Detect whether `cwd` is a non-main worktree by matching it against the real
  // worktree list (route may be unimplemented → degrades to "not a worktree").
  useEffect(() => {
    let cancelled = false;
    const norm = (p: string) => p.replace(/\/+$/, "");
    api
      .gitWorktrees(cwd)
      .then((list) => {
        if (cancelled) return;
        const match = (list ?? []).find((w) => norm(w.path) === norm(cwd));
        setIsWorktree(match != null && match.isMain !== true);
      })
      .catch(() => {
        if (!cancelled) setIsWorktree(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Dispatch a prompt as a turn over the live socket. Shared by `send` (the first
  // prompt) and `dispatchNext` (each queued follow-up) so both use the SAME
  // current cwd/sessionId/model/permission.
  const runPrompt = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !connRef.current) return;
    connRef.current.send({
      t: "prompt",
      cwd,
      prompt: trimmed,
      sessionId: sessionId ?? undefined,
      model: defaultModel ?? undefined,
      permissionMode: defaultPermissionMode,
    });
    setTurnRunning(true);
  }, [cwd, sessionId, defaultModel, defaultPermissionMode]);
  // Keep the ref pointed at the latest runPrompt for the turn-end queue dispatch.
  runPromptRef.current = runPrompt;

  // Start a fresh chat on the SAME cwd (built-in `/clear`). Mirrors ChatPane's
  // `newChat`: tear the socket down and dial a clean one, drop the session id +
  // both transcript halves + the follow-up queue + any resumed session metadata,
  // and clear the draft. `sessionId` going null means the next prompt opens a NEW
  // CLI session (runPrompt sends `sessionId ?? undefined`), and the fresh `session`
  // frame re-advertises this project's slash commands.
  const newChat = useCallback(() => {
    connect();
    setSessionId(null);
    setHistory([]);
    setLive([]);
    setHistoryTruncated(false);
    setTurnRunning(false);
    setResumedModel(null);
    setSessionCost(null);
    setSlashCommands([]);
    reconnectedRef.current = false;
    queueRef.current = [];
    setQueued([]);
    clearDraft();
  }, [connect, clearDraft]);

  // Execute a built-in slash command as a UI action — NEVER forwarded to the
  // agent. ONE shared implementation used by BOTH the Composer picker
  // (onBuiltinCommand) and send()'s backstop below, so a bare built-in behaves
  // identically whether it's picked from the menu or typed with a trailing space.
  const runBuiltinCommand = useCallback(
    (name: string) => {
      if (name === "clear") {
        newChat();
      } else if (name === "help") {
        onShowShortcuts?.();
      } else if (name === "model") {
        // GUARD (HIGH): onOpenModelPicker navigates to Settings, which UNMOUNTS
        // ChatHost — closing the socket (killing a running turn) AND destroying
        // the in-memory queue. Only open it when nothing would be lost: no running
        // turn AND an empty queue. Otherwise no-op (drop the /model) rather than
        // silently losing work. (0.1.8 replaces this with an in-place overlay
        // picker that doesn't unmount.)
        if (!turnRunning && queueRef.current.length === 0) onOpenModelPicker?.();
      }
    },
    [newChat, onShowShortcuts, onOpenModelPicker, turnRunning],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    // Backstop: a bare built-in ("/clear", "/help", "/model" — with or without
    // trailing whitespace) EXECUTES here, never forwarded to the agent. The
    // Composer intercepts these while the picker is open, but a trailing space
    // closes the picker, so Enter would otherwise send "/clear" as a literal
    // prompt. Same runBuiltinCommand (incl. the /model guard) as the picker path.
    const builtin = /^\/(\S+)$/.exec(text);
    if (builtin && isBuiltinCommand(builtin[1]!)) {
      runBuiltinCommand(builtin[1]!);
      clearDraft();
      return;
    }
    // A turn is in flight → QUEUE the follow-up (shown in ThreadWorkspace's dimmed
    // tray) instead of dropping it; it runs as its own turn on the next turn-end.
    if (turnRunning) {
      setQueued((q) => [...q, { id: String(++queueIdRef.current), text }]);
      clearDraft();
      return;
    }
    // No live socket yet → keep the draft so the text isn't lost.
    if (!connRef.current) return;
    runPrompt(text);
    clearDraft();
  }, [draft, turnRunning, runPrompt, clearDraft, runBuiltinCommand]);

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
          branch={gitBranch}
          isWorktree={isWorktree}
          worktreePath={isWorktree ? cwd : undefined}
          projectName={cwd.split("/").filter(Boolean).pop()}
          model={resumedModel ?? defaultModel ?? undefined}
          costUsd={sessionCost ?? undefined}
          running={turnRunning || externallyRunning}
        />
        <ChatWorktreePanel cwd={cwd} />
        <ThreadWorkspace
          items={items}
          provider="anthropic"
          truncatedFromStart={historyTruncated}
          onLoadOlder={loadOlderHistory}
          loadingOlder={loadingOlder}
          queued={queued}
          onCancelQueued={cancelQueued}
          emptyState={
            // Only for a brand-new chat (no resumed session, nothing sent yet):
            // an inviting prompt instead of a blank void (QA MAJOR). A resumed
            // session that happens to be empty keeps the deliberate blank canvas.
            !initialSessionId && messages.length === 0 ? (
              <div className="max-w-md text-center">
                <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--dh-brand)]/12 ring-1 ring-[var(--dh-glass-border)]">
                  <Sparkles className="h-5 w-5 text-[var(--dh-text-muted)]" />
                </div>
                <h2 className="text-[15px] font-semibold text-[var(--dh-text-strong)]">
                  Start a new chat
                </h2>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--dh-text-muted)]">
                  Describe the outcome or change you want. Claude runs in{" "}
                  <span className="font-mono text-[var(--dh-text)]">{cwd}</span>.
                </p>
                <p className="mt-3 text-[11px] text-[var(--dh-text-disabled)]">
                  Type below to begin, or press ⌘K to search past sessions.
                </p>
              </div>
            ) : undefined
          }
          composerSlot={
            <Composer
              provider="anthropic"
              isNewTask={!sessionId}
              draft={draft}
              sendState={sendState}
              disabledReason={disabledReason}
              connection={connection}
              slashCommands={slashCommands}
              footer={{ model: footer.modelValue, permissionMode: footer.permissionValue, folder: footer.folderValue }}
              onDraftChange={setDraft}
              onSend={send}
              onReconnect={connect}
              // Built-ins EXECUTE a UI action (never forwarded to the agent), via
              // the SAME shared runBuiltinCommand the send() backstop uses — so the
              // /model unmount guard applies on both paths.
              onBuiltinCommand={runBuiltinCommand}
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
