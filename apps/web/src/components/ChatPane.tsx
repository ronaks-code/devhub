import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, MessageSquarePlus, Pencil, RotateCcw, Send, Square, Sparkles, Wifi } from "lucide-react";
import { formatUsd } from "../lib/format";
import { PERMISSION_MODES, type PermissionMode } from "@claude-ui/engine/driver";
import type { TurnResult } from "@claude-ui/engine/driver";
import type { NormalizedMessage } from "../lib/types";
import { openChat, type ChatConn } from "../lib/ws";
import { cn } from "../lib/utils";
import { indexToolResults, pairMessage } from "../lib/transcript";
import { useDraft } from "../hooks/useDraft";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { MessageView } from "./MessageView";
import { PermissionCard, type PendingPermission, type PermissionDecision } from "./PermissionCard";
import { usePromptHistory } from "../hooks/usePromptHistory";
import { EmptyState, IconButton, Spinner } from "./ui";

const MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
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

export function ChatPane({
  cwd,
  projectId,
  projectName,
  initialSessionId,
  defaultModel,
  defaultPermissionMode,
  model: controlledModel,
  onModelChange,
}: {
  cwd: string;
  /** Stable project id, used to scope the persisted composer draft. */
  projectId: string;
  projectName: string;
  /** Seed to resume an existing CLI session (--resume) on the first prompt. */
  initialSessionId?: string;
  /** Preferred model from settings; falls back to the built-in default. */
  defaultModel?: string;
  /** Preferred permission mode from settings; falls back to the built-in default. */
  defaultPermissionMode?: PermissionMode;
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
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Composer text persisted per (projectId | sessionId) so an unsent message
  // survives tab switches and reloads. Scopes by the live sessionId once a turn
  // assigns one, falling back to the resume seed before the first prompt.
  const { draft, setDraft, clearDraft } = useDraft(projectId, sessionId ?? initialSessionId);
  // Shell-style Up/Down recall of previously sent prompts, persisted per project.
  const history = usePromptHistory(projectId);
  // Model can be controlled by the parent (command palette) or local. When the
  // parent passes a value we defer to it; otherwise we own it here.
  const [localModel, setLocalModel] = useState<string>(defaultModel ?? DEFAULT_MODEL);
  const model = controlledModel ?? localModel;
  const setModel = (m: string) => {
    setLocalModel(m);
    onModelChange?.(m);
  };
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    defaultPermissionMode ?? DEFAULT_PERMISSION,
  );
  // Key of the assistant bubble currently receiving deltas (null = none in flight).
  const [liveKey, setLiveKey] = useState<number | null>(null);
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
  // The most recent user prompt of this conversation, so "Regenerate" can resend
  // it (resuming the session) for a fresh response.
  const lastPromptRef = useRef<string | null>(null);

  const connRef = useRef<ChatConn | null>(null);
  const keyRef = useRef(0);
  const liveKeyRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // True between an unexpected drop and the subsequent reconnect, so the
  // reconnect handler knows to clear the (now-dead) in-flight turn state.
  const reconnectedRef = useRef(false);
  // Auto-scroll only follows new content while the user is parked at the bottom;
  // if they scroll up to read history we stop and show a "jump to latest" pill.
  const stick = useStickToBottom(scrollRef);

  const nextKey = () => ++keyRef.current;

  const push = useCallback((message: NormalizedMessage) => {
    setItems((prev) => [...prev, { key: nextKey(), message }]);
  }, []);

  // Append streamed text to the in-flight assistant bubble, creating it on the
  // first delta of a turn.
  const appendDelta = useCallback((text: string) => {
    if (liveKeyRef.current == null) {
      // First delta of a turn: spin up a fresh live assistant bubble.
      const key = nextKey();
      liveKeyRef.current = key;
      setLiveKey(key);
      const live: NormalizedMessage = {
        seq: -1,
        uuid: null,
        parentUuid: null,
        role: "assistant",
        type: "assistant",
        timestamp: new Date().toISOString(),
        blocks: [{ type: "text", text }],
      };
      setItems((prev) => [...prev, { key, message: live }]);
      return;
    }
    const liveKey = liveKeyRef.current;
    setItems((prev) =>
      prev.map((it) => {
        if (it.key !== liveKey) return it;
        const blocks = [...it.message.blocks];
        const last = blocks[blocks.length - 1];
        if (last && last.type === "text") {
          blocks[blocks.length - 1] = { type: "text", text: last.text + text };
        } else {
          blocks.push({ type: "text", text });
        }
        return { ...it, message: { ...it.message, blocks } };
      }),
    );
  }, []);

  // The full assistant message arrived: replace/finalize the live bubble so we
  // don't duplicate the streamed text, then clear the live pointer.
  const finalizeMessage = useCallback(
    (message: NormalizedMessage) => {
      const liveKey = liveKeyRef.current;
      if (message.role === "assistant" && liveKey != null) {
        liveKeyRef.current = null;
        setLiveKey(null);
        setItems((prev) => prev.map((it) => (it.key === liveKey ? { ...it, message } : it)));
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
      onSession: (id) => setSessionId(id),
      onDelta: (text) => appendDelta(text),
      onMessage: (m) => finalizeMessage(m),
      onStatus: (kind) => setStatus(kind),
      onResult: (result) => setLastResult(result),
      onPermissionRequest: (req) => setPendingPermission(req),
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
          setPendingPermission(null);
          liveKeyRef.current = null;
          setLiveKey(null);
        }
      },
      onError: (message) => {
        setErrorMsg(message);
        setRunning(false);
        setStatus(null);
        setPendingPermission(null);
        liveKeyRef.current = null;
        setLiveKey(null);
      },
      onTurnEnd: () => {
        setRunning(false);
        setStatus(null);
        setPendingPermission(null);
        liveKeyRef.current = null;
        setLiveKey(null);
      },
    });
    connRef.current = conn;
    return conn;
  }, [appendDelta, finalizeMessage]);

  // Forward the user's Allow/Deny decision (with its scope) to the agent and
  // dismiss the card. Never auto-decides: only fires from an explicit button
  // press in PermissionCard. Scope is dormant on the per-turn driver but rides
  // along in the payload so the persistent path can honor it later.
  const respondPermission = useCallback((id: string, { decision, scope }: PermissionDecision) => {
    connRef.current?.send({ t: "permission-response", id, decision, scope });
    setPendingPermission((cur) => (cur && cur.id === id ? null : cur));
  }, []);

  useEffect(() => {
    return () => {
      connRef.current?.close();
      connRef.current = null;
    };
  }, []);

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
      setLastResult(null);
      setPendingPermission(null);
      setStatus("starting");
      setRunning(true);
      liveKeyRef.current = null;
      setLiveKey(null);

      const conn = ensureConn();
      conn.send({ t: "prompt", cwd, prompt, sessionId, model, permissionMode });
    },
    [push, ensureConn, cwd, sessionId, model, permissionMode, stick.pin],
  );

  const send = useCallback(() => {
    const prompt = draft.trim();
    if (!prompt || running) return;
    history.add(prompt);
    clearDraft();
    setEditingFork(false);
    runPrompt(prompt, true);
  }, [draft, running, clearDraft, runPrompt, history]);

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
  }, []);

  const newChat = useCallback(() => {
    connRef.current?.close();
    connRef.current = null;
    keyRef.current = 0;
    liveKeyRef.current = null;
    lastPromptRef.current = null;
    setLiveKey(null);
    stick.pin();
    setItems([]);
    setSessionId(undefined);
    setRunning(false);
    setStatus(null);
    setLastResult(null);
    setErrorMsg(null);
    setPendingPermission(null);
    setEditingFork(false);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

  // Follow the newest message as the list grows, deltas stream into the live
  // bubble, or a turn ends — but only while the user is parked at the bottom.
  // liveLen captures the streamed text length so each delta re-triggers the
  // scroll (deltas mutate the live bubble in place, not the list length).
  const lastIndex = view.length - 1;
  const liveLen =
    liveKey == null
      ? 0
      : (view[lastIndex]?.message.blocks ?? []).reduce(
          (n, b) => n + (b.type === "text" ? b.text.length : 0),
          0,
        );
  useEffect(() => {
    if (lastIndex < 0) return;
    return stick.followToIndex(() =>
      virtualizer.scrollToIndex(lastIndex, { align: "end" }),
    );
  }, [lastIndex, running, liveKey, liveLen, virtualizer, stick.followToIndex]);

  return (
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

        <button
          onClick={newChat}
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] font-medium text-zinc-300 ring-1 ring-zinc-800 transition hover:bg-zinc-800 hover:text-zinc-100"
          title="Start a fresh conversation"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          New chat
        </button>
      </div>

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
                    streaming={running && it.key === liveKey}
                    onEdit={!running ? editFromMessage : undefined}
                  />
                </div>
              );
            })}
          </div>
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
          default per-turn driver). Answered via a permission-response send. */}
      {pendingPermission && (
        <PermissionCard request={pendingPermission} onDecision={respondPermission} />
      )}

      {/* Status / result footer */}
      {(running || lastResult || errorMsg || (!running && lastPromptRef.current)) && (
        <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800/80 bg-zinc-900/30 px-5 py-1.5 text-[11px]">
          {running && (
            <span className="flex items-center gap-1.5 text-clay-300">
              <Spinner className="h-3 w-3" />
              {status ?? "working"}
            </span>
          )}
          {!running && lastResult && (
            <span className="flex items-center gap-2 text-zinc-500">
              <span className={cn(lastResult.isError && "text-red-400")}>
                {formatUsd(lastResult.costUsd)}
              </span>
              {lastResult.denials.length > 0 && (
                <span className="text-amber-400">
                  {lastResult.denials.length} denial{lastResult.denials.length === 1 ? "" : "s"}
                </span>
              )}
            </span>
          )}
          {errorMsg && <span className="text-red-400">{errorMsg}</span>}
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
        <div className="flex items-end gap-2 rounded-xl bg-zinc-900 p-2 ring-1 ring-zinc-800 focus-within:ring-clay-500/40">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => {
              // A manual edit abandons history navigation (we're back on a live line).
              if (history.navigating) history.reset();
              setDraft(e.target.value);
            }}
            onKeyDown={onKeyDown}
            disabled={running}
            rows={1}
            placeholder={running ? "Claude is working…" : `Message Claude in ${projectName}…`}
            className="max-h-40 min-h-[2.25rem] w-full resize-none bg-transparent px-2 py-1.5 text-[13.5px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:outline-none disabled:opacity-50"
          />
          {running ? (
            <IconButton
              onClick={stop}
              title="Stop (interrupt)"
              className="h-9 w-9 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 hover:text-white"
            >
              <Square className="h-4 w-4 fill-current" />
            </IconButton>
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
    </div>
  );
}
