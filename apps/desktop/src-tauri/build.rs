use tauri_build::{AppManifest, Attributes};

/// Every command an IPC caller can reach. Listing them makes Tauri require an explicit
/// permission (`allow-<command>`) in a capability; see `capabilities/` and `src/session.rs`.
const COMMANDS: &[&str] = &[
    "connect_server",
    "disconnect_server",
    "discover_servers",
    "forget_server",
    "known_servers",
    "tailscale_status",
    "tailscale_switch",
    "notify",
    "set_badge",
    "window_close",
    "window_is_maximized",
    "window_minimize",
    "window_start_dragging",
    "window_toggle_maximize",
];

fn main() {
    tauri_build::try_build(Attributes::new().app_manifest(AppManifest::new().commands(COMMANDS)))
        .expect("failed to run tauri-build");
}
