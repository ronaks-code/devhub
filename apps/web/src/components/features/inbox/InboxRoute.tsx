import { type ReactNode } from "react";
import { InboxPane } from "../../InboxPane.js";
import { SecondaryNav } from "../shell/SecondaryNav.js";
import { isSettingsSecondaryApplied, resolveSettingsSecondaryMode } from "../settings/SettingsRoute.js";

/**
 * InboxRoute — routes the preserved `InboxPane` (`surface-inventory.md` `RT-05`)
 * under secondary navigation instead of as a primary task-home tab. Gated by the
 * SAME `settingsSecondary` flag as `SettingsRoute`.
 *
 * SCOPE (honest): the triage CONTENT is the preserved `InboxPane`, reused unchanged
 * — tag/pin/archive/refresh behavior stays exactly as shipped. Only its navigation
 * placement changes.
 */
export function InboxRoute({
  onOpenSession,
}: {
  onOpenSession?: (projectId: string, sessionId: string) => void;
}): ReactNode {
  return (
    <SecondaryNav active="inbox">
      <InboxPane onOpenSession={onOpenSession} />
    </SecondaryNav>
  );
}

export { isSettingsSecondaryApplied, resolveSettingsSecondaryMode };
