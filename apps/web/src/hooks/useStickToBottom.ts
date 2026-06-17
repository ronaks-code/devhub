import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Auto-scroll a streaming/live list to the bottom — but ONLY while the user is
 * already parked near the bottom. The moment they scroll up to read history we
 * stop forcing scroll (so we never yank them back down) and surface a flag so
 * the caller can show a "jump to latest" pill. Pressing it re-pins and snaps to
 * the bottom.
 *
 * Why a hook (vs. inline refs): ChatPane and TranscriptPane both need the exact
 * same "follow only when pinned" behavior over a tanstack virtualizer. Sharing
 * it keeps the rule (and the 64px threshold) in one place.
 *
 * Usage with a virtualizer:
 *   const stick = useStickToBottom(scrollRef);
 *   <div ref={scrollRef} onScroll={stick.onScroll}>…</div>
 *   // when the list grows / a delta streams in:
 *   useEffect(() => stick.followToIndex(() => v.scrollToIndex(last, {align:"end"})),
 *             [last, liveLen, stick.followToIndex]);
 *   {stick.showJumpToLatest && <button onClick={() => stick.scrollToLatest(() => …)} />}
 */

/** Distance (px) from the bottom within which we consider the user "pinned". */
const PIN_THRESHOLD = 64;

export interface StickToBottom {
  /** True while the user is parked near the bottom (auto-follow is active). */
  isPinned: boolean;
  /** True when the user has scrolled up and there is newer content below. */
  showJumpToLatest: boolean;
  /** Attach to the scroll container's onScroll to keep `isPinned` current. */
  onScroll: () => void;
  /**
   * Run `scroll` (e.g. virtualizer.scrollToIndex(last,{align:"end"})) ONLY when
   * pinned. Returns a cleanup that cancels the queued rAF. Designed to be the
   * full body of a useEffect so following happens on the next frame after paint.
   */
  followToIndex: (scroll: () => void) => (() => void) | void;
  /**
   * Re-pin and jump to the bottom now (the "jump to latest" action). Pass the
   * scroll call to run on the next frame.
   */
  scrollToLatest: (scroll: () => void) => void;
  /** Force-pin without scrolling (e.g. when a fresh turn/session starts). */
  pin: () => void;
  /**
   * Force-unpin without scrolling. Used when we deliberately scroll to a
   * mid-history position (e.g. a search jump) so the live-follow effect doesn't
   * immediately yank the view back to the tail.
   */
  unpin: () => void;
}

/**
 * @param scrollRef the scrollable container element ref.
 * @param hasNewContentBelow optional signal that there IS unseen content below
 *        (so the pill only shows when there's actually something to jump to).
 *        Defaults to true — most live lists always grow downward.
 */
export function useStickToBottom(
  scrollRef: React.RefObject<HTMLElement | null>,
  hasNewContentBelow = true,
): StickToBottom {
  // The source of truth lives in a ref so reads during a scroll-follow effect
  // are synchronous and don't depend on a re-render landing first.
  const pinnedRef = useRef(true);
  const [isPinned, setIsPinned] = useState(true);

  const setPinned = useCallback((v: boolean) => {
    if (pinnedRef.current === v) return;
    pinnedRef.current = v;
    setIsPinned(v);
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(distance < PIN_THRESHOLD);
  }, [scrollRef, setPinned]);

  const pin = useCallback(() => {
    setPinned(true);
  }, [setPinned]);

  const unpin = useCallback(() => {
    setPinned(false);
  }, [setPinned]);

  const followToIndex = useCallback((scroll: () => void): (() => void) | void => {
    if (!pinnedRef.current) return;
    const id = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(id);
  }, []);

  const scrollToLatest = useCallback(
    (scroll: () => void) => {
      setPinned(true);
      requestAnimationFrame(scroll);
    },
    [setPinned],
  );

  // Re-evaluate pinning whenever the container resizes (e.g. composer grows,
  // window resize) so the pill state stays accurate without a manual scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => onScroll());
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef, onScroll]);

  return {
    isPinned,
    showJumpToLatest: !isPinned && hasNewContentBelow,
    onScroll,
    followToIndex,
    scrollToLatest,
    pin,
    unpin,
  };
}
