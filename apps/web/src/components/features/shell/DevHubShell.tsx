import { Component, type ErrorInfo, type ReactNode } from "react";
import type { DevHubFeatureFlags } from "@devhub/engine/providers";

/**
 * DevHubShell — the locked Codex-style application chrome (M6 slice 1).
 *
 * This is the measured container/geometry frame from `design-lock.md` §4 and
 * `design-system.md` §3: a 273-unit left rail, a 46-unit header, an open `#181818`
 * canvas with no page card, route content using the full canvas, capped 736-unit
 * thread/composer children, and a
 * 300-unit content-height inspector dock (in a 316-unit lane = 300 + 16 right
 * gutter). It owns the shell landmarks (one `main`, a named rail `navigation`, an
 * optional named `complementary` inspector) plus the skip link and the `DevHub`
 * wordmark. It does NOT own provider data, transcript, or composer behavior — those
 * arrive as slots so later M6 slices (TaskRail, TaskHeader, ThreadWorkspace,
 * Composer, InspectorDock) can be extracted into the slots one at a time.
 *
 * Geometry is driven by the `--dh-*` tokens in `index.css` (never invented here);
 * the numeric `data-dh-*` attributes below mirror the locked measured values so
 * geometry tests can assert them without a layout engine.
 */

export type ShellStatus = "rest" | "loading" | "streaming";

/**
 * Locked wide-reference geometry (logical CSS px), transcribed from `design-lock.md`
 * §4 and `reference-capture-manifest.md` "Measured wide-shell geometry". Exported so
 * geometry tests assert the measured dimensions against a single source of truth.
 */
export const SHELL_GEOMETRY = Object.freeze({
  windowWidth: 1800,
  windowHeight: 1130,
  railWidth: 273,
  railCollapsedWidth: 48,
  headerHeight: 46,
  canvasColor: "#181818",
  transcriptWidth: 736,
  composerWidth: 736,
  composerHeight: 98,
  composerBottomGutter: 16,
  inspectorWidth: 300,
  inspectorLaneWidth: 316,
  inspectorTopGutter: 12,
  inspectorRightGutter: 16,
  inspectorRadius: 16,
  composerRadius: 21,
  shellGutter: 16,
  selectedRowWidth: 256,
  selectedRowHeight: 30,
  railInset: 8,
  userBubbleMax: 566,
  narrowBreakpoint: 1024,
} as const);

/** The shell gives routes the full canvas; capped thread geometry belongs to ThreadWorkspace. */
export const SHELL_LAYOUT = Object.freeze({ routeHost: "full-width" } as const);

/** Product wordmark. Never a provider wordmark (design-lock §3, invariant 9). */
export const SHELL_BRAND = "DevHub";

/**
 * Region-scoped error boundary. A provider/data failure inside the canvas or
 * inspector is caught here so the rest of the shell (rail, header, brand,
 * navigation, the other region) keeps rendering — provider failure is isolated to
 * its region, never the whole app (design-lock §4 / M6 Task 1 DoD, invariant 3).
 */
export class RegionBoundary extends Component<
  { children?: ReactNode; fallback?: ReactNode; onError?: (error: Error) => void },
  { hasError: boolean }
> {
  override state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError?.(error);
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}

export interface DevHubShellProps {
  /** Brand wordmark. Defaults to `DevHub`; a provider wordmark is never accepted. */
  brand?: string;
  /** Coarse activity state. Geometry is invariant across all values. */
  status?: ShellStatus;
  /** Skip-link target + main landmark id. */
  mainId?: string;
  /** Accessible name for the rail navigation landmark. */
  railLabel?: string;
  /** Rail content (an open list of destinations); rendered inside the shell's own nav. */
  rail?: ReactNode;
  /** Thin header content (title/identity/actions). Rendered inside the 46-unit header. */
  header?: ReactNode;
  /** Route canvas content. Thread routes own their measured inner content cap. */
  children?: ReactNode;
  /** Bottom-anchored composer content on the shared 736 column. Omit to hide the slot. */
  composer?: ReactNode;
  /** Inspector dock content. Omit to render no complementary region (stage stays put). */
  inspector?: ReactNode;
  /** Accessible name for the inspector complementary landmark. */
  inspectorLabel?: string;
  /** Fallback shown if the canvas region throws (provider-failure isolation). */
  canvasFallback?: ReactNode;
  /** Fallback shown if the inspector region throws. */
  inspectorFallback?: ReactNode;
}

export function DevHubShell({
  brand = SHELL_BRAND,
  status = "rest",
  mainId = "dh-main",
  railLabel = "Primary navigation",
  rail,
  header,
  children,
  composer,
  inspector,
  inspectorLabel = "Task inspector",
  canvasFallback,
  inspectorFallback,
}: DevHubShellProps) {
  const busy = status === "loading" || status === "streaming";
  return (
    <div className="dh-shell" data-dh-shell="" data-dh-status={status}>
      <a className="dh-skip-link" href={`#${mainId}`}>
        Skip to main content
      </a>

      <nav
        className="dh-rail"
        aria-label={railLabel}
        data-dh-rail=""
        data-dh-width={SHELL_GEOMETRY.railWidth}
      >
        <div className="dh-brand" data-dh-brand="">
          {brand}
        </div>
        <div className="dh-rail-content">{rail}</div>
      </nav>

      <div className="dh-frame">
        <div
          className="dh-header"
          data-dh-header=""
          data-dh-height={SHELL_GEOMETRY.headerHeight}
        >
          {header}
        </div>

        <div className="dh-body">
          <main
            id={mainId}
            role="main"
            tabIndex={-1}
            className="dh-canvas"
            data-dh-canvas=""
            data-dh-canvas-color={SHELL_GEOMETRY.canvasColor}
            data-dh-gutter={SHELL_GEOMETRY.shellGutter}
            aria-busy={busy || undefined}
          >
            <div
              className="dh-transcript-col"
              data-dh-transcript=""
              data-dh-route-host={SHELL_LAYOUT.routeHost}
            >
              <RegionBoundary fallback={canvasFallback}>{children}</RegionBoundary>
            </div>
            {composer !== undefined ? (
              <div
                className="dh-composer-slot"
                data-dh-composer=""
                data-dh-width={SHELL_GEOMETRY.composerWidth}
                data-dh-height={SHELL_GEOMETRY.composerHeight}
                data-dh-bottom-gutter={SHELL_GEOMETRY.composerBottomGutter}
              >
                {composer}
              </div>
            ) : null}
          </main>

          {inspector !== undefined ? (
            <aside
              role="complementary"
              aria-label={inspectorLabel}
              className="dh-inspector-lane"
              data-dh-inspector-lane=""
              data-dh-lane-width={SHELL_GEOMETRY.inspectorLaneWidth}
              data-dh-top-gutter={SHELL_GEOMETRY.inspectorTopGutter}
              data-dh-right-gutter={SHELL_GEOMETRY.inspectorRightGutter}
            >
              <div
                className="dh-inspector"
                data-dh-inspector=""
                data-dh-inspector-width={SHELL_GEOMETRY.inspectorWidth}
                data-dh-radius={SHELL_GEOMETRY.inspectorRadius}
              >
                <RegionBoundary fallback={inspectorFallback}>{inspector}</RegionBoundary>
              </div>
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export type ShellChromeMode = "devhub" | "legacy";

/**
 * Slice-flag gate. `shellChrome` defaults true, so the first paint should be the
 * new chrome — NOT the legacy chrome flashed while `/api/settings` is still null
 * (that flash is what read as "two apps"). So missing/undefined settings resolve to
 * `devhub`; only an EXPLICIT stored `shellChrome: false` selects the legacy chrome,
 * which stays the immediate, non-destructive rollback surface.
 */
export function resolveShellChromeMode(
  settings: { devHubFeatures?: Partial<DevHubFeatureFlags> } | null | undefined,
): ShellChromeMode {
  return settings?.devHubFeatures?.shellChrome === false ? "legacy" : "devhub";
}

/** True only when the shell-chrome slice flag is applied. */
export function isShellChromeApplied(
  features: Partial<DevHubFeatureFlags> | undefined,
): boolean {
  return features?.shellChrome === true;
}
