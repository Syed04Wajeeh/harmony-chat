use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::{updater, window};

pub const ID: &str = "main";

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Show / Hide", true, None::<&str>)?;
    let disconnect = MenuItem::with_id(
        app,
        "disconnect",
        "Disconnect / switch server…",
        true,
        None::<&str>,
    )?;
    let launch = CheckMenuItem::with_id(
        app,
        "launch-at-login",
        "Launch at login",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let update = MenuItem::with_id(
        app,
        updater::MENU_ID,
        updater::CHECK_LABEL,
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Harmony", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &toggle,
            &PredefinedMenuItem::separator(app)?,
            &disconnect,
            &launch,
            &update,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    app.manage(updater::MenuItemHandle(update));

    let mut tray = TrayIconBuilder::with_id(ID)
        .tooltip("Harmony")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "toggle" => window::toggle(app),
            "disconnect" => window::disconnect(app),
            "launch-at-login" => {
                let autolaunch = app.autolaunch();
                let result = if autolaunch.is_enabled().unwrap_or(false) {
                    autolaunch.disable()
                } else {
                    autolaunch.enable()
                };
                if result.is_err() {
                    eprintln!("could not change launch at login");
                }
                let _ = launch.set_checked(autolaunch.is_enabled().unwrap_or(false));
            }
            id if id == updater::MENU_ID => updater::on_menu_click(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                window::toggle(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
