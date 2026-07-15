import { type ReactNode } from "react";
import { LiveOpsBoard } from "../../LiveOpsBoard.js";
import { SecondaryNav } from "../shell/SecondaryNav.js";
import { isSettingsSecondaryApplied, resolveSettingsSecondaryMode } from "../settings/SettingsRoute.js";

/**
 * OpsRoute — routes the preserved `LiveOpsBoard` (`surface-inventory.md` `RT-04`)
 * under secondary navigation instead of as a primary task-home tab, per
 * `component-state-matrix.md` §13's rest rule: "Ops/Inbox/Dashboard stay secondary
 * utilities, not task-home cards." Gated by the SAME `settingsSecondary` flag as
 * `SettingsRoute` — this is one slice, not four independent ones.
 *
 * SCOPE (honest): the board's CONTENT is the preserved `LiveOpsBoard`, reused
 * unchanged (not rewritten) — every current running/needs-you/refresh/open-session
 * behavior stays exactly as shipped. Only its navigation placement changes.
 */
export function OpsRoute({
  onOpenSession,
}: {
  onOpenSession?: (cwd: string | null, sessionId: string) => void;
}): ReactNode {
  return (
    <SecondaryNav active="ops">
      <LiveOpsBoard onOpenSession={onOpenSession} />
    </SecondaryNav>
  );
}

export { isSettingsSecondaryApplied, resolveSettingsSecondaryMode };
