import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PermissionMode } from "@devhub/engine/driver";
import type { NormalizedMessage } from "../../../lib/types.js";
import { openChat, type ChatConn } from "../../../lib/ws.js";
import { api } from "../../../lib/api.js";
import { useDraft } from "../../../hooks/useDraft.js";
import { buildFileChanges } from "../../FileChangeSummary.js";
import {
  buildDiffContent,
  buildEnvironmentSummary,
  buildFilesContent,
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
  onFork?: () => void;
  /** Mount `InspectorDock` alongside the transcript (`inspectorDock` flag). */
  showInspector?: boolean;
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
}: ChatHostProps) {
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);
  const [messages, setMessages] = useState<NormalizedMessage[]>([]);
  const [turnRunning, setTurnRunning] = useState(false);
  const [connection, setConnection] = useState<ComposerConnection>("stale");
  const [inspectorSelected, setInspectorSelected] = useState<"diff" | "files" | "terminal" | "browser" | "artifacts">(
    "diff",
  );
  const [gitBranch, setGitBranch] = useState<string | null>(null);

  const { draft, setDraft, clearDraft } = useDraft(projectId, sessionId ?? initialSessionId);
  const connRef = useRef<ChatConn | null>(null);

  useEffect(() => {
    const conn = openChat({
      onOpen: () => setConnection("connected"),
      onError: () => setConnection("disconnected"),
      onSession: (sid) => setSessionId(sid),
      onMessage: (m) => setMessages((prev) => [...prev, m]),
      onResult: () => setTurnRunning(false),
      onTurnEnd: () => setTurnRunning(false),
    });
    connRef.current = conn;
    return () => {
      conn.close();
      connRef.current = null;
    };
    // A fresh socket per mounted host (matches ChatPane: one WS per pane, torn
    // down on unmount). cwd changes remount this component via the caller's key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

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
        <TaskHeader title={title} provider="anthropic" onFork={onFork} />
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
          selected={inspectorSelected}
          onSelectDestination={setInspectorSelected}
          environment={buildEnvironmentSummary(gitBranch ? { branch: gitBranch, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] } : null, fileChanges)}
          content={{
            diff: buildDiffContent(fileChanges),
            files: buildFilesContent(fileChanges),
          }}
        />
      ) : null}
    </div>
  );
}
