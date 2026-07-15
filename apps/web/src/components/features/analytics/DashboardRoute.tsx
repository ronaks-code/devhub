import { type ReactNode } from "react";
import { DashboardPane } from "../../DashboardPane.js";
import { SecondaryNav } from "../shell/SecondaryNav.js";
import { isSettingsSecondaryApplied, resolveSettingsSecondaryMode } from "../settings/SettingsRoute.js";

/**
 * DashboardRoute — routes the preserved `DashboardPane` (`surface-inventory.md`
 * `RT-06`) under secondary navigation instead of as a primary task-home tab, per
 * `component-state-matrix.md` §13's hover rule: "no decorative dashboard lift" and
 * the surface-inventory note "Never move dashboard cards into task shell." Gated
 * by the SAME `settingsSecondary` flag as `SettingsRoute`.
 *
 * SCOPE (honest): the analytics CONTENT is the preserved `DashboardPane`, reused
 * unchanged — every chart/KPI/heatmap stays exactly as shipped. Only its
 * navigation placement changes: it is a secondary destination, never the task
 * canvas.
 */
export function DashboardRoute({
  onOpenSession,
  onOpenProject,
}: {
  onOpenSession?: (projectId: string, sessionId: string) => void;
  onOpenProject?: (projectId: string) => void;
}): ReactNode {
  return (
    <SecondaryNav active="dashboard">
      <DashboardPane onOpenSession={onOpenSession} onOpenProject={onOpenProject} />
    </SecondaryNav>
  );
}

export { isSettingsSecondaryApplied, resolveSettingsSecondaryMode };
