use tauri_build::{AppManifest, Attributes};

/// Every command an IPC caller can reach. Listing them makes Tauri require an explicit
/// permission (`allow-<command>`) in a capability; see `capabilities/` and `src/session.rs`.
const COMMANDS: &[&str] = &["connect_server", "get_server_url", "notify", "set_badge"];

fn main() {
    tauri_build::try_build(Attributes::new().app_manifest(AppManifest::new().commands(COMMANDS)))
        .expect("failed to run tauri-build");
}
