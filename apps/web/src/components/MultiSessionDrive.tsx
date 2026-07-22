import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, RadioTower, RefreshCw, Send, Square, Wifi, X } from "lucide-react";
import type { PermissionMode } from "@devhub/engine/driver";
import type { NormalizedMessage } from "@devhub/engine/types";
import type { RunningSession, SessionSummary } from "../lib/types";
import { api, tailSession } from "../lib/api";
import { openChat, type ChatConn } from "../lib/ws";
import { LiveBubble, LiveStream } from "./LiveBubble";
import { Markdown } from "./Markdown";
import { cn } from "../lib/utils";
import { EmptyState, IconButton, Spinner } from "./ui";
import { indexSessions, lastSegment, resolveOpsTitle } from "./features/ops/opsHelpers";

/** How often to re-poll /api/running for the picker (paused while hidden). */
const POLL_MS = 4000;
/** Cap on simultaneously-watched panels — each owns a live ws, so keep it bounded. */
const MAX_PANELS = 6;
/** Permission mode each panel drives turns with (a sensible auto-accept default). */
const PANEL_PERMISSION: PermissionMode = "acceptEdits";

/**
 * Keep only ONE entry per sessionId (first wins — the server already sorts and
 * dedupes, so this is a defensive mirror for older servers). Panels, picker rows,
 * and counts are all keyed by sessionId here, so a duplicated id would produce
 * duplicate React keys, phantom panels, and a count that disagrees with the Ops
 * board. Entries with an empty sessionId aren't identifiable and pass through.
 */
function dedupeBySessionId(sessions: RunningSession[]): RunningSession[] {
  const seen = new Set<string>();
  return sessions.filter((s) => {
    if (!s.sessionId) return true;
    if (seen.has(s.sessionId)) return false;
    seen.add(s.sessionId);
    return true;
  });
}

/** Map a running-session status to a status dot + label color. Mirrors LiveOpsBoard. */
function statusStyle(s: RunningSession): { dot: string; text: string; label: string } {
  if (s.needsYou) return { dot: "bg-amber-400 animate-pulse", text: "text-amber-300", label: "needs you" };
  const status = s.status.toLowerCase();
  if (status === "busy") return { dot: "bg-clay-500 animate-pulse", text: "text-clay-300", label: "busy" };
  if (status === "waiting") return { dot: "bg-amber-400", text: "text-amber-300", label: "waiting" };
  if (status === "idle") return { dot: "bg-zinc-500", text: "text-zinc-400", label: "idle" };
  return { dot: "bg-sky-400", text: "text-sky-300", label: status || "running" };
}

/**
 * One compact live panel bound to a single session, owning its OWN chat
 * WebSocket (via openChat) independent of every other panel. A slim live view —
 * NOT a full ChatPane: it shows the streaming output of the in-flight turn (reusing
 * LiveBubble + LiveStream) and a small composer to send one turn to THIS session,
 * resuming its CLI session via its sessionId so the conversation continues.
 *
 * Deliberately minimal: no tool-pairing, history, mentions, or virtualized
 * transcript — those live in ChatPane. Here we only need to watch the latest output
 * and nudge the session along, several at once.
 */
function SessionPanel({
  session,
  title,
  pollStatus,
  onRemove,
}: {
  session: RunningSession;
  /** Real display title (D2), resolved once by the parent via `resolveOpsTitle` —
   *  the SAME derivation Grid/Board use — so Drive never shows a raw counter. */
  title: string;
  /** Latest polled status for this session (from the grid's /api/running poll). */
  pollStatus: RunningSession | null;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [liveActive, setLiveActive] = useState(false);
  // The latest FINALIZED assistant text, kept as a short preview once a turn ends
  // (the live stream resets on turn-end, so we stash the last answer to display).
  const [lastText, setLastText] = useState<string | null>(null);
  // True once the read-only transcript tail (SSE) is following this session.
  const [watching, setWatching] = useState(false);

  const connRef = useRef<ChatConn | null>(null);
  const liveStreamRef = useRef<LiveStream>(new LiveStream());
  const liveActiveRef = useRef(false);
  // Mirrors `running` for the tail callback (which must not re-subscribe per turn).
  const runningRef = useRef(false);
  // The live CLI session id: seeded from the running session, then updated if the
  // server assigns a (forked) one on the first prompt. Sending it resumes the session.
  const sessionIdRef = useRef<string>(session.sessionId);

  const beginLive = useCallback(() => {
    if (!liveActiveRef.current) {
      liveActiveRef.current = true;
      setLiveActive(true);
    }
  }, []);

  const clearLive = useCallback(() => {
    liveActiveRef.current = false;
    setLiveActive(false);
    liveStreamRef.current.reset();
  }, []);

  // Lazily open this panel's own WebSocket; tear it down on unmount.
  const ensureConn = useCallback((): ChatConn => {
    if (connRef.current) return connRef.current;
    const conn = openChat({
      onSession: (id) => {
        sessionIdRef.current = id;
      },
      onDelta: (text) => {
        beginLive();
        liveStreamRef.current.append(text);
      },
      onThinkingDelta: (text) => {
        beginLive();
        liveStreamRef.current.appendThinking(text);
      },
      onMessage: (m) => {
        // Stash the finalized assistant answer's text for the idle preview, then
        // drop the live bubble (the stream's text now lives in lastText).
        if (m.role === "assistant") {
          const text = m.blocks
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("");
          if (text) setLastText(text);
          clearLive();
        }
      },
      onStatus: (kind) => {
        // The enriched `tokens` status is opaque here — keep the human label only.
        if (kind !== "tokens") setStatus(kind);
      },
      onResult: () => {
        /* per-turn result summary isn't shown in this slim view */
      },
      onConnectionState: (state) => {
        if (state === "reconnecting") {
          setReconnecting(true);
          return;
        }
        setReconnecting(false);
      },
      onError: () => {
        runningRef.current = false;
        setRunning(false);
        setStatus(null);
        clearLive();
      },
      onTurnEnd: () => {
        runningRef.current = false;
        setRunning(false);
        setStatus(null);
        clearLive();
      },
    });
    connRef.current = conn;
    return conn;
  }, [beginLive, clearLive]);

  useEffect(() => {
    return () => {
      connRef.current?.close();
      connRef.current = null;
    };
  }, []);

  // Follow the session's transcript LIVE over the read-only SSE tail. This is what
  // makes a panel stream a session whose turn is driven by an EXTERNAL process
  // (the CLI itself) — the chat WebSocket above only streams turns THIS panel
  // sends. While this panel is driving its own turn, the WS stream is
  // authoritative, so tail frames are ignored to avoid double-rendering.
  useEffect(() => {
    if (!session.sessionId) return;
    const stop = tailSession(session.sessionId, (messages: NormalizedMessage[]) => {
      if (runningRef.current || liveActiveRef.current) return;
      // Newest assistant text in this batch wins as the panel's preview.
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m || m.role !== "assistant") continue;
        const text = m.blocks
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (text) {
          setLastText(text);
          return;
        }
      }
    });
    setWatching(true);
    return () => {
      setWatching(false);
      stop();
    };
  }, [session.sessionId]);

  const send = useCallback(() => {
    const prompt = draft.trim();
    if (!prompt || running || !session.cwd) return;
    setDraft("");
    setLastText(null);
    setStatus("starting");
    runningRef.current = true;
    setRunning(true);
    clearLive();
    const conn = ensureConn();
    conn.send({
      t: "prompt",
      cwd: session.cwd,
      prompt,
      sessionId: sessionIdRef.current,
      model: session.model ?? undefined,
      permissionMode: PANEL_PERMISSION,
    });
  }, [draft, running, session.cwd, session.model, ensureConn, clearLive]);

  const stop = useCallback(() => {
    connRef.current?.send({ t: "interrupt" });
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Prefer the freshly-polled status (so the dot tracks the live process) over the
  // snapshot the panel was opened with; fall back to the seed when the poll drops it.
  const live = pollStatus ?? session;
  const style = statusStyle(live);
  const canSend = !!session.cwd && !running;

  return (
    <div className="flex h-72 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/30 ring-1 ring-zinc-800">
      {/* Panel header: status + project + close. */}
      <div className="flex items-center gap-2 border-b border-zinc-800/80 px-3 py-2">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", style.dot)} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-zinc-100" title={live.cwd ?? title}>
          {title}
        </span>
        {reconnecting ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300 ring-1 ring-amber-500/20"
            title="Lost the connection — retrying. The session resumes on your next message."
          >
            <Wifi className="h-2.5 w-2.5 animate-pulse" />
            reconnecting
          </span>
        ) : (
          <span className={cn("shrink-0 text-[10.5px] font-medium capitalize", style.text)}>
            {style.label}
          </span>
        )}
        <IconButton onClick={onRemove} title="Remove this panel" aria-label="Remove this panel" className="h-6 w-6">
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>

      {/* Live output preview: the streaming bubble while a turn runs, otherwise the
          last finalized answer (or a hint). Scrolls within the panel. */}
      <div className="min-h-0 flex-1 overflow-y-auto text-[12.5px]">
        {liveActive ? (
          <LiveBubble stream={liveStreamRef.current} />
        ) : lastText ? (
          // Render the finalized answer as markdown (was raw text, so `**bold**`,
          // `## heads`, backticks and `|---|` tables leaked as literal syntax — QA
          // MAJOR). Cap the preview and, when truncated, fade the bottom via a mask
          // (theme-agnostic, unlike a color gradient) to signal "more" instead of a
          // hard mid-sentence "…".
          <div
            className="break-words px-3 py-2.5 text-zinc-300"
            style={
              lastText.length > 1500
                ? {
                    maskImage: "linear-gradient(to bottom, #000 78%, transparent)",
                    WebkitMaskImage: "linear-gradient(to bottom, #000 78%, transparent)",
                  }
                : undefined
            }
          >
            <Markdown text={lastText.length > 1500 ? lastText.slice(0, 1500) : lastText} />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-zinc-600">
            {running
              ? "Working…"
              : watching
                ? "Watching live — output appears here as this session works."
                : "Send a prompt to drive this session."}
          </div>
        )}
      </div>

      {/* Status line + slim composer. */}
      <div className="border-t border-zinc-800/80 px-2.5 py-2">
        {running ? (
          <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] text-clay-300">
            <Spinner className="h-3 w-3" />
            {status ?? "working"}
          </div>
        ) : null}
        <div className="flex items-end gap-1.5 rounded-lg bg-zinc-900 p-1.5 ring-1 ring-zinc-800 focus-within:ring-clay-500/40">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={running ? "Turn in flight…" : `Message ${title}…`}
            disabled={!session.cwd}
            className="max-h-24 min-h-[1.75rem] w-full resize-none bg-transparent px-1.5 py-1 text-[12.5px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:outline-none disabled:opacity-50"
          />
          {running ? (
            <IconButton
              onClick={stop}
              title="Stop (interrupt)"
              aria-label="Stop the running turn"
              className="h-7 w-7 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 hover:text-white"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </IconButton>
          ) : (
            <IconButton
              onClick={send}
              disabled={!canSend || !draft.trim()}
              title="Send (Enter)"
              aria-label="Send prompt"
              className="h-7 w-7 bg-clay-500 text-white hover:bg-clay-600 hover:text-white disabled:bg-zinc-800 disabled:text-zinc-600"
            >
              <Send className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  );
}

/** A pickable running session in the "add panel" dropdown. */
function PickerRow({
  s,
  title,
  added,
  onPick,
}: {
  s: RunningSession;
  /** Real display title (D2), resolved by the parent via `resolveOpsTitle`. */
  title: string;
  added: boolean;
  onPick: () => void;
}) {
  const style = statusStyle(s);
  return (
    <button
      onClick={onPick}
      disabled={added}
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition hover:bg-zinc-800/60 disabled:cursor-default disabled:opacity-40"
      role="menuitem"
    >
      <span className={cn("h-2 w-2 shrink-0 rounded-full", style.dot)} />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-200" title={s.cwd ?? title}>
        {title}
      </span>
      <span className={cn("shrink-0 text-[10.5px] font-medium capitalize", style.text)}>
        {added ? "added" : style.label}
      </span>
    </button>
  );
}

/**
 * Watch and drive MULTIPLE live sessions at once in a responsive grid. Each panel
 * is bound to one running session and owns its own chat WebSocket, so you can keep
 * an eye on several sessions' streaming output and nudge any of them along without
 * leaving the Ops view.
 *
 * Bounded by design: at most {@link MAX_PANELS} panels are watched at once, chosen
 * from the live running-sessions list via the "Add panel" picker. The list is
 * polled on an interval (paused while the tab is hidden) so the picker and each
 * panel's status dot stay fresh. Auto-fills with the first running sessions on
 * first load so the grid isn't empty out of the gate.
 */
export function MultiSessionDrive({
  sessions,
}: {
  /** Indexed sessions, joined by sessionId for real titles (D2) — same shape Grid/Board take. */
  sessions?: readonly SessionSummary[];
} = {}) {
  const [running, setRunning] = useState<RunningSession[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // The sessionIds the user has opened as panels (insertion order preserved).
  const [picked, setPicked] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const aliveRef = useRef(true);
  // Auto-fill the grid once, on the first non-empty running list.
  const autoFilledRef = useRef(false);

  const load = useCallback(() => {
    setRefreshing(true);
    api
      .running()
      .then((r) => {
        if (aliveRef.current) setRunning(dedupeBySessionId(r));
      })
      .catch(() => {
        if (aliveRef.current && running == null) setRunning([]);
      })
      .finally(() => {
        if (aliveRef.current) setRefreshing(false);
      });
  }, [running]);

  // Poll on an interval, pausing while hidden and refreshing on return. Mirrors
  // LiveOpsBoard's poll lifecycle exactly.
  useEffect(() => {
    aliveRef.current = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      load();
    };
    const start = () => {
      if (timer != null) return;
      tick();
      timer = setInterval(tick, POLL_MS);
    };
    const stop = () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (typeof document !== "undefined" && document.hidden) stop();
      else start();
    };
    if (typeof document === "undefined" || !document.hidden) start();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      aliveRef.current = false;
      stop();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-fill the grid with the first few running sessions on first load, so the
  // view isn't empty when there's already live work to watch. Runs once.
  useEffect(() => {
    if (autoFilledRef.current || !running || running.length === 0) return;
    autoFilledRef.current = true;
    const alive = running.filter((s) => s.alive !== false && s.sessionId);
    setPicked(alive.slice(0, MAX_PANELS).map((s) => s.sessionId));
  }, [running]);

  // Close the picker on outside-click / Escape.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  // Resolve picked ids → their session snapshots. Drop ids that vanished from the
  // running list (their process ended), keeping the grid honest. Capped at MAX_PANELS.
  const byId = useMemo(() => {
    const m = new Map<string, RunningSession>();
    for (const s of running ?? []) m.set(s.sessionId, s);
    return m;
  }, [running]);

  // Indexed sessions for the title join (D2) — the SAME `resolveOpsTitle` Grid/
  // Board use, so a panel/picker row never falls back to a raw process counter.
  const sessionsById = useMemo(() => indexSessions(sessions), [sessions]);
  const titleFor = useCallback(
    (s: RunningSession) => resolveOpsTitle(s, s.sessionId ? sessionsById.get(s.sessionId) : undefined),
    [sessionsById],
  );

  const panels = useMemo(
    () =>
      picked
        .map((id) => byId.get(id))
        .filter((s): s is RunningSession => !!s)
        .slice(0, MAX_PANELS),
    [picked, byId],
  );

  const addPanel = useCallback((id: string) => {
    setPicked((prev) => (prev.includes(id) || prev.length >= MAX_PANELS ? prev : [...prev, id]));
    setPickerOpen(false);
  }, []);

  const removePanel = useCallback((id: string) => {
    setPicked((prev) => prev.filter((p) => p !== id));
  }, []);

  // Candidates for the picker: live running sessions not already shown.
  const candidates = (running ?? []).filter((s) => s.alive !== false && s.sessionId);
  const atCap = panels.length >= MAX_PANELS;

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-zinc-950">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-[15px] font-semibold text-zinc-100">
            <RadioTower className="h-4 w-4 text-clay-400" />
            Drive
          </h1>
          {panels.length > 0 ? (
            <span className="text-[12px] text-zinc-500">
              {panels.length}/{MAX_PANELS} watching
            </span>
          ) : null}

          {/* Add-panel picker. */}
          <div className="relative ml-auto" ref={pickerRef}>
            <button
              onClick={() => setPickerOpen((v) => !v)}
              disabled={atCap || candidates.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-400 ring-1 ring-zinc-800 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
              title={atCap ? `At most ${MAX_PANELS} panels` : "Add a session panel"}
              aria-haspopup="menu"
              aria-expanded={pickerOpen}
            >
              <Plus className="h-3.5 w-3.5" />
              Add panel
            </button>
            {pickerOpen ? (
              <div
                className="absolute right-0 top-full z-50 mt-1.5 w-64 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl shadow-black/50"
                role="menu"
              >
                <div className="border-b border-zinc-800 px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-wide text-zinc-500">
                  Running sessions
                </div>
                <div className="max-h-[50vh] overflow-y-auto py-1">
                  {candidates.length > 0 ? (
                    candidates.map((s) => (
                      <PickerRow
                        key={s.sessionId}
                        s={s}
                        title={titleFor(s)}
                        added={picked.includes(s.sessionId)}
                        onPick={() => addPanel(s.sessionId)}
                      />
                    ))
                  ) : (
                    <div className="px-3 py-2 text-[11.5px] text-zinc-600">No running sessions.</div>
                  )}
                </div>
              </div>
            ) : null}
          </div>

          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-400 ring-1 ring-zinc-800 transition hover:bg-zinc-800 hover:text-zinc-200"
            title="Refresh now"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            Refresh
          </button>
        </div>

        {running == null ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner className="h-6 w-6" />
          </div>
        ) : panels.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 py-14">
            <EmptyState
              icon={<RadioTower className="h-10 w-10" />}
              title={candidates.length > 0 ? "Add a session to watch" : "No sessions running right now"}
              hint={
                candidates.length > 0
                  ? "Use “Add panel” to watch and drive up to six live sessions side by side."
                  : "Live Claude Code sessions show up here as they start — then add them as panels."
              }
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {panels.map((s) => (
              <SessionPanel
                key={s.sessionId}
                session={s}
                title={titleFor(byId.get(s.sessionId) ?? s)}
                pollStatus={byId.get(s.sessionId) ?? null}
                onRemove={() => removePanel(s.sessionId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
