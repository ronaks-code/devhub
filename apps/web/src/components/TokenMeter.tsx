import { Coins, Gauge } from "lucide-react";
import type { TokenStatusData } from "../lib/ws";
import { compactNumber, formatUsd } from "../lib/format";
import { costUsd as estimateCost } from "../lib/pricing";
import { cn } from "../lib/utils";

/**
 * A small live "how much is this turn costing" meter, fed by the enriched
 * `{kind:"tokens", data}` status frame during a running turn.
 *
 * Plain words: while Claude is working, this shows roughly how many tokens it's
 * burned and the running dollar estimate — and, when we know the model's context
 * window, how full the context is (a thin bar). It's a gut-check readout, not
 * billing truth. Cost prefers a server-provided `costUsd`; otherwise it's
 * estimated from the token counts + the model's list price (same pricing the
 * dashboard uses).
 */
export function TokenMeter({
  data,
  model,
  className,
}: {
  data: TokenStatusData;
  /** Fallback model id for pricing/context when the status omits one. */
  model?: string | null;
  className?: string;
}) {
  const input = data.inputTokens ?? 0;
  const output = data.outputTokens ?? 0;
  const cacheRead = data.cacheReadTokens ?? 0;
  const cacheCreate = data.cacheCreationTokens ?? 0;
  const total = input + output + cacheRead + cacheCreate;

  const effModel = data.model ?? model ?? null;

  // Prefer a server-provided running cost; otherwise estimate from usage + price.
  const cost =
    typeof data.costUsd === "number"
      ? data.costUsd
      : estimateCost(effModel, {
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheCreate,
        });

  // "% of context" — only when we know the window. Input + cache-read is what's
  // actually occupying the context window (output is generated, not resident).
  const ctxUsed = input + cacheRead;
  const ctxPct =
    data.contextWindow && data.contextWindow > 0
      ? Math.min(100, Math.round((ctxUsed / data.contextWindow) * 100))
      : null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2.5 rounded-md bg-zinc-800/60 px-2 py-0.5 text-[11px] tabular-nums text-zinc-400 ring-1 ring-zinc-700/50",
        className,
      )}
      title={`Live turn usage — ${compactNumber(total)} tokens` +
        (data.costUsd == null ? " (cost estimated from list price)" : "")}
    >
      <span className="flex items-center gap-1">
        <Gauge className="h-3 w-3 text-clay-400" />
        <span className="font-medium text-zinc-300">{compactNumber(total)}</span>
        <span className="text-zinc-600">tok</span>
      </span>
      <span className="flex items-center gap-1">
        <Coins className="h-3 w-3 text-emerald-400/80" />
        <span className="font-medium text-emerald-300/90">{formatUsd(cost)}</span>
      </span>
      {ctxPct != null ? (
        <span className="flex items-center gap-1.5" title="Context window used">
          <span className="h-1.5 w-12 overflow-hidden rounded-full bg-zinc-700">
            <span
              className={cn(
                "block h-full rounded-full",
                ctxPct >= 90 ? "bg-red-500" : ctxPct >= 70 ? "bg-amber-500" : "bg-clay-500",
              )}
              style={{ width: `${ctxPct}%` }}
            />
          </span>
          <span className="text-zinc-500">{ctxPct}%</span>
        </span>
      ) : null}
    </span>
  );
}
