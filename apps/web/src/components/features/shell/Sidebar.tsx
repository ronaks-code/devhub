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
import { DeckMark } from "../../DeckMark.js";
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

/**
 * The redesigned rail geometry (§3.1), the single source of truth for the cockpit's
 * dimensions. Mirrors the matching fields on `SHELL_GEOMETRY` (52 icon-rail + 272
 * panel = 324; two-line 44px rows) so the shell and the sidebar never drift.
 */
export const SIDEBAR_GEOMETRY = Object.freeze({
  iconRailWidth: 52,
  panelWidth: 272,
  railWidth: 324,
  collapsedWidth: 52,
  rowMinHeight: 44,
  /** Tier-3 "recent" one-line rows (§3.1v2) — settled history earns less height. */
  compactRowHeight: 26,
  railInset: 8,
} as const);

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
  /** Legacy line-2 lead text — kept for filter matching. Omitted when absent. */
  subtitle?: string;
  /** ISO timestamp for the right-aligned relative time. */
  timestamp?: string | null;
  /** Session cost — rendered only when present (> 0 at the call site). */
  costUsd?: number;
  /** Real git branch (SessionSummary.gitBranch) for the tier cards. */
  branch?: string | null;
  /** Model id when the session reported one (SessionSummary.model / running join). */
  model?: string | null;
  /**
   * Tier-1 reason line, composed by the caller from the running join's REAL
   * `waitingFor`/`alive`/`stale` fields (see m6-compose `describeRunReason`).
   */
  reason?: string;
  /** Epoch ms the live run started (RunningSession.startedAt) — drives the tier-2 timer. */
  startedAt?: number | null;
}

/**
 * Attention tier → row density (§3.1v2 inbox): row height is EARNED by state.
 *  - "attention" (needs you): full detailed card — reason line, status pill, Open.
 *  - "active"    (running):   lighter card with a live elapsed timer.
 *  - "recent"    (settled):   compact one-line row — quiet history.
 */
export type SidebarTier = "attention" | "active" | "recent";

export interface SidebarGroup {
  id: string;
  label: string;
  rows: SidebarRow[];
  /** Row density for this group; defaults to the quiet "recent" one-liners. */
  tier?: SidebarTier;
}

/**
 * A git worktree row (§3.1 worktrees group). Only fields the /api/git/worktrees
 * endpoint actually returns — branch + main/locked flags. (The endpoint carries NO
 * dirty +N/~M counts, so the spec's dirty display is intentionally omitted rather
 * than faked.) Read-only.
 */
export interface SidebarWorktree {
  path: string;
  branch: string | null;
  isMain?: boolean;
  locked?: boolean;
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
  /** Read-only worktrees group; omit/empty to hide it (no data → no group). */
  worktrees?: SidebarWorktree[];
  sessionCount: number;
  selectedSessionId?: string | null;
  onSelectSession: (id: string) => void;
  onNewTask: () => void;
  /** Provider segment (defaultMechanics). Omit onMechanicsChange to render read-only. */
  mechanics: "claude" | "codex";
  onMechanicsChange?: (m: "claude" | "codex") => void;
  modelLabel?: string;
  spend?: SidebarSpend;
  /**
   * True while the active project's session list is (re)fetching. Cold start
   * can take 10-20s while the index rebuilds; without this the panel showed a
   * confident "No sessions" during that whole window — read as "this project
   * has nothing", not "still loading" (QA). Only affects the truly-empty,
   * unfiltered case; a filtered/chip-narrowed empty result keeps its own copy.
   */
  loading?: boolean;
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

/** Live elapsed for a tier-2 running card (from the run's real startedAt). */
function elapsedTime(startedAt: number | null | undefined, nowMs: number): string | null {
  if (!startedAt || startedAt <= 0) return null;
  const s = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const CHIP_FILTERS = [
  { id: "all", label: "All" },
  { id: "review", label: "Needs you" },
  { id: "running", label: "Running" },
  { id: "anthropic", label: "Claude" },
  { id: "openai", label: "Codex" },
] as const;
type ChipFilter = (typeof CHIP_FILTERS)[number]["id"];

export function Sidebar({
  brand = "DevHub",
  destinations,
  onSelectDestination,
  groups,
  worktrees,
  sessionCount,
  selectedSessionId,
  onSelectSession,
  onNewTask,
  mechanics,
  onMechanicsChange,
  modelLabel,
  spend,
  loading,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => readCompat(COLLAPSE_KEY) === "1");
  const [filter, setFilter] = useState("");
  const [chip, setChip] = useState<ChipFilter>("all");

  // 1s tick for the tier-2 "running {elapsed}" timers — armed only while a
  // running card actually carries a real startedAt (no rows → no interval).
  const hasLiveTimer = groups.some(
    (g) => g.tier === "active" && g.rows.some((r) => r.startedAt && r.startedAt > 0),
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!hasLiveTimer) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasLiveTimer]);

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
          const hay = `${r.title} ${r.subtitle ?? ""} ${r.branch ?? ""} ${r.model ?? ""} ${r.reason ?? ""}`;
          if (q && !hay.toLowerCase().includes(q)) return false;
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
        <div className="dh-logo" data-dh-logo="" aria-label={brand} title={brand}>
          <DeckMark size={26} />
        </div>
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
          {/* F6: this is the indexed Claude session TOTAL (api.health()'s
              sessionCount), not how many are currently running — "open" read as
              "active" and contradicted the running/needs-you counts elsewhere.
              It's also Claude-only (a separate count from Codex's), so label the
              scope rather than a vaguer, misleading word. */}
          <span className="dh-panel-header-count">{sessionCount} Claude</span>
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
          {filteredGroups.length === 0 && loading && !q && chip === "all" ? (
            <div className="flex flex-col gap-1.5 px-1 py-0.5" aria-hidden>
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-11 animate-pulse rounded-lg bg-[var(--dh-control)]" />
              ))}
            </div>
          ) : filteredGroups.length === 0 ? (
            <p className="dh-sempty">{q || chip !== "all" ? "No matching sessions" : "No sessions"}</p>
          ) : (
            filteredGroups.map((g) => (
              <div key={g.id} className="dh-sgroup" data-dh-sgroup="">
                <div className="dh-sgroup-head">
                  <span className="dh-label">{g.label}</span>
                  <span className="dh-sgroup-count">{g.rows.length}</span>
                </div>
                {g.rows.map((r) => {
                  const selected = r.id === selectedSessionId;
                  const tier = g.tier ?? "recent";
                  const open = () => onSelectSession(r.id);
                  // Tier 3 — settled history collapses to a quiet one-line row.
                  if (tier === "recent") {
                    return (
                      <button
                        key={r.id}
                        type="button"
                        className={cn("dh-srowc", selected && "dh-srowc--selected")}
                        data-dh-srow=""
                        data-dh-tier="recent"
                        data-dh-selected={selected ? "" : undefined}
                        aria-current={selected ? "page" : undefined}
                        onClick={open}
                      >
                        {r.status ? <StatusDot status={r.status} /> : <span className="dh-srowc-dotpad" aria-hidden />}
                        <span className="dh-srowc-title">{r.title}</span>
                        <span className="dh-srowc-right">
                          {typeof r.costUsd === "number" ? `$${r.costUsd.toFixed(2)}` : relTime(r.timestamp)}
                        </span>
                      </button>
                    );
                  }
                  // Tiers 1+2 — cards. A div (not button) so the tier-1 Open action
                  // can be a REAL nested button without invalid button-in-button DOM.
                  const el = tier === "active" ? elapsedTime(r.startedAt, nowMs) : null;
                  return (
                    <div
                      key={r.id}
                      role="button"
                      tabIndex={0}
                      className={cn(
                        "dh-scard",
                        tier === "attention" ? "dh-scard--attention" : "dh-scard--running",
                        selected && "dh-scard--selected",
                      )}
                      data-dh-srow=""
                      data-dh-tier={tier}
                      data-dh-selected={selected ? "" : undefined}
                      aria-current={selected ? "page" : undefined}
                      onClick={open}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          open();
                        }
                      }}
                    >
                      <span className="dh-scard-line1">
                        {r.status ? <StatusDot status={r.status} /> : null}
                        <span className="dh-scard-title">{r.title}</span>
                        {el ? (
                          <span className="dh-scard-timer">{`running ${el}`}</span>
                        ) : r.timestamp ? (
                          <span className="dh-scard-time">{relTime(r.timestamp)}</span>
                        ) : null}
                      </span>
                      {tier === "attention" ? (
                        // Reason + the Open action share a row so the meta line
                        // below keeps room for the real branch/model text.
                        <span className="dh-scard-line1">
                          {r.reason ? (
                            <span className="dh-scard-reason" title={r.reason}>
                              {r.reason}
                            </span>
                          ) : null}
                          <button
                            type="button"
                            className="dh-scard-open"
                            onClick={(e) => {
                              e.stopPropagation();
                              open();
                            }}
                          >
                            Open
                          </button>
                        </span>
                      ) : null}
                      <span className="dh-scard-meta">
                        {tier === "attention" && r.status ? (
                          <span className="dh-spill" data-status={r.status}>
                            {r.status === "failed" ? "stalled" : "waiting"}
                          </span>
                        ) : null}
                        {r.branch ? <span className="dh-scard-branch">{`⎇ ${r.branch}`}</span> : null}
                        {r.model ? <span className="dh-scard-model">{r.model}</span> : null}
                        <ProviderChip provider={r.provider} />
                        {tier === "active" && typeof r.costUsd === "number" ? (
                          <span className="dh-scard-cost">${r.costUsd.toFixed(2)}</span>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))
          )}

          {worktrees && worktrees.length > 0 ? (
            <div className="dh-sgroup" data-dh-worktrees="">
              <div className="dh-sgroup-head">
                <span className="dh-label">Worktrees</span>
                <span className="dh-sgroup-count">{worktrees.length}</span>
              </div>
              {worktrees.map((w) => (
                <div key={w.path} className="dh-wtrow" data-dh-wtrow="" title={w.path}>
                  <span className="dh-wtrow-branch">{`⎇ ${w.branch ?? "detached"}`}</span>
                  {w.isMain ? <span className="dh-wtrow-tag">main</span> : null}
                  {w.locked ? <span className="dh-wtrow-tag">locked</span> : null}
                </div>
              ))}
            </div>
          ) : null}
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
