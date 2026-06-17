import { useCallback, useEffect, useRef, useState } from "react";

export interface UseListKeyboardNavOptions {
  /** Number of items in the list. The focused index is always clamped to this. */
  count: number;
  /** Called when the user presses Enter (or Space) on the focused item. */
  onSelect?: (index: number) => void;
  /**
   * When provided, the focused item is scrolled into view on every change. Maps
   * an item index to its DOM element (e.g. from a ref array). Optional.
   */
  getItemElement?: (index: number) => HTMLElement | null | undefined;
}

export interface UseListKeyboardNavResult {
  /** The currently focused row index, or -1 when nothing is focused. */
  focusedIndex: number;
  /** Set the focused index directly (e.g. on hover/mouse-enter). Clamps to range. */
  setFocusedIndex: (index: number) => void;
  /**
   * Spread onto the scrollable list container. Makes it focusable and routes
   * j/k, ArrowUp/Down, Home/End, and Enter/Space through the navigator.
   */
  containerProps: {
    tabIndex: 0;
    role: "listbox";
    onKeyDown: (e: React.KeyboardEvent) => void;
  };
  /**
   * Per-row props: marks the active row for aria + lets a mouse hover move the
   * keyboard focus so the two input modes stay in sync. Spread onto each item.
   */
  getItemProps: (index: number) => {
    role: "option";
    "aria-selected": boolean;
    "data-focused": boolean;
    onMouseEnter: () => void;
  };
}

/**
 * Reusable keyboard navigation for a vertical list: j/k and Arrow keys move a
 * highlight, Home/End jump to the ends, and Enter/Space select. Purely additive
 * — it never calls preventDefault on keys it doesn't own, and mouse clicks keep
 * working because selection still flows through each row's own onClick.
 *
 * The hook owns a `focusedIndex` (the highlighted row); hovering a row syncs it
 * so the highlight follows the mouse too. Selection is reported via `onSelect`.
 */
export function useListKeyboardNav({
  count,
  onSelect,
  getItemElement,
}: UseListKeyboardNavOptions): UseListKeyboardNavResult {
  const [focusedIndex, setFocusedIndexState] = useState(-1);
  // Keep the latest values in refs so the keydown handler stays stable.
  const countRef = useRef(count);
  const onSelectRef = useRef(onSelect);
  const getElRef = useRef(getItemElement);
  countRef.current = count;
  onSelectRef.current = onSelect;
  getElRef.current = getItemElement;

  // Clamp focus when the list shrinks (e.g. after filtering) so we never point
  // past the end. -1 (nothing focused) is preserved.
  useEffect(() => {
    setFocusedIndexState((i) => (i >= count ? count - 1 : i));
  }, [count]);

  const setFocusedIndex = useCallback((index: number) => {
    const max = countRef.current - 1;
    setFocusedIndexState(index < -1 ? -1 : index > max ? max : index);
  }, []);

  // Scroll the focused row into view when it changes (if a resolver is given).
  useEffect(() => {
    if (focusedIndex < 0) return;
    const el = getElRef.current?.(focusedIndex);
    el?.scrollIntoView({ block: "nearest" });
  }, [focusedIndex]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Don't hijack keys while the user is typing in a field that bubbled up to
    // the list container (e.g. an inline rename input or contentEditable). This
    // keeps `j`/`k` usable as literal text and Enter as the field's own action.
    const t = e.target as HTMLElement | null;
    if (t) {
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) {
        return;
      }
    }
    const max = countRef.current - 1;
    if (max < 0) return;
    const move = (delta: number) => {
      e.preventDefault();
      setFocusedIndexState((i) => {
        const start = i < 0 ? (delta > 0 ? -1 : 0) : i;
        const next = start + delta;
        return next < 0 ? 0 : next > max ? max : next;
      });
    };
    switch (e.key) {
      case "j":
      case "ArrowDown":
        move(1);
        break;
      case "k":
      case "ArrowUp":
        move(-1);
        break;
      case "Home":
        e.preventDefault();
        setFocusedIndexState(0);
        break;
      case "End":
        e.preventDefault();
        setFocusedIndexState(max);
        break;
      case "Enter":
      case " ":
        setFocusedIndexState((i) => {
          if (i >= 0 && i <= max) {
            e.preventDefault();
            onSelectRef.current?.(i);
          }
          return i;
        });
        break;
    }
  }, []);

  return {
    focusedIndex,
    setFocusedIndex,
    containerProps: { tabIndex: 0, role: "listbox", onKeyDown },
    getItemProps: (index: number) => ({
      role: "option",
      "aria-selected": index === focusedIndex,
      "data-focused": index === focusedIndex,
      onMouseEnter: () => setFocusedIndex(index),
    }),
  };
}
