import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Shared status dot (Aurora Cockpit §1.1E). A 6px circle whose color communicates
 * run state; `running`/`failed` glow, `running` pulses (stilled under reduced motion).
 *
 * Color is NEVER the only signal in the UI — a StatusDot always sits next to a label
 * (session title, column header, live pill), so the dot itself is decorative
 * (`aria-hidden`) by default. Pass `label` when the dot stands alone to expose an
 * accessible name via `role="img"`.
 */
export type StatusKind = "running" | "waiting" | "idle" | "failed";

const KIND_CLASS: Record<StatusKind, string> = {
  running: "dh-status-dot--running",
  waiting: "dh-status-dot--waiting",
  idle: "dh-status-dot--idle",
  failed: "dh-status-dot--failed",
};

export interface StatusDotProps extends React.ComponentProps<"span"> {
  status: StatusKind;
  /** Accessible name; when set the dot is exposed as an image instead of hidden. */
  label?: string;
}

export function StatusDot({ status, label, className, ...props }: StatusDotProps) {
  return (
    <span
      data-slot="status-dot"
      data-status={status}
      className={cn("dh-status-dot", KIND_CLASS[status], className)}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      {...props}
    />
  );
}
