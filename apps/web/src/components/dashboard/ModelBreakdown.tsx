import { useMemo } from "react";
import { Cpu } from "lucide-react";
import type { ModelStat } from "../../lib/types";
import { compactNumber, formatUsd } from "../../lib/format";
import { cn } from "../../lib/utils";

/**
 * Per-model token & $ breakdown for the Dashboard. Each row is one model with a
 * token bar (relative to the busiest model) and its estimated spend. Sorted by
 * cost descending so the most expensive model leads. Tokens drive the bar width
 * (the natural "how much work" axis); cost is the headline figure on the right.
 */
export function ModelBreakdown({ models }: { models: ModelStat[] }) {
  // Sort a copy by cost (then tokens) descending — never mutate the prop array.
  const sorted = useMemo(
    () => [...models].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens),
    [models],
  );

  if (sorted.length === 0) {
    return <div className="text-[12px] text-zinc-600">No per-model usage yet.</div>;
  }

  const maxTokens = Math.max(1, ...sorted.map((m) => m.tokens));
  const totalCost = sorted.reduce((n, m) => n + m.costUsd, 0);

  return (
    <div className="flex flex-col gap-2.5">
      {sorted.map((m) => {
        const share = totalCost > 0 ? (m.costUsd / totalCost) * 100 : 0;
        return (
          <div key={m.model} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3 text-[12px]">
              <span className="flex min-w-0 items-center gap-1.5">
                <Cpu className="h-3 w-3 shrink-0 text-violet-400" />
                <span className="truncate font-medium text-zinc-200" title={m.model}>
                  {m.model}
                </span>
                <span className="shrink-0 text-[10.5px] text-zinc-600">
                  {m.sessions} session{m.sessions === 1 ? "" : "s"}
                </span>
              </span>
              <span className="flex shrink-0 items-baseline gap-2 tabular-nums text-zinc-500">
                <span
                  className="text-violet-300/90"
                  title={`estimated cost · ${share.toFixed(0)}% of spend`}
                >
                  {formatUsd(m.costUsd)}
                </span>
                <span title="total tokens">{compactNumber(m.tokens)}</span>
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-zinc-900 ring-1 ring-zinc-800">
              <div
                className={cn("h-full rounded-full bg-violet-500")}
                style={{ width: `${(m.tokens / maxTokens) * 100}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
