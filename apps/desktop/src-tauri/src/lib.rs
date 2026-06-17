//! Tauri desktop shell for Claude UI.
//!
//! On launch we start the Claude UI server (the Fastify app over the engine) as
//! a child process so the user never needs a separate `pnpm dev` terminal. The
//! child is killed when the app exits. If a server is already listening on the
//! target port (e.g. the user ran `pnpm dev` themselves) we detect it and skip
//! spawning, then just point the webview at the live UI.
//!
//! Everything is configurable via env so power users / CI can override:
//!   CLAUDE_UI_SERVER_CMD   full shell command to launch the server
//!                          (default: `pnpm --filter @claude-ui/server start`)
//!   CLAUDE_UI_REPO_DIR     working dir for the command (default: detected repo root)
//!   CLAUDE_UI_SERVER_HOST  host to probe for readiness    (default: 127.0.0.1)
//!   CLAUDE_UI_SERVER_PORT  port to probe for readiness    (default: 8787)
//!   CLAUDE_UI_NO_SPAWN     if set ("1"/"true"), never spawn — assume external server

use std::io::Read;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Handle to the spawned server, kept in Tauri-managed state so we can reap it
/// on exit. `None` means we never spawned (external server already running, or
/// spawning was disabled).
#[derive(Default)]
struct ServerProcess(Mutex<Option<Child>>);

impl ServerProcess {
    /// Store the spawned child (if any). Keeps the lock fully contained so no
    /// guard escapes into the caller's borrow of Tauri-managed state.
    fn set(&self, child: Option<Child>) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = child;
        }
    }

    /// Kill the child if we own one. Idempotent — safe to call from both the
    /// window-destroyed event and the exit-requested event.
    fn shutdown(&self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(mut child) = guard.take() {
                log::info!("[claude-ui] stopping server (pid {})", child.id());
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn env_or(name: &str, default: &str) -> String {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => v,
        _ => default.to_string(),
    }
}

fn env_flag(name: &str) -> bool {
    matches!(
        std::env::var(name).ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes")
    )
}

/// Probe whether something is already accepting TCP connections at host:port.
/// We only need a connect() to know the port is taken — the readiness loop does
/// the deeper HTTP health check.
fn port_open(host: &str, port: u16) -> bool {
    let addr = format!("{host}:{port}");
    let Ok(mut addrs) = addr.to_socket_addrs() else {
        return false;
    };
    let Some(sockaddr) = addrs.next() else {
        return false;
    };
    TcpStream::connect_timeout(&sockaddr, Duration::from_millis(300)).is_ok()
}

/// Minimal, dependency-free HTTP GET against the server health endpoint. Returns
/// true only when the server answers with a 2xx — i.e. the engine is up and the
/// API is serving, not just that the port is bound.
fn health_ok(host: &str, port: u16) -> bool {
    let addr = format!("{host}:{port}");
    let Ok(mut addrs) = addr.to_socket_addrs() else {
        return false;
    };
    let Some(sockaddr) = addrs.next() else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&sockaddr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    let req = format!(
        "GET /api/health HTTP/1.0\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
    );
    use std::io::Write;
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::with_capacity(256);
    // Read just the status line region; cap the read so a chatty body can't hang us.
    let mut chunk = [0u8; 256];
    if let Ok(n) = stream.read(&mut chunk) {
        buf.extend_from_slice(&chunk[..n]);
    }
    let head = String::from_utf8_lossy(&buf);
    head.starts_with("HTTP/1.0 2") || head.starts_with("HTTP/1.1 2")
}

/// Walk up from `start` looking for the monorepo root (the dir holding
/// `pnpm-workspace.yaml`). In `tauri dev` the binary runs from
/// `apps/desktop/src-tauri`; in a bundled app cwd is unpredictable, so callers
/// should prefer the compile-time fallback below when this returns None.
fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        if d.join("pnpm-workspace.yaml").is_file() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

/// Best-effort repo root: env override → walk up from cwd → walk up from the
/// compile-time crate dir (this file lives at <repo>/apps/desktop/src-tauri/src).
fn repo_root() -> PathBuf {
    if let Ok(dir) = std::env::var("CLAUDE_UI_REPO_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(root) = find_repo_root(&cwd) {
            return root;
        }
    }
    // CARGO_MANIFEST_DIR = <repo>/apps/desktop/src-tauri at build time. Ascend 3.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = find_repo_root(manifest) {
        return root;
    }
    manifest
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| manifest.to_path_buf())
}

/// Split the configured command into program + args. We deliberately run it
/// through the platform shell so users can pass a full command line (pipes,
/// env, `pnpm --filter ...`) in CLAUDE_UI_SERVER_CMD without us re-parsing it.
fn build_server_command(cmd: &str, cwd: &Path, port: u16, host: &str) -> Command {
    let mut command = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(cmd);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-lc").arg(cmd);
        c
    };
    command
        .current_dir(cwd)
        // Hand the server its port/host so a custom CLAUDE_UI_SERVER_PORT lines
        // up with what we probe. The server reads PORT/HOST from env.
        .env("PORT", port.to_string())
        .env("HOST", host)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    command
}

/// Start the server if it isn't already up. Returns the child (if we spawned
/// one) so the caller can hand it to managed state for later cleanup.
fn ensure_server(host: &str, port: u16) -> Option<Child> {
    // Already serving? (External `pnpm dev`, or a prior instance.) Don't spawn.
    if health_ok(host, port) || port_open(host, port) {
        log::info!("[claude-ui] server already reachable on {host}:{port}; not spawning");
        return None;
    }

    if env_flag("CLAUDE_UI_NO_SPAWN") {
        log::warn!("[claude-ui] CLAUDE_UI_NO_SPAWN set but no server on {host}:{port}");
        return None;
    }

    let cmd = env_or(
        "CLAUDE_UI_SERVER_CMD",
        "pnpm --filter @claude-ui/server start",
    );
    let cwd = repo_root();
    log::info!("[claude-ui] starting server: `{cmd}` (cwd: {})", cwd.display());

    match build_server_command(&cmd, &cwd, port, host).spawn() {
        Ok(child) => {
            log::info!("[claude-ui] server spawned (pid {})", child.id());
            Some(child)
        }
        Err(err) => {
            log::error!("[claude-ui] failed to spawn server: {err}");
            None
        }
    }
}

/// Block (on a background thread) until the server answers /api/health, or until
/// `timeout` elapses. Polls cheaply so first paint isn't delayed once it's up.
fn wait_for_health(host: &str, port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if health_ok(host, port) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ServerProcess::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let host = env_or("CLAUDE_UI_SERVER_HOST", "127.0.0.1");
            let port: u16 = env_or("CLAUDE_UI_SERVER_PORT", "8787")
                .parse()
                .unwrap_or(8787);

            // Spawn (or detect) the server and stash the child for cleanup.
            let child = ensure_server(&host, port);
            {
                use tauri::Manager;
                app.state::<ServerProcess>().set(child);
            }

            // Give the server a moment to come up. The webview talks to the API
            // same-origin (vite proxies /api in dev), so the UI is resilient to
            // the API lagging a beat — but waiting here makes first load smooth.
            // Done on a background thread so we never block the UI/event loop.
            let probe_host = host.clone();
            std::thread::spawn(move || {
                if wait_for_health(&probe_host, port, Duration::from_secs(20)) {
                    log::info!("[claude-ui] server healthy on {probe_host}:{port}");
                } else {
                    log::warn!(
                        "[claude-ui] server not healthy after 20s on {probe_host}:{port}; UI will retry"
                    );
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // When the last window is destroyed, reap the server child.
            if let tauri::WindowEvent::Destroyed = event {
                use tauri::Manager;
                window.state::<ServerProcess>().shutdown();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Catch-all: also reap on explicit exit (Cmd-Q, app.exit, etc.).
            if let tauri::RunEvent::ExitRequested { .. } = event {
                use tauri::Manager;
                app_handle.state::<ServerProcess>().shutdown();
            }
        });
}
