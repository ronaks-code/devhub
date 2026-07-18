import { useEffect, useRef } from "react";
import { onFetchError, type ApiFetchError } from "../lib/api";
import type { ToastItem } from "../components/Toast";

/** Last path segment of a URL (drops the query) for a short, human label. */
function shortPath(url: string): string {
  const noQuery = url.split("?")[0] ?? url;
  return noQuery || url;
}

/** Collapse query variants while keeping methods and endpoint paths distinct. */
export function fetchErrorDedupeKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${shortPath(url)}`;
}

/**
 * Bridge non-401 API fetch failures (from {@link onFetchError}) to the app's Toast
 * system, giving each one a Retry affordance. When a request fails for a reason
 * other than auth (a network blip, a 500), this shows an error toast whose click
 * re-runs the exact failed call; a successful retry quietly dismisses the toast.
 *
 * Plain words: if loading something hiccups, you get a small "couldn't load …,
 * click to retry" toast instead of a silent dead end.
 *
 * Wired once near the app root. `pushToast`/`dismissToast` come from App's toast
 * state (the same stack the SSE `notify` events use). The handler is held in a ref
 * so the subscription set up on mount always calls the latest closure without
 * re-subscribing.
 */
export function useFetchErrorToasts(
  pushToast: (toast: Omit<ToastItem, "id">) => number,
  dismissToast: (id: number) => void,
): void {
  const handlerRef = useRef<(e: ApiFetchError) => void>(() => {});

  handlerRef.current = (e: ApiFetchError) => {
    const label = shortPath(e.url);
    let toastId = -1;
    const onClick = () => {
      // Fire-and-forget the retry: success → drop the toast; failure re-notifies
      // (withFetchErrorNotify reattaches a fresh retry), so a new toast appears.
      e.retry()
        .then(() => dismissToast(toastId))
        .catch(() => {
          /* a repeat failure re-enters onFetchError → a fresh toast */
        });
    };
    toastId = pushToast({
      title: `Couldn't load ${label}`,
      body: "The request failed.",
      level: "error",
      dedupeKey: fetchErrorDedupeKey(e.method, e.url),
      onClick,
      actionLabel: "Retry →",
      // Sticky-ish: give the user time to notice + act on a load failure.
      duration: 8000,
    });
  };

  useEffect(() => onFetchError((e) => handlerRef.current(e)), []);
}
