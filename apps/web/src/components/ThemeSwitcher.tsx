import { Moon, Sun, MonitorSmartphone } from "lucide-react";
import type { ThemePreference } from "../hooks/useTheme";
import { cn } from "../lib/utils";

/**
 * A single header button that cycles the theme dark → light → system. Mirrors the
 * perf/reduced-motion toggle's shape exactly: an icon button that shows the NEXT
 * action's intent via its current-state icon, tinted clay while a non-default
 * (here: light) palette is active so the choice reads at a glance.
 *
 * Plain words: one little button up top. Click it to flip the whole app between
 * the dark look, a light look, and "follow my computer". The icon shows where you
 * are — moon for dark, sun for light, a phone/monitor for system.
 *
 * Theming itself lives in {@link useTheme} (preference + OS resolution +
 * `data-theme` on <html>); this is just the affordance, so the host owns the
 * hook and passes the three values down — keeping it trivially testable and free
 * of side effects.
 */

/** Icon + label/title for each preference, for the cycling button. */
const THEME_META: Record<ThemePreference, { label: string; title: string }> = {
  dark: { label: "Theme: dark", title: "Dark theme — click for light" },
  light: { label: "Theme: light", title: "Light theme — click to follow your OS" },
  system: {
    label: "Theme: system",
    title: "Theme follows your OS — click to force dark",
  },
};

export function ThemeSwitcher({
  preference,
  theme,
  onCycle,
  className,
}: {
  /** The user's stored preference (dark / light / system). */
  preference: ThemePreference;
  /** The resolved palette currently rendered ("dark" | "light"). */
  theme: "dark" | "light";
  /** Advance the preference one step (dark → light → system → dark). */
  onCycle: () => void;
  className?: string;
}) {
  const Icon =
    preference === "system" ? MonitorSmartphone : preference === "light" ? Sun : Moon;
  // Tint when a non-default palette is in effect (light), matching how the perf
  // toggle tints while motion is being suppressed.
  const active = theme === "light";
  return (
    <button
      onClick={onCycle}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md p-1 transition",
        active
          ? "bg-clay-500/15 text-clay-300 ring-1 ring-clay-500/30"
          : "text-zinc-500 hover:text-zinc-300",
        className,
      )}
      title={THEME_META[preference].title}
      aria-label={THEME_META[preference].label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
