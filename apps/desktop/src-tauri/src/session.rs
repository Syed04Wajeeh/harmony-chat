use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, Runtime};
use url::Url;

use crate::server_url::{capability_pattern, same_origin};

/// Commands the remote page may call; they must match `build.rs`.
const REMOTE_PERMISSIONS: [&str; 2] = ["allow-notify", "allow-set-badge"];

/// The server this window is connected to, or none while the setup page is showing.
///
/// Commands compare the calling page against this on every call, so a page from a server
/// that is no longer configured is refused even though Tauri cannot withdraw a capability
/// at runtime.
#[derive(Default)]
pub struct Session {
    origin: Mutex<Option<Url>>,
    grants: AtomicU32,
}

impl Session {
    pub fn new(origin: Option<Url>) -> Self {
        Self {
            origin: Mutex::new(origin),
            grants: AtomicU32::new(0),
        }
    }

    pub fn origin(&self) -> Option<Url> {
        self.origin.lock().expect("session lock").clone()
    }

    pub fn set(&self, origin: Option<Url>) {
        *self.origin.lock().expect("session lock") = origin;
    }

    pub fn is_server(&self, url: &Url) -> bool {
        self.origin()
            .is_some_and(|origin| same_origin(&origin, url))
    }

    fn next_grant(&self) -> u32 {
        self.grants.fetch_add(1, Ordering::Relaxed)
    }
}

/// Lets pages served from exactly `origin` call the notification and badge commands.
pub fn grant_remote_access<R: Runtime>(app: &AppHandle<R>, origin: &Url) -> tauri::Result<()> {
    let Some(pattern) = capability_pattern(origin) else {
        return Ok(());
    };
    let id = app.state::<Session>().next_grant();
    let capability = REMOTE_PERMISSIONS.into_iter().fold(
        CapabilityBuilder::new(format!("remote-server-{id}"))
            .local(false)
            .window(crate::window::MAIN)
            .remote(pattern),
        CapabilityBuilder::permission,
    );
    app.add_capability(capability)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    #[tauri::command]
    fn notify() -> &'static str {
        "shown"
    }

    #[tauri::command]
    fn connect_server() -> &'static str {
        "connected"
    }

    #[test]
    fn only_the_current_origin_is_the_server() {
        let a = Url::parse("https://a.example.ts.net/").unwrap();
        let b = Url::parse("https://b.example.ts.net/").unwrap();
        let session = Session::new(Some(a.clone()));
        assert!(session.is_server(&a.join("/channels/1").unwrap()));
        assert!(!session.is_server(&b));

        session.set(Some(b.clone()));
        assert!(!session.is_server(&a), "the old origin loses access");
        assert!(session.is_server(&b));

        session.set(None);
        assert!(!session.is_server(&b));
    }

    /// Runs real IPC requests through Tauri's access control, with the capabilities and
    /// command manifest this crate ships.
    #[test]
    fn remote_capability_covers_only_the_configured_origin_and_only_its_commands() {
        let origin = Url::parse("https://chat.example.ts.net:18470/").unwrap();
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![notify, connect_server])
            .build(tauri::generate_context!())
            .unwrap();
        app.manage(Session::new(Some(origin.clone())));
        grant_remote_access(app.handle(), &origin).unwrap();
        let webview = WebviewWindowBuilder::new(&app, crate::window::MAIN, WebviewUrl::default())
            .build()
            .unwrap();

        let call = |command: &str, url: &str| {
            get_ipc_response(
                &webview,
                InvokeRequest {
                    cmd: command.into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: url.parse().unwrap(),
                    body: InvokeBody::default(),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.into(),
                },
            )
            .map(|_| ())
        };

        assert!(call("notify", "https://chat.example.ts.net:18470/channels/1").is_ok());
        assert!(call("notify", "https://chat.example.ts.net:18470/").is_ok());
        assert!(
            call("notify", "https://chat.example.ts.net/").is_err(),
            "other port"
        );
        assert!(
            call("notify", "http://chat.example.ts.net:18470/").is_err(),
            "other scheme"
        );
        assert!(
            call("notify", "https://other.example.ts.net:18470/").is_err(),
            "other host"
        );
        assert!(call("notify", "https://chat.example.ts.net.evil.test:18470/").is_err());
        assert!(
            call("connect_server", "https://chat.example.ts.net:18470/").is_err(),
            "setup commands are not exposed to the server"
        );
        assert!(
            call("connect_server", "tauri://localhost/").is_ok(),
            "setup page"
        );
        assert!(
            call("notify", "tauri://localhost/").is_err(),
            "setup page has no bridge"
        );
    }
}
