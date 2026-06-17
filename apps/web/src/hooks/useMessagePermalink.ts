import { useCallback, useEffect } from "react";

/**
 * The `data-msg-id` attribute messages tag themselves with so the permalink hook
 * can find them. Keep this in lockstep between the component (MessageView) and
 * the hook. A message exposes BOTH its uuid and its seq under this attribute via
 * {@link messageAnchorProps}, so either form of hash resolves to the same node.
 */
export const MSG_ID_ATTR = "data-msg-id";

/** The transient class that drives the flash animation (see index.css). */
const FLASH_CLASS = "permalink-flash";

/**
 * Parse the target message id out of a URL hash. Supports:
 *   - `#<uuid>`        → match by message uuid
 *   - `#seq-<n>`       → match by 0-based sequence index (explicit form)
 *   - `#<n>`           → bare number, also treated as a seq
 * Returns the normalized list of candidate ids to look up (we tag each message
 * with both its uuid and `seq-<n>`), or null when the hash is empty.
 */
function parseHash(hash: string): string[] | null {
  const raw = hash.replace(/^#/, "").trim();
  if (!raw) return null;
  // A bare integer is shorthand for a seq; normalize to the `seq-<n>` token we tag.
  if (/^\d+$/.test(raw)) return [`seq-${raw}`];
  return [raw];
}

/** Build the value(s) a message should expose under `data-msg-id`. */
export function messageAnchorId(uuid: string | null, seq: number): string {
  // Prefer the stable uuid when present; always also reachable via `seq-<n>`.
  return uuid ?? `seq-${seq}`;
}

/**
 * Props a message wrapper spreads so it's reachable by permalink. We pack both
 * the uuid and `seq-<n>` into a space-separated `data-msg-id` so a hash of either
 * form resolves (the hook matches against the token list). `id` is also set to
 * the uuid (when present) for native `:target` / browser scroll-on-load.
 */
export function messageAnchorProps(uuid: string | null, seq: number) {
  const tokens = uuid ? `${uuid} seq-${seq}` : `seq-${seq}`;
  return { [MSG_ID_ATTR]: tokens, ...(uuid ? { id: uuid } : {}) } as const;
}

/** Find the element whose `data-msg-id` token list contains `id`. */
function findMessageEl(id: string): HTMLElement | null {
  // Exact match (single-token nodes) or token within a space-separated list.
  return (
    document.querySelector<HTMLElement>(`[${MSG_ID_ATTR}="${CSS.escape(id)}"]`) ??
    document.querySelector<HTMLElement>(`[${MSG_ID_ATTR}~="${CSS.escape(id)}"]`)
  );
}

/** Scroll an element into view (centered) and flash it. */
function revealAndFlash(el: HTMLElement) {
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  // Restart the animation if it's already flashing (re-click of the same link).
  el.classList.remove(FLASH_CLASS);
  // Force reflow so removing+adding re-triggers the keyframes.
  void el.offsetWidth;
  el.classList.add(FLASH_CLASS);
  const onEnd = () => el.classList.remove(FLASH_CLASS);
  el.addEventListener("animationend", onEnd, { once: true });
}

/**
 * Deep-link to a message via the URL hash (`#<uuid>` or `#seq-<n>`). On mount and
 * on every `hashchange`, resolves the hash to a tagged message element, scrolls
 * to it, and briefly flashes it. Because transcripts are virtualized the target
 * node may not be mounted yet, so we retry on a short interval before giving up.
 *
 * Returns `{ copyPermalink }` — a helper that writes a shareable URL (with the
 * message hash) to the clipboard, for the per-message "copy link" affordance.
 *
 * `deps` lets a host re-run the scroll attempt when its content changes (e.g.
 * after a session's page loads), so a permalink opened in a fresh tab lands once
 * the messages exist. Self-contained: no router, no virtualizer coupling.
 */
export function useMessagePermalink(deps: ReadonlyArray<unknown> = []) {
  // Resolve the current hash to an element and reveal it, retrying while the
  // (possibly virtualized) target mounts.
  const tryReveal = useCallback(() => {
    const ids = parseHash(window.location.hash);
    if (!ids) return () => {};
    let attempts = 0;
    const maxAttempts = 20; // ~2s at 100ms — covers async page loads.
    const tick = () => {
      for (const id of ids) {
        const el = findMessageEl(id);
        if (el) {
          revealAndFlash(el);
          return true;
        }
      }
      return false;
    };
    if (tick()) return () => {};
    const timer = window.setInterval(() => {
      attempts++;
      if (tick() || attempts >= maxAttempts) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, []);

  // Initial resolution + re-run when host content changes.
  useEffect(() => {
    const cancel = tryReveal();
    return cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tryReveal, ...deps]);

  // Re-resolve whenever the hash itself changes (clicking a permalink in-page).
  useEffect(() => {
    const onHash = () => tryReveal();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [tryReveal]);

  /**
   * Copy a shareable permalink to a message. Sets `location.hash` (so the link is
   * live immediately in this tab and the back/forward history records it) and
   * copies the full URL to the clipboard. Falls back gracefully when the
   * Clipboard API is unavailable (older/insecure contexts) by still updating the
   * hash. Returns whether the clipboard write succeeded.
   */
  const copyPermalink = useCallback(async (uuid: string | null, seq: number): Promise<boolean> => {
    const anchor = messageAnchorId(uuid, seq);
    const url = `${window.location.origin}${window.location.pathname}${window.location.search}#${anchor}`;
    // Update the hash without triggering our own hashchange scroll-jump for the
    // node the user is already looking at: replaceState avoids a history spam,
    // and we intentionally don't call tryReveal here.
    try {
      window.history.replaceState(null, "", `#${anchor}`);
    } catch {
      window.location.hash = anchor;
    }
    try {
      await navigator.clipboard?.writeText(url);
      return true;
    } catch {
      return false;
    }
  }, []);

  return { copyPermalink };
}
