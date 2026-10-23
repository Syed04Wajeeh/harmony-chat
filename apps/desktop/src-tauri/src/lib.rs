mod badge;
mod commands;
mod config;
mod discovery;
mod notify;
mod probe;
mod server_url;
mod session;
mod tailscale;
mod tray;
mod updater;
mod window;

use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_window_state::StateFlags;

use config::ConfigStore;
use session::Session;

const MINIMIZED_FLAG: &str = "--minimized";

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            window::show(app)
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Decorations are decided by the app per platform, not by a saved state.
                .with_state_flags(
                    StateFlags::all() & !StateFlags::VISIBLE & !StateFlags::DECORATIONS,
                )
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![MINIMIZED_FLAG]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::connect_server,
            commands::discover_servers,
            commands::disconnect_server,
            commands::forget_server,
            commands::known_servers,
            commands::tailscale_status,
            commands::tailscale_switch,
            commands::notify,
            commands::set_badge,
            commands::window_close,
            commands::window_is_maximized,
            commands::window_minimize,
            commands::window_start_dragging,
            commands::window_toggle_maximize,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let store = ConfigStore::new(app.path().app_config_dir()?);
            let origin = store
                .load()
                .server_url
                .and_then(|url| server_url::normalize(&url).ok());
            app.manage(store);
            app.manage(Session::new(origin.clone()));
            app.manage(updater::Pending::default());
            if let Some(origin) = &origin {
                session::grant_remote_access(&handle, origin)?;
            }

            if let Err(error) = tray::build(&handle) {
                eprintln!("tray unavailable: {error}");
            }
            handle.notification().on_action({
                let handle = handle.clone();
                move |action| open_clicked_notification(&handle, action)
            })?;
            window::create_main(&handle, std::env::args().any(|arg| arg == MINIMIZED_FLAG))?;
            updater::spawn_background_checks(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing hides the window; the tray menu quits.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == window::MAIN
                    && window.app_handle().tray_by_id(tray::ID).is_some()
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Harmony");
}

fn open_clicked_notification(
    app: &tauri::AppHandle,
    action: &tauri_plugin_notification::ActionPerformed,
) {
    window::show(app);
    let route = action
        .notification()
        .and_then(|notification| notification.extra().get("route"))
        .and_then(|route| route.as_str());
    if let (Some(route), Some(window)) = (route, window::main_window(app)) {
        if notify::is_app_route(route)
            && window
                .url()
                .is_ok_and(|url| app.state::<Session>().is_server(&url))
        {
            window::navigate_page(&window, route);
        }
    }
}
