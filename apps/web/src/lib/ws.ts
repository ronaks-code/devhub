import type { ClientMsg, ServerMsg, TurnResult, SessionInit } from "@claude-ui/engine/driver";
import type { NormalizedMessage } from "@claude-ui/engine/types";

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
  onStatus?: (kind: string) => void;
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
}

export interface ChatConn {
  send: (msg: ClientMsg) => void;
  close: () => void;
}

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

  const ws = new WebSocket(url);
  const queue: string[] = [];
  let closed = false;

  // Coalesce a fast {t:"delta"} token stream: accumulate chunks and flush the
  // concatenated text once per animation frame, so we call onDelta a few times
  // per frame instead of once per token (which would thrash React renders).
  let deltaBuf = "";
  let rafId: number | null = null;
  const canRaf =
    typeof window !== "undefined" && typeof window.requestAnimationFrame === "function";

  const flushDeltas = () => {
    if (rafId != null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
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

  ws.onopen = () => {
    for (const raw of queue.splice(0)) ws.send(raw);
    handlers.onOpen?.();
  };

  ws.onclose = () => {
    // Emit any buffered remainder before signalling close, preserving order.
    flushDeltas();
    handlers.onClose?.();
  };

  ws.onerror = () => {
    handlers.onError?.("WebSocket connection error");
  };

  ws.onmessage = (ev) => {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(ev.data as string) as ServerMsg;
    } catch {
      return; // ignore malformed frames
    }
    // Any non-delta frame must observe the full streamed text first: flush the
    // buffer synchronously so e.g. a final "message" sees the live bubble that
    // the deltas built up, keeping handler ordering identical to the wire order.
    if (msg.t !== "delta") flushDeltas();
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
      case "status":
        handlers.onStatus?.(msg.kind);
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

  return {
    send(msg: ClientMsg) {
      if (closed) return;
      const raw = JSON.stringify(msg);
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
      else queue.push(raw);
    },
    close() {
      closed = true;
      queue.length = 0;
      // Cancel any pending frame; flush the remainder so no streamed text is lost.
      if (rafId != null && canRaf) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      flushDeltas();
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
  };
}
