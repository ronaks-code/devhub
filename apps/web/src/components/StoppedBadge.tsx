import { OctagonX } from "lucide-react";
import { cn } from "../lib/utils";
import { StatusLabel, statusMeta } from "./StatusLabel";

/**
 * A small "stopped" badge marking a turn that was interrupted or ended in an
 * error subtype — i.e. it did NOT run to a clean finish.
 *
 * Plain words: when you hit Stop on a running answer, or Claude bailed out (hit
 * the max-turns limit, errored mid-execution, …), this little amber chip says so
 * right in the transcript so a half-finished turn doesn't look like a normal one.
 *
 * Purely presentational: the caller decides WHEN a turn counts as stopped (see
 * {@link isStoppedSubtype} / {@link stoppedReason}) and just renders this when so.
 *
 * When the caller passes the result `subtype` and it maps to a known status (via
 * {@link statusMeta}), this renders the precise {@link StatusLabel} chip ("Hit the
 * max-turns limit", "Hit the spend limit", "Rate limited", …) instead of the generic
 * amber "stopped" pill — clearer at a glance. The `subtype` prop is additive: callers
 * that pass only `reason` keep the original chip.
 */
export function StoppedBadge({
  reason,
  subtype,
  className,
}: {
  /** Short explanation shown on hover (e.g. "Interrupted", "Hit the max-turns limit"). */
  reason?: string;
  /** Optional result `subtype` — when recognized, drives a precise StatusLabel chip. */
  subtype?: string | null;
  className?: string;
}) {
  // A recognized subtype reads better as its specific status label.
  if (subtype && statusMeta(subtype)) {
    return <StatusLabel subtype={subtype} className={className} />;
  }
  return (
    <span
      title={reason ?? "This turn was stopped before it finished."}
      className={cn(
        "inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300 ring-1 ring-amber-500/25",
        className,
      )}
    >
      <OctagonX className="h-3 w-3" />
      stopped
    </span>
  );
}

/**
 * Whether a {@link import("@devhub/engine/driver").TurnResult} `subtype` means
 * the turn was stopped rather than completing cleanly. Claude Code uses "success"
 * for a clean finish and an `error_*` family for everything else; a plain "error"
 * (socket-level) also counts. Anything else is treated as a normal completion.
 */
export function isStoppedSubtype(subtype: string | undefined | null): boolean {
  if (!subtype) return false;
  return subtype === "error" || subtype.startsWith("error_");
}

/** Friendly hover reason for a known stopped subtype (falls back to a generic line). */
export function stoppedReason(subtype: string | undefined | null): string {
  switch (subtype) {
    case "error_max_turns":
      return "Stopped: hit the max-turns limit";
    case "error_during_execution":
      return "Stopped: error during execution";
    case "error":
      return "Stopped: the turn ended with an error";
    default:
      return "This turn was stopped before it finished.";
  }
}
