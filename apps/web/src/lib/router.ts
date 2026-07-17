import { useEffect, useRef, useState } from "react";

/**
 * Dependency-free deep-link routing. We reflect the current view in the URL's
 * query string so a copied URL reopens the same place, and so the browser's
 * back/forward buttons walk the navigation history.
 *
 * Plain words: the address bar becomes a bookmark for "where you are" — which
 * tab you're on, which project, which session. Open the link on another machine
 * and you land on the same screen.
 *
 * Shape: `?tab=browse&project=<id>&session=<id>&providerTask=<locator>`. Only the
 * keys that have a value are written, so a bare `/` (no query) is the clean
 * default. Parsing is fully tolerant: unknown tabs fall back to undefined, missing
 * keys are simply absent, and a malformed query never throws (URLSearchParams
 * handles the decoding).
 *
 * `providerTask` carries a serialized `ProviderTaskLocator` — an opaque,
 * path-free handle for a native provider task (no raw filesystem home ever
 * appears in the URL). It is validated on the way in AND out: a malformed locator
 * is dropped, never thrown, so a hand-edited or stale link degrades gracefully
 * instead of crashing the app. Legacy URLs that predate this field parse
 * unchanged (the field is simply absent).
 *
 * No react-router: it's a single useSyncedRoute hook plus two pure helpers, so
 * there's nothing to learn and no bundle cost beyond a few lines.
 */

/** The tabs the URL can address. Kept in lockstep with App's `Tab` union. */
export const ROUTE_TABS = [
  "home",
  "browse",
  "chat",
  "ops",
  "inbox",
  "dashboard",
  "spatial",
  "settings",
  "openai-chat",
  "codex-history",
] as const;

export type RouteTab = (typeof ROUTE_TABS)[number];

/**
 * The slice of app state we mirror in the URL. Every field is optional — a fresh
 * load with no query yields an all-undefined state, and the app keeps its own
 * defaults. `project`/`session` only carry meaning on the Browse/Chat tabs but we
 * preserve whatever is present so a back-nav restores it.
 */
export interface RouteState {
  tab?: RouteTab;
  project?: string | null;
  session?: string | null;
  /**
   * Serialized `ProviderTaskLocator` for a native provider task. Opaque and
   * path-free; validated on parse/build so a malformed value is dropped rather
   * than surfaced. Absent on legacy URLs.
   */
  providerTask?: string | null;
}

function isRouteTab(v: string | null): v is RouteTab {
  return v != null && (ROUTE_TABS as readonly string[]).includes(v);
}

/**
 * Grammar of a serialized `ProviderTaskLocator`, mirrored from the engine's
 * `serializeTaskLocator` (`packages/engine/src/provider-index/identity.ts`):
 * `pt1.<provider>.<64-hex-fingerprint>.<base64url-native-id>`, at most 1024
 * chars, no whitespace, no NUL. Validated locally so the browser bundle stays
 * free of the engine's Node-only locator module (which imports `node:fs`); the
 * server's facade re-validates against the exact provider registry. The router's
 * job is only to keep a malformed/opaque token out of the URL, never to parse it.
 * router.test.ts feeds a genuinely engine-serialized locator through this to
 * guard against grammar drift.
 */
const MAX_LOCATOR_CHARS = 1_024;
const SERIALIZED_LOCATOR =
  /^pt1\.[a-z][a-z0-9-]*\.[0-9a-f]{64}\.[A-Za-z0-9_-]+$/u;

/**
 * Validate a serialized provider-task locator. Returns the (already-canonical)
 * string on success, or null for anything malformed. Never throws — a bad locator
 * in a URL must degrade, not crash.
 */
function normalizeProviderTask(value: string | null | undefined): string | null {
  if (!value || value.length > MAX_LOCATOR_CHARS) return null;
  return SERIALIZED_LOCATOR.test(value) ? value : null;
}

/**
 * Parse a route out of a query string (defaults to `window.location.search`).
 * Tolerant by design: an unknown/absent `tab` is dropped, empty params are
 * treated as absent, and a malformed search string never throws — at worst it
 * yields an empty route. SSR-guarded (returns `{}` with no window).
 */
export function parseRoute(search?: string): RouteState {
  const raw = search ?? (typeof window !== "undefined" ? window.location.search : "");
  const out: RouteState = {};
  try {
    const params = new URLSearchParams(raw);
    const tab = params.get("tab");
    if (isRouteTab(tab)) out.tab = tab;
    const project = params.get("project");
    if (project) out.project = project;
    const session = params.get("session");
    if (session) out.session = session;
    const providerTask = normalizeProviderTask(params.get("providerTask"));
    if (providerTask) out.providerTask = providerTask;
  } catch {
    /* malformed query — fall through to the empty route */
  }
  return out;
}

/**
 * Build the `?…` query string for a route. Omits empty/undefined keys so the URL
 * stays minimal (a default Browse view with no project is just `?tab=browse`, and
 * an all-empty route is the empty string). Order is stable (tab, project, session,
 * providerTask) so consecutive states produce comparable strings (used to skip
 * no-op pushes). A malformed `providerTask` is dropped, never emitted.
 */
export function buildRouteSearch(state: RouteState): string {
  const params = new URLSearchParams();
  if (state.tab) params.set("tab", state.tab);
  if (state.project) params.set("project", state.project);
  if (state.session) params.set("session", state.session);
  const providerTask = normalizeProviderTask(state.providerTask);
  if (providerTask) params.set("providerTask", providerTask);
  const s = params.toString();
  return s ? `?${s}` : "";
}

/**
 * Sync app state to the URL and vice-versa, dependency-free.
 *
 * - On mount it parses the current URL once and hands the caller the initial
 *   route (so the app can restore that project/session/tab).
 * - Each time the caller's `state` changes we `pushState` the new query (so
 *   back/forward works); an identical query is skipped so we never spam history
 *   with no-op entries (e.g. a re-render with the same selection).
 * - A browser back/forward (`popstate`) re-parses the URL and calls `onPop` so
 *   the app can adopt the restored route.
 *
 * The first programmatic update after mount uses `replaceState` so the very first
 * navigation doesn't leave a duplicate of the entry page in history.
 */
export function useUrlRouter(
  state: RouteState,
  onPop: (route: RouteState) => void,
): { initial: RouteState } {
  // Parse the entry URL exactly once. Lazy initializer so it runs before paint
  // and the value is stable across renders.
  const initialRef = useRef<RouteState | null>(null);
  if (initialRef.current === null) initialRef.current = parseRoute();

  // Latest onPop, read by the popstate listener without re-subscribing.
  const onPopRef = useRef(onPop);
  onPopRef.current = onPop;

  // Track the last search string we wrote so we can skip no-op pushes and so the
  // FIRST write replaces (rather than appends to) the entry history entry. Seed
  // it with the entry URL so the first effect run treats the booted URL as
  // already-written: that lets the host adopt an initial route (it parsed via
  // `initial`) WITHOUT this sync effect clobbering the entry URL's session first.
  const lastSearchRef = useRef<string | null>(
    typeof window !== "undefined" ? window.location.search : "",
  );
  const didFirstWriteRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const search = buildRouteSearch(state);
    const current = lastSearchRef.current ?? window.location.search;
    if (search === current) {
      lastSearchRef.current = search;
      return;
    }
    const url = `${window.location.pathname}${search}${window.location.hash}`;
    try {
      if (!didFirstWriteRef.current) {
        // First real navigation replaces the entry so back doesn't return to a
        // stale duplicate of where the app booted.
        window.history.replaceState(null, "", url);
        didFirstWriteRef.current = true;
      } else {
        window.history.pushState(null, "", url);
      }
    } catch {
      /* history API unavailable (sandboxed iframe) — non-fatal, state still works */
    }
    lastSearchRef.current = search;
  }, [state.tab, state.project, state.session, state.providerTask]); // eslint-disable-line react-hooks/exhaustive-deps

  // Adopt back/forward navigations. We update lastSearchRef first so the sync
  // effect above sees the popped URL as "already written" and doesn't push it
  // back onto the stack.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPopState = () => {
      lastSearchRef.current = window.location.search;
      onPopRef.current(parseRoute());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return { initial: initialRef.current };
}

/**
 * A tiny "did the URL ever carry a route?" probe, for callers that want to know
 * whether to honor the URL over their own persisted state on first load. True
 * when any of the routed keys were present in the entry URL.
 */
export function useHadInitialRoute(): boolean {
  const [had] = useState(() => {
    const r = parseRoute();
    return r.tab != null || r.project != null || r.session != null || r.providerTask != null;
  });
  return had;
}
