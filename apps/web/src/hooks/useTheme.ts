import { useCallback, useEffect, useMemo, useState } from "react";
import { readCompat, writeCompat } from "../lib/compat-storage";

/**
 * Light / dark / system theming. Mirrors the three-state shape of
 * {@link useReducedMotion}: a stored preference that can DEFER to the OS.
 *
 * The index.css clay tokens (var(--bg) / --panel / --text / …) define both a dark
 * and a light palette keyed off `data-theme` on <html>; this hook owns which one
 * is active. It resolves the preference + the OS `prefers-color-scheme` signal
 * into a concrete "dark" | "light" and writes `data-theme` accordingly so every
 * token-driven surface flips at once — no per-component color hardcoding.
 *
 *   - "system" → follow the OS color scheme (the default).
 *   - "dark"   → force dark regardless of the OS.
 *   - "light"  → force light regardless of the OS.
 *
 * Plain words: a switch that flips the whole app between the dark clay look and a
 * readable light version, or lets your computer decide. Your choice is remembered
 * across reloads, and "system" reacts live if you change your OS appearance.
 *
 * App.tsx ALSO reflects the server-backed `settings.theme` onto the document (it
 * toggles the legacy `.dark` class). This hook is the client-side, instant,
 * localStorage-backed source of truth for the actual rendered palette and runs
 * independently — the two never fight because they write different attributes
 * (`data-theme` here, the `.dark` class there).
 */

export type ThemePreference = "dark" | "light" | "system";

const STORAGE_KEY = "devhub:theme";
const ROOT_ATTR = "data-theme";

const PREFS: readonly ThemePreference[] = ["dark", "light", "system"];

function isThemePreference(v: unknown): v is ThemePreference {
  return typeof v === "string" && (PREFS as readonly string[]).includes(v);
}

/** Read the persisted preference; tolerant of missing/garbage values. */
function readPreference(): ThemePreference {
  const raw = readCompat(STORAGE_KEY);
  return isThemePreference(raw) ? raw : "system";
}

function writePreference(pref: ThemePreference): void {
  writeCompat(STORAGE_KEY, pref);
}

/** Whether the OS currently asks for a dark color scheme. SSR-safe (true). */
function osPrefersDark(): boolean {
  // Default to dark off-DOM: the app has always been dark-only, so a server
  // render / no-matchMedia environment keeps the existing look.
  if (typeof window === "undefined" || !window.matchMedia) return true;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return true;
  }
}

/** Resolve the three-state preference + OS signal into a concrete palette. */
function resolveTheme(pref: ThemePreference, osDark: boolean): "dark" | "light" {
  if (pref === "dark") return "dark";
  if (pref === "light") return "light";
  return osDark ? "dark" : "light"; // "system"
}

export interface Theme {
  /** The effective rendered palette ("dark" | "light"). */
  theme: "dark" | "light";
  /** The user's stored preference (dark / light / system). */
  preference: ThemePreference;
  /** Set the preference explicitly (persisted). */
  setPreference: (pref: ThemePreference) => void;
  /**
   * Cycle the preference dark → light → system → dark. Handy for a single header
   * button that walks the three states on click.
   */
  cyclePreference: () => void;
  /**
   * True if THIS browser already had a stored preference at mount — i.e. the
   * user (or a prior "adopt the server's theme" pass) has explicitly set one
   * before. Callers that want to adopt a server-backed default on first run
   * (e.g. a synced setting) should check this and skip adopting once it's
   * true, so that a later local choice always wins over a stale server value
   * (QA: an explicit header theme toggle got clobbered back on reload by the
   * server-settings adopt effect racing the save).
   */
  hasStoredPreference: boolean;
}

/**
 * Owns the theme decision and keeps the document root `data-theme` attribute in
 * sync so the index.css token palettes apply. Subscribes to OS changes so a
 * "system" preference reacts to the OS appearance flipping while the app is open.
 */
export function useTheme(): Theme {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readPreference());
  const [osDark, setOsDark] = useState<boolean>(() => osPrefersDark());
  // Captured once at mount, BEFORE any "adopt a server default" effect can run,
  // so that check reflects "did the user already choose", not "did we just adopt".
  const [hasStoredPreference, setHasStoredPreference] = useState<boolean>(
    () => isThemePreference(readCompat(STORAGE_KEY)),
  );

  // Track the OS media query live so a "system" preference reacts to changes.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return;
    }
    const onChange = () => setOsDark(mql.matches);
    onChange();
    // addEventListener is the modern API; older Safari only has addListener.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  const theme = resolveTheme(preference, osDark);

  // Reflect the decision onto <html> so the index.css token palettes apply. We
  // always set an explicit value (never remove it): the light palette only takes
  // effect under [data-theme="light"], and pinning "dark" keeps the default look
  // even if the document is reused. Also toggle the legacy `.dark` class so the
  // few Tailwind `dark:` variants in the tree stay coherent with the palette.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.setAttribute(ROOT_ATTR, theme);
    root.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const setPreference = useCallback((pref: ThemePreference) => {
    setPreferenceState(pref);
    writePreference(pref);
    setHasStoredPreference(true);
  }, []);

  const cyclePreference = useCallback(() => {
    setPreferenceState((prev) => {
      const next = PREFS[(PREFS.indexOf(prev) + 1) % PREFS.length]!;
      writePreference(next);
      return next;
    });
    setHasStoredPreference(true);
  }, []);

  return useMemo(
    () => ({ theme, preference, setPreference, cyclePreference, hasStoredPreference }),
    [theme, preference, setPreference, cyclePreference, hasStoredPreference],
  );
}
