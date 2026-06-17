import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Coins,
  Hourglass,
  OctagonX,
  ServerCrash,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/utils";

/**
 * Turn a raw turn/result/system `subtype` into a short HUMAN label + a tone + an
 * icon, so the UI shows "Hit the max-turns limit" instead of `error_max_turns`.
 *
 * Plain words: Claude Code reports how a turn ended with a terse code like
 * `error_max_budget_usd`. This maps those codes (and a few system/rate-limit ones)
 * to a friendly phrase, a color tone, and a matching icon, so anywhere we used to
 * print the raw code can read clearly instead.
 *
 * Pure data → no React state. {@link statusMeta} does the mapping; {@link StatusLabel}
 * is a tiny chip that renders it. The rate-limit/overload/budget subtypes here match
 * the engine's `rate-limit` classifier by STRING (we don't import engine symbols, so
 * web typecheck never depends on another lane's in-flight types).
 */

/** How serious / what color a status reads as. */
export type StatusTone = "ok" | "warn" | "error" | "info";

export interface StatusMeta {
  /** Short human label, e.g. "Hit the max-turns limit". */
  label: string;
  tone: StatusTone;
  /** Optional icon for a chip; omitted for the neutral/clean case where none fits. */
  icon?: LucideIcon;
  /** Longer hover explanation (falls back to the label). */
  title?: string;
}

// Per-tone chip styling (background tint + ring + text), keyed by tone.
const TONE_CLASS: Record<StatusTone, string> = {
  ok: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/25",
  warn: "bg-amber-500/10 text-amber-300 ring-amber-500/25",
  error: "bg-red-500/10 text-red-300 ring-red-500/25",
  info: "bg-zinc-500/10 text-zinc-300 ring-zinc-500/25",
};

/**
 * Map a known subtype string to its {@link StatusMeta}. Matches on the exact subtype
 * the CLI/engine reports plus a few defensive `includes` for the spellings that have
 * drifted across versions (budget, rate-limit). Returns null for an UNKNOWN subtype
 * so callers can decide whether to show a raw fallback or nothing — keeping this
 * additive (it never forces a label onto a status it doesn't understand).
 */
export function statusMeta(subtype: string | null | undefined): StatusMeta | null {
  if (!subtype) return null;
  const s = subtype.toLowerCase();

  // Clean completion.
  if (s === "success") {
    return { label: "Completed", tone: "ok", icon: CheckCircle2, title: "The turn finished cleanly" };
  }

  // User / external stop.
  if (s === "interrupted" || s === "stopped" || s === "aborted" || s === "cancelled" || s === "canceled") {
    return { label: "Stopped", tone: "warn", icon: OctagonX, title: "The turn was stopped before it finished" };
  }

  // Spend ceiling — match the engine's BUDGET_SUBTYPES set + any *max_budget* spelling.
  if (
    s === "error_max_budget_usd" ||
    s === "error_max_budget" ||
    s === "error_budget_exceeded" ||
    s === "max_budget" ||
    s.includes("max_budget") ||
    s.includes("budget")
  ) {
    return {
      label: "Hit the spend limit",
      tone: "error",
      icon: Coins,
      title: "Stopped: hit the configured max budget for this run",
    };
  }

  // Rate-limit (HTTP 429 family) — engine RateLimitReason "rate_limit".
  if (s === "rate_limit" || s.includes("rate_limit") || s.includes("rate limit") || s === "error_rate_limit") {
    return {
      label: "Rate limited",
      tone: "warn",
      icon: Hourglass,
      title: "Stopped: the API rate limit was hit — try again shortly",
    };
  }

  // Transient API overload (HTTP 529) — engine RateLimitReason "overloaded".
  if (s === "overloaded" || s.includes("overload")) {
    return {
      label: "API overloaded",
      tone: "warn",
      icon: ServerCrash,
      title: "Stopped: the API was transiently overloaded — try again shortly",
    };
  }

  // Max-turns ceiling.
  if (s === "error_max_turns") {
    return {
      label: "Hit the max-turns limit",
      tone: "error",
      icon: Ban,
      title: "Stopped: the turn reached its max-turns limit",
    };
  }

  // Timeout.
  if (s === "error_timeout" || s.includes("timeout")) {
    return { label: "Timed out", tone: "error", icon: Clock, title: "Stopped: the turn timed out" };
  }

  // Generic execution error.
  if (s === "error_during_execution") {
    return {
      label: "Error during execution",
      tone: "error",
      icon: AlertTriangle,
      title: "Stopped: an error occurred while running the turn",
    };
  }

  // Bare / unrecognized error family — still meaningful as a generic error.
  if (s === "error" || s.startsWith("error_") || s.startsWith("error")) {
    return { label: "Turn failed", tone: "error", icon: AlertTriangle, title: "The turn ended with an error" };
  }

  return null;
}

/**
 * A compact status chip rendered from a subtype. Falls back to the raw subtype text
 * (neutral tone, no icon) for an unknown subtype unless `hideUnknown` is set, in
 * which case it renders nothing — so it can replace a raw `{subtype}` print without
 * ever losing information, or be a no-op for the clean case.
 */
export function StatusLabel({
  subtype,
  className,
  hideUnknown,
  showIcon = true,
}: {
  subtype: string | null | undefined;
  className?: string;
  /** Render nothing (instead of the raw subtype) when the subtype isn't recognized. */
  hideUnknown?: boolean;
  /** Show the tone icon (default true). */
  showIcon?: boolean;
}) {
  const meta = statusMeta(subtype);
  if (!meta) {
    if (hideUnknown || !subtype) return null;
    return (
      <span
        title={subtype}
        className={cn(
          "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1",
          TONE_CLASS.info,
          className,
        )}
      >
        {subtype}
      </span>
    );
  }
  const Icon = meta.icon;
  return (
    <span
      title={meta.title ?? meta.label}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1",
        TONE_CLASS[meta.tone],
        className,
      )}
    >
      {showIcon && Icon ? <Icon className="h-3 w-3" /> : null}
      {meta.label}
    </span>
  );
}
