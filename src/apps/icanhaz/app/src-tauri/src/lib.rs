//! icanhaz — the native (tray) app. It *is* the daemon: the whole NoCap surface
//! (broker + capabilities served over WebSocket + WebTransport) runs inside this
//! process, spawned from the Tauri `setup` hook onto Tauri's async runtime.
//!
//! Consent is **native**: a request parks in a shared registry, which shows + focuses
//! this app's window and posts a notification. The window polls `list_pending` to
//! render each request and calls `decide` to resolve it — with an optional narrowed
//! grant (the broker clamps it to a subset of the request regardless).

mod consent;

use std::path::PathBuf;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_notification::NotificationExt as _;

use icanhaz_host::approve::{PendingConsent, PendingRequest};
use icanhaz_host::broker::{Consent, GrantStore, Hosts, Pairings};
use icanhaz_host::daemon::DaemonConfig;

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

/// Show + focus the consent window (it exists, possibly hidden behind the tray).
fn show_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn pairings_path() -> PathBuf {
    std::env::var("ICANHAZ_PAIRINGS").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string())).join(".icanhaz-pairings.json")
    })
}

fn hosts_path() -> PathBuf {
    std::env::var("ICANHAZ_HOSTS").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string())).join(".icanhaz-hosts.json")
    })
}

/// Read the same `ICANHAZ_*` env the headless binary does, with sensible defaults.
fn daemon_config() -> DaemonConfig {
    let root = std::env::var("ICANHAZ_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("icanhaz-demo-root"));
    let fs_component = std::env::var("ICANHAZ_FS_COMPONENT").unwrap_or_else(|_| {
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../policies/fs-passthrough/target/wasm32-wasip2/debug/fs_passthrough.wasm"
        )
        .to_string()
    });
    DaemonConfig {
        ws_bind: env_or("ICANHAZ_WS_BIND", "127.0.0.1:7777"),
        wt_bind: env_or("ICANHAZ_WT_BIND", "127.0.0.1:7778").parse().expect("invalid ICANHAZ_WT_BIND"),
        root,
        fs_component: PathBuf::from(fs_component),
        cert: std::env::var("ICANHAZ_CERT").ok(),
        key: std::env::var("ICANHAZ_KEY").ok(),
        consent_label: "native consent window".to_string(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            consent::list_pending,
            consent::decide,
            consent::list_grants,
            consent::revoke_grant,
            consent::list_capabilities,
            consent::list_pairings,
            consent::forget_pairing,
            consent::list_hosts,
            consent::list_unknown_hosts,
            consent::add_host,
            consent::remove_host
        ])
        .setup(|app| {
            // Tray: left-click summons the window; the menu offers Show + Quit.
            let show_i = MenuItem::with_id(app, "show", "Show icanhaz", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit icanhaz", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;
            let _tray = TrayIconBuilder::with_id("icanhaz")
                .tooltip("icanhaz — consent")
                .icon(app.default_window_icon().cloned().expect("bundled default icon"))
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_window(app),
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
                        show_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Native consent surface: a freshly-parked request shows + focuses the
            // window and posts a notification. The window polls `list_pending`.
            let handle = app.handle().clone();
            let pending = PendingConsent::with_notifier(move |req: &PendingRequest| {
                show_window(&handle);
                let _ = handle
                    .notification()
                    .builder()
                    .title("icanhaz — consent requested")
                    .body(format!("{} wants {}", req.requester, req.summary))
                    .show();
            });
            app.manage(pending.clone());

            // The daemon = the whole NoCap surface, gated by that consent.
            let grants = GrantStore::shared();
            app.manage(grants.clone()); // for the audit view's list_grants / revoke_grant
            let pairings = Pairings::load(pairings_path());
            app.manage(pairings.clone()); // so revoke_grant can also forget the pairing
            let hosts = Hosts::load(hosts_path(), true); // app: strict — unapproved hosts are recorded, not prompted
            app.manage(hosts.clone()); // for the Hosts allowlist section + gating
            let consent = Consent::Surface(pending);
            let config = daemon_config();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = icanhaz_host::daemon::run(config, grants, pairings, hosts, consent).await {
                    eprintln!("icanhaz daemon exited with error: {err:?}");
                }
            });

            // Keep the tray badge in sync from the backend, independent of the window
            // (a hidden window's JS timers get throttled, so the count could go stale).
            let tray_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let n = tray_handle.state::<PendingConsent>().list().len();
                    consent::set_tray_badge(&tray_handle, n);
                    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                }
            });
            Ok(())
        })
        // Close = hide to the tray, keeping the daemon resident in the background.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running icanhaz");
}
