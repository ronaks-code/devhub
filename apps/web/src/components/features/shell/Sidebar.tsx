import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Bot,
  ChevronDown,
  CircleUserRound,
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
import { startWindowDrag } from "../../../lib/windowDrag.js";
import { LogoutButton } from "../../AuthGate.js";
import { getToken } from "../../../lib/api.js";
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
  /** Opens the shared ShortcutOverlay (the rail's dashed `?` chip, §3.1). */
  onShowShortcuts?: () => void;
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
const GROUPS_COLLAPSED_KEY = "devhub:sidebar-groups-collapsed";

/** Parse the persisted {groupId: true} collapsed-group map (tolerant of junk). */
function readCollapsedGroups(): Record<string, boolean> {
  const raw = readCompat(GROUPS_COLLAPSED_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/**
 * True ONLY in the macOS Tauri desktop build, where the native traffic-lights
 * (Overlay title-bar style) render over the window's top-left — which is this
 * sidebar. We require BOTH the Tauri runtime AND a Mac UA: the plain web build
 * (even in a Mac browser) has no native chrome, so it must apply NO inset (§4).
 * Computed once; the Tauri globals are injected before the app script runs.
 */
function isMacTauriChrome(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const tauri = "__TAURI__" in window || "__TAURI_INTERNALS__" in window;
  const mac = /Mac/i.test(navigator.userAgent);
  return tauri && mac;
}

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

/**
 * Numeric row-jump chip (§3.1, opt-5): a small 1-9 kbd shown on the first nine
 * visible session rows ONLY while the panel has focus. Inline-styled so the row
 * layout stays self-contained (no new global CSS class to drift).
 */
const ROW_JUMP_KBD_STYLE: CSSProperties = {
  flexShrink: 0,
  fontFamily: "var(--font-mono)",
  fontSize: "9px",
  lineHeight: 1,
  padding: "1px 4px",
  borderRadius: "4px",
  color: "var(--dh-text-muted)",
  background: "var(--dh-control)",
  border: "1px solid var(--dh-border-subtle)",
};

/**
 * Rail-bottom account popover (§3.1). A small avatar button anchored at the icon
 * rail's bottom; clicking it opens a popover to the right of the rail. The only
 * real action is Log out — reused from AuthGate, so it self-hides when no access
 * token is stored (the local default). The status line reflects the REAL token
 * state (getToken()); nothing here is fabricated — this local tool has no user
 * profile, so we show the honest access state, not an invented name/email.
 */
function RailAuthMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const hasToken = typeof window !== "undefined" && !!getToken();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="dh-navicon"
        data-dh-navicon=""
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account"
        title="Account"
        onClick={() => setOpen((v) => !v)}
      >
        <CircleUserRound size={18} strokeWidth={2} aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Account"
          style={{
            position: "absolute",
            bottom: 0,
            left: "calc(100% + 6px)",
            zIndex: 60,
            width: 220,
            padding: 10,
            borderRadius: 12,
            background: "var(--dh-surface)",
            border: "1px solid var(--dh-glass-border)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--dh-text-strong)" }}>
            {hasToken ? "Remote access" : "Local access"}
          </div>
          <p style={{ margin: "4px 0 8px", fontSize: 11, lineHeight: 1.4, color: "var(--dh-text-muted)" }}>
            {hasToken
              ? "A saved access token is in use on this device."
              : "No access token stored — this server isn’t locked."}
          </p>
          <LogoutButton className="w-full justify-start" />
        </div>
      ) : null}
    </div>
  );
}

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
  onShowShortcuts,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => readCompat(COLLAPSE_KEY) === "1");
  // macOS Tauri only: reserve a top drag-strip so the native traffic-lights don't
  // cover the logo / nav icons / Sessions header (§4). No inset in the web build.
  const [macTauri] = useState<boolean>(() => isMacTauriChrome());
  const [filter, setFilter] = useState("");
  const [chip, setChip] = useState<ChipFilter>("all");
  const filterInputRef = useRef<HTMLInputElement>(null);
  // Row-jump (§3.1 opt-5): the 1-9 chips + digit handler are armed ONLY while
  // focus is somewhere inside the panel, so they never fight the app's global
  // shortcuts. `panelRef` scopes the focusin/focusout so tabbing between rows
  // keeps the chips up, and tabbing out (to the rail or chat) drops them.
  const [panelFocused, setPanelFocused] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // Per-group collapse state (§3.1), keyed by the stable group id (review/stale/
  // running/idle). Persisted so a collapsed group stays folded across launches.
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(
    () => readCollapsedGroups(),
  );
  const toggleGroup = useCallback((id: string) => {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      if (!next[id]) delete next[id];
      writeCompat(GROUPS_COLLAPSED_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

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
      // `/` focuses the session filter (the kbd hint in the filter well). If the
      // panel is collapsed there's no input to focus, so open it first.
      if (e.key === "/") {
        // On the Settings route its own query-deck "/" owns the key — don't steal
        // it to the sessions filter (QA: settings search "/" never fired).
        if (destinations.some((d) => d.id === "settings" && d.current)) return;
        e.preventDefault();
        if (collapsed) {
          toggleCollapsed();
          // The input mounts on the next paint once the panel un-collapses.
          requestAnimationFrame(() => filterInputRef.current?.focus());
        } else {
          filterInputRef.current?.focus();
        }
        return;
      }
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
  }, [destinations, onSelectDestination, toggleCollapsed, collapsed]);

  const q = filter.trim().toLowerCase();
  const filteredGroups = useMemo(() => {
    return groups
      .map((g) => ({
        ...g,
        rows: g.rows.filter((r) => {
          const hay = `${r.title} ${r.subtitle ?? ""} ${r.branch ?? ""} ${r.model ?? ""} ${r.reason ?? ""}`;
          if (q && !hay.toLowerCase().includes(q)) return false;
          if (chip === "running" && r.status !== "running") return false;
          // "Needs you" means genuinely waiting on you (W3-COUNTS) — stale/failed
          // sessions live in their own "Stale" group, not this filter.
          if (chip === "review" && r.status !== "waiting") return false;
          if (chip === "anthropic" && r.provider !== "anthropic") return false;
          if (chip === "openai" && r.provider !== "openai") return false;
          return true;
        }),
      }))
      .filter((g) => g.rows.length > 0);
  }, [groups, q, chip]);

  // Map the first 9 VISIBLE session rows (render order, skipping collapsed
  // groups) to their 1-9 jump index. Collapsed groups aren't rendered, so their
  // rows earn no number — the digits only ever target a row you can actually see.
  const jumpIndexById = useMemo(() => {
    const m = new Map<string, number>();
    let n = 0;
    for (const g of filteredGroups) {
      if (collapsedGroups[g.id]) continue;
      for (const r of g.rows) {
        if (n >= 9) break;
        n += 1;
        m.set(r.id, n);
      }
      if (n >= 9) break;
    }
    return m;
  }, [filteredGroups, collapsedGroups]);

  // Digit 1-9 opens the numbered row — but ONLY while the panel holds focus and
  // you're not typing in the filter input. Listening solely during panel-focus is
  // what keeps this from stomping any global 1-9 shortcut elsewhere in the app.
  useEffect(() => {
    if (!panelFocused) return;
    const idToIndex = jumpIndexById;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (typing) return;
      if (e.key < "1" || e.key > "9") return;
      const want = Number(e.key);
      for (const [id, idx] of idToIndex) {
        if (idx === want) {
          e.preventDefault();
          onSelectSession(id);
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelFocused, jumpIndexById, onSelectSession]);

  const iconDests = destinations.filter((d) => d.id !== "settings" && NAV_ICONS[d.id]);
  const settingsDest = destinations.find((d) => d.id === "settings");
  // Only a real budget CAP makes a "% of budget" meaningful — with no cap set,
  // `pct` is 0 and the ring read "Spend 0% of budget" while thousands were spent
  // (QA: misleading). No cap → no ring (the absolute spend still shows below).
  const spendPct =
    spend && spend.monthlyBudgetUsd != null
      ? Math.round(Math.min(100, Math.max(0, spend.pct)))
      : null;

  return (
    <div
      className={cn("dh-sidebar", collapsed && "dh-sidebar--collapsed")}
      data-dh-sidebar=""
      data-tauri-macos={macTauri ? "" : undefined}
    >
      {/* Icon rail — also the window drag grab-zone at the top-left (§4). */}
      <div className="dh-iconrail" data-dh-iconrail="" onMouseDown={startWindowDrag}>
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
        <RailAuthMenu />
        {onShowShortcuts ? (
          <button
            type="button"
            className="dh-help-chip"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts"
            onClick={onShowShortcuts}
          >
            ?
          </button>
        ) : null}
      </div>

      {/* Panel — sessions cockpit. */}
      <div
        className="dh-panel"
        data-dh-panel=""
        ref={panelRef}
        onFocus={() => setPanelFocused(true)}
        onBlur={(e) => {
          // Only drop the row-jump chips when focus truly leaves the panel — not
          // when it just hops between rows (relatedTarget still inside panelRef).
          if (!panelRef.current?.contains(e.relatedTarget as Node | null)) {
            setPanelFocused(false);
          }
        }}
      >
        <div className="dh-panel-header" onMouseDown={startWindowDrag}>
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
            ref={filterInputRef}
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
            filteredGroups.map((g) => {
              const groupCollapsed = !!collapsedGroups[g.id];
              return (
              <div key={g.id} className="dh-sgroup" data-dh-sgroup="">
                <button
                  type="button"
                  className="dh-sgroup-head"
                  aria-expanded={!groupCollapsed}
                  data-dh-collapsed={groupCollapsed ? "" : undefined}
                  onClick={() => toggleGroup(g.id)}
                >
                  <ChevronDown className="dh-sgroup-caret" size={12} strokeWidth={2.5} aria-hidden />
                  <span className="dh-label">{g.label}</span>
                  <span className="dh-sgroup-count">{g.rows.length}</span>
                </button>
                {groupCollapsed ? null : g.rows.map((r) => {
                  const selected = r.id === selectedSessionId;
                  const tier = g.tier ?? "recent";
                  const open = () => onSelectSession(r.id);
                  const jump = panelFocused ? jumpIndexById.get(r.id) : undefined;
                  // Tier 3 — settled history. Still a compact TWO-line row (§3.1
                  // legibility: never truncate to one), just denser than the
                  // attention/active cards. Line 1 = title (+ cost when it exists);
                  // line 2 = the REAL context that exists — project · branch
                  // (from the row's subtitle) and the relative time. Any field
                  // that's genuinely absent is omitted, never faked.
                  if (tier === "recent") {
                    const rel = relTime(r.timestamp);
                    const cost = typeof r.costUsd === "number" ? `$${r.costUsd.toFixed(2)}` : null;
                    const ctx = r.subtitle ?? (r.branch ? `⎇ ${r.branch}` : "");
                    const hasLine2 = !!ctx || !!rel;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        className={cn("dh-srowc", selected && "dh-srowc--selected")}
                        // Override the base one-line flex-row into a compact
                        // two-line stack (inline beats the unlayered .dh-srowc rule).
                        style={{ flexDirection: "column", alignItems: "stretch", gap: "2px", paddingTop: "5px", paddingBottom: "5px" }}
                        data-dh-srow=""
                        data-dh-tier="recent"
                        data-dh-selected={selected ? "" : undefined}
                        aria-current={selected ? "page" : undefined}
                        onClick={open}
                      >
                        <span style={{ display: "flex", alignItems: "center", gap: "6px", width: "100%", minWidth: 0 }}>
                          {r.status ? <StatusDot status={r.status} /> : <span className="dh-srowc-dotpad" aria-hidden />}
                          <span className="dh-srowc-title">{r.title}</span>
                          {jump ? <kbd className="dh-rowjump" style={ROW_JUMP_KBD_STYLE} aria-hidden>{jump}</kbd> : null}
                          {cost ? <span className="dh-srowc-right">{cost}</span> : null}
                        </span>
                        {hasLine2 ? (
                          <span style={{ display: "flex", alignItems: "center", gap: "6px", width: "100%", minWidth: 0, paddingLeft: "12px" }}>
                            {ctx ? (
                              <span
                                className="dh-srowc-sub"
                                style={{
                                  flex: "1 1 auto",
                                  minWidth: 0,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  fontFamily: "var(--font-mono)",
                                  fontSize: "10px",
                                  color: "var(--dh-text-muted)",
                                }}
                              >
                                {ctx}
                              </span>
                            ) : (
                              <span style={{ flex: "1 1 auto" }} aria-hidden />
                            )}
                            {rel ? <span className="dh-srowc-right">{rel}</span> : null}
                          </span>
                        ) : null}
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
                        {jump ? <kbd className="dh-rowjump" style={ROW_JUMP_KBD_STYLE} aria-hidden>{jump}</kbd> : null}
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
              );
            })
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
              {/* Only a real budget CAP makes a fill % meaningful. With no cap,
                  `spendPct` is null and a 0%-fill bar read as broken (QA) — same
                  principle as the spend-ring: no cap → no bar, the absolute spend
                  label above still carries the number. */}
              {spendPct !== null ? (
                <div className="dh-spend-bar">
                  <span
                    className="dh-spend-fill"
                    data-alert={spend.alert ?? "none"}
                    style={{ width: `${spendPct}%` }}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
