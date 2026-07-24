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
 * The Sidebar only has the derived `StatusKind` + the composed `reason` line to work
 * from (the raw `alive`/`stale`/`exited` flags live upstream in m6-compose's
 * `deriveRunStatus`, which folds BOTH "process exited" and "stale/silent" into the
 * single `failed` status). So we recover the honest distinction from the reason text
 * m6-compose already wrote, and never label an exited run "stalled".
 *
 * Returns null when there is no attention-worthy state to badge (running/idle).
 */
export function attentionPillLabel(
  status: StatusKind | undefined,
  reason: string | undefined,
): string | null {
  if (status === "waiting") return "Needs you";
  if (status === "failed") {
    // An exited run ENDED — it is not stalled. A non-exited "failed" is the
    // busy-but-silent / stale case, which reads clearest as "no response".
    if (reason && /exit/i.test(reason)) return "Exited";
    return "No response";
  }
  return null;
}
