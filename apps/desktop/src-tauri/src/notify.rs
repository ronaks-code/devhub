//! Native OS notification when a running Claude session FINISHES a turn.
//!
//! A small piece of native polish wired into `lib.rs`'s `setup()`, mirroring how
//! `tray::setup_tray` (W21) and `shortcut::setup_shortcut` (W22) were wired in. The
//! tray paints a dock badge for *how many* sessions are live; this fires a desktop
//! notification the moment one of them *finishes* — so you can walk away from a long
//! turn and get pinged when Claude is done, then click the toast to jump back in.
//!
//! We learn when a turn completes the same way `tray.rs` learns the badge count: a
//! background thread polls the local server's `GET /api/running` every few seconds —
//! the same server `lib.rs` already spawns — and watches each session's `status`. A
//! session reported `busy`/`waiting` that then flips to `idle` (or simply disappears
//! from the list while it had been busy) is a finished turn, and we notify once on
//! that busy -> idle EDGE. We dedupe by `sessionId` + status so a session that sits
//! idle across many polls only pings once, never on every poll.
//!
//! Clicking/activating the notification (and firing it at all) shows + focuses the
//! main window, matching the "bring me back" gesture the tray and shortcut use.
//!
//! Like `tray.rs`, we reuse `lib.rs`'s dependency-free TCP+HTTP approach for the poll
//! rather than pulling reqwest in as a *direct* dependency: it's a single tiny GET
//! against 127.0.0.1, so a minimal std read keeps the build lean and matches the
//! existing `http_get_body` style.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;

/// Label of the main window (matches `tauri.conf.json` -> app.windows[0], and the
/// `MAIN_WINDOW` constant in `tray.rs` / `shortcut.rs`).
const MAIN_WINDOW: &str = "main";

/// How often the finish-watcher refreshes session statuses. Matches `tray.rs`'s
/// `BADGE_POLL_INTERVAL`: a few seconds is responsive enough to feel "instant" when a
/// turn ends without hammering the local API or the disk reads behind it.
const NOTIFY_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// One session's status as we last saw it, keyed by `sessionId`. We only keep the
/// fields the busy -> idle edge detector needs: whether the session was in an active
/// (working) status, plus the project name to put in the toast.
#[derive(Clone)]
struct SeenSession {
    /// Was the last-seen status an *active* (working) one — `busy` or `waiting`? This
    /// is the left-hand side of the busy -> idle edge.
    active: bool,
    /// Display name for the project the session is running in (basename of its cwd, or
    /// a fallback). Captured while we can still see the session so a finished-by-
    /// disappearing session still names its project.
    project: String,
}

/// Is this status an *active* / working one — i.e. a turn is in flight? `busy` is an
/// in-progress turn; `waiting` is blocked on the user but still an open turn. Anything
/// else (`idle`, `dead`, `unknown`, ...) is not-working, so a transition INTO it from
/// an active status is a finished turn.
fn is_active_status(status: &str) -> bool {
    matches!(status, "busy" | "waiting")
}

/// Human-friendly project name for a session's `cwd`: the basename of the path (the
/// folder you'd recognize), falling back to the whole cwd, then to a generic label so
/// the toast always reads sensibly even on a malformed/missing path.
fn project_label(cwd: Option<&str>) -> String {
    match cwd {
        Some(c) if !c.trim().is_empty() => c
            .trim_end_matches('/')
            .rsplit('/')
            .find(|seg| !seg.is_empty())
            .unwrap_or(c)
            .to_string(),
        _ => "a project".to_string(),
    }
}

/// Reveal the main window: show + unminimize + focus. Best-effort — any error (window
/// gone, runtime quirk) is logged and swallowed so a notification action never panics
/// the event loop. Mirrors the reveal half of `tray::toggle_main_window` /
/// `shortcut::summon_main_window` (we always bring it forward here; a finished turn is
/// a "come look" event, never a "hide" one).
fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        log::warn!("[claude-ui] notify: no `{MAIN_WINDOW}` window to focus");
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Minimal, dependency-free `GET http://{host}:{port}{path}` that returns the raw
/// response body (sans headers), or `None` on any failure. A copy of `tray.rs`'s
/// `http_get_body` kept module-local so the two pollers don't couple to each other —
/// both deliberately avoid pulling reqwest in for one tiny localhost GET.
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
    // Split headers from body on the blank line. If there's no separator the response
    // is malformed for our purposes; bail rather than parse garbage.
    let body_start = text.find("\r\n\r\n").map(|i| i + 4)?;
    Some(text[body_start..].to_string())
}

/// Snapshot the *currently-running* sessions reported by `GET /api/running`, mapped by
/// `sessionId` to the bits the edge detector needs. Returns `None` (not an empty map)
/// when the server is unreachable or the payload doesn't parse, so the caller can SKIP
/// a poll rather than mistake a transient blip for "everything finished" and fire a
/// storm of notifications. Only sessions with a non-empty `sessionId` are tracked —
/// we key dedupe on it, so an entry without one can't be tracked reliably.
fn snapshot_sessions(host: &str, port: u16) -> Option<HashMap<String, SeenSession>> {
    let body = http_get_body(host, port, "/api/running")?;
    let value: serde_json::Value = serde_json::from_str(&body).ok()?;
    let arr = value.as_array()?;
    let mut out: HashMap<String, SeenSession> = HashMap::with_capacity(arr.len());
    for s in arr {
        let session_id = s
            .get("sessionId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if session_id.is_empty() {
            continue; // can't dedupe an unkeyed session
        }
        let status = s
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown");
        let cwd = s.get("cwd").and_then(serde_json::Value::as_str);
        out.insert(
            session_id.to_string(),
            SeenSession {
                active: is_active_status(status),
                project: project_label(cwd),
            },
        );
    }
    Some(out)
}

/// Fire the native "Claude finished" notification for `project`, then bring the window
/// forward. Best-effort: a notification build/show failure is logged and swallowed so
/// the watcher loop keeps running. We focus the window on FIRE (not only on the OS
/// "clicked" callback) because the v2 notification plugin's click/action delivery is
/// platform-dependent — firing the reveal here guarantees the "come look" gesture
/// happens, and the toast itself is the user's pointer back to the finished turn.
fn notify_finished<R: Runtime>(app: &AppHandle<R>, project: &str) {
    let body = format!("Claude finished in {project}");
    match app
        .notification()
        .builder()
        .title("DevHub")
        .body(&body)
        .show()
    {
        Ok(()) => {
            log::info!("[claude-ui] notify: {body}");
            focus_main_window(app);
        }
        Err(err) => {
            // A denied/unavailable notification permission lands here; don't spam the
            // log past debug, and never let it kill the watcher.
            log::debug!("[claude-ui] notify: show failed: {err}");
        }
    }
}

/// Spawn the background finish-watcher. Polls `GET /api/running` every
/// `NOTIFY_POLL_INTERVAL`, tracks each session's active/idle status by `sessionId`, and
/// fires exactly one notification on each busy -> idle EDGE:
///
///   * a session that was `active` (busy/waiting) last poll is now `idle`/etc. -> finished;
///   * a session that was `active` last poll has VANISHED from the list -> also finished
///     (it exited as its turn completed and cleaned up its file).
///
/// Dedupe falls out of the edge model: we only notify when the *previous* snapshot had
/// the session active and the *current* one doesn't, so a session sitting idle across
/// many polls pings once, never on every poll. An unreachable server / unparseable
/// payload yields `None` and we hold the previous snapshot unchanged — a transient blip
/// can't be misread as "every session finished" and trigger a notification storm.
fn spawn_finish_watcher<R: Runtime>(app: AppHandle<R>, host: String, port: u16) {
    std::thread::spawn(move || {
        // Seed from the first successful poll WITHOUT notifying: sessions already busy
        // when the app launches shouldn't ping the instant we start watching — we only
        // care about transitions we actually observed.
        let mut prev: HashMap<String, SeenSession> = HashMap::new();
        let mut seeded = false;
        loop {
            if let Some(curr) = snapshot_sessions(&host, port) {
                if seeded {
                    for (session_id, was) in &prev {
                        if !was.active {
                            continue; // wasn't working last poll -> no finish edge possible
                        }
                        // Finished if it's now present-but-not-active, or gone entirely.
                        let finished = match curr.get(session_id) {
                            Some(now) => !now.active,
                            None => true,
                        };
                        if finished {
                            notify_finished(&app, &was.project);
                        }
                    }
                }
                prev = curr;
                seeded = true;
            }
            std::thread::sleep(NOTIFY_POLL_INTERVAL);
        }
    });
}

/// Request notification permission (best-effort) and start the finish-watcher.
///
/// Called from `lib.rs`'s `setup()` as best-effort — a failure must not block the
/// window from opening — mirroring how `tray::setup_tray` (W21) and
/// `shortcut::setup_shortcut` (W22) are wired. We ask for permission up front so the
/// OS prompt appears at launch rather than at the surprising moment a turn finishes;
/// if it's already granted this is a cheap no-op, and if the user denies it the
/// watcher still runs (each `show()` simply no-ops via the guarded `notify_finished`).
/// The plugin itself is registered on the builder in `lib.rs`; here we just request
/// permission and spin up the watcher once the app handle exists.
pub fn setup_notify<R: Runtime>(
    app: &AppHandle<R>,
    host: String,
    port: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    // Only prompt if we don't already hold permission. `permission_state` /
    // `request_permission` can fail on an unsupported platform; treat any error as
    // "leave it to the per-notification guard" rather than aborting setup.
    match app.notification().permission_state() {
        Ok(state) if state == tauri_plugin_notification::PermissionState::Granted => {}
        Ok(_) => {
            if let Err(err) = app.notification().request_permission() {
                log::debug!("[claude-ui] notify: request_permission failed: {err}");
            }
        }
        Err(err) => {
            log::debug!("[claude-ui] notify: permission_state failed: {err}");
        }
    }

    spawn_finish_watcher(app.clone(), host, port);
    log::info!("[claude-ui] finish-notification watcher registered");
    Ok(())
}
