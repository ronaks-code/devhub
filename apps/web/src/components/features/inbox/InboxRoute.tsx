import { type ReactNode } from "react";
import { InboxPane } from "../../InboxPane.js";
import { isSettingsSecondaryApplied, resolveSettingsSecondaryMode } from "../settings/SettingsRoute.js";

/**
 * InboxRoute — routes the preserved `InboxPane` (`surface-inventory.md` `RT-05`).
 * Gated by the SAME `settingsSecondary` flag as `SettingsRoute`.
 *
 * The `SecondaryNav` text strip this route used to wrap around the pane is GONE
 * (Aurora shell QA F2/M9): it duplicated destinations the icon rail already owns
 * and its links weren't wired, so it read as a second, dead navigation system.
 * The icon rail is the ONE owner of Settings/Live ops/Inbox/Dashboard now.
 *
 * SCOPE (honest): the triage CONTENT is the preserved `InboxPane`, reused unchanged
 * — tag/pin/archive/refresh behavior stays exactly as shipped.
 */
export function InboxRoute({
  onOpenSession,
}: {
  onOpenSession?: (projectId: string, sessionId: string) => void;
}): ReactNode {
  return <InboxPane onOpenSession={onOpenSession} />;
}

export { isSettingsSecondaryApplied, resolveSettingsSecondaryMode };
