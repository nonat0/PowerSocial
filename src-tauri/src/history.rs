use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Um item baixado, exibido na galeria e persistido em disco.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryItem {
    pub id: String,
    pub title: String,
    pub platform: String,
    pub quality: String,
    pub filepath: String,
    pub thumbnail: Option<String>,
    pub filesize: u64,
    pub date: String,
    pub url: String,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub duration: Option<f64>,
}

/// Configuracoes do app: pasta de downloads e cookies p/ sites que exigem login.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Settings {
    pub download_dir: Option<String>,
    /// Navegador de onde extrair cookies (chrome/edge/firefox/brave/...).
    #[serde(default)]
    pub cookies_browser: Option<String>,
    /// Caminho para um arquivo cookies.txt (tem prioridade sobre o navegador).
    #[serde(default)]
    pub cookies_file: Option<String>,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Nao foi possivel obter o diretorio de dados: {e}"))?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Falha ao criar diretorio de dados: {e}"))?;
    }
    Ok(dir)
}

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("history.json"))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("settings.json"))
}

fn cancelled_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("cancelled.json"))
}

/// Lista de downloads cancelados (registro livre vindo do frontend).
pub fn load_cancelled(app: &AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let path = cancelled_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Falha ao ler cancelados: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Cancelados corrompidos: {e}"))
}

pub fn add_cancelled(app: &AppHandle, item: serde_json::Value) -> Result<(), String> {
    let mut items = load_cancelled(app)?;
    items.insert(0, item);
    items.truncate(200);
    let data = serde_json::to_string_pretty(&items)
        .map_err(|e| format!("Falha ao serializar cancelados: {e}"))?;
    std::fs::write(cancelled_path(app)?, data)
        .map_err(|e| format!("Falha ao salvar cancelados: {e}"))
}

pub fn clear_cancelled(app: &AppHandle) -> Result<(), String> {
    std::fs::write(cancelled_path(app)?, "[]")
        .map_err(|e| format!("Falha ao limpar cancelados: {e}"))
}

pub fn load_history(app: &AppHandle) -> Result<Vec<HistoryItem>, String> {
    let path = history_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Falha ao ler historico: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Historico corrompido: {e}"))
}

fn save_history(app: &AppHandle, items: &[HistoryItem]) -> Result<(), String> {
    let path = history_path(app)?;
    let data = serde_json::to_string_pretty(items)
        .map_err(|e| format!("Falha ao serializar historico: {e}"))?;
    std::fs::write(&path, data).map_err(|e| format!("Falha ao salvar historico: {e}"))
}

/// Insere um item no topo do historico (mais recente primeiro).
pub fn add_item(app: &AppHandle, item: HistoryItem) -> Result<(), String> {
    let mut items = load_history(app)?;
    items.retain(|i| i.id != item.id);
    items.insert(0, item);
    save_history(app, &items)
}

/// Atualiza o link (url) de um item pelo caminho do arquivo. Devolve o id se achou.
pub fn set_url_by_path(app: &AppHandle, path: &str, url: &str) -> Option<String> {
    let mut items = load_history(app).ok()?;
    let key = path.to_lowercase();
    let pos = items.iter().position(|i| i.filepath.to_lowercase() == key)?;
    if items[pos].url == url {
        return Some(items[pos].id.clone());
    }
    items[pos].url = url.to_string();
    let id = items[pos].id.clone();
    let _ = save_history(app, &items);
    Some(id)
}

/// Marca/desmarca um item como favorito.
pub fn set_favorite(app: &AppHandle, id: &str, favorite: bool) -> Result<(), String> {
    let mut items = load_history(app)?;
    if let Some(it) = items.iter_mut().find(|i| i.id == id) {
        it.favorite = favorite;
    }
    save_history(app, &items)
}

/// Sobrescreve todo o histórico (usado por backfill/atualizações em massa).
pub fn replace(app: &AppHandle, items: &[HistoryItem]) -> Result<(), String> {
    save_history(app, items)
}

/// Importa: adiciona os novos (no topo) e, se o caminho já existir, atualiza
/// metadados que faltam (ex.: duração) em vez de duplicar. Devolve o histórico
/// completo e quantos itens novos foram adicionados.
pub fn add_imported(
    app: &AppHandle,
    new_items: Vec<HistoryItem>,
) -> Result<(Vec<HistoryItem>, usize), String> {
    use std::collections::HashMap;
    let mut items = load_history(app)?;
    let index: HashMap<String, usize> = items
        .iter()
        .enumerate()
        .map(|(i, it)| (it.filepath.to_lowercase(), i))
        .collect();

    let mut to_add = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for it in new_items {
        let key = it.filepath.to_lowercase();
        if let Some(&i) = index.get(&key) {
            // já existe: completa a duração que faltar.
            if items[i].duration.is_none() {
                items[i].duration = it.duration;
            }
        } else if seen.insert(key) {
            to_add.push(it);
        }
    }
    let added = to_add.len();
    for it in to_add.into_iter().rev() {
        items.insert(0, it);
    }
    save_history(app, &items)?;
    Ok((items, added))
}

pub fn remove_item(app: &AppHandle, id: &str, delete_file: bool) -> Result<(), String> {
    let mut items = load_history(app)?;
    if let Some(pos) = items.iter().position(|i| i.id == id) {
        let removed = items.remove(pos);
        if delete_file {
            let _ = std::fs::remove_file(&removed.filepath);
            if let Some(thumb) = &removed.thumbnail {
                let _ = std::fs::remove_file(thumb);
            }
        }
    }
    save_history(app, &items)
}

pub fn load_settings(app: &AppHandle) -> Result<Settings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Falha ao ler configuracoes: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Configuracoes corrompidas: {e}"))
}

pub fn save_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let data = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Falha ao serializar configuracoes: {e}"))?;
    std::fs::write(&path, data).map_err(|e| format!("Falha ao salvar configuracoes: {e}"))
}

/// Pasta de download padrao: <Downloads do usuario>/CreatorGallery.
pub fn default_download_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("Nao foi possivel determinar a pasta padrao: {e}"))?;
    Ok(base.join("CreatorGallery"))
}

/// Retorna a pasta de download efetiva (config do usuario ou padrao), criando-a.
pub fn effective_download_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let settings = load_settings(app)?;
    let dir = match settings.download_dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => default_download_dir(app)?,
    };
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Falha ao criar a pasta de downloads: {e}"))?;
    }
    Ok(dir)
}
