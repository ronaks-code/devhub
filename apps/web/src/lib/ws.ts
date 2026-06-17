import type { ClientMsg, ServerMsg, TurnResult, SessionInit } from "@claude-ui/engine/driver";
import type { NormalizedMessage } from "@claude-ui/engine/types";
import type { PermissionScope } from "../components/PermissionCard";

/**
 * Client frames we send on the chat socket. This is the engine's `ClientMsg`
 * extended with an optional `scope` on permission-response: the engine union
 * doesn't carry the scope (it's groundwork for the persistent path), and we
 * can't edit that package, so we widen the type at this boundary. The extra field
 * is harmless to a server that ignores it and ready for one that honors it.
 *
 * `updatedInput` (the user-edited tool input from EditableApproval) and the
 * `{t:"thinking-delta"}` ServerMsg below ARE in the engine union now, so they
 * need no shim — we just spell out the full permission-response shape here so the
 * web-only `scope` rides alongside the engine fields.
 */
export type OutgoingMsg =
  | ClientMsg
  | {
      t: "permission-response";
      id: string;
      decision: "allow" | "deny";
      scope?: PermissionScope;
      message?: string;
      // The user's EDITED tool input (from EditableApproval), forwarded on an
      // allow so the persistent path runs the REVISED call instead of the
      // original. Engine-backed (ClientMsg.permission-response carries it); a
      // server that ignores it falls back to the request's original input.
      updatedInput?: unknown;
    }
  // Cancel any prompts the server has queued behind the running turn. Groundwork
  // for the server-side queue: the engine `ClientMsg` union doesn't carry it yet,
  // so we widen it at this boundary (same approach as permission-response's
  // `scope`). A server that doesn't know it can ignore it; ChatPane also drops
  // its local queue, so cancellation works against today's per-turn server too.
  | { t: "clear-queue" };

/**
 * The payload carried by an enriched `{kind:"tokens", data}` status frame: a live
 * snapshot of the in-flight turn's token usage (and, when the server includes it,
 * an estimated cost + a model/context-window hint for a "% of context" read).
 *
 * The engine emits this opaquely (`onStatus`'s `data` is `unknown`), so every
 * field is optional and read defensively via {@link parseTokenStatus}. We accept
 * a few common field spellings (snake_case from the CLI, camelCase from the
 * engine) so whatever the engine/server lane ends up sending still lights up the
 * meter rather than silently no-op'ing.
 */
export interface TokenStatusData {
  /** Tokens sent into the model so far this turn. */
  inputTokens?: number;
  /** Tokens generated so far this turn. */
  outputTokens?: number;
  /** Cache-read tokens (cheap context re-reads), when reported. */
  cacheReadTokens?: number;
  /** Cache-creation tokens, when reported. */
  cacheCreationTokens?: number;
  /** Running estimated USD cost of the turn, when the server computes it. */
  costUsd?: number;
  /** Model id (so the meter can price/scale even if the turn's select changed). */
  model?: string | null;
  /** Total context window size for the model, enabling a "% of context" read. */
  contextWindow?: number;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Defensively parse an enriched `tokens` status `data` payload into a
 * {@link TokenStatusData}. Returns null when it doesn't look like a token
 * snapshot at all, so a non-token status never lights up the meter.
 */
export function parseTokenStatus(data: unknown): TokenStatusData | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const input = num(o.inputTokens) ?? num(o.input_tokens);
  const output = num(o.outputTokens) ?? num(o.output_tokens);
  const cacheRead = num(o.cacheReadTokens) ?? num(o.cache_read_input_tokens) ?? num(o.cacheReadInputTokens);
  const cacheCreate =
    num(o.cacheCreationTokens) ?? num(o.cache_creation_input_tokens) ?? num(o.cacheCreationInputTokens);
  const cost = num(o.costUsd) ?? num(o.cost_usd) ?? num(o.totalCostUsd) ?? num(o.total_cost_usd);
  const ctx = num(o.contextWindow) ?? num(o.context_window) ?? num(o.contextLimit);
  const model = typeof o.model === "string" ? o.model : undefined;
  // Need at least one usable number to be a meaningful snapshot.
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheCreate === undefined &&
    cost === undefined
  ) {
    return null;
  }
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreate,
    costUsd: cost,
    model,
    contextWindow: ctx,
  };
}

/** A pending tool-permission request from the agent (persistent-path only). */
export interface PermissionRequestFrame {
  id: string;
  toolName: string;
  toolInput: unknown;
  suggestions?: string[];
}

export interface ChatHandlers {
  onMessage?: (m: NormalizedMessage) => void;
  onSession?: (sessionId: string, init: SessionInit) => void;
  /** Token-by-token partial assistant text streamed during a turn. */
  onDelta?: (text: string) => void;
  /**
   * Token-by-token partial THINKING (reasoning) text streamed during a turn,
   * from a `{t:"thinking-delta"}` frame. Only emitted on the persistent
   * (stream-json) path; dormant on the default per-turn driver. Coalesced per
   * animation frame like text deltas so it never thrashes React renders.
   */
  onThinkingDelta?: (text: string) => void;
  /**
   * A turn status update. `kind` is the phase ("starting" | "working" | …); the
   * persistent path also emits enriched statuses like `{kind:"tokens", data}`
   * carrying a live token/cost snapshot. The engine WS `status` frame is typed
   * `{t:"status"; kind}` (no `data`), so we widen the parse at this boundary and
   * pass any `data` through — see {@link StatusData} for the `tokens` shape.
   */
  onStatus?: (kind: string, data?: unknown) => void;
  onResult?: (result: TurnResult) => void;
  onError?: (message: string) => void;
  onTurnEnd?: () => void;
  /**
   * The agent asks the user to approve/deny one tool call. Only fired on the
   * persistent (stream-json) session path; dormant on the default per-turn
   * driver. Answer with {t:"permission-response"} via the returned conn.send.
   */
  onPermissionRequest?: (req: PermissionRequestFrame) => void;
  onOpen?: () => void;
  onClose?: () => void;
  /**
   * Connection liveness for a subtle UI hint. "open" once the socket is up,
   * "reconnecting" while a backoff retry is pending after an unexpected drop.
   * Distinct from onOpen/onClose (which still fire) so the pane can show a
   * "reconnecting…" pill without conflating it with a turn ending.
   */
  onConnectionState?: (state: ConnectionState) => void;
}

export type ConnectionState = "open" | "reconnecting";

export interface ChatConn {
  send: (msg: OutgoingMsg) => void;
  close: () => void;
}

// Exponential backoff: 0.5s, 1s, 2s, 4s … capped at 15s, with jitter to avoid a
// thundering herd of synchronized retries.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

/**
 * Opens the live-session WebSocket (same-origin; Vite dev proxy upgrades it).
 * Queues sends until the socket is OPEN, then flushes. Incoming frames are
 * JSON-parsed as ServerMsg and dispatched to the matching handler.
 */
export function openChat(handlers: ChatHandlers): ChatConn {
  const url =
    (location.protocol === "https:" ? "wss:" : "ws:") +
    "//" +
    location.host +
    "/api/ws/session";

  // Frames typed before the socket is OPEN. We only ever push frames here that
  // haven't been sent on the wire, so a reconnect flush can never duplicate an
  // already-delivered prompt. Resume itself is handled by ChatPane: it re-sends
  // the live sessionId on the NEXT prompt, so the new socket continues the same
  // CLI session rather than starting a fresh one.
  const queue: string[] = [];
  // The current live socket. Swapped out on each reconnect; null while a backoff
  // retry is pending (sends buffer into `queue` meanwhile).
  let ws: WebSocket | null = null;
  // Set once the caller calls close(): stops all reconnect attempts for good.
  let closed = false;
  let attempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Coalesce the fast {t:"delta"} / {t:"thinking-delta"} token streams:
  // accumulate chunks and flush the concatenated text once per animation frame,
  // so we call onDelta/onThinkingDelta a few times per frame instead of once per
  // token (which would thrash React renders). The two streams share one rAF tick
  // but keep separate buffers so text and thinking never bleed into each other.
  let deltaBuf = "";
  let thinkingBuf = "";
  let rafId: number | null = null;
  const canRaf =
    typeof window !== "undefined" && typeof window.requestAnimationFrame === "function";

  const flushDeltas = () => {
    if (rafId != null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    // Flush thinking BEFORE text: a turn streams thinking first, then the visible
    // answer, so emitting in that order keeps the handler sequence wire-faithful.
    if (thinkingBuf.length > 0) {
      const t = thinkingBuf;
      thinkingBuf = "";
      handlers.onThinkingDelta?.(t);
    }
    if (deltaBuf.length === 0) return;
    const text = deltaBuf;
    deltaBuf = "";
    handlers.onDelta?.(text);
  };

  const scheduleFlush = () => {
    if (!canRaf) {
      // No rAF available (e.g. SSR/tests): flush synchronously, preserving order.
      flushDeltas();
      return;
    }
    if (rafId != null) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = null;
      flushDeltas();
    });
  };

  const onWsMessage = (ev: MessageEvent) => {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(ev.data as string) as ServerMsg;
    } catch {
      return; // ignore malformed frames
    }
    // Any non-streaming frame must observe the full streamed text/thinking first:
    // flush the buffers synchronously so e.g. a final "message" sees the live
    // bubble the deltas built up, keeping handler ordering identical to the wire
    // order. Both delta and thinking-delta are streaming frames, so neither flushes.
    if (msg.t !== "delta" && msg.t !== "thinking-delta") flushDeltas();
    switch (msg.t) {
      case "session":
        handlers.onSession?.(msg.sessionId, msg.init);
        break;
      case "message":
        handlers.onMessage?.(msg.message);
        break;
      case "delta":
        deltaBuf += msg.text;
        scheduleFlush();
        break;
      case "thinking-delta":
        thinkingBuf += msg.text;
        scheduleFlush();
        break;
      case "status":
        // The engine WS type is `{t:"status"; kind}` (no data), but the
        // persistent path emits enriched statuses (e.g. `{kind:"tokens", data}`).
        // Read `data` off the parsed frame defensively so a live token meter can
        // consume it; a plain status simply passes `undefined`.
        handlers.onStatus?.(msg.kind, (msg as { data?: unknown }).data);
        break;
      case "result":
        handlers.onResult?.(msg.result);
        break;
      case "error":
        handlers.onError?.(msg.message);
        break;
      case "turn-end":
        handlers.onTurnEnd?.();
        break;
      case "permission-request":
        handlers.onPermissionRequest?.({
          id: msg.id,
          toolName: msg.toolName,
          toolInput: msg.toolInput,
          suggestions: msg.suggestions,
        });
        break;
    }
  };

  // Schedule a reconnect after an unexpected drop, with exponential backoff +
  // jitter. Surfaces "reconnecting" so the pane can show a subtle hint.
  const scheduleReconnect = () => {
    if (closed || reconnectTimer != null) return;
    handlers.onConnectionState?.("reconnecting");
    const delay =
      Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS) *
      (0.5 + Math.random() * 0.5);
    attempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!closed) connect();
    }, delay);
  };

  function connect() {
    if (closed) return;
    const socket = new WebSocket(url);
    ws = socket;

    socket.onopen = () => {
      attempts = 0; // reset backoff on a healthy connection
      // Flush only genuinely-unsent frames (never re-send delivered prompts).
      for (const raw of queue.splice(0)) socket.send(raw);
      handlers.onConnectionState?.("open");
      handlers.onOpen?.();
    };

    socket.onclose = () => {
      // Emit any buffered remainder before reacting, preserving order. A new
      // socket starts with an empty deltaBuf, so deltas are never duplicated.
      flushDeltas();
      handlers.onClose?.();
      // Only retry on an UNEXPECTED drop: a caller close() flips `closed` first.
      if (!closed && ws === socket) {
        ws = null;
        scheduleReconnect();
      }
    };

    socket.onerror = () => {
      // Don't surface a hard error on a transient drop — onclose drives the
      // reconnect. Errors only matter to the user when we've given up (closed).
      if (closed) handlers.onError?.("WebSocket connection error");
    };

    socket.onmessage = onWsMessage;
  }

  connect();

  return {
    send(msg: OutgoingMsg) {
      if (closed) return;
      const raw = JSON.stringify(msg);
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(raw);
      else queue.push(raw); // flushed on (re)connect — order preserved
    },
    close() {
      closed = true;
      queue.length = 0;
      if (reconnectTimer != null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      // Cancel any pending frame; flush the remainder so no streamed text is lost.
      if (rafId != null && canRaf) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      flushDeltas();
      try {
        ws?.close();
      } catch {
        /* already closing */
      }
      ws = null;
    },
  };
}
