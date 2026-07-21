import { type ReactNode } from "react";
import { DashboardPane } from "../../DashboardPane.js";
import { isSettingsSecondaryApplied, resolveSettingsSecondaryMode } from "../settings/SettingsRoute.js";

/**
 * DashboardRoute — routes the preserved `DashboardPane` (`surface-inventory.md`
 * `RT-06`), per `component-state-matrix.md` §13's hover rule: "no decorative
 * dashboard lift" and the surface-inventory note "Never move dashboard cards into
 * task shell." Gated by the SAME `settingsSecondary` flag as `SettingsRoute`.
 *
 * The `SecondaryNav` text strip this route used to wrap around the pane is GONE
 * (Aurora shell QA F2/M9): it duplicated destinations the icon rail already owns
 * and its links weren't wired, so it read as a second, dead navigation system.
 * The icon rail is the ONE owner of Settings/Live ops/Inbox/Dashboard now.
 *
 * SCOPE (honest): the analytics CONTENT is the preserved `DashboardPane`, reused
 * unchanged — every chart/KPI/heatmap stays exactly as shipped.
 */
export function DashboardRoute({
  onOpenSession,
  onOpenProject,
}: {
  onOpenSession?: (projectId: string, sessionId: string) => void;
  onOpenProject?: (projectId: string) => void;
}): ReactNode {
  return <DashboardPane onOpenSession={onOpenSession} onOpenProject={onOpenProject} />;
}

export { isSettingsSecondaryApplied, resolveSettingsSecondaryMode };
