import { ArrowDownToLine, ArrowUpFromLine, Clock, Coins, Cpu, Database } from "lucide-react";
import type { TurnResult } from "@claude-ui/engine/driver";
import { compactNumber, formatUsd } from "../lib/format";
import { costUsd as estimateCost } from "../lib/pricing";
import { cn } from "../lib/utils";

/** Format a millisecond duration compactly: "820ms", "4.2s", "1m 12s". */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

/** One compact stat: an icon, a value, and a muted unit/label. */
function Stat({
  icon,
  value,
  label,
  title,
  className,
}: {
  icon: React.ReactNode;
  value: string;
  label?: string;
  title: string;
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1 tabular-nums", className)} title={title}>
      <span className="text-zinc-600">{icon}</span>
      <span className="font-medium">{value}</span>
      {label ? <span className="text-zinc-600">{label}</span> : null}
    </span>
  );
}

/**
 * A per-turn footer summarizing the just-finished turn from its {t:"result"}
 * payload: cost ($), tokens (input / output / cache), duration, and model.
 *
 * Plain words: after Claude finishes answering, this little strip tells you how
 * much that turn cost, how many tokens it used (split into what you sent, what it
 * wrote, and what came from cache), how long it took, and which model ran it.
 *
 * Cost prefers the server-provided `result.costUsd`; when that's zero/absent
 * (some servers don't fill it on a per-turn basis) it falls back to estimating
 * from the usage + the model's list price — the same pricing the dashboard and
 * live TokenMeter use. Duration comes from the host's measured turn time
 * (`durationMs`), falling back to a `durationMs` the server may include on the
 * result. Renders nothing when there's no usage and no cost to show.
 */
export function TurnFooter({
  result,
  /** Model the turn ran on (ChatPane's selected model); used for pricing + display. */
  model,
  /** Client-measured turn duration in ms (start of prompt → result). */
  durationMs,
  className,
}: {
  result: TurnResult;
  model?: string | null;
  durationMs?: number;
  className?: string;
}) {
  const usage = result.usage;
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  const cache = (usage?.cacheReadTokens ?? 0) + (usage?.cacheCreationTokens ?? 0);

  // Prefer the server's cost; otherwise estimate from usage + the model's price.
  const cost =
    result.costUsd && result.costUsd > 0
      ? result.costUsd
      : usage
        ? estimateCost(model, usage)
        : 0;
  // The result may carry a model id and/or a duration on servers that enrich it;
  // read both defensively (the engine TurnResult types neither today).
  const enriched = result as TurnResult & { model?: string | null; durationMs?: number };
  const effModel = enriched.model ?? model ?? null;
  const dur = durationMs ?? enriched.durationMs;

  // Nothing meaningful to show (no usage, no cost) → render nothing rather than
  // an empty strip. The host already shows cost/denials in its status footer.
  const hasUsage = input > 0 || output > 0 || cache > 0;
  if (!hasUsage && cost <= 0) return null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500",
        className,
      )}
    >
      <Stat
        icon={<Coins className="h-3 w-3 text-emerald-400/80" />}
        value={formatUsd(cost)}
        title={
          result.costUsd && result.costUsd > 0
            ? "Turn cost (reported by the server)"
            : "Turn cost (estimated from list price)"
        }
        className="text-emerald-300/90"
      />
      {hasUsage ? (
        <>
          <Stat
            icon={<ArrowUpFromLine className="h-3 w-3" />}
            value={compactNumber(input)}
            label="in"
            title={`${input.toLocaleString()} input tokens`}
          />
          <Stat
            icon={<ArrowDownToLine className="h-3 w-3" />}
            value={compactNumber(output)}
            label="out"
            title={`${output.toLocaleString()} output tokens`}
          />
          {cache > 0 ? (
            <Stat
              icon={<Database className="h-3 w-3" />}
              value={compactNumber(cache)}
              label="cache"
              title={
                `${cache.toLocaleString()} cache tokens ` +
                `(${(usage?.cacheReadTokens ?? 0).toLocaleString()} read, ` +
                `${(usage?.cacheCreationTokens ?? 0).toLocaleString()} write)`
              }
            />
          ) : null}
        </>
      ) : null}
      {dur != null ? (
        <Stat
          icon={<Clock className="h-3 w-3" />}
          value={formatDuration(dur)}
          title="Turn duration"
        />
      ) : null}
      {effModel ? (
        <Stat
          icon={<Cpu className="h-3 w-3" />}
          value={effModel}
          title={`Model: ${effModel}`}
          className="text-zinc-400"
        />
      ) : null}
    </div>
  );
}
