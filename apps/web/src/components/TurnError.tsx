import { AlertTriangle, RotateCcw, X } from "lucide-react";

/**
 * An inline error card shown in the chat when a turn fails — either an
 * {t:"error"} socket frame (connection/driver error) or a result whose
 * `isError` is set (the turn ran but ended in an error subtype). Surfaces the
 * message and a Retry button that resends the last prompt (resuming the
 * session), plus a dismiss affordance.
 *
 * Rendered above the composer (not in the virtualized message list) so it stays
 * pinned + visible regardless of scroll, mirroring how PermissionCard mounts.
 */
export function TurnError({
  message,
  subtype,
  onRetry,
  onDismiss,
}: {
  /** Human-readable error text (the socket error message or result text). */
  message: string;
  /** Optional result `subtype` (e.g. "error_max_turns") for a precise label. */
  subtype?: string;
  /** Resend the last prompt for a fresh attempt. Hidden when there's nothing to retry. */
  onRetry?: () => void;
  /** Dismiss the card without retrying. */
  onDismiss?: () => void;
}) {
  return (
    <div className="border-t border-red-900/50 bg-red-500/5 px-5 py-3">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] font-semibold text-red-300">
              {subtype && subtype !== "error" ? labelForSubtype(subtype) : "Turn failed"}
            </span>
            {onDismiss ? (
              <button
                onClick={onDismiss}
                aria-label="Dismiss error"
                title="Dismiss"
                className="ml-auto inline-flex items-center justify-center rounded-md p-1 text-red-400/70 transition hover:bg-red-500/10 hover:text-red-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-red-200/90">
            {message || "Something went wrong running this turn."}
          </p>
          {onRetry ? (
            <button
              onClick={onRetry}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-red-500/15 px-2.5 py-1 text-[12px] font-medium text-red-200 ring-1 ring-red-500/30 transition hover:bg-red-500/25 hover:text-red-100"
              title="Resend the last prompt (resumes the session)"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Retry
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Friendly label for a known result error subtype. */
function labelForSubtype(subtype: string): string {
  switch (subtype) {
    case "error_max_turns":
      return "Hit the max-turns limit";
    case "error_during_execution":
      return "Error during execution";
    default:
      return "Turn failed";
  }
}
