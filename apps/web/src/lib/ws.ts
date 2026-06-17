import type { ClientMsg, ServerMsg, TurnResult, SessionInit } from "@claude-ui/engine/driver";
import type { NormalizedMessage } from "@claude-ui/engine/types";

export interface ChatHandlers {
  onMessage?: (m: NormalizedMessage) => void;
  onSession?: (sessionId: string, init: SessionInit) => void;
  /** Token-by-token partial assistant text streamed during a turn. */
  onDelta?: (text: string) => void;
  onStatus?: (kind: string) => void;
  onResult?: (result: TurnResult) => void;
  onError?: (message: string) => void;
  onTurnEnd?: () => void;
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

  ws.onopen = () => {
    for (const raw of queue.splice(0)) ws.send(raw);
    handlers.onOpen?.();
  };

  ws.onclose = () => {
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
    switch (msg.t) {
      case "session":
        handlers.onSession?.(msg.sessionId, msg.init);
        break;
      case "message":
        handlers.onMessage?.(msg.message);
        break;
      case "delta":
        handlers.onDelta?.(msg.text);
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
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
  };
}
