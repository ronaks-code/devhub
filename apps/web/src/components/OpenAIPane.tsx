import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  MessageSquarePlus,
  Send,
  Square,
  Sparkles,
  Terminal,
} from "lucide-react";
import { cn } from "../lib/utils";
import { openaiApi } from "../lib/api";
import { getToken } from "../lib/api";
import { Markdown } from "./Markdown";
import { EmptyState, IconButton, Spinner } from "./ui";

// ---------------------------------------------------------------------------
// Model catalogue
// ---------------------------------------------------------------------------

const OPENAI_MODELS = [
  // Current lineup (GPT-5.6 family, 2026-07-09): Sol (default), Terra, Luna.
  "gpt-5.6",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  // Retained so stored sessions on prior models still resolve.
  "gpt-5.4-mini",
  "gpt-5.4",
  "gpt-4.1",
  "gpt-4.1-mini",
  "o3",
  "o4-mini",
] as const;

type OpenAIModel = (typeof OPENAI_MODELS)[number];
const DEFAULT_MODEL: OpenAIModel = "gpt-5.6";

export const OPENAI_CHAT_TITLE = "OpenAI Chat — development only";
export const OPENAI_CHAT_WARNING =
  "Chat-only experiment. This is not Codex. Local tools are disabled.";
export const OPENAI_CHAT_EMPTY_HINT =
  "Pick a model and type a message. Enter to send, Shift+Enter for a new line.";
// User-facing copy only (W3-SHELL): the env-var/Bearer setup instructions this used
// to surface belong in server docs, not in-product. Says WHAT the state means for
// the user, not HOW an operator flips it.
export const OPENAI_CHAT_DISABLED_EXPLANATION =
  "This experimental chat is turned off by default. If messages fail to send, whoever runs your DevHub server hasn't enabled it.";

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

interface UserMsg {
  role: "user";
  text: string;
  id: number;
}

interface AssistantMsg {
  role: "assistant";
  text: string;
  id: number;
}

interface ToolCall {
  id: number;
  toolName: string;
  input?: string;
  output?: string;
  done: boolean;
}

type ChatMsg = UserMsg | AssistantMsg;

// ---------------------------------------------------------------------------
// Tool call card — collapsible, shows running state then result
// ---------------------------------------------------------------------------

function ToolCallCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-zinc-400 transition hover:bg-zinc-800/40"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform",
            open && "rotate-90",
          )}
        />
        <Terminal className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
        <span className="text-zinc-300">
          {call.done ? "Ran:" : "Running:"}{" "}
          <span className="font-mono text-[11px] text-emerald-300">{call.toolName}</span>
        </span>
        {!call.done && (
          <Spinner className="ml-1 h-3 w-3 border-zinc-600 border-t-emerald-400" />
        )}
        <span className="ml-auto shrink-0 text-[10.5px] text-zinc-600">
          {open ? "collapse" : "expand"}
        </span>
      </button>
      {open && (
        <div className="border-t border-zinc-800/60 px-3 py-2 space-y-2">
          {call.input ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
                Input
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-zinc-950/60 px-2 py-1.5 text-[11.5px] leading-relaxed text-zinc-300">
                {call.input}
              </pre>
            </div>
          ) : null}
          {call.output ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
                Output
              </div>
              <pre className="max-h-48 overflow-y-auto overflow-x-auto whitespace-pre-wrap break-all rounded bg-zinc-950/60 px-2 py-1.5 text-[11.5px] leading-relaxed text-zinc-300">
                {call.output}
              </pre>
            </div>
          ) : !call.done ? (
            <div className="text-[11px] text-zinc-600 italic">waiting for result…</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual message bubbles
// ---------------------------------------------------------------------------

function UserBubble({ msg }: { msg: UserMsg }) {
  return (
    <div className="flex justify-end px-4 py-2.5">
      <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-emerald-600/20 px-3.5 py-2.5 ring-1 ring-emerald-500/20">
        <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-zinc-100">
          {msg.text}
        </p>
      </div>
    </div>
  );
}

function AssistantBubble({ msg }: { msg: AssistantMsg }) {
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 ring-1 ring-emerald-500/30">
          <Sparkles className="h-3 w-3 text-emerald-300" />
        </div>
        <div className="min-w-0 flex-1">
          <Markdown
            text={msg.text}
            className="text-[13.5px] leading-relaxed text-zinc-200"
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Typing cursor while streaming
// ---------------------------------------------------------------------------

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 ring-1 ring-emerald-500/30">
          <Sparkles className="h-3 w-3 text-emerald-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-zinc-200">
            {text || <span className="text-zinc-600">thinking…</span>}
            <span className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse rounded-full bg-emerald-400 align-middle" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WebSocket connection for OpenAI sessions
// ---------------------------------------------------------------------------

interface OpenAIHandlers {
  onToken: (text: string) => void;
  onToolStart: (id: string, toolName: string, input?: string) => void;
  onToolEnd: (id: string, output: string) => void;
  onTurnDone: () => void;
  onError: (msg: string) => void;
}

interface OpenAIConn {
  send: (payload: { type: "send"; text: string }) => void;
  stop: () => void;
  close: () => void;
}

export function openOpenAIChat(
  sessionId: string,
  handlers: OpenAIHandlers,
): OpenAIConn {
  const token = getToken();
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${wsProto}//${location.host}/api/ws/openai/${encodeURIComponent(sessionId)}`;

  const queue: string[] = [];
  let ws: WebSocket | null = null;
  let closed = false;

  function connect() {
    if (closed) return;
    const socket = new WebSocket(url);
    ws = socket;

    socket.onopen = () => {
      if (!token) {
        closed = true;
        queue.length = 0;
        handlers.onError("OpenAI Chat requires access token authentication.");
        socket.close();
        return;
      }
      socket.send(JSON.stringify({ type: "authenticate", token }));
      for (const raw of queue.splice(0)) socket.send(raw);
    };

    socket.onmessage = (ev) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(ev.data as string) as Record<string, unknown>;
      } catch {
        return;
      }

      const type = frame.type as string | undefined;
      switch (type) {
        case "token":
          handlers.onToken((frame.token as string | undefined) ?? "");
          break;
        case "tool_start":
          handlers.onToolStart(
            (frame.id as string | undefined) ?? "",
            (frame.name as string | undefined) ?? "tool",
            (frame.args as string | undefined) ?? undefined,
          );
          break;
        case "tool_end":
          handlers.onToolEnd(
            (frame.id as string | undefined) ?? "",
            (frame.result as string | undefined) ?? "",
          );
          break;
        case "turn_done":
          handlers.onTurnDone();
          break;
        case "error":
          handlers.onError((frame.message as string | undefined) ?? "Unknown error");
          break;
        default:
          break;
      }
    };

    socket.onclose = () => {
      if (!closed && ws === socket) {
        ws = null;
        handlers.onError("OpenAI Chat connection closed.");
      }
    };

    socket.onerror = () => {
      if (!closed) handlers.onError("WebSocket connection error");
    };
  }

  connect();

  return {
    send(payload) {
      if (closed) return;
      const raw = JSON.stringify(payload);
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(raw);
      else queue.push(raw);
    },
    stop() {
      if (closed) return;
      queue.length = 0;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "stop" }));
      }
    },
    close() {
      if (closed) return;
      queue.length = 0;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "stop" }));
      }
      closed = true;
      try { ws?.close(); } catch { /* already closing */ }
      ws = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function OpenAIPane() {
  // Detect the user's home directory heuristic — browser can't read env, so
  // we seed with a likely path. The user can edit it in the CWD input.
  const [cwd, setCwd] = useState(() => {
    // Try to derive from a known project path in localStorage, else fall back.
    try {
      const stored = window.localStorage.getItem("openai-pane-cwd");
      if (stored) return stored;
    } catch { /* ignore */ }
    return "/tmp";
  });
  const [cwdEditing, setCwdEditing] = useState(false);
  const [cwdDraft, setCwdDraft] = useState(cwd);

  const [model, setModel] = useState<OpenAIModel>(DEFAULT_MODEL);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [running, setRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);

  const connRef = useRef<OpenAIConn | null>(null);
  const streamBufRef = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const msgIdRef = useRef(0);
  const toolIdRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  // Stick to bottom while streaming
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Flush streaming buffer on rAF so individual token appends don't cause per-
  // token re-renders of the entire component.
  const flushStream = useCallback(() => {
    rafRef.current = null;
    const text = streamBufRef.current;
    setStreamText(text);
    scrollToBottom();
  }, [scrollToBottom]);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(flushStream);
  }, [flushStream]);

  // Persist CWD
  const commitCwd = useCallback((val: string) => {
    setCwd(val);
    setCwdEditing(false);
    try { window.localStorage.setItem("openai-pane-cwd", val); } catch { /* ignore */ }
  }, []);

  // Create a new OpenAI session via POST /api/openai/sessions
  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionId) return sessionId;
    setSessionLoading(true);
    try {
      const created = await openaiApi.createSession({ model, cwd });
      setSessionId(created.sessionId);
      setSessionLoading(false);
      return created.sessionId;
    } catch (err) {
      setSessionLoading(false);
      throw err;
    }
  }, [sessionId, model, cwd]);

  // Lazily open (or reuse) the WebSocket for a given session
  const ensureConn = useCallback((sid: string): OpenAIConn => {
    if (connRef.current) return connRef.current;

    const conn = openOpenAIChat(sid, {
      onToken(text) {
        streamBufRef.current += text;
        scheduleFlush();
      },
      onToolStart(id, toolName, input) {
        setToolCalls((prev) => [
          ...prev,
          { id: ++toolIdRef.current, toolName, input, output: undefined, done: false },
        ]);
        scrollToBottom();
      },
      onToolEnd(id, output) {
        // Match by toolName suffix of id or just the last pending call
        setToolCalls((prev) =>
          prev.map((tc, i) =>
            i === prev.length - 1 && !tc.done
              ? { ...tc, output, done: true }
              : tc,
          ),
        );
      },
      onTurnDone() {
        // Flush any remaining stream text into a real assistant message
        if (rafRef.current != null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        const finalText = streamBufRef.current;
        streamBufRef.current = "";
        setStreaming(false);
        setStreamText("");
        setRunning(false);
        setErrorMsg(null);
        if (finalText.trim()) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", text: finalText, id: ++msgIdRef.current },
          ]);
        }
        scrollToBottom();
      },
      onError(msg) {
        if (rafRef.current != null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        streamBufRef.current = "";
        setStreaming(false);
        setStreamText("");
        setRunning(false);
        setErrorMsg(msg);
        scrollToBottom();
      },
    });

    connRef.current = conn;
    return conn;
  }, [scheduleFlush, scrollToBottom]);

  // Tear down on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      connRef.current?.close();
      connRef.current = null;
    };
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || running) return;

    setDraft("");
    setErrorMsg(null);
    setRunning(true);
    setStreaming(true);
    streamBufRef.current = "";
    setStreamText("");
    setToolCalls([]);

    // Echo user message immediately
    setMessages((prev) => [
      ...prev,
      { role: "user", text, id: ++msgIdRef.current },
    ]);
    scrollToBottom();

    let sid: string;
    try {
      sid = await ensureSession();
    } catch (err) {
      setRunning(false);
      setStreaming(false);
      setErrorMsg(err instanceof Error ? err.message : "Failed to create session");
      return;
    }

    const conn = ensureConn(sid);
    conn.send({ type: "send", text });
  }, [draft, running, cwd, model, ensureSession, ensureConn, scrollToBottom]);

  const stop = useCallback(() => {
    connRef.current?.stop();
    if (sessionId) {
      void openaiApi.stopSession(sessionId).catch(() => {
        // The authenticated WebSocket stop above is the primary path. A failed
        // REST fallback is reflected by the socket close/error if still active.
      });
    }
    connRef.current?.close();
    connRef.current = null;

    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const finalText = streamBufRef.current;
    streamBufRef.current = "";
    setStreaming(false);
    setStreamText("");
    setRunning(false);

    if (finalText.trim()) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: finalText + "\n\n*(stopped)*",
          id: ++msgIdRef.current,
        },
      ]);
    }
  }, [sessionId]);

  const newSession = useCallback(() => {
    connRef.current?.close();
    connRef.current = null;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamBufRef.current = "";
    msgIdRef.current = 0;
    toolIdRef.current = 0;
    setSessionId(null);
    setMessages([]);
    setToolCalls([]);
    setStreaming(false);
    setStreamText("");
    setRunning(false);
    setErrorMsg(null);
    setDraft("");
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || (!e.shiftKey))) {
      e.preventDefault();
      void send();
    }
  };

  const isEmpty = messages.length === 0 && !streaming;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-zinc-950">
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 px-5 py-2.5">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-[15px] font-semibold text-zinc-100">
            <Sparkles className="h-4 w-4 shrink-0 text-emerald-400" />
            {OPENAI_CHAT_TITLE}
          </h1>
          {/* CWD pill — click to edit */}
          {cwdEditing ? (
            <input
              autoFocus
              value={cwdDraft}
              onChange={(e) => setCwdDraft(e.target.value)}
              onBlur={() => commitCwd(cwdDraft)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitCwd(cwdDraft);
                if (e.key === "Escape") { setCwdEditing(false); setCwdDraft(cwd); }
              }}
              className="mt-0.5 w-full rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
              placeholder="/path/to/cwd"
            />
          ) : (
            <button
              onClick={() => { setCwdDraft(cwd); setCwdEditing(true); }}
              className="truncate text-[11px] text-zinc-600 hover:text-zinc-400 transition"
              title="Click to change working directory"
              dir="rtl"
            >
              {cwd}
            </button>
          )}
        </div>

        {/* Model selector */}
        <select
          value={model}
          onChange={(e) => setModel(e.target.value as OpenAIModel)}
          disabled={running}
          className="rounded-lg bg-zinc-900 px-2 py-1 text-[12px] text-zinc-200 ring-1 ring-zinc-800 focus:outline-none focus:ring-emerald-500/40 disabled:opacity-50"
          title="Model"
        >
          {OPENAI_MODELS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        {/* New session */}
        <button
          onClick={newSession}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] font-medium text-zinc-300 ring-1 ring-zinc-800 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
          title="Start a fresh conversation"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          New session
        </button>
      </div>

      <div
        role="status"
        className="border-b border-amber-900/40 bg-amber-950/20 px-5 py-2 text-[11px] text-amber-200"
      >
        <div>{OPENAI_CHAT_WARNING}</div>
        <div className="mt-0.5 text-amber-300/80">
          {OPENAI_CHAT_DISABLED_EXPLANATION}
        </div>
      </div>

      {/* ── Message stream ───────────────────────────────────────── */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {isEmpty ? (
          <EmptyState
            icon={<Sparkles className="h-12 w-12" />}
            title={OPENAI_CHAT_TITLE}
            hint={OPENAI_CHAT_EMPTY_HINT}
          />
        ) : (
          <div className="pb-4">
            {messages.map((msg, i) => {
              // Render any tool calls that occurred before this assistant message.
              // Tool calls are associated with assistant turns — show them in order.
              const isLast = i === messages.length - 1;
              const showTools = msg.role === "assistant" && isLast;

              return (
                <div key={msg.id} className="border-b border-zinc-900/60 last:border-0">
                  {msg.role === "user" ? (
                    <UserBubble msg={msg} />
                  ) : (
                    <>
                      {/* Tool calls for this turn — shown above the reply */}
                      {showTools &&
                        toolCalls.map((tc) => (
                          <div key={tc.id} className="px-4 pt-2">
                            <ToolCallCard call={tc} />
                          </div>
                        ))}
                      <AssistantBubble msg={msg} />
                    </>
                  )}
                </div>
              );
            })}

            {/* Tool calls for in-flight turn (before first assistant message) */}
            {running && toolCalls.length > 0 && messages[messages.length - 1]?.role !== "assistant" && (
              <div className="border-b border-zinc-900/60">
                {toolCalls.map((tc) => (
                  <div key={tc.id} className="px-4 pt-2">
                    <ToolCallCard call={tc} />
                  </div>
                ))}
              </div>
            )}

            {/* Streaming bubble */}
            {streaming && (
              <div className="border-b border-zinc-900/60">
                <StreamingBubble text={streamText} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Error banner ─────────────────────────────────────────── */}
      {errorMsg && (
        <div className="border-t border-red-900/40 bg-red-950/30 px-4 py-2 text-[12px] text-red-300">
          {errorMsg}
        </div>
      )}

      {/* ── Status bar ───────────────────────────────────────────── */}
      {(running || sessionLoading) && (
        <div className="flex items-center gap-2 border-t border-zinc-800/80 bg-zinc-900/30 px-5 py-1.5 text-[11px]">
          <Spinner className="h-3 w-3" />
          <span className="text-emerald-300">
            {sessionLoading ? "Starting session…" : "Generating…"}
          </span>
        </div>
      )}

      {/* ── Composer ─────────────────────────────────────────────── */}
      <div className="border-t border-zinc-800/80 px-4 py-3">
        <div className="flex items-end gap-2 rounded-xl bg-zinc-900 p-2 ring-1 ring-zinc-800 focus-within:ring-emerald-500/30">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={running ? "Please wait…" : "Message OpenAI…"}
            disabled={running || sessionLoading}
            className="max-h-40 min-h-[2.25rem] w-full resize-none bg-transparent px-2 py-1.5 text-[13.5px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:outline-none disabled:opacity-50"
          />

          {running ? (
            <IconButton
              onClick={stop}
              title="Stop generation"
              aria-label="Stop generation"
              className="h-9 w-9 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 hover:text-white"
            >
              <Square className="h-4 w-4 fill-current" />
            </IconButton>
          ) : (
            <IconButton
              onClick={() => void send()}
              disabled={!draft.trim() || sessionLoading}
              title="Send (Enter)"
              aria-label="Send message"
              className="h-9 w-9 bg-emerald-600 text-white hover:bg-emerald-500 hover:text-white disabled:bg-zinc-800 disabled:text-zinc-600"
            >
              <Send className="h-4 w-4" />
            </IconButton>
          )}
        </div>
        <div className="mt-1.5 text-[10px] text-zinc-700">
          Enter to send · Shift+Enter for new line · Cmd+Enter also sends
        </div>
      </div>
    </div>
  );
}
