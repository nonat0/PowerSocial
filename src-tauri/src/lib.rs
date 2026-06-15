mod downloader;
mod history;

use downloader::DownloadManager;
use history::{HistoryItem, Settings};
use std::sync::Arc;
use tauri::AppHandle;

#[tauri::command]
fn load_history(app: AppHandle) -> Result<Vec<HistoryItem>, String> {
    history::load_history(&app)
}

#[tauri::command]
fn remove_history_item(app: AppHandle, id: String, delete_file: bool) -> Result<(), String> {
    history::remove_item(&app, &id, delete_file)
}

#[tauri::command]
fn set_favorite(app: AppHandle, id: String, favorite: bool) -> Result<(), String> {
    history::set_favorite(&app, &id, favorite)
}

#[tauri::command]
fn load_cancelled(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    history::load_cancelled(&app)
}

#[tauri::command]
fn add_cancelled(app: AppHandle, item: serde_json::Value) -> Result<(), String> {
    history::add_cancelled(&app, item)
}

#[tauri::command]
fn clear_cancelled(app: AppHandle) -> Result<(), String> {
    history::clear_cancelled(&app)
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Result<Settings, String> {
    history::load_settings(&app)
}

#[tauri::command]
fn set_download_dir(app: AppHandle, dir: String) -> Result<(), String> {
    let mut settings = history::load_settings(&app)?;
    settings.download_dir = Some(dir);
    history::save_settings(&app, &settings)
}

#[tauri::command]
fn get_download_dir(app: AppHandle) -> Result<String, String> {
    Ok(history::effective_download_dir(&app)?
        .to_string_lossy()
        .to_string())
}

/// Define a fonte de cookies para conteudo que exige login (YouTube etc.).
/// `browser` ex.: "chrome"/"edge"/"firefox"/"brave"; `file` = caminho cookies.txt.
/// Passe strings vazias/None para limpar.
#[tauri::command]
fn set_cookie_settings(
    app: AppHandle,
    browser: Option<String>,
    file: Option<String>,
) -> Result<(), String> {
    let norm = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let mut settings = history::load_settings(&app)?;
    settings.cookies_browser = norm(browser);
    settings.cookies_file = norm(file);
    history::save_settings(&app, &settings)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(DownloadManager::new()))
        .invoke_handler(tauri::generate_handler![
            downloader::get_video_info,
            downloader::download_video,
            downloader::cancel_download,
            downloader::pause_download,
            downloader::fetch_playlist_sizes,
            downloader::cancel_playlist_sizes,
            downloader::open_path,
            downloader::reveal_path,
            downloader::read_image_base64,
            load_history,
            remove_history_item,
            set_favorite,
            downloader::import_gallery,
            downloader::backfill_durations,
            downloader::cut_video,
            downloader::generate_thumbnails,
            downloader::probe_media,
            downloader::apply_edits,
            downloader::cancel_edit,
            downloader::capture_frame,
            load_cancelled,
            add_cancelled,
            clear_cancelled,
            get_settings,
            set_download_dir,
            get_download_dir,
            set_cookie_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
