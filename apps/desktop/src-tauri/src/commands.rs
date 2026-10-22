use serde::Serialize;
use tauri::{AppHandle, State, Webview};
use tauri_plugin_notification::NotificationExt;
use thiserror::Error;

use crate::badge;
use crate::config::{Config, ConfigStore};
use crate::notify::{InvalidArgument, Toast};
use crate::probe::{probe, ProbeError};
use crate::server_url::{normalize, UrlError};
use crate::session::{grant_remote_access, Session};
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
) -> Result<(), ConnectError> {
    if called_by_server(&session, &webview) {
        return Err(ConnectError::Forbidden);
    }
    let origin = normalize(&url)?;
    probe(&origin).await?;
    store
        .save(&Config {
            server_url: Some(origin.to_string()),
        })
        .map_err(|_| ConnectError::SaveFailed)?;
    session.set(Some(origin.clone()));
    grant_remote_access(&app, &origin).map_err(|_| ConnectError::Internal)?;
    let window = window::main_window(&app).ok_or(ConnectError::Internal)?;
    window.navigate(origin).map_err(|_| ConnectError::Internal)
}

/// Setup page only: the stored address, to prefill the form.
#[tauri::command]
pub fn get_server_url(
    session: State<'_, Session>,
    store: State<'_, ConfigStore>,
    webview: Webview,
) -> Result<Option<String>, ConnectError> {
    if called_by_server(&session, &webview) {
        return Err(ConnectError::Forbidden);
    }
    Ok(store.load().server_url)
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
