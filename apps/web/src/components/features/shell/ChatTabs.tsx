import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ProviderChip, type ChipProvider } from "../../ui/ProviderChip.js";
import { StatusDot, type StatusKind } from "../../ui/StatusDot.js";

/**
 * ChatTabs — Conductor-style multi-chat strip (§3.2). One tab per open chat session
 * in this window. Tab state (openTabs/activeTabId) lives in App.tsx wired to the
 * existing ?session= route; this is pure presentation. Active tab fuses with the
 * canvas below (inset violet top glow). Overflow scrolls horizontally (no wrap).
 */
export interface ChatTab {
  sessionId: string;
  title: string;
  provider: ChipProvider;
  status?: StatusKind;
}

export interface ChatTabsProps {
  tabs: ChatTab[];
  activeTabId?: string | null;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onNew: () => void;
}

export function ChatTabs({ tabs, activeTabId, onSelect, onClose, onNew }: ChatTabsProps) {
  return (
    <div className="dh-chattabs" role="tablist" aria-label="Open chats" data-dh-chattabs="">
      <div className="dh-chattabs-scroll">
        {tabs.map((t) => {
          const active = t.sessionId === activeTabId;
          return (
            <div
              key={t.sessionId}
              className={cn("dh-chattab", active && "dh-chattab--active")}
              data-dh-chattab=""
              data-dh-active={active ? "" : undefined}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="dh-chattab-main"
                onClick={() => onSelect(t.sessionId)}
                title={t.title}
              >
                {t.status ? <StatusDot status={t.status} /> : null}
                <span className="dh-chattab-title">{t.title}</span>
                <ProviderChip provider={t.provider} />
              </button>
              <button
                type="button"
                className="dh-chattab-close"
                aria-label={`Close ${t.title}`}
                onClick={() => onClose(t.sessionId)}
              >
                <X size={11} strokeWidth={2.5} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="dh-chattab-new" aria-label="New chat" title="New chat" onClick={onNew}>
        <Plus size={14} strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}
