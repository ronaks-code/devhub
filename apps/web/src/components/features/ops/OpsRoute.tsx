import { type ReactNode } from "react";
import type { RunningSession, SessionSummary } from "../../../lib/types.js";
import { LiveOpsBoard } from "../../LiveOpsBoard.js";
import { isSettingsSecondaryApplied, resolveSettingsSecondaryMode } from "../settings/SettingsRoute.js";

/**
 * OpsRoute — routes the preserved `LiveOpsBoard` (`surface-inventory.md` `RT-04`),
 * per `component-state-matrix.md` §13's rest rule: "Ops/Inbox/Dashboard stay
 * secondary utilities, not task-home cards." Gated by the SAME `settingsSecondary`
 * flag as `SettingsRoute` — this is one slice, not four independent ones.
 *
 * The `SecondaryNav` text strip this route used to wrap around the board is GONE
 * (Aurora shell QA F2/M9): it duplicated destinations the icon rail already owns
 * and its links weren't wired, so it read as a second, dead navigation system —
 * worst inside Ops→Board, where it sat UNDER the Grid/Board/Drive toggle. The
 * icon rail is the ONE owner of Settings/Live ops/Inbox/Dashboard now.
 *
 * SCOPE (honest): the board's CONTENT is the preserved `LiveOpsBoard`, reused
 * unchanged (not rewritten) — every current running/needs-you/refresh/open-session
 * behavior stays exactly as shipped.
 */
export function OpsRoute({
  running,
  sessions,
  onOpenSession,
  onRefresh,
}: {
  running?: RunningSession[] | null;
  sessions?: readonly SessionSummary[];
  onOpenSession?: (cwd: string | null, sessionId: string) => void;
  onRefresh?: () => void;
}): ReactNode {
  return (
    <LiveOpsBoard running={running} sessions={sessions} onOpenSession={onOpenSession} onRefresh={onRefresh} />
  );
}

export { isSettingsSecondaryApplied, resolveSettingsSecondaryMode };
