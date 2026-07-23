import type { MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Explicit macOS/Tauri window dragging for the chrome (top bar + sidebar + status bar).
 *
 * Two things are load-bearing and were each, in turn, the reason drag didn't work:
 *  1. `startDragging()` MUST be called SYNCHRONOUSLY inside the mousedown handler —
 *     macOS attaches the window-move to the live gesture, so an `await import(...)`
 *     first would drop it. Hence the static import + direct call here.
 *  2. The command is ACL-gated. Because the UI is served from the app's sidecar over
 *     http://127.0.0.1:<port> (a REMOTE origin to Tauri), the "main" capability must
 *     declare that origin in `remote.urls` (see capabilities/default.json) or every
 *     IPC call — including this one — is rejected with "not allowed by ACL".
 *
 * Interactive targets (buttons/links/inputs/tabs, or anything opting out via
 * `data-no-drag`) never start a drag, so clicking a control still works. A
 * double-click on the chrome toggles maximize (macOS convention). No-op outside Tauri.
 */
const INTERACTIVE_SELECTOR =
  "button, a, input, textarea, select, label, [role='button'], [role='tab'], [role='menuitem'], [data-no-drag]";

export function startWindowDrag(e: ReactMouseEvent): void {
  if (e.button !== 0) return; // primary (left) button only
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest(INTERACTIVE_SELECTOR)) return;
  try {
    const appWindow = getCurrentWindow();
    if (e.detail === 2) {
      void appWindow.toggleMaximize();
    } else {
      void appWindow.startDragging();
    }
  } catch {
    /* not a Tauri window / API unavailable — ignore */
  }
}
