import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MessageSquarePlus, RotateCcw, Send, Square, Sparkles } from "lucide-react";
import { formatUsd } from "../lib/format";
import { PERMISSION_MODES, type PermissionMode } from "@claude-ui/engine/driver";
import type { TurnResult } from "@claude-ui/engine/driver";
import type { NormalizedMessage } from "../lib/types";
import { openChat, type ChatConn } from "../lib/ws";
import { cn } from "../lib/utils";
import { indexToolResults, pairMessage } from "../lib/transcript";
import { useDraft } from "../hooks/useDraft";
import { MessageView } from "./MessageView";
import { PermissionCard, type PendingPermission } from "./PermissionCard";
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
  // Tracks whether the user is parked at the bottom; auto-scroll only follows
  // new content when they haven't scrolled up to read history.
  const stickToBottomRef = useRef(true);

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

  // Forward the user's Allow/Deny decision to the agent and dismiss the card.
  // Never auto-decides: only fires from an explicit button press in PermissionCard.
  const respondPermission = useCallback((id: string, decision: "allow" | "deny") => {
    connRef.current?.send({ t: "permission-response", id, decision });
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
      stickToBottomRef.current = true;
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
    [push, ensureConn, cwd, sessionId, model, permissionMode],
  );

  const send = useCallback(() => {
    const prompt = draft.trim();
    if (!prompt || running) return;
    clearDraft();
    runPrompt(prompt, true);
  }, [draft, running, clearDraft, runPrompt]);

  // Resend the last user prompt (resuming the session) to get a fresh response.
  // Reuses the prompt already in the transcript, so it doesn't echo a duplicate
  // user bubble.
  const regenerate = useCallback(() => {
    const prompt = lastPromptRef.current?.trim();
    if (!prompt || running) return;
    runPrompt(prompt, false);
  }, [running, runPrompt]);

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
    stickToBottomRef.current = true;
    setItems([]);
    setSessionId(undefined);
    setRunning(false);
    setStatus(null);
    setLastResult(null);
    setErrorMsg(null);
    setPendingPermission(null);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
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

  // Note whether the user is pinned to the bottom; if they scroll up to read
  // older messages we stop auto-following so we don't yank them back down.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < 64;
  }, []);

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
    if (lastIndex < 0 || !stickToBottomRef.current) return;
    const id = requestAnimationFrame(() =>
      virtualizer.scrollToIndex(lastIndex, { align: "end" }),
    );
    return () => cancelAnimationFrame(id);
  }, [lastIndex, running, liveKey, liveLen, virtualizer]);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-zinc-950">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 px-5 py-2.5">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold text-zinc-100">{projectName}</h1>
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
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
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
                  <MessageView m={it.message} streaming={running && it.key === liveKey} />
                </div>
              );
            })}
          </div>
        )}
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
        <div className="flex items-end gap-2 rounded-xl bg-zinc-900 p-2 ring-1 ring-zinc-800 focus-within:ring-clay-500/40">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
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
