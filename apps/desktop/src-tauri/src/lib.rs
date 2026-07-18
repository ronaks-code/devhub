//! Native DevHub launcher.
//!
//! A release bundle carries a relocatable pnpm deployment of `@devhub/server`
//! plus the built Vite application. The launcher starts that deployment with the
//! user's real Node binary, waits for DevHub's strict health identity, then points
//! the WebView at the server. UI, HTTP, SSE, and WebSocket traffic consequently
//! share one localhost origin and retain the exact web-app behavior.

mod notify;
mod shortcut;
mod tray;

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;

const DEVHUB_SERVER_SERVICE_ID: &str = "devhub-server";
const HEALTH_PROBE_READ_CAP: usize = 8192;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
struct ServerProcess(Mutex<Option<Child>>);

impl ServerProcess {
    fn set(&self, child: Option<Child>) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = child;
        }
    }

    fn shutdown(&self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(mut child) = guard.take() {
                log::info!(
                    "[devhub] stopping server process group (pid {})",
                    child.id()
                );
                stop_child(&mut child);
            }
        }
    }
}

fn env_or(name: &str, default: &str) -> String {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => value,
        _ => default.to_string(),
    }
}

fn env_flag(name: &str) -> bool {
    matches!(
        std::env::var(name).ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes")
    )
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

/// Finder launches with a deliberately small environment. Prepend every stable
/// executable location DevHub needs, then retain the inherited PATH entries.
fn finder_safe_path(inherited: Option<&OsStr>, home: Option<&Path>) -> OsString {
    let mut candidates = vec![
        PathBuf::from("/usr/local/opt/node/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = home {
        candidates.insert(1, home.join(".local/bin"));
        candidates.insert(2, home.join(".claude/bin"));
        candidates.insert(3, home.join(".claude/local"));
    }
    candidates.extend([PathBuf::from("/usr/bin"), PathBuf::from("/bin")]);
    if let Some(path) = inherited {
        candidates.extend(std::env::split_paths(path));
    }

    let mut seen = HashSet::new();
    candidates.retain(|entry| seen.insert(entry.clone()));
    std::env::join_paths(candidates).unwrap_or_else(|_| OsString::from("/usr/bin:/bin"))
}

fn read_capped(stream: &mut TcpStream, cap: usize) -> Vec<u8> {
    let mut output = Vec::with_capacity(cap.min(4096));
    let mut chunk = [0_u8; 1024];
    while output.len() < cap {
        let remaining = cap - output.len();
        let read_len = remaining.min(chunk.len());
        match stream.read(&mut chunk[..read_len]) {
            Ok(0) => break,
            Ok(count) => output.extend_from_slice(&chunk[..count]),
            Err(_) => break,
        }
    }
    output
}

fn response_proves_devhub_identity(response: &[u8]) -> bool {
    let text = String::from_utf8_lossy(response);
    let is_2xx = text.starts_with("HTTP/1.0 2") || text.starts_with("HTTP/1.1 2");
    is_2xx && text.contains("\"service\"") && text.contains(DEVHUB_SERVER_SERVICE_ID)
}

fn health_ok(host: &str, port: u16) -> bool {
    let address = format!("{host}:{port}");
    let Some(socket) = address
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| addrs.next())
    else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&socket, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    let request =
        format!("GET /api/health HTTP/1.0\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    response_proves_devhub_identity(&read_capped(&mut stream, HEALTH_PROBE_READ_CAP))
}

fn port_open(host: &str, port: u16) -> bool {
    let address = format!("{host}:{port}");
    address
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| addrs.next())
        .is_some_and(|socket| {
            TcpStream::connect_timeout(&socket, Duration::from_millis(300)).is_ok()
        })
}

fn find_repo_root(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|directory| directory.join("pnpm-workspace.yaml").is_file())
        .map(Path::to_path_buf)
}

fn repo_root() -> PathBuf {
    if let Some(override_dir) =
        std::env::var_os("CLAUDE_UI_REPO_DIR").filter(|value| !value.is_empty())
    {
        return PathBuf::from(override_dir);
    }
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(root) = find_repo_root(&cwd) {
            return root;
        }
    }
    find_repo_root(Path::new(env!("CARGO_MANIFEST_DIR")))
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn launch_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut bytes))
        .map_err(|error| format!("Could not generate the desktop launch token: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn apply_child_environment(
    command: &mut Command,
    host: &str,
    port: u16,
    desktop_token: Option<&str>,
) {
    let path = finder_safe_path(std::env::var_os("PATH").as_deref(), home_dir().as_deref());
    command
        .env("PATH", path)
        .env("PORT", port.to_string())
        .env("HOST", host)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if let Some(token) = desktop_token {
        let desktop_host = if host.contains(':') {
            format!("[{host}]:{port}")
        } else {
            format!("{host}:{port}")
        };
        command
            .env("DEVHUB_TOKEN", token)
            .env("DEVHUB_DESKTOP_TOKEN", token)
            .env("DEVHUB_DESKTOP_HOST", desktop_host);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

fn shell_server_command(
    command_line: &str,
    cwd: &Path,
    host: &str,
    port: u16,
    desktop_token: Option<&str>,
) -> Command {
    let mut command = if cfg!(target_os = "windows") {
        let mut command = Command::new("cmd");
        command.arg("/C").arg(command_line);
        command
    } else {
        // Do not use a login shell: it may replace the Finder-safe PATH below.
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(command_line);
        command
    };
    command.current_dir(cwd);
    apply_child_environment(&mut command, host, port, desktop_token);
    command
}

fn packaged_server_command(
    resource_dir: &Path,
    host: &str,
    port: u16,
    desktop_token: &str,
) -> Result<Command, String> {
    let root = resource_dir.join("sidecar");
    let entry = root.join("node_modules/tsx/dist/cli.mjs");
    let server = root.join("src/index.ts");
    let web = root.join("web");
    for required in [&entry, &server, &web.join("index.html")] {
        if !required.exists() {
            return Err(format!(
                "Packaged DevHub resource is missing: {}",
                required.display()
            ));
        }
    }

    let node = std::env::var_os("DEVHUB_NODE_EXECUTABLE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/usr/local/opt/node/bin/node"));
    if node.is_absolute() && !node.is_file() {
        return Err(format!("Node executable is missing: {}", node.display()));
    }

    let mut command = Command::new(node);
    command
        .arg(entry)
        .arg(server)
        .current_dir(&root)
        .env("DEVHUB_WEB_DIST", web);
    apply_child_environment(&mut command, host, port, Some(desktop_token));
    Ok(command)
}

fn spawn_server(
    resource_dir: &Path,
    host: &str,
    port: u16,
    desktop_token: Option<&str>,
) -> Result<Child, String> {
    let mut command = if let Ok(override_command) = std::env::var("CLAUDE_UI_SERVER_CMD") {
        shell_server_command(&override_command, &repo_root(), host, port, desktop_token)
    } else if cfg!(debug_assertions) {
        shell_server_command(
            "pnpm --filter @devhub/server start",
            &repo_root(),
            host,
            port,
            desktop_token,
        )
    } else {
        packaged_server_command(
            resource_dir,
            host,
            port,
            desktop_token.ok_or("A release launch requires a desktop token")?,
        )?
    };
    command
        .spawn()
        .map_err(|error| format!("Failed to launch DevHub server: {error}"))
}

fn wait_for_server(child: &mut Child, host: &str, port: u16) -> Result<(), String> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        if health_ok(host, port) {
            return Ok(());
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not inspect DevHub server: {error}"))?
        {
            return Err(format!(
                "DevHub server exited before becoming ready: {status}"
            ));
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "DevHub server did not become ready at http://{host}:{port} within {} seconds",
                STARTUP_TIMEOUT.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn ensure_server(
    resource_dir: &Path,
    host: &str,
    port: u16,
    desktop_token: Option<&str>,
) -> Result<Child, String> {
    if port_open(host, port) {
        return Err(format!(
            "Port {port} is already occupied; DevHub requires an app-owned server"
        ));
    }
    if env_flag("CLAUDE_UI_NO_SPAWN") {
        return Err(format!(
            "CLAUDE_UI_NO_SPAWN is set but no DevHub server is available on {host}:{port}"
        ));
    }

    let mut child = spawn_server(resource_dir, host, port, desktop_token)?;
    if let Err(error) = wait_for_server(&mut child, host, port) {
        stop_child(&mut child);
        return Err(error);
    }
    Ok(child)
}

fn stop_child(child: &mut Child) {
    let process_group = child.id() as i32;
    #[cfg(unix)]
    unsafe {
        // The child was placed in its own process group. SIGTERM reaches Node and
        // every pnpm/tsx descendant, allowing Fastify's shutdown hooks to run.
        let _ = libc::kill(-process_group, libc::SIGTERM);
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }

    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        #[cfg(unix)]
        unsafe {
            if libc::kill(-process_group, 0) != 0 {
                let _ = child.wait();
                return;
            }
        }
        #[cfg(not(unix))]
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    #[cfg(unix)]
    unsafe {
        let _ = libc::kill(-process_group, libc::SIGKILL);
    }
    #[cfg(not(unix))]
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ServerProcess::default())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let host = env_or("CLAUDE_UI_SERVER_HOST", "127.0.0.1");
            if !cfg!(debug_assertions) && host != "127.0.0.1" {
                return Err("A packaged DevHub server must bind to 127.0.0.1".into());
            }
            let port = env_or("CLAUDE_UI_SERVER_PORT", "8787")
                .parse::<u16>()
                .map_err(|_| "CLAUDE_UI_SERVER_PORT must be a valid port")?;
            let resource_dir = app.path().resource_dir()?;
            let desktop_token = if cfg!(debug_assertions) {
                None
            } else {
                Some(
                    launch_token()
                        .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?,
                )
            };
            let mut child = ensure_server(&resource_dir, &host, port, desktop_token.as_deref())
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            let start_ui = || -> Result<(), Box<dyn std::error::Error>> {
                let window = app.get_webview_window("main").ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "Tauri did not create the main DevHub window",
                    )
                })?;
                if !cfg!(debug_assertions) {
                    let url = format!("http://{host}:{port}").parse::<tauri::Url>()?;
                    window.navigate(url)?;
                }
                window.show()?;
                window.set_focus()?;
                Ok(())
            };
            if let Err(error) = start_ui() {
                stop_child(&mut child);
                return Err(error);
            }
            app.state::<ServerProcess>().set(Some(child));

            if let Err(error) = tray::setup_tray(app.handle(), host.clone(), port) {
                log::warn!("[devhub] failed to set up tray: {error}");
            }
            if let Err(error) = shortcut::setup_shortcut(app.handle()) {
                log::warn!("[devhub] failed to set up summon shortcut: {error}");
            }
            if let Err(error) = notify::setup_notify(app.handle(), host, port) {
                log::warn!("[devhub] failed to set up notifications: {error}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building DevHub")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                app.state::<ServerProcess>().shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_a_2xx_response_with_devhub_identity() {
        assert!(response_proves_devhub_identity(
            b"HTTP/1.1 200 OK\r\n\r\n{\"service\":\"devhub-server\"}"
        ));
        assert!(!response_proves_devhub_identity(
            b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}"
        ));
        assert!(!response_proves_devhub_identity(
            b"HTTP/1.1 500 Error\r\n\r\n{\"service\":\"devhub-server\"}"
        ));
    }

    #[test]
    fn finder_path_has_required_prefixes_and_retains_inherited_entries() {
        let home = Path::new("/Users/example");
        let path = finder_safe_path(Some(OsStr::new("/custom/bin:/usr/bin")), Some(home));
        let entries: Vec<_> = std::env::split_paths(&path).collect();
        assert_eq!(entries[0], PathBuf::from("/usr/local/opt/node/bin"));
        assert!(entries.contains(&home.join(".local/bin")));
        assert!(entries.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(entries.contains(&PathBuf::from("/custom/bin")));
        assert_eq!(
            entries
                .iter()
                .filter(|entry| *entry == Path::new("/usr/bin"))
                .count(),
            1
        );
    }

    #[test]
    fn repo_root_walk_finds_workspace_marker() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        assert!(find_repo_root(manifest).is_some());
    }

    #[test]
    fn launch_tokens_are_unguessable_hex() {
        let first = launch_token().expect("first token");
        let second = launch_token().expect("second token");
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }
}
