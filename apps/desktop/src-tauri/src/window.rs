use tauri::webview::{Color, NewWindowResponse};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::config::ConfigStore;
use crate::server_url::same_origin;
use crate::session::Session;

pub const MAIN: &str = "main";

/// Canvas color of the default theme, shown before the page paints (no white flash).
const CANVAS: Color = Color(0x14, 0x14, 0x13, 0xff);
const MIN_SIZE: (f64, f64) = (400.0, 500.0);

/// Fired in the page when the user clicks a notification; the web client navigates to `detail`.
const NAVIGATE_EVENT: &str = "harmony-desktop:navigate";

pub fn create_main(app: &AppHandle, hidden: bool) -> tauri::Result<WebviewWindow> {
    let start = match app.state::<Session>().origin() {
        Some(origin) => WebviewUrl::External(origin),
        None => WebviewUrl::App("index.html".into()),
    };
    let navigation_app = app.clone();
    let new_window_app = app.clone();
    WebviewWindowBuilder::new(app, MAIN, start)
        .title("Harmony")
        .inner_size(1200.0, 800.0)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .background_color(CANVAS)
        // Windows draws its own title bar in the accent color; the web client brings its own.
        .decorations(!cfg!(windows))
        .shadow(true)
        .visible(!hidden)
        .on_navigation(move |url| {
            let allowed =
                is_local(&navigation_app, url) || navigation_app.state::<Session>().is_server(url);
            if !allowed {
                open_external(&navigation_app, url);
            }
            allowed
        })
        .on_new_window(move |url, _| {
            open_external(&new_window_app, &url);
            NewWindowResponse::Deny
        })
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        .build()
}

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

pub fn show(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn toggle(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        return;
    };
    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
        let _ = window.hide();
    } else {
        show(app);
    }
}

/// Where the bundled setup page is served from.
fn local_origin(app: &AppHandle) -> Url {
    if tauri::is_dev() {
        if let Some(dev) = app.config().build.dev_url.clone() {
            return dev;
        }
    }
    let origin = if cfg!(windows) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    };
    Url::parse(origin).expect("constant URL")
}

pub fn is_local(app: &AppHandle, url: &Url) -> bool {
    same_origin(&local_origin(app), url)
}

/// Drops the connection and shows the setup page again.
///
/// The stored address is cleared so the next start shows the setup page too, but the recent list
/// stays and no browsing data (cookies, local storage) is touched: reconnecting restores it.
pub fn disconnect(app: &AppHandle) {
    app.state::<Session>().set(None);
    let store = app.state::<ConfigStore>();
    let mut config = store.load();
    config.disconnect();
    if store.save(&config).is_err() {
        eprintln!("could not save settings");
    }
    if let Some(window) = main_window(app) {
        let _ = window.navigate(local_origin(app));
    }
    show(app);
}

pub fn open_external(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

/// Asks the page to move to an in-app route. Only call with a route that passed `is_app_route`.
pub fn navigate_page(window: &WebviewWindow, route: &str) {
    let detail = serde_json::to_string(route).expect("a string serializes");
    let script = format!(
        "window.dispatchEvent(new CustomEvent('{NAVIGATE_EVENT}', {{ detail: {detail} }}));"
    );
    let _ = window.eval(script);
}
