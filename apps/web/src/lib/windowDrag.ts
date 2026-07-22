import type { MouseEvent as ReactMouseEvent } from "react";

/**
 * Explicit macOS/Tauri window dragging for the chrome (top bar + sidebar header).
 *
 * Why not just `data-tauri-drag-region`: DevHub's web UI is served over HTTP by the
 * app's own sidecar, and Tauri's automatic drag-region handling is unreliable for
 * externally-loaded content + the `Overlay` title-bar style (the window would drag
 * once, or not at all). Calling `startDragging()` directly over the Tauri IPC on
 * mousedown is engine-agnostic and reliable. The IPC is present in the desktop
 * webview (same `__TAURI_INTERNALS__` the sidebar detects); in the plain web build
 * it's absent, so this is a clean no-op there.
 *
 * Interactive targets (buttons/links/inputs/tabs, or anything opting out via
 * `data-no-drag`) never start a drag, so clicking a control still works.
 */
const INTERACTIVE_SELECTOR =
  "button, a, input, textarea, select, label, [role='button'], [role='tab'], [role='menuitem'], [data-no-drag]";

export function startWindowDrag(e: ReactMouseEvent): void {
  if (e.button !== 0) return; // primary button only
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest(INTERACTIVE_SELECTOR)) return;
  void import("@tauri-apps/api/window")
    .then((m) => m.getCurrentWindow().startDragging())
    .catch(() => {
      /* not in a Tauri window / API unavailable — ignore */
    });
}
