import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  Folder,
  Hexagon,
  History,
  Home,
  Inbox,
  LayoutDashboard,
  Plus,
  Radio,
  Rocket,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { readCompat, writeCompat } from "../../../lib/compat-storage.js";
import { ProviderChip, type ChipProvider } from "../../ui/ProviderChip.js";
import { StatusDot, type StatusKind } from "../../ui/StatusDot.js";

/**
 * Sidebar — the Aurora Cockpit rail+panel (§3.1). A 52px icon rail (glassless,
 * darkest chrome) + a 272px glass panel. This REPLACES the flat `TaskRail` open-list
 * in the devhub shell; `TaskRail`/`resolveTaskRailMode` stay exported for the mode
 * gate + rollback. Every row is real session data joined from `api.running()` — no
 * status/provider is fabricated (SessionSummary carries neither; see m6-compose).
 */

export interface SidebarDestination {
  id: string;
  label: string;
  current?: boolean;
  /** Optional unread/attention badge count (rendered only when > 0). */
  badge?: number;
}

export interface SidebarRow {
  id: string;
  title: string;
  provider: ChipProvider;
  status?: StatusKind;
  /** Line 2 lead text — e.g. "project · ⎇ branch". Omitted when absent. */
  subtitle?: string;
  /** ISO timestamp for the right-aligned relative time. */
  timestamp?: string | null;
  /** Session cost — shown as a hover badge only. */
  costUsd?: number;
}

export interface SidebarGroup {
  id: string;
  label: string;
  rows: SidebarRow[];
}

export interface SidebarSpend {
  monthToDateUsd: number;
  monthlyBudgetUsd: number | null;
  pct: number;
  alert?: "none" | "warn" | "over";
  /** Short month label, e.g. "jul". */
  month?: string;
}

export interface SidebarProps {
  brand?: string;
  destinations: SidebarDestination[];
  onSelectDestination: (id: string) => void;
  groups: SidebarGroup[];
  sessionCount: number;
  selectedSessionId?: string | null;
  onSelectSession: (id: string) => void;
  onNewTask: () => void;
  /** Provider segment (defaultMechanics). Omit onMechanicsChange to render read-only. */
  mechanics: "claude" | "codex";
  onMechanicsChange?: (m: "claude" | "codex") => void;
  modelLabel?: string;
  spend?: SidebarSpend;
}

/** Icon + keyboard chord for each known destination id (icon rail, §3.1). */
const NAV_ICONS: Record<string, { icon: LucideIcon; chord: string }> = {
  home: { icon: Home, chord: "h" },
  browse: { icon: Folder, chord: "b" },
  chat: { icon: Sparkles, chord: "c" },
  "openai-chat": { icon: Bot, chord: "n" },
  "codex-history": { icon: History, chord: "x" },
  dashboard: { icon: LayoutDashboard, chord: "u" },
  ops: { icon: Radio, chord: "o" },
  spatial: { icon: Hexagon, chord: "e" },
  progress: { icon: Rocket, chord: "p" },
  automations: { icon: Timer, chord: "a" },
  inbox: { icon: Inbox, chord: "i" },
  settings: { icon: SettingsIcon, chord: "," },
};

const COLLAPSE_KEY = "devhub:sidebar-collapsed";

function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const CHIP_FILTERS = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "review", label: "Review" },
  { id: "anthropic", label: "Claude" },
  { id: "openai", label: "Codex" },
] as const;
type ChipFilter = (typeof CHIP_FILTERS)[number]["id"];

export function Sidebar({
  brand = "DevHub",
  destinations,
  onSelectDestination,
  groups,
  sessionCount,
  selectedSessionId,
  onSelectSession,
  onNewTask,
  mechanics,
  onMechanicsChange,
  modelLabel,
  spend,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => readCompat(COLLAPSE_KEY) === "1");
  const [filter, setFilter] = useState("");
  const [chip, setChip] = useState<ChipFilter>("all");

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      writeCompat(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  // ⌘\ collapse toggle + `g`-chord destination jumps (§3.1 keyboard sidecar).
  useEffect(() => {
    let chordArmed = false;
    let chordTimer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        toggleCollapsed();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (chordArmed) {
        const dest = destinations.find((d) => NAV_ICONS[d.id]?.chord === e.key);
        if (dest) {
          e.preventDefault();
          onSelectDestination(dest.id);
        }
        chordArmed = false;
        if (chordTimer) clearTimeout(chordTimer);
        return;
      }
      if (e.key === "g") {
        chordArmed = true;
        chordTimer = setTimeout(() => {
          chordArmed = false;
        }, 1200);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (chordTimer) clearTimeout(chordTimer);
    };
  }, [destinations, onSelectDestination, toggleCollapsed]);

  const q = filter.trim().toLowerCase();
  const filteredGroups = useMemo(() => {
    return groups
      .map((g) => ({
        ...g,
        rows: g.rows.filter((r) => {
          if (q && !`${r.title} ${r.subtitle ?? ""}`.toLowerCase().includes(q)) return false;
          if (chip === "running" && r.status !== "running") return false;
          if (chip === "review" && !(r.status === "waiting" || r.status === "failed")) return false;
          if (chip === "anthropic" && r.provider !== "anthropic") return false;
          if (chip === "openai" && r.provider !== "openai") return false;
          return true;
        }),
      }))
      .filter((g) => g.rows.length > 0);
  }, [groups, q, chip]);

  const iconDests = destinations.filter((d) => d.id !== "settings" && NAV_ICONS[d.id]);
  const settingsDest = destinations.find((d) => d.id === "settings");
  const spendPct = spend ? Math.round(Math.min(100, Math.max(0, spend.pct))) : null;

  return (
    <div className={cn("dh-sidebar", collapsed && "dh-sidebar--collapsed")} data-dh-sidebar="">
      {/* Icon rail — also the window drag grab-zone at the top-left (§4). */}
      <div className="dh-iconrail" data-dh-iconrail="" data-tauri-drag-region>
        <div className="dh-logo" data-dh-logo="" aria-label={brand} title={brand} />
        {iconDests.map((d) => {
          const meta = NAV_ICONS[d.id]!;
          const Icon = meta.icon;
          return (
            <button
              key={d.id}
              type="button"
              className="dh-navicon"
              data-dh-navicon=""
              aria-current={d.current ? "page" : undefined}
              aria-label={d.label}
              title={d.label}
              onClick={() => onSelectDestination(d.id)}
            >
              <Icon size={16} strokeWidth={2} aria-hidden />
              {d.badge && d.badge > 0 ? (
                <span className="dh-navicon-badge" aria-hidden>
                  {d.badge > 99 ? "99+" : d.badge}
                </span>
              ) : null}
              <span className="dh-navicon-chord" aria-hidden>{`g${meta.chord}`}</span>
            </button>
          );
        })}
        <div className="dh-iconrail-spacer" />
        {spendPct !== null ? (
          <div
            className="dh-spend-ring"
            data-dh-spend-ring=""
            title={`Spend ${spendPct}% of budget`}
            aria-label={`Spend ${spendPct}% of budget`}
          >
            {spendPct}
          </div>
        ) : null}
        {settingsDest ? (
          <button
            type="button"
            className="dh-navicon"
            data-dh-navicon=""
            aria-current={settingsDest.current ? "page" : undefined}
            aria-label={settingsDest.label}
            title={settingsDest.label}
            onClick={() => onSelectDestination(settingsDest.id)}
          >
            <SettingsIcon size={16} strokeWidth={2} aria-hidden />
            <span className="dh-navicon-chord" aria-hidden>g,</span>
          </button>
        ) : null}
      </div>

      {/* Panel — sessions cockpit. */}
      <div className="dh-panel" data-dh-panel="">
        <div className="dh-panel-header" data-tauri-drag-region>
          <span className="dh-label">Sessions</span>
          <span className="dh-panel-header-count">{sessionCount} open</span>
          <button
            type="button"
            className="dh-panel-newbtn"
            aria-label="New session"
            title="New session"
            onClick={onNewTask}
          >
            <Plus size={14} strokeWidth={2} aria-hidden />
          </button>
        </div>

        <label className="dh-panel-filter">
          <Search size={12} strokeWidth={2} aria-hidden />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter sessions"
            aria-label="Filter sessions"
          />
          <kbd aria-hidden>/</kbd>
        </label>

        <div className="dh-filter-chips" role="group" aria-label="Session filters">
          {CHIP_FILTERS.map((c) => (
            <button
              key={c.id}
              type="button"
              className="dh-chip"
              aria-pressed={chip === c.id}
              onClick={() => setChip(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>

        <div className="dh-sessions" data-dh-sessions="">
          {filteredGroups.length === 0 ? (
            <p className="dh-sempty">{q || chip !== "all" ? "No matching sessions" : "No sessions"}</p>
          ) : (
            filteredGroups.map((g) => (
              <div key={g.id} className="dh-sgroup" data-dh-sgroup="">
                <div className="dh-sgroup-head">
                  <span className="dh-label">{g.label}</span>
                  <span className="dh-sgroup-count">{g.rows.length}</span>
                </div>
                {g.rows.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={cn("dh-srow", r.id === selectedSessionId && "dh-srow--selected")}
                    data-dh-srow=""
                    data-dh-selected={r.id === selectedSessionId ? "" : undefined}
                    aria-current={r.id === selectedSessionId ? "page" : undefined}
                    onClick={() => onSelectSession(r.id)}
                  >
                    <span className="dh-srow-line1">
                      {r.status ? <StatusDot status={r.status} /> : null}
                      <span className="dh-srow-title">{r.title}</span>
                      <ProviderChip provider={r.provider} />
                    </span>
                    <span className="dh-srow-line2">
                      {r.subtitle ? <span className="dh-srow-sub">{r.subtitle}</span> : <span className="dh-srow-sub" />}
                      {typeof r.costUsd === "number" ? (
                        <span className="dh-srow-cost">${r.costUsd.toFixed(2)}</span>
                      ) : null}
                      {r.timestamp ? <span className="dh-srow-time">{relTime(r.timestamp)}</span> : null}
                    </span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="dh-panel-footer" data-dh-panel-footer="">
          <div className="dh-provider-seg" role="group" aria-label="Default provider">
            {(["claude", "codex"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className="dh-seg-btn"
                aria-pressed={mechanics === m}
                disabled={!onMechanicsChange}
                onClick={() => onMechanicsChange?.(m)}
              >
                {m === "claude" ? "Claude" : "Codex"}
              </button>
            ))}
          </div>
          {modelLabel ? <div className="dh-footer-model">{modelLabel}</div> : null}
          {spend ? (
            <div className="dh-spend" data-dh-spend="">
              <div className="dh-spend-label">
                <span>{`${spend.month ?? ""} spend $${spend.monthToDateUsd.toFixed(0)}`.trim()}</span>
                {spend.monthlyBudgetUsd ? <span>{`/ $${spend.monthlyBudgetUsd.toFixed(0)}`}</span> : null}
              </div>
              <div className="dh-spend-bar">
                <span
                  className="dh-spend-fill"
                  data-alert={spend.alert ?? "none"}
                  style={{ width: `${spendPct ?? 0}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
