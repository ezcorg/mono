#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init());

    // Global (system-wide) shortcut support is desktop-only. The actual hotkey
    // is registered from the frontend (src/App.tsx) so its handler can drive
    // the editor.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    builder
        // Keep the app resident: closing the window hides it instead of
        // quitting, so the global "new scratch pad" hotkey can always summon
        // it back.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
