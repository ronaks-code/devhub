import type { MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Explicit macOS/Tauri window dragging for the chrome (top bar + sidebar + status bar).
 *
 * Why not `data-tauri-drag-region`: DevHub's web UI is served over HTTP by the app's
 * own sidecar, and Tauri's automatic drag-region handling is unreliable for
 * externally-loaded content + the `Overlay` title-bar style.
 *
 * CRITICAL — `startDragging()` MUST be called SYNCHRONOUSLY inside the `mousedown`
 * handler. macOS attaches the window-move to the *live* mouse-down gesture; if the
 * call is deferred (e.g. behind an `await import(...)`) the OS has already finished
 * processing the event and the drag never attaches — the window drags once (or not
 * at all) and then "loses the ability to move" (Tauri issues #10767 / #11605). So we
 * static-import `getCurrentWindow` and call through synchronously, matching the
 * official window-customization docs. `getCurrentWindow()` only touches
 * `__TAURI_INTERNALS__` when invoked, so the static import is a safe no-op in the
 * plain web build (guarded below anyway).
 *
 * Interactive targets (buttons/links/inputs/tabs, or anything opting out via
 * `data-no-drag`) never start a drag, so clicking a control still works. A
 * double-click toggles maximize (macOS-standard) instead of dragging.
 */
const INTERACTIVE_SELECTOR =
  "button, a, input, textarea, select, label, [role='button'], [role='tab'], [role='menuitem'], [data-no-drag]";

export function startWindowDrag(e: ReactMouseEvent): void {
  // Primary (left) button only, and no-op outside a Tauri webview.
  if (e.buttons !== 1) return;
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest(INTERACTIVE_SELECTOR)) return;
  try {
    const appWindow = getCurrentWindow();
    // Double-click on the chrome maximizes (macOS convention); otherwise drag.
    if (e.detail === 2) {
      void appWindow.toggleMaximize();
    } else {
      void appWindow.startDragging();
    }
  } catch {
    /* not a Tauri window / API unavailable — ignore */
  }
}
