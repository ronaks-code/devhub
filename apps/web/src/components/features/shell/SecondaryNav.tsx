import { type ReactNode } from "react";

/**
 * SecondaryNav — the shared secondary-navigation landmark for M6 Task 8's
 * `SettingsRoute`/`OpsRoute`/`InboxRoute`/`DashboardRoute` (`design-lock.md` §8 /
 * `component-state-matrix.md` §13 / `surface-inventory.md` `RT-04`..`RT-07`).
 *
 * `component-state-matrix.md` §13 rest-state rule: "Ops/Inbox/Dashboard stay
 * secondary utilities, not task-home cards." Today those three panes (plus
 * Settings) are mounted as PRIMARY tabs in `App.tsx`'s w-44 rail, alongside
 * `home`/`browse` — structurally indistinguishable from the task-home surface.
 * This component is the canonical secondary destination list so a later mount
 * (Task 9's `codexStyleShell` cutover) can relocate all four underneath it,
 * instead of leaving them as primary siblings of the task canvas.
 */

export type SecondaryDestinationId = "settings" | "ops" | "inbox" | "dashboard";

export const SECONDARY_DESTINATIONS: ReadonlyArray<{
  id: SecondaryDestinationId;
  label: string;
}> = Object.freeze([
  { id: "settings", label: "Settings" },
  { id: "ops", label: "Live ops" },
  { id: "inbox", label: "Inbox" },
  { id: "dashboard", label: "Dashboard" },
]);

/** True only for the four secondary destinations this slice governs. */
export function isSecondaryDestination(id: string): id is SecondaryDestinationId {
  return SECONDARY_DESTINATIONS.some((d) => d.id === id);
}

export function SecondaryNav({
  active,
  onNavigate,
  children,
}: {
  active: SecondaryDestinationId;
  /** Present so a future data-wire can route without this component knowing how. */
  onNavigate?: (id: SecondaryDestinationId) => void;
  children?: ReactNode;
}): ReactNode {
  return (
    <nav aria-label="Secondary" className="dh-secondary-nav" data-dh-secondary-nav="">
      <ul role="list" className="dh-secondary-nav-list">
        {SECONDARY_DESTINATIONS.map((d) => {
          const isActive = d.id === active;
          return (
            <li key={d.id}>
              <button
                type="button"
                aria-current={isActive ? "page" : undefined}
                className="dh-secondary-nav-link"
                data-dh-secondary-active={isActive ? "true" : "false"}
                onClick={() => onNavigate?.(d.id)}
              >
                {d.label}
              </button>
            </li>
          );
        })}
      </ul>
      {children}
    </nav>
  );
}
