import type { ReactNode } from "react";
import { ErrorBoundary } from "../../ErrorBoundary.js";
import { DevHubShell, type ShellChromeMode, type ShellStatus } from "./DevHubShell.js";

/**
 * Chrome composition seam for the M6 strangler cutover. `App.tsx` builds the header,
 * rail content, and main panes, then hands them here; this file owns ONLY the choice
 * between the legacy chrome and the new `DevHubShell`, keyed by the `shellChrome`
 * slice flag.
 *
 * - `mode === "legacy"` reproduces the exact current structure byte-for-byte (skip
 *   link, `TopBar` slot, `ErrorBoundary`, `#main-content` main landmark, the `w-44`
 *   primary-navigation rail, and the flexible main content column). It returns a
 *   fragment so the caller's outer `flex h-full flex-col` wrapper and overlay
 *   siblings stay exactly where they are today. This is the immediate,
 *   non-destructive rollback surface and stays live by default.
 * - `mode === "devhub"` mounts `DevHubShell` with the same slots. It is instantiated
 *   ONLY in this branch, so flag-off never builds the new tree.
 */

// Byte-for-byte copies of the current App.tsx chrome classes so flag-off output is
// unchanged. Do not "clean these up" — they must match the legacy render exactly.
const LEGACY_SKIP_LINK_CLASS =
  "sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-2 focus:z-[80] focus:rounded-md focus:bg-clay-500 focus:px-3 focus:py-1.5 focus:text-[12px] focus:font-medium focus:text-white focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-clay-500/50";
const LEGACY_RAIL_CLASS =
  "flex w-44 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950 py-2";
const LEGACY_MAIN_CONTENT_CLASS = "flex min-w-0 flex-1 flex-col";

export interface AppShellProps {
  mode: ShellChromeMode;
  /** Coarse activity state forwarded to DevHubShell (geometry is invariant). */
  status?: ShellStatus;
  /** Thin header content (currently the legacy `TopBar`). */
  header: ReactNode;
  /** Accessible name of the primary-navigation landmark. */
  railLabel?: string;
  /** Rail content (the open list of destinations), without its own nav wrapper. */
  rail: ReactNode;
  /** When true, the rail slot owns its chrome (Sidebar cockpit); forwarded to DevHubShell. */
  chromeless?: boolean;
  /** Ambient status bar under the main surface (devhub only). */
  statusBar?: ReactNode;
  /** Main content panes (the tab-routed body). */
  children: ReactNode;
}

export function AppShell({
  mode,
  status = "rest",
  header,
  railLabel = "Primary navigation",
  rail,
  chromeless,
  statusBar,
  children,
}: AppShellProps) {
  if (mode === "devhub") {
    return (
      <DevHubShell
        status={status}
        header={header}
        railLabel={railLabel}
        rail={rail}
        chromeless={chromeless}
        statusBar={statusBar}
      >
        {children}
      </DevHubShell>
    );
  }

  return (
    <>
      {/* Skip link: first focusable element, hidden until focused, jumps past the
          top bar into the main content. */}
      <a href="#main-content" className={LEGACY_SKIP_LINK_CLASS}>
        Skip to main content
      </a>
      {header}
      <ErrorBoundary>
        {/* Main landmark + skip-link target. tabIndex={-1} lets the skip link move
            focus here without adding it to the Tab order. */}
        <div id="main-content" role="main" tabIndex={-1} className="flex min-h-0 flex-1 outline-none">
          <nav aria-label={railLabel} className={LEGACY_RAIL_CLASS}>
            {rail}
          </nav>
          <div className={LEGACY_MAIN_CONTENT_CLASS}>{children}</div>
        </div>
      </ErrorBoundary>
    </>
  );
}
