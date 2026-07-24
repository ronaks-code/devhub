import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { providerFromModel } from "./features/ops/opsHelpers";

/**
 * ModelBadge — a compact, honest model indicator: a small provider mark plus a
 * clean, human model name (e.g. an Anthropic sunburst + "Opus 4.8", or the
 * OpenAI mark + "GPT-5.4"). It replaces the raw, useless id/label string (like
 * "Anthropic · Claude" or "claude-opus-4-8") the composer footer used to show.
 *
 * Provider detection reuses the SAME `providerFromModel` the Live Ops surfaces
 * use, so the mark can never disagree with a chip elsewhere. An unrecognized id
 * renders no mark (never a wrong one) and just shows the cleaned name.
 */

/** Family tokens that identify an Anthropic (Claude) model id. */
const CLAUDE_FAMILIES = new Set(["opus", "sonnet", "haiku", "fable"]);

/** Known OpenAI tier/variant tokens, mapped to their display casing. */
const OPENAI_TIERS: Record<string, string> = {
  mini: "Mini",
  nano: "Nano",
  turbo: "Turbo",
  pro: "Pro",
  preview: "Preview",
  codex: "Codex",
};

function titleCase(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/**
 * Derive a clean, human model name from a raw id. Strips date stamps and
 * bracket/paren tags, title-cases the family, and keeps the version number:
 *   "claude-opus-4-8"          → "Opus 4.8"
 *   "claude-fable-5"           → "Fable 5"
 *   "claude-haiku-4-5-2025..." → "Haiku 4.5"
 *   "gpt-5.4"                  → "GPT-5.4"
 *   "gpt-5.4-mini"             → "GPT-5.4 Mini"
 *   "gpt-5-codex"              → "GPT-5 Codex"
 */
export function formatModelName(model: string | null | undefined): string {
  if (!model) return "Model";
  // Drop bracket/paren tags like "[1m]" or "(preview)" before tokenizing.
  const cleaned = model.replace(/[[(][^)\]]*[)\]]/g, "").trim();
  if (!cleaned) return "Model";
  const tokens = cleaned.toLowerCase().split(/[\s_-]+/).filter(Boolean);
  const isDate = (t: string) => /^\d{6,}$/.test(t); // e.g. 20251001
  const isVer = (t: string) => /^\d+(?:\.\d+)*$/.test(t); // 4, 5, 5.4

  // Anthropic (Claude): "claude-opus-4-8" → "Opus 4.8".
  const famIdx = tokens.findIndex((t) => CLAUDE_FAMILIES.has(t));
  if (famIdx >= 0) {
    const family = titleCase(tokens[famIdx]!);
    const version = tokens
      .slice(famIdx + 1)
      .filter((t) => isVer(t) && !isDate(t))
      .join(".");
    return version ? `${family} ${version}` : family;
  }

  // OpenAI GPT: "gpt-5.4" → "GPT-5.4", "gpt-5.4-mini" → "GPT-5.4 Mini".
  const gptIdx = tokens.indexOf("gpt");
  if (gptIdx >= 0) {
    const version: string[] = [];
    const extra: string[] = [];
    for (const t of tokens.slice(gptIdx + 1)) {
      if (isDate(t)) continue;
      if (isVer(t)) version.push(t);
      else extra.push(OPENAI_TIERS[t] ?? titleCase(t));
    }
    const head = version.length ? `GPT-${version.join(".")}` : "GPT";
    return [head, ...extra].join(" ");
  }

  // o-series reasoning models: "o3", "o4-mini".
  if (/^o\d/.test(tokens[0]!)) {
    const head = tokens[0]!.toUpperCase();
    const extra = tokens
      .slice(1)
      .filter((t) => !isDate(t))
      .map((t) => OPENAI_TIERS[t] ?? titleCase(t));
    return [head, ...extra].join(" ");
  }

  // Bare Codex, else a title-cased fallback (never the raw date stamp).
  if (tokens.includes("codex")) return "Codex";
  return tokens.filter((t) => !isDate(t)).map(titleCase).join(" ") || "Model";
}

/**
 * The Claude / Anthropic mark — a tasteful sunburst approximation drawn as
 * radiating spokes, inheriting the passed color. Purely decorative (aria-hidden);
 * the readable model name sits beside it.
 */
function AnthropicMark({ className }: { className?: string }): ReactNode {
  const rays = 12;
  const cx = 12;
  const cy = 12;
  const inner = 3;
  const outer = 10;
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
    >
      {Array.from({ length: rays }).map((_, i) => {
        const a = (i / rays) * Math.PI * 2;
        return (
          <line
            key={i}
            x1={(cx + Math.cos(a) * inner).toFixed(2)}
            y1={(cy + Math.sin(a) * inner).toFixed(2)}
            x2={(cx + Math.cos(a) * outer).toFixed(2)}
            y2={(cy + Math.sin(a) * outer).toFixed(2)}
          />
        );
      })}
    </svg>
  );
}

/** The OpenAI mark (official interlocking-knot logomark), inheriting color. */
function OpenAIMark({ className }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="currentColor">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062l-4.833 2.792a4.504 4.504 0 0 1-6.15-1.647zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071.006l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071-.006l4.83 2.785a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 7.23V4.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zM8.3 12.863l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

export interface ModelBadgeProps {
  /** Raw model id (e.g. "claude-opus-4-8", "gpt-5.4"). */
  model?: string | null;
  /** Optional reasoning-effort tier, appended as "· High". */
  effort?: string | null;
  /** Extra classes for the badge root. */
  className?: string;
}

/** Provider mark + clean model name (+ optional effort), compact and polished. */
export function ModelBadge({ model, effort, className }: ModelBadgeProps): ReactNode {
  const provider = providerFromModel(model);
  const name = formatModelName(model);
  const label = effort ? `${name} · ${titleCase(effort)}` : name;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-[var(--dh-text)]",
        className,
      )}
      data-dh-model-badge=""
      title={model ?? undefined}
    >
      {provider === "anthropic" ? (
        <AnthropicMark className="h-3.5 w-3.5 shrink-0 text-[#d97757]" />
      ) : provider === "openai" ? (
        <OpenAIMark className="h-3.5 w-3.5 shrink-0 text-[var(--dh-text)]" />
      ) : null}
      <span className="truncate">{label}</span>
    </span>
  );
}
