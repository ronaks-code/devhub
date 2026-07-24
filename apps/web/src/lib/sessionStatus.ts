import type { StatusKind } from "../components/ui/StatusDot.js";

/**
 * Human, accurate label for the sidebar's attention-tier status pill (§3.1v2 inbox).
 *
 * The "attention" tier holds two DISTINCT groups: "Needs you" (a run genuinely
 * waiting on your input) and "Stale" (a run that has gone quiet or whose process
 * exited). The old pill collapsed all of that into "waiting"/"stalled" — and worst,
 * it called a FINISHED/exited session "stalled", which reads as "stuck/crashed"
 * when the run simply ended.
 *
 * `deriveRunStatus` (m6-compose) folds BOTH "process exited" and "stale/silent"
 * into the single `failed` status. The Sidebar recovers the distinction from the
 * `exited` boolean the caller threads onto each `SidebarRow` (m6-compose's
 * `isRunExited`, off the run's real `alive` flag) — NOT by sniffing the reason
 * text, which used to mean a reworded reason line could silently mislabel a run.
 * An exited run reads "Exited"; a still-alive-but-stalled one reads "No response".
 *
 * Returns null when there is no attention-worthy state to badge (running/idle).
 */
export function attentionPillLabel(
  status: StatusKind | undefined,
  exited: boolean | undefined,
): string | null {
  if (status === "waiting") return "Needs you";
  if (status === "failed") {
    // An exited run ENDED — it is not stalled. A non-exited "failed" is the
    // busy-but-silent / stale case, which reads clearest as "no response".
    return exited ? "Exited" : "No response";
  }
  return null;
}
