import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Folder, MessagesSquare, FileText, ArrowLeft } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * Responsive wrapper for the Browse view's three panes (projects | sessions |
 * transcript).
 *
 * Plain words: on a wide screen you see all three columns at once, exactly like
 * before. On a phone/narrow window there's no room for three columns, so we show
 * ONE at a time with a little breadcrumb up top — tap Projects → Sessions →
 * Transcript to drill in, and tap a crumb (or Back) to step out.
 *
 * The desktop path renders the panes verbatim inside the same flex row App used,
 * so wide layout is byte-for-byte unchanged. Only the narrow branch is new.
 */

/** Which pane is in front on a narrow viewport. */
export type ShellStage = "projects" | "sessions" | "transcript";

/**
 * Subscribe to a CSS media query. SSR-safe (assumes no match) and resilient to
 * older Safari (addListener fallback). Returns whether the query currently matches.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia(query);
    } catch {
      return;
    }
    const onChange = () => setMatches(mql.matches);
    onChange();
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query]);

  return matches;
}

/** The Tailwind `lg` breakpoint (1024px). At/above this we show all 3 panes. */
const WIDE_QUERY = "(min-width: 1024px)";

/**
 * `useResponsiveShell` derives the right narrow-viewport stage from selection
 * state and exposes navigation helpers, so the host can keep the stage in sync
 * with what the user picked without duplicating the logic.
 */
export function useResponsiveShell({
  hasProject,
  hasSession,
}: {
  hasProject: boolean;
  hasSession: boolean;
}): {
  isWide: boolean;
  stage: ShellStage;
  setStage: (stage: ShellStage) => void;
} {
  const isWide = useMediaQuery(WIDE_QUERY);
  // The deepest pane the current selection justifies; the user can step back
  // from it via the breadcrumb. Auto-advances as they drill in.
  const [stage, setStage] = useState<ShellStage>("projects");

  // Follow selection forward on narrow screens: picking a session reveals the
  // transcript; picking a project (without a session) reveals the session list.
  // We never auto-step BACKWARD, so a manual "back" tap sticks until the next pick.
  useEffect(() => {
    if (isWide) return;
    if (hasSession) setStage("transcript");
    else if (hasProject) setStage((s) => (s === "transcript" ? "sessions" : s));
  }, [isWide, hasProject, hasSession]);

  return { isWide, stage, setStage };
}

interface Crumb {
  stage: ShellStage;
  label: string;
  icon: ReactNode;
  /** Whether this crumb is reachable (e.g. transcript needs a session). */
  enabled: boolean;
}

/** A compact breadcrumb + back control for the narrow single-pane layout. */
function MobileBreadcrumb({
  stage,
  onNavigate,
  projectLabel,
  sessionLabel,
}: {
  stage: ShellStage;
  onNavigate: (stage: ShellStage) => void;
  projectLabel?: string | null;
  sessionLabel?: string | null;
}) {
  const crumbs: Crumb[] = [
    { stage: "projects", label: "Projects", icon: <Folder className="h-3.5 w-3.5" />, enabled: true },
    {
      stage: "sessions",
      label: projectLabel || "Sessions",
      icon: <MessagesSquare className="h-3.5 w-3.5" />,
      enabled: !!projectLabel,
    },
    {
      stage: "transcript",
      label: sessionLabel || "Transcript",
      icon: <FileText className="h-3.5 w-3.5" />,
      enabled: !!sessionLabel,
    },
  ];
  const order: ShellStage[] = ["projects", "sessions", "transcript"];
  const idx = order.indexOf(stage);
  const back = idx > 0 ? order[idx - 1] : null;

  return (
    <div className="glass-chrome flex items-center gap-1.5 border-x-0 border-t-0 px-3 py-1.5 lg:hidden">
      {back ? (
        <button
          onClick={() => onNavigate(back)}
          className="mr-0.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-[var(--dh-text-muted)] transition hover:bg-[var(--dh-hover)] hover:text-[var(--dh-text-strong)]"
          aria-label="Back"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <nav className="flex min-w-0 items-center gap-1 text-[12px]" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <span key={c.stage} className="flex min-w-0 items-center gap-1">
            {i > 0 ? <ChevronRight className="h-3 w-3 shrink-0 text-[var(--dh-text-dim)]" /> : null}
            <button
              onClick={() => c.enabled && onNavigate(c.stage)}
              disabled={!c.enabled}
              className={cn(
                "inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 transition",
                c.stage === stage
                  ? "bg-[var(--dh-rail-active)] font-medium text-[var(--dh-brand)]"
                  : c.enabled
                    ? "text-[var(--dh-text-muted)] hover:bg-[var(--dh-hover)] hover:text-[var(--dh-text)]"
                    : "cursor-default text-[var(--dh-text-dim)]",
              )}
              aria-current={c.stage === stage ? "page" : undefined}
            >
              {c.icon}
              <span className="truncate">{c.label}</span>
            </button>
          </span>
        ))}
      </nav>
    </div>
  );
}

/**
 * Lay out the three Browse panes responsively.
 *
 * - Wide (≥ lg): the panes render side by side in a flex row, identical to the
 *   prior hard-coded layout — each child keeps owning its own width.
 * - Narrow: only the active `stage` pane shows (full width), topped by a
 *   breadcrumb to move between Projects → Sessions → Transcript.
 *
 * Each pane is passed as a node so the host wires its real props; ResponsiveShell
 * only owns visibility and the mobile chrome.
 */
export function ResponsiveShell({
  stage,
  onNavigate,
  projects,
  sessions,
  transcript,
  projectLabel,
  sessionLabel,
}: {
  stage: ShellStage;
  onNavigate: (stage: ShellStage) => void;
  projects: ReactNode;
  sessions: ReactNode;
  transcript: ReactNode;
  /** Label for the Sessions crumb (the active project's name). */
  projectLabel?: string | null;
  /** Label for the Transcript crumb (the open session's title). */
  sessionLabel?: string | null;
}) {
  return (
    <div className="dh-aurora-bg--soft flex min-h-0 flex-1 flex-col">
      <MobileBreadcrumb
        stage={stage}
        onNavigate={onNavigate}
        projectLabel={projectLabel}
        sessionLabel={sessionLabel}
      />
      <div className="flex min-h-0 min-w-0 flex-1">
        {/*
         * Each pane sits in a wrapper that OWNS its column geometry on wide
         * viewports: projects=w-72 (288px), sessions=w-80 (320px), transcript takes
         * the remaining flex space. The wrappers are real flex columns (never
         * `display: contents`) — the old `lg:contents` + `lg:[&>*]:w-auto` pattern
         * let the panes' intrinsic content width win inside the DevHubShell
         * `dh-transcript-col` host, blowing the columns past the viewport and
         * collapsing the transcript to 0px. The single pane child fills its wrapper
         * (`w-full` + `lg:flex-1`). On narrow, the wrapper controls single-pane
         * visibility: only the active stage shows, at full width.
         */}
        <div
          className={cn(
            "min-h-0 [&>*]:w-full lg:flex lg:w-72 lg:flex-none lg:flex-col lg:[&>*]:min-h-0 lg:[&>*]:flex-1",
            // Glass panel with a violet seam on wide (§3.8) — reads as its own pane.
            "lg:border-r lg:border-[var(--dh-glass-border)] lg:bg-[var(--dh-glass-bg)]",
            stage === "projects" ? "flex flex-1 flex-col" : "hidden",
          )}
        >
          {projects}
        </div>
        <div
          className={cn(
            "min-h-0 [&>*]:w-full lg:flex lg:w-80 lg:flex-none lg:flex-col lg:[&>*]:min-h-0 lg:[&>*]:flex-1",
            "lg:border-r lg:border-[var(--dh-glass-border)] lg:bg-[var(--dh-glass-bg)]",
            stage === "sessions" ? "flex flex-1 flex-col" : "hidden",
          )}
        >
          {sessions}
        </div>
        <div
          className={cn(
            "min-h-0 min-w-0 [&>*]:min-w-0 [&>*]:w-full lg:flex lg:min-w-0 lg:flex-1 lg:flex-col lg:[&>*]:min-h-0 lg:[&>*]:flex-1",
            stage === "transcript" ? "flex flex-1 flex-col" : "hidden",
          )}
        >
          {transcript}
        </div>
      </div>
    </div>
  );
}
