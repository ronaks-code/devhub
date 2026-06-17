//! macOS menu-bar (system tray) icon + dock badge for Claude UI.
//!
//! Two small, self-contained pieces of native polish wired into `lib.rs`'s
//! `setup()`:
//!
//!   1. A menu-bar tray icon. Left-clicking it toggles the main window between
//!      shown/hidden; right-clicking opens a tiny menu (Show/Hide + Quit). This
//!      keeps the app reachable even when its window is closed/hidden.
//!
//!   2. A dock badge (macOS only) that mirrors how many Claude sessions are
//!      currently running. We learn the count by polling the local server's
//!      `GET /api/running` on a background thread — the same server `lib.rs`
//!      already spawns — and reflecting `count > 0` as a badge label via the
//!      window's `set_badge_count` API (on macOS that paints the dock badge).
//!
//! We deliberately reuse `lib.rs`'s dependency-free TCP+HTTP approach rather than
//! pulling reqwest in as a *direct* dependency: the badge poll is a single tiny
//! GET against 127.0.0.1, so a minimal std read keeps the build lean and matches
//! the existing `health_ok` style in `lib.rs`.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

/// Label of the main window (matches `tauri.conf.json` -> app.windows[0]).
const MAIN_WINDOW: &str = "main";

/// Menu item id for the show/hide toggle. We keep a stable id so the menu-event
/// handler can match on it without depending on the (localizable) label text.
const TOGGLE_ID: &str = "toggle-window";

/// How often the badge poller refreshes the running-session count. A few seconds
/// is responsive enough for "how many sessions are live" without hammering the
/// local API or the disk reads behind it.
const BADGE_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Toggle the main window's visibility. Hidden/closed -> show + focus it; visible
/// -> hide it. Best-effort: any error (window gone, runtime quirk) is logged and
/// swallowed so a stray click never panics the event loop.
fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        log::warn!("[claude-ui] tray: no `{MAIN_WINDOW}` window to toggle");
        return;
    };
    // `is_visible` can fail on some runtimes; treat an error as "not visible" so a
    // click still does *something* useful (reveal the window).
    let visible = window.is_visible().unwrap_or(false);
    if visible {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Reflect `count` running sessions as the macOS dock badge. `0` clears it.
/// Guarded to macOS — `set_badge_count` is a no-op-ish elsewhere, but the dock
/// badge is the macOS-specific affordance this targets, so we keep the call
/// behind the cfg to make the platform intent explicit.
#[cfg(target_os = "macos")]
fn set_dock_badge<R: Runtime>(app: &AppHandle<R>, count: i64) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let value = if count > 0 { Some(count) } else { None };
    if let Err(err) = window.set_badge_count(value) {
        log::debug!("[claude-ui] tray: set_badge_count failed: {err}");
    }
}

/// On non-macOS we have no dock to badge; keep the call site uniform with a stub.
#[cfg(not(target_os = "macos"))]
fn set_dock_badge<R: Runtime>(_app: &AppHandle<R>, _count: i64) {}

/// Minimal, dependency-free `GET http://{host}:{port}/api/running` that returns the
/// raw response body (sans headers), or `None` on any failure. Mirrors the TCP/HTTP
/// helper style in `lib.rs` so we don't add reqwest as a direct dependency just for
/// one tiny localhost poll.
fn http_get_body(host: &str, port: u16, path: &str) -> Option<String> {
    let addr = format!("{host}:{port}");
    let mut addrs = addr.to_socket_addrs().ok()?;
    let sockaddr = addrs.next()?;
    let mut stream = TcpStream::connect_timeout(&sockaddr, Duration::from_millis(500)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1500)));
    let req =
        format!("GET {path} HTTP/1.0\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).ok()?;
    let mut raw = Vec::with_capacity(4096);
    // HTTP/1.0 + `Connection: close` => the server closes when done, so read to EOF.
    stream.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw);
    // Split headers from body on the blank line. If there's no separator the
    // response is malformed for our purposes; bail rather than parse garbage.
    let body_start = text.find("\r\n\r\n").map(|i| i + 4)?;
    Some(text[body_start..].to_string())
}

/// Count of *alive* running sessions reported by `GET /api/running`. The endpoint
/// returns a JSON array of session objects, each with an `alive: bool` flag (dead
/// PIDs are flagged, not always dropped), so we count only the live ones — the
/// number a user would consider "running". Returns `None` if the server isn't
/// reachable or the payload doesn't parse, so callers can skip a badge update
/// rather than clobber a good value with a transient blip.
fn running_session_count(host: &str, port: u16) -> Option<i64> {
    let body = http_get_body(host, port, "/api/running")?;
    let value: serde_json::Value = serde_json::from_str(&body).ok()?;
    let arr = value.as_array()?;
    let alive = arr
        .iter()
        .filter(|s| {
            // Be lenient: an entry missing `alive` (older server) counts as live so
            // we never *undercount* genuinely-running sessions.
            s.get("alive").and_then(serde_json::Value::as_bool).unwrap_or(true)
        })
        .count();
    Some(alive as i64)
}

/// Spawn the background badge poller. Polls `GET /api/running` every
/// `BADGE_POLL_INTERVAL`, and updates the dock badge only when the count actually
/// changes (avoids redundant native calls). Unreachable server / parse failures are
/// treated as "no change" so a momentary blip doesn't flicker the badge to 0.
fn spawn_badge_poller<R: Runtime>(app: AppHandle<R>, host: String, port: u16) {
    std::thread::spawn(move || {
        let mut last: Option<i64> = None;
        loop {
            if let Some(count) = running_session_count(&host, port) {
                if last != Some(count) {
                    set_dock_badge(&app, count);
                    last = Some(count);
                }
            }
            std::thread::sleep(BADGE_POLL_INTERVAL);
        }
    });
}

/// Build the menu-bar tray icon and start the dock-badge poller.
///
/// Called from `lib.rs`'s `setup()` after the server host/port are resolved. Errors
/// building the tray are returned to the caller (setup treats them as fatal-ish via
/// `?`), but the badge poller is fire-and-forget. Reuses the bundled app icon
/// (`default_window_icon`) for the tray image so we don't ship a second asset.
pub fn setup_tray<R: Runtime>(
    app: &AppHandle<R>,
    host: String,
    port: u16,
) -> tauri::Result<()> {
    // Show/Hide toggle (stable id) + a separator + the native Quit item.
    let toggle = MenuItemBuilder::with_id(TOGGLE_ID, "Show/Hide Claude UI").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&toggle)
        .separator()
        .quit()
        .build()?;

    let mut builder = TrayIconBuilder::with_id("claude-ui-tray")
        .menu(&menu)
        .tooltip("Claude UI")
        // Left-click toggles the window; reserve the menu for right-click so the
        // primary click is the common "bring me back" gesture.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == TOGGLE_ID {
                toggle_main_window(app);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        });

    // Reuse the bundled window icon as the tray image when available. On macOS we
    // render it as a template image so it adapts to light/dark menu bars.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
        #[cfg(target_os = "macos")]
        {
            builder = builder.icon_as_template(true);
        }
    }

    builder.build(app)?;

    // Fire up the dock-badge poller against the local server.
    spawn_badge_poller(app.clone(), host, port);

    Ok(())
}
