import { useCallback, useEffect, useMemo, useState } from "react";
import { readCompat, writeCompat } from "../lib/compat-storage";

/**
 * "Perf mode" / reduced motion. Two inputs decide whether non-essential
 * animation runs:
 *   1. The OS `prefers-reduced-motion` media query (respected automatically).
 *   2. A manual toggle the user flips in the UI, persisted in localStorage.
 *
 * When either says "reduce", we set `data-reduce-motion="true"` on <html>; the
 * rules in index.css then near-instant any decorative transition/animation
 * (the streaming caret blink, skeleton shimmer, smooth-scroll, hover fades).
 *
 * Plain words: a switch that calms the UI down — no blinking, no shimmer, no
 * sliding — for people who get motion sick or who want a snappier, cheaper feel.
 * Essential feedback (a spinner that means "working") is intentionally left
 * alone; only decoration is gated.
 *
 * The manual toggle is three-state so it can DEFER to the OS by default:
 *   - "auto"  → follow the OS preference (the default).
 *   - "on"    → force reduced motion regardless of the OS.
 *   - "off"   → force full motion regardless of the OS.
 */

export type PerfPreference = "auto" | "on" | "off";

const STORAGE_KEY = "devhub:perf-mode";
const ROOT_ATTR = "data-reduce-motion";

const PREFS: readonly PerfPreference[] = ["auto", "on", "off"];

function isPerfPreference(v: unknown): v is PerfPreference {
  return typeof v === "string" && (PREFS as readonly string[]).includes(v);
}

/** Read the persisted preference; tolerant of missing/garbage values. */
function readPreference(): PerfPreference {
  const raw = readCompat(STORAGE_KEY);
  return isPerfPreference(raw) ? raw : "auto";
}

function writePreference(pref: PerfPreference): void {
  writeCompat(STORAGE_KEY, pref);
}

/** Whether the OS currently asks for reduced motion. SSR-safe (false). */
function osPrefersReduced(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Resolve the three-state preference + OS signal into a single boolean. */
function resolveReduced(pref: PerfPreference, osReduced: boolean): boolean {
  if (pref === "on") return true;
  if (pref === "off") return false;
  return osReduced; // "auto"
}

export interface ReducedMotion {
  /** The effective decision: true means decorative motion is suppressed. */
  reduced: boolean;
  /** The user's stored preference (auto / on / off). */
  preference: PerfPreference;
  /** Set the preference explicitly (persisted). */
  setPreference: (pref: PerfPreference) => void;
  /**
   * Cycle the preference auto → on → off → auto. Handy for a single header
   * button that walks the three states on click.
   */
  cyclePreference: () => void;
}

/**
 * Owns the reduced-motion decision and keeps the document root attribute in sync
 * so CSS can key off it. Subscribes to OS changes so toggling the system setting
 * while the app is open takes effect live (when the preference is "auto").
 */
export function useReducedMotion(): ReducedMotion {
  const [preference, setPreferenceState] = useState<PerfPreference>(() => readPreference());
  const [osReduced, setOsReduced] = useState<boolean>(() => osPrefersReduced());

  // Track the OS media query live so an "auto" preference reacts to system changes.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      return;
    }
    const onChange = () => setOsReduced(mql.matches);
    onChange();
    // addEventListener is the modern API; older Safari only has addListener.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  const reduced = resolveReduced(preference, osReduced);

  // Reflect the decision onto <html> so index.css rules apply globally. Removing
  // the attr entirely when motion is allowed keeps the DOM clean.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (reduced) root.setAttribute(ROOT_ATTR, "true");
    else root.removeAttribute(ROOT_ATTR);
  }, [reduced]);

  const setPreference = useCallback((pref: PerfPreference) => {
    setPreferenceState(pref);
    writePreference(pref);
  }, []);

  const cyclePreference = useCallback(() => {
    setPreferenceState((prev) => {
      const next = PREFS[(PREFS.indexOf(prev) + 1) % PREFS.length]!;
      writePreference(next);
      return next;
    });
  }, []);

  return useMemo(
    () => ({ reduced, preference, setPreference, cyclePreference }),
    [reduced, preference, setPreference, cyclePreference],
  );
}
