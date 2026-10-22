use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

pub const MENU_ID: &str = "update";
pub const CHECK_LABEL: &str = "Check for updates";

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(20);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

pub struct MenuItemHandle(pub MenuItem<Wry>);

#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

/// Checks quietly now and then. Any failure, such as an unreachable or private release feed,
/// is ignored: updates are a convenience and must never get in the way of chat.
pub fn spawn_background_checks(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            let _ = check(&app).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

/// Installs the update found earlier, or looks for one if none is waiting.
pub fn on_menu_click(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let update = app
            .state::<Pending>()
            .0
            .lock()
            .expect("pending lock")
            .take();
        if let Some(update) = update {
            install(&app, update).await;
            return;
        }
        match check(&app).await {
            Ok(Some(version)) => say(
                &app,
                &format!(
                    "Version {version} is available. Choose the menu item again to install it."
                ),
            ),
            Ok(None) => say(&app, "Harmony is up to date."),
            Err(()) => say(&app, "Could not check for updates."),
        }
    });
}

async fn check(app: &AppHandle) -> Result<Option<String>, ()> {
    let updater = app.updater().map_err(|_| ())?;
    let found = updater.check().await.map_err(|_| ())?;
    let version = found.as_ref().map(|update| update.version.clone());
    if let Some(item) = app.try_state::<MenuItemHandle>() {
        let label = version
            .as_ref()
            .map_or_else(|| CHECK_LABEL.to_owned(), |v| format!("Install update {v}"));
        let _ = item.0.set_text(label);
    }
    *app.state::<Pending>().0.lock().expect("pending lock") = found;
    Ok(version)
}

async fn install(app: &AppHandle, update: Update) {
    say(app, "Downloading the update…");
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => app.restart(),
        Err(_) => say(app, "The update could not be installed."),
    }
}

fn say(app: &AppHandle, body: &str) {
    let _ = app
        .notification()
        .builder()
        .title("Harmony")
        .body(body)
        .show();
}
