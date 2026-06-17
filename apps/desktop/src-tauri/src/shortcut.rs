//! Global hotkey to summon (show + focus) the Claude UI window from anywhere.
//!
//! A small piece of native polish wired into `lib.rs`'s `setup()`, mirroring how
//! `tray::setup_tray` was wired in W21. The tray gives you a click target on the
//! menu bar; this gives you a keyboard chord that works even when the app is in
//! the background and no tray icon is visible.
//!
//! The default chord is `CmdOrCtrl+Shift+K` (Cmd on macOS, Ctrl elsewhere). On
//! trigger we reveal the main window: show + unminimize + focus. If the window is
//! already the focused, visible window we hide it instead, so the same chord
//! toggles the app in and out of view — matching the tray's left-click behavior in
//! `tray.rs`.
//!
//! We register the shortcut through the `tauri-plugin-global-shortcut` plugin's
//! builder (compile-time chord + handler) rather than at runtime, so there's a
//! single place that owns both the binding and the action.

use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use tauri::{AppHandle, Manager, Runtime};

/// Label of the main window (matches `tauri.conf.json` -> app.windows[0], and the
/// `MAIN_WINDOW` constant in `tray.rs`).
const MAIN_WINDOW: &str = "main";

/// The summon chord. `Modifiers::SUPER` is Cmd on macOS; on Windows/Linux it maps
/// to the platform's primary modifier, giving us the conventional "CmdOrCtrl"
/// behavior without parsing a string. `Code::KeyK` is the `K` key.
fn summon_shortcut() -> Shortcut {
    #[cfg(target_os = "macos")]
    let primary = Modifiers::SUPER;
    #[cfg(not(target_os = "macos"))]
    let primary = Modifiers::CONTROL;
    Shortcut::new(Some(primary | Modifiers::SHIFT), Code::KeyK)
}

/// Reveal-or-toggle the main window. Visible + focused -> hide it; otherwise show
/// + unminimize + focus. Best-effort: any error (window gone, runtime quirk) is
/// logged and swallowed so a stray keypress never panics the event loop. Mirrors
/// `tray::toggle_main_window`, but treats "visible but not focused" as a request
/// to bring the window forward rather than hide it (you pressed the summon chord
/// while looking at another app — you want it up front, not gone).
fn summon_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        log::warn!("[claude-ui] shortcut: no `{MAIN_WINDOW}` window to summon");
        return;
    };
    // `is_visible`/`is_focused` can fail on some runtimes; treat an error as
    // "not visible/focused" so the chord still does something useful (reveal it).
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    if visible && focused {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Register the global-shortcut plugin's handler and bind the summon chord.
///
/// Called from `lib.rs`'s `setup()` as best-effort (a failure must not block the
/// window from opening), mirroring how `tray::setup_tray` was wired in W21 — hence
/// the boxed-error return so the caller can `if let Err(..)` and log+continue.
/// (The plugin's own `on_shortcut` error type doesn't convert into `tauri::Error`,
/// so we box it; the call site only needs `Display`.) The plugin itself is
/// registered on the builder in `lib.rs`; here we just attach the chord -> action
/// wiring once the app handle exists.
pub fn setup_shortcut<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(), Box<dyn std::error::Error>> {
    let shortcut = summon_shortcut();
    app.global_shortcut().on_shortcut(shortcut, move |app, _shortcut, event| {
        // Only act on the press edge; ignore the matching release so the window
        // doesn't immediately toggle back when the keys come up.
        if event.state() == ShortcutState::Pressed {
            summon_main_window(app);
        }
    })?;
    log::info!("[claude-ui] global summon shortcut registered (CmdOrCtrl+Shift+K)");
    Ok(())
}
