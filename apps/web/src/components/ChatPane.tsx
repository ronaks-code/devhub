import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Check, FileText, Image as ImageIcon, ListPlus, Loader2, MessageSquarePlus, Pencil, Pin, RotateCcw, Send, Square, Sparkles, Wifi, X } from "lucide-react";
import { PERMISSION_MODES, type PermissionMode } from "@devhub/engine/driver";
import type { TurnResult } from "@devhub/engine/driver";
import type { NormalizedMessage } from "../lib/types";
import { openChat, parseTokenStatus, type ChatConn, type TokenStatusData } from "../lib/ws";
import { cn } from "../lib/utils";
import { indexToolResults, pairMessage } from "../lib/transcript";
import { useDraft } from "../hooks/useDraft";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { useApprovalKeyboard } from "../hooks/useApprovalKeyboard";
import { MessageView } from "./MessageView";
import { CwdProvider } from "./OpenInEditor";
import { StoppedBadge, isStoppedSubtype, stoppedReason } from "./StoppedBadge";
import { RetryingLabel, parseRetryStatus, type RetryStatus } from "./StatusLabel";
import { LiveBubble, LiveStream } from "./LiveBubble";
import { SlashPalette, filterCommands, BUILTIN_COMMANDS } from "./SlashPalette";
import { MentionPicker, detectMention } from "./MentionPicker";
import { PermissionCard, type PendingPermission, type PermissionDecision } from "./PermissionCard";
import { SnippetLibrary } from "./SnippetLibrary";
import { TokenMeter } from "./TokenMeter";
import { TurnFooter } from "./TurnFooter";
import { BranchSwitcher } from "./BranchSwitcher";
import { ChatWorktreePanel } from "./ChatWorktreePanel";
import { TurnError } from "./TurnError";
import { usePromptHistory } from "../hooks/usePromptHistory";
import { useImageAttach } from "../hooks/useImageAttach";
import { api, type FileEntry } from "../lib/api";
import { EmptyState, IconButton, Spinner } from "./ui";

const MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
] as const;

const DEFAULT_MODEL: string = MODELS[0];
const DEFAULT_PERMISSION: PermissionMode = "acceptEdits";

/** A streamed message paired with a stable, monotonic key (NOT message.seq, which resets per turn). */
interface ChatItem {
  key: number;
  message: NormalizedMessage;
}

/** A follow-up prompt queued while a turn runs, awaiting its own turn. */
interface QueuedPrompt {
  /** Stable id for React keys + targeted cancellation. */
  id: number;
  prompt: string;
}

export function ChatPane({
  cwd,
  projectId,
  projectName,
  initialSessionId,
  defaultModel,
  defaultPermissionMode,
  projectDefaultModel,
  projectDefaultPermissionMode,
  onSaveProjectDefaults,
  model: controlledModel,
  onModelChange,
}: {
  cwd: string;
  /** Stable project id, used to scope the persisted composer draft. */
  projectId: string;
  projectName: string;
  /** Seed to resume an existing CLI session (--resume) on the first prompt. */
  initialSessionId?: string;
  /** Preferred model from GLOBAL settings; falls back to the built-in default. */
  defaultModel?: string;
  /** Preferred permission mode from GLOBAL settings; falls back to the built-in default. */
  defaultPermissionMode?: PermissionMode;
  /**
   * This project's preferred model (ProjectSummary.defaultModel). Takes
   * precedence over the global settings default when opening a fresh chat here.
   */
  projectDefaultModel?: string | null;
  /** This project's preferred permission mode. Precedes the global default. */
  projectDefaultPermissionMode?: PermissionMode | null;
  /**
   * Persist the current model + permission as THIS PROJECT's defaults (PATCH
   * /api/projects/:id). When omitted the "set as project default" control is
   * hidden. Returns a promise so the control can show a brief saved/failed state.
   */
  onSaveProjectDefaults?: (model: string, permissionMode: PermissionMode) => Promise<void>;
  /** Controlled model id (e.g. from a command palette). Uncontrolled if omitted. */
  model?: string | null;
  /** Notified when the model select changes; required for controlled mode. */
  onModelChange?: (model: string) => void;
}) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>(initialSessionId);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<TurnResult | null>(null);
  // True once the user hit Stop on the in-flight turn, until the next turn
  // starts. Drives the "stopped" badge in the result footer even when the server
  // reports the interrupted turn with a clean (non-error) result subtype.
  const [interrupted, setInterrupted] = useState(false);
  // Wall-clock duration of the just-finished turn (ms), measured from the prompt
  // send to the result frame. Feeds the per-turn TurnFooter (the engine's
  // TurnResult carries no duration). Null until a turn completes with a result.
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Composer text persisted per (projectId | sessionId) so an unsent message
  // survives tab switches and reloads. Scopes by the live sessionId once a turn
  // assigns one, falling back to the resume seed before the first prompt.
  const { draft, setDraft, clearDraft } = useDraft(projectId, sessionId ?? initialSessionId);
  // Shell-style Up/Down recall of previously sent prompts, persisted per project.
  const history = usePromptHistory(projectId);
  // Model can be controlled by the parent (command palette) or local. When the
  // parent passes a value we defer to it; otherwise we own it here.
  // Initial model/permission precedence: this project's saved default →
  // global settings default → built-in. The project default wins so opening a
  // chat in a project lands on that project's preferred model/mode.
  const [localModel, setLocalModel] = useState<string>(
    projectDefaultModel ?? defaultModel ?? DEFAULT_MODEL,
  );
  const model = controlledModel ?? localModel;
  const setModel = (m: string) => {
    setLocalModel(m);
    onModelChange?.(m);
  };
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    projectDefaultPermissionMode ?? defaultPermissionMode ?? DEFAULT_PERMISSION,
  );
  // True while the in-flight assistant turn is streaming text into the LiveBubble.
  // Deltas flow through liveStreamRef (an external store) — NOT React state — so a
  // token re-renders only LiveBubble, never this pane's finalized message list.
  const [liveActive, setLiveActive] = useState(false);
  // True while the chat socket is retrying after an unexpected drop. Drives a
  // subtle "reconnecting" hint; the live session resumes on the next prompt.
  const [reconnecting, setReconnecting] = useState(false);
  // True once the user has clicked "Edit & resend" on a prior user message and
  // the composer holds that (editable) text. Sending resumes the session, so it
  // continues/forks the conversation from that earlier turn. Cleared on send,
  // on a manual composer edit that diverges, or via the "cancel" affordance.
  const [editingFork, setEditingFork] = useState(false);
  // A pending inline permission request from the agent (persistent-path only;
  // dormant on the default per-turn driver). Cleared once answered or the turn ends.
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  // Live token/cost snapshot for the in-flight turn, fed by the enriched
  // `{kind:"tokens", data}` status frame. Null until the first snapshot arrives
  // (and reset at the start/end of each turn). Dormant on a server that doesn't
  // emit token statuses, so the meter simply never appears there.
  const [tokenStatus, setTokenStatus] = useState<TokenStatusData | null>(null);
  // A rate-limit auto-retry in flight, parsed from a `{kind:"retrying:<n>:<ms>"}`
  // status frame. Drives a calm inline "retrying in Ns (attempt k)…" indicator.
  // Null until/unless the server sends one (older servers never do), and cleared
  // the moment the turn resumes (any other status), finishes, errors, or drops —
  // so it never lingers past the retry it describes.
  const [retry, setRetry] = useState<RetryStatus | null>(null);
  // The snippet-library overlay (prompt templates). Opened via the composer
  // button or by typing a bare "/" with no slash-command matches.
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  // Bumped by the approval "E" key to ask the active PermissionCard to focus its
  // editable input. Undefined = no focus request pending.
  const [editFocusToken, setEditFocusToken] = useState<number | undefined>(undefined);
  // The most recent user prompt of this conversation, so "Regenerate" can resend
  // it (resuming the session) for a fresh response.
  const lastPromptRef = useRef<string | null>(null);
  // Wall-clock start of the in-flight turn (Date.now() at prompt send), used to
  // compute the TurnFooter's duration when the result lands.
  const turnStartRef = useRef<number | null>(null);
  // Slash commands advertised by the session (from the {t:"session"} init frame),
  // surfaced in the SlashPalette when the composer starts with "/".
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  // Highlighted row in the slash palette; reset whenever the palette (re)opens or
  // the query changes. Steered by Arrow keys in the composer's keydown handler.
  const [slashIndex, setSlashIndex] = useState(0);
  // Follow-up prompts composed WHILE a turn is running. The server accepts one
  // turn at a time, so we hold these locally and dispatch the head as each turn
  // ends — rendering them meanwhile as pending "queue" bubbles below the stream.
  const [queued, setQueued] = useState<QueuedPrompt[]>([]);
  // User dismissed the current turn-error card (so it doesn't reappear until the
  // next failure). Reset whenever a new error/error-result arrives or a turn starts.
  const [errorDismissed, setErrorDismissed] = useState(false);
  // Transient UI state for the "set as project default" affordance: null idle,
  // "saving" mid-PATCH, "ok"/"fail" briefly after.
  const [savingDefault, setSavingDefault] = useState<"saving" | "ok" | "fail" | null>(null);

  // /help overlay — shows all available slash commands.
  const [helpOpen, setHelpOpen] = useState(false);
  // /model inline picker — true while the model-switch popover is shown.
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

  // "@" file-mention picker state. `mention` holds the active query + the
  // [start,end) range of the "@token" in the draft to replace on insert; null
  // when no mention is active at the caret. `mentionEntries` is the fuzzy file
  // list from GET /api/files; `mentionIndex` is the keyboard cursor.
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null);
  const [mentionEntries, setMentionEntries] = useState<FileEntry[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionError, setMentionError] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  // Current caret position in the textarea, tracked so mention detection knows
  // where "@" tokens end. Updated on every key/click/select.
  const caretRef = useRef(0);

  const connRef = useRef<ChatConn | null>(null);
  const keyRef = useRef(0);
  // The streamed-text store for the in-flight turn. One per pane; LiveBubble
  // subscribes to it. Holds no React state, so appending a token doesn't re-render
  // ChatPane (only the subscribed LiveBubble).
  const liveStreamRef = useRef<LiveStream>(new LiveStream());
  // Mirrors `liveActive` for synchronous reads inside socket handlers (which fire
  // outside React's render cycle).
  const liveActiveRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // True between an unexpected drop and the subsequent reconnect, so the
  // reconnect handler knows to clear the (now-dead) in-flight turn state.
  const reconnectedRef = useRef(false);
  // The queue, mirrored for synchronous reads inside socket handlers (turn-end
  // fires outside React's render cycle and must see the current head).
  const queueRef = useRef<QueuedPrompt[]>([]);
  // Always points at the latest `runPrompt` so the turn-end handler dispatches a
  // queued prompt with CURRENT sessionId/model/permission — not a stale closure.
  const runPromptRef = useRef<((prompt: string, echo: boolean) => void) | null>(null);
  // Monotonic id source for queued prompts (keys + cancellation targets).
  const queueIdRef = useRef(0);
  // Auto-scroll only follows new content while the user is parked at the bottom;
  // if they scroll up to read history we stop and show a "jump to latest" pill.
  const stick = useStickToBottom(scrollRef);

  const nextKey = () => ++keyRef.current;

  const push = useCallback((message: NormalizedMessage) => {
    setItems((prev) => [...prev, { key: nextKey(), message }]);
  }, []);

  // Append streamed text to the in-flight assistant bubble. Deltas go into the
  // external LiveStream (not React state), so only the subscribed LiveBubble
  // re-renders per token. The first delta of a turn flips `liveActive` once to
  // mount the bubble.
  const appendDelta = useCallback((text: string) => {
    if (!liveActiveRef.current) {
      liveActiveRef.current = true;
      setLiveActive(true);
    }
    liveStreamRef.current.append(text);
  }, []);

  // Append streamed THINKING text to the in-flight bubble. Like appendDelta it
  // flips `liveActive` on the first chunk so the bubble mounts even when thinking
  // arrives before any visible answer (the common case — reasoning streams first).
  const appendThinkingDelta = useCallback((text: string) => {
    if (!liveActiveRef.current) {
      liveActiveRef.current = true;
      setLiveActive(true);
    }
    liveStreamRef.current.appendThinking(text);
  }, []);

  // Tear down the in-flight live bubble (turn ended/aborted with no finalized
  // assistant message). Drops the streamed text rather than stranding a cursor.
  const clearLive = useCallback(() => {
    liveActiveRef.current = false;
    setLiveActive(false);
    liveStreamRef.current.reset();
  }, []);

  // Mirror the queue into a ref for synchronous reads in socket handlers.
  useEffect(() => {
    queueRef.current = queued;
  }, [queued]);

  // Dispatch the head of the queue as its own turn. Called when a turn ends (or
  // is cleared) so a follow-up the user composed mid-turn runs next. Echoes the
  // prompt as a user bubble — the pending "queue" bubble for it disappears in the
  // same commit, so it reads as the queued prompt simply starting. No-op when the
  // queue is empty. Runs via runPromptRef to pick up the latest sessionId/model.
  const dispatchNext = useCallback(() => {
    const head = queueRef.current[0];
    if (!head) return;
    const rest = queueRef.current.slice(1);
    queueRef.current = rest;
    setQueued(rest);
    runPromptRef.current?.(head.prompt, true);
  }, []);

  // The full assistant message arrived. When a turn was streaming, the finalized
  // message supersedes the live bubble: push it into the stable `items` list and
  // reset the stream so the (now-duplicated) streamed text disappears in the same
  // commit the finalized message appears — no flicker, no double text.
  const finalizeMessage = useCallback(
    (message: NormalizedMessage) => {
      if (message.role === "assistant" && liveActiveRef.current) {
        liveActiveRef.current = false;
        setLiveActive(false);
        liveStreamRef.current.reset();
        push(message);
        return;
      }
      push(message);
    },
    [push],
  );

  // Lazily open one WebSocket for this pane; tear it down on unmount.
  const ensureConn = useCallback((): ChatConn => {
    if (connRef.current) return connRef.current;
    const conn = openChat({
      onSession: (id, init) => {
        setSessionId(id);
        // Capture the session's slash commands for the composer palette. Guard
        // the shape — older servers may omit it.
        if (Array.isArray(init?.slashCommands)) setSlashCommands(init.slashCommands);
      },
      onDelta: (text) => appendDelta(text),
      onThinkingDelta: (text) => appendThinkingDelta(text),
      onMessage: (m) => finalizeMessage(m),
      onStatus: (kind, data) => {
        // An enriched `tokens` status carries a live usage snapshot — feed the
        // meter without disturbing the human-readable status label.
        if (kind === "tokens") {
          const parsed = parseTokenStatus(data);
          if (parsed) setTokenStatus(parsed);
          return;
        }
        // A `retrying:<attempt>:<delayMs>` status means a rate-limited/overloaded
        // turn is auto-retrying. Surface a calm inline indicator instead of letting
        // the raw kind string land in the status label. Older servers never emit
        // this, so the indicator simply never appears there.
        const r = parseRetryStatus(kind);
        if (r) {
          setRetry(r);
          return;
        }
        // Any OTHER status means the turn has resumed past a retry — clear the
        // retry indicator so it never outlives the wait it described.
        setRetry(null);
        setStatus(kind);
      },
      onResult: (result) => {
        setLastResult(result);
        // Stamp the turn's wall-clock duration for the per-turn footer (the
        // engine TurnResult carries none). Null start = couldn't measure.
        setLastDurationMs(turnStartRef.current != null ? Date.now() - turnStartRef.current : null);
        // A turn that ended in an error subtype should surface the retry card,
        // so un-dismiss when an error result lands.
        if (result.isError) setErrorDismissed(false);
      },
      onPermissionRequest: (req) => enqueueApprovalRef.current(req),
      onConnectionState: (state) => {
        if (state === "reconnecting") {
          reconnectedRef.current = true;
          setReconnecting(true);
          return;
        }
        // Reconnected after a drop: the server canceled the in-flight turn on
        // socket close, so we'll never receive its turn-end. Clear the stuck
        // "running" UI so the user can resume — the next prompt re-sends the
        // live sessionId, continuing the same CLI session.
        setReconnecting(false);
        if (reconnectedRef.current) {
          reconnectedRef.current = false;
          setRunning(false);
          setStatus(null);
          clearApprovalsRef.current();
          setPendingPermission(null);
          setTokenStatus(null);
          setRetry(null);
          clearLive();
        }
      },
      onError: (message) => {
        setErrorMsg(message);
        setErrorDismissed(false);
        setRunning(false);
        setStatus(null);
        clearApprovalsRef.current();
        setPendingPermission(null);
        setTokenStatus(null);
        setRetry(null);
        clearLive();
        // A failed turn shouldn't auto-fire the queue (it might fail the same
        // way, or the error needs the user's attention). The queued prompts stay
        // pending so the user can retry or cancel them.
      },
      onTurnEnd: () => {
        setRunning(false);
        setStatus(null);
        clearApprovalsRef.current();
        setPendingPermission(null);
        setTokenStatus(null);
        setRetry(null);
        clearLive();
        // The turn finished cleanly — kick off the next queued follow-up, if any.
        dispatchNext();
      },
    });
    connRef.current = conn;
    return conn;
  }, [appendDelta, appendThinkingDelta, finalizeMessage, clearLive, dispatchNext]);

  // Forward the user's Allow/Deny decision (with its scope) to the agent and
  // dismiss the card. Never auto-decides: only fires from an explicit button
  // press in PermissionCard or an approval-keyboard binding. Scope is dormant on
  // the per-turn driver but rides along in the payload so the persistent path can
  // honor it later.
  const respondPermission = useCallback((id: string, { decision, scope, message, updatedInput }: PermissionDecision) => {
    connRef.current?.send({
      t: "permission-response",
      id,
      decision,
      scope,
      // Optional deny feedback (PermissionCard → DenyFeedback). Only include it
      // when present so a plain deny/allow payload is unchanged.
      ...(message ? { message } : {}),
      // Optional edited tool input (PermissionCard → EditableApproval) on an
      // allow. Only include it when the user revised the input, so a plain
      // unchanged-allow payload is identical to before.
      ...(updatedInput !== undefined ? { updatedInput } : {}),
    });
    setPendingPermission((cur) => (cur && cur.id === id ? null : cur));
  }, []);

  // Keyboard-driven approvals + a small pending-approvals QUEUE. The hook binds
  // A=allow once, D=deny, S=allow-for-session, E=edit, and J/K (or arrows) to step
  // between multiple waiting requests. Bindings are disabled while the composer or
  // a picker has focus typing (the hook also ignores keystrokes from inputs), and
  // while the snippet overlay is open. `respond` reuses respondPermission so the
  // WS frame + the single-card `pendingPermission` clear stay in lockstep.
  const approvals = useApprovalKeyboard({
    respond: (id, decision) => {
      respondPermission(id, decision);
    },
    onEdit: () => setEditFocusToken((t) => (t ?? 0) + 1),
    enabled: !snippetsOpen,
  });

  // Mirror the active queued approval into `pendingPermission` so the existing
  // render path (and the deny-feedback sub-state inside the card) is driven by
  // whichever request the queue is currently focused on.
  const approvalsActive = approvals.active;
  useEffect(() => {
    setPendingPermission(approvalsActive);
  }, [approvalsActive]);

  // Latest enqueue, read by the socket handler so a new permission-request joins
  // the queue without re-subscribing the connection.
  const enqueueApprovalRef = useRef(approvals.enqueue);
  enqueueApprovalRef.current = approvals.enqueue;
  const clearApprovalsRef = useRef(approvals.clear);
  clearApprovalsRef.current = approvals.clear;

  useEffect(() => {
    return () => {
      connRef.current?.close();
      connRef.current = null;
    };
  }, []);

  // Insert arbitrary text (e.g. an uploaded image's "@path ") at the current
  // caret, restoring the caret after it and refocusing. Used by useImageAttach
  // when a pasted/dropped image finishes uploading. Reads the live textarea value
  // (not stale `draft`) so multiple inserts in a row don't clobber each other.
  const insertAtCaret = useCallback(
    (text: string) => {
      const el = textareaRef.current;
      const base = el ? el.value : draft;
      const caret = el ? el.selectionStart ?? base.length : base.length;
      // Ensure a separating space before the reference when mid-word.
      const needsLeadingSpace = caret > 0 && !/\s$/.test(base.slice(0, caret));
      const insert = `${needsLeadingSpace ? " " : ""}@${text} `;
      const next = base.slice(0, caret) + insert + base.slice(caret);
      setDraft(next);
      const newCaret = caret + insert.length;
      caretRef.current = newCaret;
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (node) {
          node.focus();
          node.selectionStart = node.selectionEnd = newCaret;
        }
      });
    },
    [draft, setDraft],
  );

  // Paste / drag-drop image attachments: upload to /api/attachments and insert the
  // returned on-disk path as an "@path" reference (the CLI reads the file). Shows
  // pending thumbnails while uploads run; degrades gracefully if the route is absent.
  const imageAttach = useImageAttach({ onInsertPath: insertAtCaret });

  // Shared turn kickoff. `echo` controls whether we render a local user bubble
  // (true for a typed send; false for regenerate, which reuses the prompt that
  // already shows in the transcript). Snaps to the bottom and resets per-turn UI.
  const runPrompt = useCallback(
    (prompt: string, echo: boolean) => {
      if (echo) {
        const localUser: NormalizedMessage = {
          seq: -1,
          uuid: null,
          parentUuid: null,
          role: "user",
          type: "user",
          timestamp: new Date().toISOString(),
          blocks: [{ type: "text", text: prompt }],
        };
        push(localUser);
      }

      lastPromptRef.current = prompt;
      // A fresh turn always snaps back to the bottom to follow the reply.
      stick.pin();
      setErrorMsg(null);
      setErrorDismissed(false);
      setLastResult(null);
      setLastDurationMs(null);
      setInterrupted(false);
      turnStartRef.current = Date.now();
      clearApprovalsRef.current();
      setPendingPermission(null);
      setTokenStatus(null);
      setRetry(null);
      setStatus("starting");
      setRunning(true);
      clearLive();

      const conn = ensureConn();
      conn.send({ t: "prompt", cwd, prompt, sessionId, model, permissionMode });
    },
    [push, ensureConn, cwd, sessionId, model, permissionMode, stick.pin, clearLive],
  );

  // Keep the ref pointed at the latest runPrompt so a queued dispatch (fired from
  // a socket handler on turn-end) uses the current sessionId/model/permission.
  useEffect(() => {
    runPromptRef.current = runPrompt;
  }, [runPrompt]);

  const send = useCallback(() => {
    const prompt = draft.trim();
    if (!prompt) return;
    history.add(prompt);
    clearDraft();
    setEditingFork(false);
    setMention(null);
    setMentionEntries([]);
    // The image @paths are already embedded in the prompt text; drop the pending
    // thumbnails now that the message carrying them is on its way.
    imageAttach.clear();
    // A turn is in flight: queue this follow-up instead of dropping it. It runs
    // as its own turn when the current (and any earlier-queued) turn finishes.
    if (running) {
      setQueued((q) => [...q, { id: ++queueIdRef.current, prompt }]);
      return;
    }
    runPrompt(prompt, true);
  }, [draft, running, clearDraft, runPrompt, history, imageAttach]);

  // Cancel a single queued follow-up by dropping it locally. The queue is held
  // entirely client-side (today's per-turn server only ever sees one prompt at a
  // time — the head is dispatched on turn-end), so removing it here is the whole
  // cancellation. We deliberately do NOT send {t:"clear-queue"} to the current
  // server: it rejects unknown frames with an `error` that would tear down the
  // in-flight turn's UI. The OutgoingMsg type carries `clear-queue` as
  // groundwork for a queue-aware server that owns the queue itself.
  const cancelQueued = useCallback((id: number) => {
    setQueued((q) => {
      const next = q.filter((it) => it.id !== id);
      queueRef.current = next;
      return next;
    });
  }, []);

  // Resend the last user prompt (resuming the session) to get a fresh response.
  // Reuses the prompt already in the transcript, so it doesn't echo a duplicate
  // user bubble.
  const regenerate = useCallback(() => {
    const prompt = lastPromptRef.current?.trim();
    if (!prompt || running) return;
    runPrompt(prompt, false);
  }, [running, runPrompt]);

  // "Edit & resend" from a prior user bubble: drop its text into the composer,
  // mark this as a fork-from-here send, and focus the textarea for editing. The
  // actual resend goes through the normal send() path, which includes the live
  // sessionId — so the CLI resumes (forks) the session from that point.
  const editFromMessage = useCallback(
    (text: string) => {
      if (running) return;
      setDraft(text);
      setEditingFork(true);
      const el = textareaRef.current;
      if (el) {
        requestAnimationFrame(() => {
          el.focus();
          // Caret to the end so the user can keep typing immediately.
          el.selectionStart = el.selectionEnd = el.value.length;
        });
      }
    },
    [running, setDraft],
  );

  const stop = useCallback(() => {
    connRef.current?.send({ t: "interrupt" });
    setInterrupted(true);
  }, []);

  // Persist the current model + permission as THIS project's defaults. Shows a
  // brief saved/failed state on the pin control. No-op when the host didn't wire
  // a save handler (the control is hidden then).
  const saveProjectDefaults = useCallback(() => {
    if (!onSaveProjectDefaults || savingDefault === "saving") return;
    setSavingDefault("saving");
    onSaveProjectDefaults(model, permissionMode)
      .then(() => setSavingDefault("ok"))
      .catch(() => setSavingDefault("fail"))
      .finally(() => {
        window.setTimeout(() => setSavingDefault(null), 1800);
      });
  }, [onSaveProjectDefaults, savingDefault, model, permissionMode]);

  const newChat = useCallback(() => {
    connRef.current?.close();
    connRef.current = null;
    keyRef.current = 0;
    lastPromptRef.current = null;
    clearLive();
    stick.pin();
    setItems([]);
    setSessionId(undefined);
    setRunning(false);
    setStatus(null);
    setLastResult(null);
    setLastDurationMs(null);
    setInterrupted(false);
    turnStartRef.current = null;
    setErrorMsg(null);
    clearApprovalsRef.current();
    setPendingPermission(null);
    setTokenStatus(null);
    setEditingFork(false);
    queueRef.current = [];
    setQueued([]);
  }, [clearLive, stick.pin]);

  // The composer is in "slash mode" when, with a turn idle, the draft is a single
  // leading-"/" token (no space/newline yet) — e.g. "/" or "/comp". The query is
  // the text after the slash. Anything else (a space, a second line, normal text)
  // closes the palette so typing a message that merely starts with "/path" works.
  const slashMatch = !running ? /^\/(\S*)$/.exec(draft) : null;
  const slashQuery = slashMatch ? slashMatch[1]! : null;
  const slashMatches = useMemo(
    () => (slashQuery == null ? [] : filterCommands(slashCommands, slashQuery)),
    [slashQuery, slashCommands],
  );
  const slashOpen = slashQuery != null && slashMatches.length > 0;

  // Keep the highlighted row valid as the filtered list changes (e.g. typing
  // narrows it). Clamp into range; reset to the top when the query changes shape.
  useEffect(() => {
    setSlashIndex((i) => (i >= slashMatches.length ? 0 : i));
  }, [slashMatches.length]);

  // Insert a snippet's (placeholder-filled) text into the composer. Appends to any
  // existing draft (with a separating blank line) so a partial message isn't lost,
  // then focuses the textarea with the caret at the end for immediate editing.
  const insertSnippet = useCallback(
    (text: string) => {
      const base = draft.trim();
      setDraft(base ? `${base}\n\n${text}` : text);
      const el = textareaRef.current;
      if (el) {
        requestAnimationFrame(() => {
          el.focus();
          el.selectionStart = el.selectionEnd = el.value.length;
        });
      }
    },
    [draft, setDraft],
  );

  // Execute or insert a chosen slash command. Built-ins (/clear, /model, /help)
  // run their UI action and clear the draft. Session-advertised commands that
  // aren't built-ins are inserted as "/name " text for the agent to handle.
  const insertSlash = useCallback(
    (command: string) => {
      const builtin = BUILTIN_COMMANDS.find((b) => b.name === command);
      if (builtin) {
        // Always clear the draft + close the palette first.
        setDraft("");
        setSlashIndex(0);
        if (command === "clear") {
          newChat();
        } else if (command === "model") {
          setModelPickerOpen(true);
        } else if (command === "help") {
          setHelpOpen(true);
        }
        return;
      }
      // Non-built-in: insert as text so the agent can process it.
      setDraft(`/${command} `);
      setSlashIndex(0);
      const el = textareaRef.current;
      if (el) {
        requestAnimationFrame(() => {
          el.focus();
          el.selectionStart = el.selectionEnd = el.value.length;
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setDraft, newChat],
  );

  // Recompute the active "@" mention from the current draft + caret. Slash mode
  // (a leading "/token") wins, so we never show both pickers at once. Called from
  // the textarea's change/select/click handlers via syncMention.
  const recomputeMention = useCallback((text: string, caret: number) => {
    // Mentions work whether idle or composing a mid-turn follow-up. Slash mode
    // can't co-occur (it needs a leading "/", a mention needs an "@" token).
    const m = detectMention(text, caret);
    setMention(m);
    if (!m) {
      setMentionEntries([]);
      setMentionError(null);
    }
  }, []);

  // Read the caret from the textarea and re-detect the mention. Used after any
  // edit (change/keyup/click) so the picker tracks where the user is typing.
  const syncMention = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    caretRef.current = el.selectionStart ?? el.value.length;
    recomputeMention(el.value, caretRef.current);
  }, [recomputeMention]);

  const mentionQuery = mention?.query ?? null;
  const mentionOpen = mention != null;

  // Fetch fuzzy file matches for the active mention query (debounced). Backed by
  // GET /api/files?cwd=&q=; the cwd is allowlisted server-side. A failure (e.g.
  // the route isn't available) shows a hint in the picker but never breaks typing.
  useEffect(() => {
    if (mentionQuery == null) return;
    let cancelled = false;
    setMentionLoading(true);
    setMentionError(null);
    const t = window.setTimeout(() => {
      api
        .listFiles(cwd, mentionQuery)
        .then((rows) => {
          if (cancelled) return;
          // Normalize: the server may return bare path strings or rich objects.
          const entries: FileEntry[] = (rows as unknown[]).map((r) =>
            typeof r === "string" ? { path: r } : (r as FileEntry),
          );
          setMentionEntries(entries);
          setMentionLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setMentionEntries([]);
          setMentionError("File search is unavailable here.");
          setMentionLoading(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [mentionQuery, cwd]);

  // Keep the highlighted mention row valid as the list changes.
  useEffect(() => {
    setMentionIndex((i) => (i >= mentionEntries.length ? 0 : i));
  }, [mentionEntries.length]);

  // Insert a chosen file as an "@path " mention: replace the "@query" token in the
  // draft with "@<path> " (trailing space so the user keeps typing), restore the
  // caret after it, and refocus. Closes the picker.
  const insertMention = useCallback(
    (entry: FileEntry) => {
      if (!mention) return;
      const insertText = `@${entry.path}${entry.dir ? "/" : " "}`;
      const next = draft.slice(0, mention.start) + insertText + draft.slice(mention.end);
      setDraft(next);
      setMention(null);
      setMentionEntries([]);
      const caret = mention.start + insertText.length;
      caretRef.current = caret;
      const el = textareaRef.current;
      if (el) {
        requestAnimationFrame(() => {
          el.focus();
          el.selectionStart = el.selectionEnd = caret;
          // A directory insert keeps the "@" token open to drill in further.
          if (entry.dir) recomputeMention(next, caret);
        });
      }
    },
    [mention, draft, setDraft, recomputeMention],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Mention picker takes keyboard priority while open (Arrow/Enter/Tab/Escape),
    // ahead of the send/history handlers. Slash mode can't be active at the same
    // time (it requires a leading "/", a mention requires an "@" token).
    if (mentionOpen) {
      const count = mentionEntries.length;
      if (e.key === "ArrowDown" && count > 0) {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % count);
        return;
      }
      if (e.key === "ArrowUp" && count > 0) {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + count) % count);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        if (count > 0) {
          e.preventDefault();
          const pick = mentionEntries[mentionIndex] ?? mentionEntries[0];
          if (pick) insertMention(pick);
          return;
        }
        // No matches: fall through so Enter still sends / Tab does nothing special.
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        setMentionEntries([]);
        return;
      }
    }

    // Slash palette takes keyboard priority while open: Arrow to move, Enter/Tab
    // to insert the highlighted command, Escape to dismiss (clearing the draft).
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        const pick = slashMatches[slashIndex] ?? slashMatches[0];
        if (pick) insertSlash(pick);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDraft("");
        setSlashIndex(0);
        return;
      }
    }

    // Escape closes the model picker or help overlay if they're open.
    if (e.key === "Escape") {
      if (modelPickerOpen) { e.preventDefault(); setModelPickerOpen(false); return; }
      if (helpOpen) { e.preventDefault(); setHelpOpen(false); return; }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
      return;
    }
    // Up/Down recall previously sent prompts — but only when the caret can't move
    // within the textarea (at the very start for Up, the very end for Down), so
    // editing a multi-line draft is never hijacked. Skip while a turn is running.
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !running) {
      const el = e.currentTarget;
      const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
      const atEnd =
        el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
      if (e.key === "ArrowUp" && atStart) {
        const recalled = history.recallPrev(draft);
        if (recalled !== null) {
          e.preventDefault();
          setDraft(recalled);
        }
      } else if (e.key === "ArrowDown" && atEnd && history.navigating) {
        const recalled = history.recallNext();
        if (recalled !== null) {
          e.preventDefault();
          setDraft(recalled);
        }
      }
    }
  };

  const cwdShort = useMemo(() => cwd, [cwd]);

  // Pair tool_use ⇄ tool_result before rendering, keeping each item's stable
  // monotonic key. pairMessage clones changed messages and returns null for the
  // tool_result-only user messages that get absorbed into a tool_use card.
  const view = useMemo(() => {
    const resultById = indexToolResults(items.map((it) => it.message));
    if (resultById.size === 0) return items;
    const out: ChatItem[] = [];
    for (const it of items) {
      const paired = pairMessage(it.message, resultById);
      if (paired) out.push({ key: it.key, message: paired });
    }
    return out;
  }, [items]);

  const virtualizer = useVirtualizer({
    count: view.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 10,
  });

  // Follow the newest FINALIZED message as the list grows or a turn ends — but
  // only while the user is parked at the bottom. Streaming growth (the LiveBubble)
  // is followed separately via `followLiveBottom` (passed to LiveBubble) so a
  // token never re-renders this pane.
  const lastIndex = view.length - 1;
  useEffect(() => {
    if (lastIndex < 0) return;
    return stick.followToIndex(() =>
      virtualizer.scrollToIndex(lastIndex, { align: "end" }),
    );
  }, [lastIndex, running, liveActive, virtualizer, stick.followToIndex]);

  // Keep the streaming LiveBubble in view as it grows, but only while pinned.
  // LiveBubble invokes this on each delta (it owns the per-token re-render); we
  // scroll the container to its bottom, which lands on the live bubble below the
  // virtualized (finalized) block. `followToIndex` reads the pin state
  // synchronously, so a scrolled-up user is never yanked back down.
  const followLiveBottom = useCallback(() => {
    stick.followToIndex(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [stick.followToIndex]);

  return (
    <CwdProvider value={cwd}>
    <div className="flex min-w-0 flex-1 flex-col bg-zinc-950">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 px-5 py-2.5">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 truncate text-[15px] font-semibold text-zinc-100">
            <span className="truncate">{projectName}</span>
            {reconnecting && (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-medium text-amber-300 ring-1 ring-amber-500/20"
                title="Lost the connection — retrying. The session resumes on your next message."
              >
                <Wifi className="h-3 w-3 animate-pulse" />
                reconnecting…
              </span>
            )}
          </h1>
          <div className="truncate text-[11px] text-zinc-600" title={cwd} dir="rtl">
            {cwdShort}
          </div>
        </div>

        {/* Git branch dropdown for this project's working tree: switch branches
            or create a new one before starting a chat. Hides itself when the cwd
            isn't a git repo. Locked while a turn runs. */}
        <BranchSwitcher cwd={cwd} disabled={running} />

        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={running}
          className="rounded-lg bg-zinc-900 px-2 py-1 text-[12px] text-zinc-200 ring-1 ring-zinc-800 focus:outline-none focus:ring-clay-500/40 disabled:opacity-50"
          title="Model"
        >
          {MODELS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        <select
          value={permissionMode}
          onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
          disabled={running}
          className="rounded-lg bg-zinc-900 px-2 py-1 text-[12px] text-zinc-200 ring-1 ring-zinc-800 focus:outline-none focus:ring-clay-500/40 disabled:opacity-50"
          title="Permission mode"
        >
          {PERMISSION_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        {/* Pin the current model + permission as this project's defaults. Only
            shown when the host wired a save handler. Reflects a brief saved/
            failed state after the PATCH. */}
        {onSaveProjectDefaults ? (
          <button
            onClick={saveProjectDefaults}
            disabled={savingDefault === "saving"}
            className={cn(
              "inline-flex items-center justify-center rounded-lg px-2 py-1 ring-1 transition disabled:opacity-50",
              savingDefault === "ok"
                ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30"
                : savingDefault === "fail"
                  ? "bg-red-500/15 text-red-300 ring-red-500/30"
                  : "bg-zinc-900 text-zinc-400 ring-zinc-800 hover:bg-zinc-800 hover:text-clay-300",
            )}
            title="Set the current model + permission mode as this project's defaults"
            aria-label="Set as project default"
          >
            {savingDefault === "saving" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : savingDefault === "ok" ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Pin className="h-3.5 w-3.5" />
            )}
          </button>
        ) : null}

        <button
          onClick={newChat}
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] font-medium text-zinc-300 ring-1 ring-zinc-800 transition hover:bg-zinc-800 hover:text-zinc-100"
          title="Start a fresh conversation"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          New chat
        </button>
      </div>

      <ChatWorktreePanel cwd={cwd} />

      {/* Message stream */}
      <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={stick.onScroll} className="h-full overflow-y-auto">
        {view.length === 0 ? (
          <EmptyState
            icon={<Sparkles className="h-12 w-12" />}
            title={`Chat in ${projectName}`}
            hint={
              initialSessionId
                ? "Resuming this session. Type a prompt below to continue where it left off."
                : "Type a prompt below to start a live Claude Code session in this project. Enter to send, Shift+Enter for a new line."
            }
          />
        ) : (
          <>
            <div
              style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}
            >
              {virtualizer.getVirtualItems().map((vi) => {
                const it = view[vi.index]!;
                return (
                  <div
                    key={it.key}
                    data-index={vi.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vi.start}px)`,
                    }}
                    className="border-b border-zinc-900/70"
                  >
                    <MessageView
                      m={it.message}
                      live={running}
                      prevTimestamp={view[vi.index - 1]?.message.timestamp ?? null}
                      onEdit={!running ? editFromMessage : undefined}
                    />
                  </div>
                );
              })}
            </div>
            {/* The in-flight streaming bubble lives BELOW the virtualized
                (finalized) block, in normal flow, and subscribes to the delta
                store itself — so a streamed token re-renders only it, not the
                finalized list above. Finalizing moves its text into `view`. */}
            {liveActive ? (
              <div className="border-b border-zinc-900/70">
                <LiveBubble stream={liveStreamRef.current} onGrow={followLiveBottom} />
              </div>
            ) : null}
            {/* Pending follow-ups composed mid-turn. Rendered as dimmed "queue"
                bubbles below the stream; each dispatches as its own turn when the
                turns ahead of it finish, or can be cancelled here. */}
            {queued.map((q, i) => (
              <QueuedBubble
                key={q.id}
                index={i}
                prompt={q.prompt}
                onCancel={() => cancelQueued(q.id)}
              />
            ))}
          </>
        )}
      </div>

        {/* "Jump to latest" pill — shown only when the user scrolled up while
            new content is below. Clicking re-pins and snaps to the newest. */}
        {stick.showJumpToLatest && lastIndex >= 0 ? (
          <button
            onClick={() =>
              stick.scrollToLatest(() =>
                virtualizer.scrollToIndex(lastIndex, { align: "end" }),
              )
            }
            className="absolute bottom-4 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-clay-500 px-3 py-1.5 text-[12px] font-medium text-white shadow-lg ring-1 ring-clay-400/50 transition hover:bg-clay-600"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Jump to latest
          </button>
        ) : null}
      </div>

      {/* Inline tool-permission request (persistent-path only; dormant on the
          default per-turn driver). Answered via a permission-response send, or via
          the approval keyboard (A/D/S/E + J/K to step the queue). */}
      {pendingPermission && (
        <PermissionCard
          request={pendingPermission}
          onDecision={respondPermission}
          queueCount={approvals.queue.length}
          queuePosition={approvals.activeIndex}
          onNext={approvals.next}
          onPrev={approvals.prev}
          editFocusToken={editFocusToken}
        />
      )}

      {/* Turn-error card: an {t:"error"} socket frame, or a result that ended in
          an error subtype. Offers Retry (resend the last prompt, resuming the
          session) + dismiss. Hidden while a turn runs or once dismissed. */}
      {!running && !errorDismissed && (errorMsg || lastResult?.isError) ? (
        <TurnError
          message={errorMsg ?? lastResult?.resultText ?? "The turn ended with an error."}
          subtype={errorMsg ? undefined : lastResult?.subtype}
          onRetry={lastPromptRef.current ? regenerate : undefined}
          onDismiss={() => setErrorDismissed(true)}
        />
      ) : null}

      {/* Status / result footer */}
      {(running || lastResult || errorMsg || (!running && lastPromptRef.current)) && (
        <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800/80 bg-zinc-900/30 px-5 py-1.5 text-[11px]">
          {running && (
            <span className="flex items-center gap-1.5 text-clay-300">
              <Spinner className="h-3 w-3" />
              {status ?? "working"}
            </span>
          )}
          {/* Live token/context/$ meter for the running turn — fed by the enriched
              `tokens` status. Only appears once a snapshot has arrived (so it's a
              no-op on servers that don't emit token statuses). */}
          {running && tokenStatus && <TokenMeter data={tokenStatus} model={model} />}
          {/* Rate-limit auto-retry indicator — only while a turn is running and the
              server has reported a `retrying:*` status. Calm, warn-toned, and
              cleared the instant the turn resumes/ends (see onStatus/onTurnEnd). */}
          {running && retry && <RetryingLabel retry={retry} />}
          {queued.length > 0 && (
            <span
              className="flex items-center gap-1 text-amber-400"
              title="Follow-ups waiting to run after the current turn"
            >
              <ListPlus className="h-3 w-3" />
              {queued.length} queued
            </span>
          )}
          {/* Per-turn summary: cost, tokens (in/out/cache), duration, and model
              from the {t:"result"} payload (TurnResult). The denials chip rides
              alongside it. Replaces the old cost-only line. */}
          {!running && lastResult && (
            <>
              <TurnFooter
                result={lastResult}
                model={model}
                durationMs={lastDurationMs ?? undefined}
              />
              {/* Mark a turn that was stopped early — the user hit Stop, or the
                  result ended in an error/aborted subtype — so a half-finished
                  turn reads distinctly from a clean completion. */}
              {(interrupted || isStoppedSubtype(lastResult.subtype)) && (
                <StoppedBadge
                  reason={interrupted ? "Stopped: interrupted by you" : stoppedReason(lastResult.subtype)}
                  // Pass the result subtype (only when not a user interrupt) so a
                  // recognized one renders its precise StatusLabel ("Hit the spend
                  // limit", "Rate limited", …) instead of the generic chip.
                  subtype={interrupted ? undefined : lastResult.subtype}
                />
              )}
              {lastResult.denials.length > 0 && (
                <span className="text-amber-400">
                  {lastResult.denials.length} denial{lastResult.denials.length === 1 ? "" : "s"}
                </span>
              )}
            </>
          )}
          {/* Interrupted but no result frame arrived (server didn't emit one for
              the aborted turn) — still surface the stopped state. */}
          {!running && !lastResult && interrupted && (
            <StoppedBadge reason="Stopped: interrupted by you" />
          )}
          {/* The error itself renders in the TurnError card above; the footer just
              keeps the per-turn summary and the Regenerate affordance. */}
          {/* Resend the last prompt for a fresh response (resumes the session). */}
          {!running && lastPromptRef.current && (
            <button
              onClick={regenerate}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-medium text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
              title="Regenerate the last response"
            >
              <RotateCcw className="h-3 w-3" />
              Regenerate
            </button>
          )}
        </div>
      )}

      {/* Composer */}
      <div className="border-t border-zinc-800/80 px-4 py-3">
        {/* "@" file-mention picker — opens when the caret is in an "@token".
            Fuzzy-matches project files via GET /api/files; Arrow/Enter handled in
            onKeyDown so focus stays in the textarea; clicking a row inserts it. */}
        {mentionOpen ? (
          <MentionPicker
            query={mentionQuery ?? ""}
            entries={mentionEntries}
            activeIndex={mentionIndex}
            loading={mentionLoading}
            error={mentionError}
            onPick={insertMention}
          />
        ) : null}
        {/* Slash command palette — opens when the draft is a single "/token".
            Arrow/Enter are handled in the composer's onKeyDown so focus stays in
            the textarea; clicking a row inserts it too. */}
        {slashOpen ? (
          <SlashPalette
            query={slashQuery!}
            commands={slashCommands}
            activeIndex={slashIndex}
            onPick={insertSlash}
          />
        ) : null}
        {/* /model inline picker — appears above the composer when the user runs
            /model. Lets them pick a model without leaving the chat. */}
        {modelPickerOpen ? (
          <div className="mb-2 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl shadow-black/40 ring-1 ring-black/20">
            <div className="flex items-center justify-between border-b border-zinc-800/80 px-3 py-1.5 text-[11px] text-zinc-500">
              <span>Switch model</span>
              <button
                type="button"
                onClick={() => setModelPickerOpen(false)}
                className="rounded p-0.5 hover:bg-zinc-800 hover:text-zinc-300"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <ul className="py-1">
              {MODELS.map((m) => (
                <li key={m}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setModel(m);
                      setModelPickerOpen(false);
                      textareaRef.current?.focus();
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition",
                      m === model
                        ? "bg-clay-500/15 text-clay-200"
                        : "text-zinc-300 hover:bg-zinc-800/70",
                    )}
                  >
                    {m === model ? <Check className="h-3.5 w-3.5 shrink-0 text-clay-400" /> : <span className="h-3.5 w-3.5 shrink-0" />}
                    <span className="font-mono text-[12.5px]">{m}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {/* /help overlay — shows all available slash commands. */}
        {helpOpen ? (
          <div className="mb-2 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl shadow-black/40 ring-1 ring-black/20">
            <div className="flex items-center justify-between border-b border-zinc-800/80 px-3 py-1.5 text-[11px] text-zinc-500">
              <span>Slash commands</span>
              <button
                type="button"
                onClick={() => { setHelpOpen(false); textareaRef.current?.focus(); }}
                className="rounded p-0.5 hover:bg-zinc-800 hover:text-zinc-300"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <ul className="py-1">
              {BUILTIN_COMMANDS.map((b) => (
                <li key={b.name} className="flex items-center gap-3 px-3 py-1.5 text-[13px]">
                  <span className="font-mono font-medium text-clay-300">/{b.name}</span>
                  <span className="text-zinc-500">{b.description}</span>
                </li>
              ))}
              {slashCommands.filter((c) => !BUILTIN_COMMANDS.find((b) => b.name === c)).map((c) => (
                <li key={c} className="flex items-center gap-3 px-3 py-1.5 text-[13px]">
                  <span className="font-mono font-medium text-zinc-300">/{c}</span>
                  <span className="text-zinc-600">session command</span>
                </li>
              ))}
              {slashCommands.length === 0 && (
                <li className="px-3 py-1.5 text-[12px] text-zinc-600">
                  No session commands available — start a chat to load them.
                </li>
              )}
            </ul>
          </div>
        ) : null}
        {/* Fork-from-here banner: shown after "Edit & resend" until the message
            is sent or the user cancels. Sending resumes the session, so it
            continues/forks the conversation from that earlier turn. */}
        {editingFork && !running ? (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-clay-500/10 px-2.5 py-1.5 text-[11px] text-clay-200 ring-1 ring-clay-500/20">
            <Pencil className="h-3 w-3 shrink-0" />
            <span className="min-w-0 flex-1">
              Editing an earlier message — sending will continue this session, forking
              the conversation from here.
            </span>
            <button
              onClick={() => setEditingFork(false)}
              className="shrink-0 rounded px-1.5 py-0.5 font-medium text-clay-300 transition hover:bg-clay-500/15 hover:text-clay-100"
            >
              Cancel
            </button>
          </div>
        ) : null}
        {/* Pending image attachments — thumbnails of pasted/dropped images. Each
            uploads to /api/attachments and inserts its "@path" into the prompt. */}
        {imageAttach.attachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {imageAttach.attachments.map((a) => (
              <div
                key={a.id}
                className={cn(
                  "group relative h-16 w-16 overflow-hidden rounded-lg ring-1",
                  a.status === "error" ? "ring-red-700/60" : "ring-zinc-700",
                )}
                title={a.status === "error" ? a.error : a.status === "done" ? a.path : a.filename}
              >
                <img src={a.previewUrl} alt={a.filename} className="h-full w-full object-cover" />
                {/* Uploading veil with a spinner. */}
                {a.status === "uploading" ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/60">
                    <Loader2 className="h-4 w-4 animate-spin text-clay-300" />
                  </div>
                ) : null}
                {/* Error veil. */}
                {a.status === "error" ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-red-950/60 px-1 text-center text-[9px] text-red-200">
                    failed
                  </div>
                ) : null}
                {/* Remove button (hover). */}
                <button
                  onClick={() => imageAttach.remove(a.id)}
                  className="absolute right-0.5 top-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-zinc-950/80 text-zinc-300 opacity-0 transition hover:bg-zinc-800 hover:text-white group-hover:opacity-100"
                  title="Remove attachment"
                  aria-label="Remove attachment"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {/* Graceful notice when the server can't accept image uploads. */}
        {imageAttach.unsupported ? (
          <div className="mb-2 flex items-center gap-1.5 text-[11px] text-zinc-600">
            <ImageIcon className="h-3 w-3" />
            Image upload isn't available on this server yet.
          </div>
        ) : null}
        <div
          className="flex items-end gap-2 rounded-xl bg-zinc-900 p-2 ring-1 ring-zinc-800 focus-within:ring-clay-500/40"
          onDrop={imageAttach.onDrop}
          onDragOver={imageAttach.onDragOver}
        >
          {/* Snippet library trigger — open the prompt-templates overlay to insert
              a saved template (with {placeholders}) into the composer. */}
          <IconButton
            onClick={() => setSnippetsOpen(true)}
            title="Snippet library — insert a saved prompt template"
            aria-label="Open snippet library"
            className="h-9 w-9"
          >
            <FileText className="h-4 w-4" />
          </IconButton>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => {
              // A manual edit abandons history navigation (we're back on a live line).
              if (history.navigating) history.reset();
              setDraft(e.target.value);
              // Track the caret + re-detect an "@" mention at the new position.
              caretRef.current = e.target.selectionStart ?? e.target.value.length;
              recomputeMention(e.target.value, caretRef.current);
            }}
            onKeyDown={onKeyDown}
            // Caret moves (click / arrow nav) also re-detect a mention so moving
            // INTO or OUT of an "@token" opens/closes the picker.
            onKeyUp={syncMention}
            onClick={syncMention}
            // Pasting an image uploads it + inserts its @path; text paste is normal.
            onPaste={imageAttach.onPaste}
            rows={1}
            placeholder={
              running
                ? `Queue a follow-up for ${projectName}…`
                : `Message Claude in ${projectName}…`
            }
            className="max-h-40 min-h-[2.25rem] w-full resize-none bg-transparent px-2 py-1.5 text-[13.5px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:outline-none disabled:opacity-50"
          />
          {/* While a turn runs the composer stays live: Send QUEUES the follow-up
              (it runs as its own turn when the current one ends), and a separate
              Stop interrupts the in-flight turn. */}
          {running ? (
            <>
              <IconButton
                onClick={send}
                disabled={!draft.trim()}
                title="Queue this follow-up (Enter) — runs when the current turn ends"
                className="h-9 w-9 bg-clay-500/80 text-white hover:bg-clay-600 hover:text-white disabled:bg-zinc-800 disabled:text-zinc-600"
              >
                <ListPlus className="h-4 w-4" />
              </IconButton>
              <IconButton
                onClick={stop}
                title="Stop (interrupt)"
                className="h-9 w-9 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 hover:text-white"
              >
                <Square className="h-4 w-4 fill-current" />
              </IconButton>
            </>
          ) : (
            <IconButton
              onClick={send}
              disabled={!draft.trim()}
              title="Send (Enter)"
              className="h-9 w-9 bg-clay-500 text-white hover:bg-clay-600 hover:text-white disabled:bg-zinc-800 disabled:text-zinc-600"
            >
              <Send className="h-4 w-4" />
            </IconButton>
          )}
        </div>
      </div>

      {/* Prompt-template (snippet) library overlay. Opened from the composer's
          snippet button; inserts a chosen template (placeholders filled) into the
          draft via insertSnippet. */}
      <SnippetLibrary
        open={snippetsOpen}
        onClose={() => setSnippetsOpen(false)}
        onInsert={insertSnippet}
      />
    </div>
    </CwdProvider>
  );
}

/**
 * One pending follow-up in the queue, rendered as a dimmed "queue" bubble below
 * the live stream. Mirrors MessageView's "queue" role styling (amber accent +
 * ListPlus) so a queued prompt reads as a first-class, not-yet-sent turn. Shows
 * its position ("next" for the head) and a cancel affordance.
 */
function QueuedBubble({
  index,
  prompt,
  onCancel,
}: {
  index: number;
  prompt: string;
  onCancel: () => void;
}) {
  return (
    <div className="group flex gap-3 border-b border-zinc-900/70 px-4 py-2.5 opacity-70">
      <div className="mt-1 w-0.5 shrink-0 rounded-full bg-amber-800" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs font-semibold text-amber-400">queued</span>
          <ListPlus className="h-3 w-3 text-amber-500" />
          <span className="text-[10px] text-zinc-600">
            {index === 0 ? "next" : `#${index + 1} in queue`}
          </span>
          <button
            onClick={onCancel}
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-zinc-500 opacity-0 transition hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100"
            title="Cancel this queued message"
          >
            <X className="h-3 w-3" />
            Cancel
          </button>
        </div>
        <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-zinc-300">
          {prompt}
        </div>
      </div>
    </div>
  );
}
