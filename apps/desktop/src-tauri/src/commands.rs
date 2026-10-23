use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State, Webview, WebviewWindow};
use tauri_plugin_notification::NotificationExt;

use thiserror::Error;

use crate::badge;
use crate::config::{ConfigStore, KnownServer};
use crate::discovery::{self, FoundServer};
use crate::notify::{InvalidArgument, Toast};
use crate::probe::{probe, ProbeError};
use crate::server_url::{normalize, UrlError};
use crate::session::{grant_remote_access, Session};
use crate::tailscale::{self, Account, SwitchError};
use crate::window;

/// Why connecting to a server failed. The setup page turns each code into a message.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum ConnectError {
    #[error("address is empty")]
    Empty,
    #[error("address is not valid")]
    Malformed,
    #[error("address is not secure")]
    Insecure,
    #[error("address has credentials")]
    Credentials,
    #[error("server unreachable")]
    Unreachable,
    #[error("server timed out")]
    Timeout,
    #[error("server answered {status}")]
    BadStatus { status: u16 },
    #[error("not a Harmony server")]
    NotHarmony,
    #[error("caller not allowed")]
    Forbidden,
    #[error("could not save settings")]
    SaveFailed,
    #[error("internal error")]
    Internal,
}

impl From<UrlError> for ConnectError {
    fn from(error: UrlError) -> Self {
        match error {
            UrlError::Empty => Self::Empty,
            UrlError::Malformed => Self::Malformed,
            UrlError::Insecure => Self::Insecure,
            UrlError::Credentials => Self::Credentials,
        }
    }
}

impl From<ProbeError> for ConnectError {
    fn from(error: ProbeError) -> Self {
        match error {
            ProbeError::Unreachable => Self::Unreachable,
            ProbeError::Timeout => Self::Timeout,
            ProbeError::BadStatus(status) => Self::BadStatus { status },
            ProbeError::NotHarmony => Self::NotHarmony,
        }
    }
}

/// Errors from the commands the remote page may call.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum BridgeError {
    #[error("caller not allowed")]
    Forbidden,
    #[error("{0}")]
    InvalidArgument(#[from] InvalidArgument),
    #[error("could not show notification")]
    Failed,
}

fn called_by_server(session: &Session, webview: &Webview) -> bool {
    webview.url().is_ok_and(|url| session.is_server(&url))
}

/// Setup page only: validates, probes and stores the address, then opens the server.
#[tauri::command]
pub async fn connect_server(
    app: AppHandle,
    session: State<'_, Session>,
    store: State<'_, ConfigStore>,
    webview: Webview,
    url: String,
    owner_label: Option<String>,
) -> Result<(), ConnectError> {
    if called_by_server(&session, &webview) {
        return Err(ConnectError::Forbidden);
    }
    let origin = normalize(&url)?;
    probe(&origin).await?;
    let mut config = store.load();
    config.connect(
        origin.as_str(),
        origin.host_str().unwrap_or_default(),
        owner_label.as_deref(),
        now_secs(),
    );
    store.save(&config).map_err(|_| ConnectError::SaveFailed)?;
    session.set(Some(origin.clone()));
    grant_remote_access(&app, &origin).map_err(|_| ConnectError::Internal)?;
    let window = window::main_window(&app).ok_or(ConnectError::Internal)?;
    window.navigate(origin).map_err(|_| ConnectError::Internal)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// Errors from the commands only the bundled setup page may call.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum SetupError {
    #[error("caller not allowed")]
    Forbidden,
    #[error("{message}")]
    Failed { message: String },
}

fn require_setup_page(session: &Session, webview: &Webview) -> Result<(), SetupError> {
    if called_by_server(session, webview) {
        Err(SetupError::Forbidden)
    } else {
        Ok(())
    }
}

/// Setup page only: the servers connected to before, most recent first.
#[tauri::command]
pub fn known_servers(
    session: State<'_, Session>,
    store: State<'_, ConfigStore>,
    webview: Webview,
) -> Result<Vec<KnownServer>, SetupError> {
    require_setup_page(&session, &webview)?;
    Ok(store.load().known_servers)
}

/// Setup page only: removes one entry from the recent list. Browsing data is left alone.
#[tauri::command]
pub fn forget_server(
    session: State<'_, Session>,
    store: State<'_, ConfigStore>,
    webview: Webview,
    url: String,
) -> Result<(), SetupError> {
    require_setup_page(&session, &webview)?;
    let mut config = store.load();
    config.forget(&url);
    store.save(&config).map_err(|_| SetupError::Failed {
        message: "could not save settings".into(),
    })
}

/// What the setup page shows about Tailscale.
#[derive(Debug, Serialize)]
pub struct TailnetView {
    #[serde(flatten)]
    status: tailscale::Status,
    accounts: Vec<Account>,
}

/// Setup page only: Tailscale state, the signed-in account, and the accounts that can be
/// switched to.
#[tauri::command]
pub async fn tailscale_status(
    session: State<'_, Session>,
    webview: Webview,
) -> Result<TailnetView, SetupError> {
    require_setup_page(&session, &webview)?;
    let (status, accounts) = tokio::join!(tailscale::status(), tailscale::accounts());
    Ok(TailnetView { status, accounts })
}

/// Setup page only: the Harmony servers among the online devices on the tailnet. Nothing is
/// connected; the user picks one.
#[tauri::command]
pub async fn discover_servers(
    session: State<'_, Session>,
    webview: Webview,
    extra_port: Option<u16>,
) -> Result<Vec<FoundServer>, SetupError> {
    require_setup_page(&session, &webview)?;
    let status = tailscale::status().await;
    Ok(discovery::discover(&status.peers, extra_port).await)
}

/// Setup page only: switches Tailscale to one of its listed accounts.
#[tauri::command]
pub async fn tailscale_switch(
    session: State<'_, Session>,
    webview: Webview,
    id: String,
) -> Result<(), SetupError> {
    require_setup_page(&session, &webview)?;
    tailscale::switch(&id).await.map_err(|error| {
        let message = match error {
            SwitchError::UnknownAccount => "That account is not in the list.".to_owned(),
            SwitchError::Run(tailscale::RunError::NotInstalled) => {
                "Tailscale is not installed.".to_owned()
            }
            SwitchError::Run(tailscale::RunError::TimedOut) => {
                "Tailscale did not answer in time.".to_owned()
            }
            SwitchError::Run(tailscale::RunError::Failed(text)) => text,
        };
        SetupError::Failed { message }
    })
}

/// Shows a native notification unless the window is already in front. Clicking it opens `route`.
#[tauri::command]
pub fn notify(
    app: AppHandle,
    session: State<'_, Session>,
    webview: Webview,
    title: String,
    body: String,
    route: String,
) -> Result<(), BridgeError> {
    if !called_by_server(&session, &webview) {
        return Err(BridgeError::Forbidden);
    }
    let toast = Toast::parse(&title, &body, &route)?;
    let in_front = window::main_window(&app).is_some_and(|window| {
        window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
    });
    if in_front {
        return Ok(());
    }
    app.notification()
        .builder()
        .title(toast.title)
        .body(toast.body)
        .extra("route", toast.route)
        .show()
        .map_err(|_| BridgeError::Failed)
}

/// Shows the unread count on the tray tooltip, the dock/launcher badge and the taskbar overlay.
#[tauri::command]
pub fn set_badge(
    app: AppHandle,
    session: State<'_, Session>,
    webview: Webview,
    count: u32,
) -> Result<(), BridgeError> {
    if !called_by_server(&session, &webview) {
        return Err(BridgeError::Forbidden);
    }
    let count = badge::clamp(count);
    if let Some(tray) = app.tray_by_id(crate::tray::ID) {
        let _ = tray.set_tooltip(Some(badge::tooltip(count)));
    }
    if let Some(window) = window::main_window(&app) {
        let _ = window.set_badge_count((count > 0).then_some(i64::from(count)));
        #[cfg(windows)]
        {
            let overlay = tauri::image::Image::new_owned(
                badge::overlay_rgba(),
                badge::OVERLAY_SIZE,
                badge::OVERLAY_SIZE,
            );
            let _ = window.set_overlay_icon((count > 0).then_some(overlay));
        }
    }
    Ok(())
}

/// The window behind the custom title bar, if the caller is the bundled setup page or the
/// configured server.
fn title_bar_window(
    app: &AppHandle,
    session: &Session,
    window: WebviewWindow,
) -> Result<WebviewWindow, BridgeError> {
    let trusted = window
        .url()
        .is_ok_and(|url| session.is_server(&url) || window::is_local(app, &url));
    if trusted && window.label() == window::MAIN {
        Ok(window)
    } else {
        Err(BridgeError::Forbidden)
    }
}

/// Title bar: minimizes the window.
#[tauri::command]
pub fn window_minimize(
    app: AppHandle,
    session: State<'_, Session>,
    window: WebviewWindow,
) -> Result<(), BridgeError> {
    title_bar_window(&app, &session, window)?
        .minimize()
        .map_err(|_| BridgeError::Failed)
}

/// Title bar: maximizes the window, or restores it when it is maximized.
#[tauri::command]
pub fn window_toggle_maximize(
    app: AppHandle,
    session: State<'_, Session>,
    window: WebviewWindow,
) -> Result<(), BridgeError> {
    let window = title_bar_window(&app, &session, window)?;
    let result = if window.is_maximized().map_err(|_| BridgeError::Failed)? {
        window.unmaximize()
    } else {
        window.maximize()
    };
    result.map_err(|_| BridgeError::Failed)
}

/// Title bar: whether the window is maximized, to pick the right button icon.
#[tauri::command]
pub fn window_is_maximized(
    app: AppHandle,
    session: State<'_, Session>,
    window: WebviewWindow,
) -> Result<bool, BridgeError> {
    title_bar_window(&app, &session, window)?
        .is_maximized()
        .map_err(|_| BridgeError::Failed)
}

/// Title bar: closes the window, which hides it to the tray like the native close button.
#[tauri::command]
pub fn window_close(
    app: AppHandle,
    session: State<'_, Session>,
    window: WebviewWindow,
) -> Result<(), BridgeError> {
    title_bar_window(&app, &session, window)?
        .close()
        .map_err(|_| BridgeError::Failed)
}

/// Title bar: starts moving the window; call it from a mouse-down on the bar.
#[tauri::command]
pub fn window_start_dragging(
    app: AppHandle,
    session: State<'_, Session>,
    window: WebviewWindow,
) -> Result<(), BridgeError> {
    title_bar_window(&app, &session, window)?
        .start_dragging()
        .map_err(|_| BridgeError::Failed)
}

/// Title bar and tray: drops the connection and shows the setup page. Local browsing data is kept.
#[tauri::command]
pub fn disconnect_server(
    app: AppHandle,
    session: State<'_, Session>,
    window: WebviewWindow,
) -> Result<(), BridgeError> {
    title_bar_window(&app, &session, window)?;
    window::disconnect(&app);
    Ok(())
}
