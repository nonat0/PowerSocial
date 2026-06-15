use crate::history::{self, HistoryItem};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::collections::HashSet;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{oneshot, watch, Semaphore};

/// Quantos downloads podem rodar ao mesmo tempo; o restante fica na fila.
const MAX_CONCURRENT: usize = 3;

/// Motivo de parada de um download em andamento.
#[derive(Clone, Copy)]
pub enum StopReason {
    Cancel,
    Pause,
}

/// Gerencia os downloads em andamento: permite cancelar/pausar e limita a concorrencia.
pub struct DownloadManager {
    jobs: Mutex<HashMap<String, oneshot::Sender<StopReason>>>,
    /// Sondagens de tamanho de playlist em andamento (uma de cada vez, na prática).
    probes: Mutex<HashMap<String, oneshot::Sender<()>>>,
    /// Edições de vídeo (ffmpeg) em andamento, para permitir cancelar.
    edits: Mutex<HashMap<String, oneshot::Sender<()>>>,
    sem: Arc<Semaphore>,
}

impl DownloadManager {
    pub fn new() -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
            probes: Mutex::new(HashMap::new()),
            edits: Mutex::new(HashMap::new()),
            sem: Arc::new(Semaphore::new(MAX_CONCURRENT)),
        }
    }
}

impl Default for DownloadManager {
    fn default() -> Self {
        Self::new()
    }
}

// ------------------------------------------------------------------
// Resolucao dos executaveis (sidecar > PATH > winget)
// ------------------------------------------------------------------

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

fn find_on_path(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(exe))
        .find(|c| c.is_file())
}

fn find_recursive(dir: &Path, filename: &str, depth: usize) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    let mut subdirs = Vec::new();
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.is_file() {
            if p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.eq_ignore_ascii_case(filename))
                .unwrap_or(false)
            {
                return Some(p);
            }
        } else if p.is_dir() {
            subdirs.push(p);
        }
    }
    subdirs
        .into_iter()
        .find_map(|sd| find_recursive(&sd, filename, depth - 1))
}

#[cfg(target_os = "windows")]
fn search_winget(filename: &str) -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    let base = Path::new(&local)
        .join("Microsoft")
        .join("WinGet")
        .join("Packages");
    find_recursive(&base, filename, 6)
}

#[cfg(not(target_os = "windows"))]
fn search_winget(_filename: &str) -> Option<PathBuf> {
    None
}

/// Nome do yt-dlp: sidecar ao lado do exe (producao) > PATH > winget (dev) > nome puro.
fn ytdlp_exe() -> &'static str {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let name = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };
            if let Some(dir) = exe_dir() {
                let sidecar = dir.join(name);
                if sidecar.is_file() {
                    return sidecar.to_string_lossy().into_owned();
                }
            }
            if let Some(p) = find_on_path(name) {
                return p.to_string_lossy().into_owned();
            }
            if let Some(p) = search_winget("yt-dlp.exe") {
                return p.to_string_lossy().into_owned();
            }
            "yt-dlp".to_string()
        })
        .as_str()
}

/// Caminho do executavel do ffmpeg (sidecar > PATH > winget > nome puro).
fn ffmpeg_exe() -> &'static str {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
            if let Some(dir) = exe_dir() {
                let sidecar = dir.join(name);
                if sidecar.is_file() {
                    return sidecar.to_string_lossy().into_owned();
                }
            }
            if let Some(p) = find_on_path(name) {
                return p.to_string_lossy().into_owned();
            }
            if let Some(p) = search_winget("ffmpeg.exe") {
                return p.to_string_lossy().into_owned();
            }
            "ffmpeg".to_string()
        })
        .as_str()
}

/// Lê a duração do mídia (em segundos) parseando o "Duration:" do ffmpeg.
async fn probe_duration(path: &str) -> Option<f64> {
    let mut cmd = Command::new(ffmpeg_exe());
    cmd.args(["-i", path])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let out = cmd.output().await.ok()?;
    let err = String::from_utf8_lossy(&out.stderr);
    let idx = err.find("Duration:")?;
    let ts = err[idx + "Duration:".len()..]
        .trim_start()
        .split(',')
        .next()?
        .trim();
    if ts.starts_with("N/A") {
        return None;
    }
    parse_time(ts)
}

/// Converte "h:mm:ss" / "m:ss" / "ss" em segundos.
fn parse_time(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let mut total = 0f64;
    for part in s.split(':') {
        let v: f64 = part.trim().parse().ok()?;
        total = total * 60.0 + v;
    }
    Some(total)
}

/// Pasta do ffmpeg para passar via --ffmpeg-location quando ele nao esta no PATH.
fn ffmpeg_location() -> Option<&'static str> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
            if let Some(dir) = exe_dir() {
                if dir.join(name).is_file() {
                    return Some(dir.to_string_lossy().into_owned());
                }
            }
            if find_on_path(name).is_some() {
                return None; // ja no PATH, o yt-dlp encontra sozinho
            }
            search_winget("ffmpeg.exe")
                .and_then(|p| p.parent().map(|d| d.to_string_lossy().into_owned()))
        })
        .as_deref()
}

#[cfg(target_os = "windows")]
fn hide_console(cmd: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_console(_cmd: &mut Command) {}

// ------------------------------------------------------------------
// Metadados / analise de link
// ------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct QualityOption {
    pub id: String,
    pub label: String,
    pub available: bool,
}

#[derive(Debug, Serialize)]
pub struct PlaylistEntry {
    pub index: i64,
    pub id: String,
    pub title: String,
    pub url: String,
    pub thumbnail: String,
    pub duration: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct VideoInfo {
    pub title: String,
    pub uploader: String,
    pub thumbnail: String,
    pub duration: Option<f64>,
    pub platform: String,
    pub max_height: Option<i64>,
    pub qualities: Vec<QualityOption>,
    pub is_playlist: bool,
    pub playlist_count: Option<i64>,
    pub entries: Vec<PlaylistEntry>,
}

#[derive(Debug, Deserialize)]
pub struct DownloadRequest {
    pub id: String,
    pub url: String,
    pub quality: String,
    pub title: String,
    pub platform: String,
    #[serde(default)]
    pub playlist: bool,
    /// Seleção de itens da playlist no formato do yt-dlp (ex.: "1,3,5-7").
    /// Vazio/None = baixar todos os itens.
    #[serde(default)]
    pub playlist_items: Option<String>,
    /// Corte de trecho no formato "INICIO-FIM" (ex.: "00:01:00-00:02:30").
    /// Vazio/None = vídeo inteiro.
    #[serde(default)]
    pub section: Option<String>,
}

fn friendly_platform(extractor: &str) -> String {
    let e = extractor.to_lowercase();
    if e.contains("youtube") {
        "YouTube"
    } else if e.contains("instagram") {
        "Instagram"
    } else if e.contains("facebook") {
        "Facebook"
    } else if e.contains("twitter") || e.contains("x.com") {
        "X"
    } else if e.contains("tiktok") {
        "TikTok"
    } else {
        return extractor.to_string();
    }
    .to_string()
}

/// Nome de pasta seguro para a rede social (ex.: "YouTube" -> "youtube").
fn platform_folder(platform: &str) -> String {
    let cleaned: String = platform
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "outros".into()
    } else {
        trimmed
    }
}

fn build_quality_options(max_height: Option<i64>) -> Vec<QualityOption> {
    let avail = |h: i64| max_height.map(|m| m >= h).unwrap_or(true);
    vec![
        QualityOption {
            id: "best".into(),
            label: "Melhor disponivel".into(),
            available: true,
        },
        QualityOption {
            id: "1080".into(),
            label: "1080p (Full HD)".into(),
            available: avail(1080),
        },
        QualityOption {
            id: "720".into(),
            label: "720p (HD)".into(),
            available: avail(720),
        },
        QualityOption {
            id: "480".into(),
            label: "480p".into(),
            available: avail(480),
        },
        QualityOption {
            id: "audio".into(),
            label: "Apenas audio (MP3)".into(),
            available: true,
        },
    ]
}

fn json_str<'a>(v: &'a serde_json::Value, keys: &[&str]) -> &'a str {
    for k in keys {
        if let Some(s) = v.get(*k).and_then(|x| x.as_str()) {
            if !s.is_empty() {
                return s;
            }
        }
    }
    ""
}

/// Pega a melhor thumbnail de um objeto (campo `thumbnail` ou ultima de `thumbnails`).
fn extract_thumbnail(v: &serde_json::Value) -> String {
    if let Some(t) = v.get("thumbnail").and_then(|x| x.as_str()) {
        if !t.is_empty() {
            return t.to_string();
        }
    }
    v.get("thumbnails")
        .and_then(|t| t.as_array())
        .and_then(|arr| arr.last())
        .and_then(|t| t.get("url"))
        .and_then(|u| u.as_str())
        .unwrap_or("")
        .to_string()
}

fn build_single_info(json: &serde_json::Value) -> VideoInfo {
    let title = json_str(json, &["title"]);
    let uploader = json_str(json, &["uploader", "channel", "uploader_id"]);
    let extractor = json_str(json, &["extractor_key", "extractor"]);

    let max_height = json
        .get("formats")
        .and_then(|f| f.as_array())
        .and_then(|formats| {
            formats
                .iter()
                .filter_map(|f| f.get("height").and_then(|h| h.as_i64()))
                .max()
        })
        .or_else(|| json.get("height").and_then(|h| h.as_i64()));

    VideoInfo {
        title: if title.is_empty() { "Sem titulo".into() } else { title.into() },
        uploader: if uploader.is_empty() { "Desconhecido".into() } else { uploader.into() },
        thumbnail: extract_thumbnail(json),
        duration: json.get("duration").and_then(|d| d.as_f64()),
        platform: friendly_platform(extractor),
        max_height,
        qualities: build_quality_options(max_height),
        is_playlist: false,
        playlist_count: None,
        entries: Vec::new(),
    }
}

/// Limite de itens listados para seleção (evita payloads gigantes em canais grandes).
const MAX_LISTED_ENTRIES: usize = 500;

fn build_entries(entries: Option<&Vec<serde_json::Value>>) -> Vec<PlaylistEntry> {
    entries
        .map(|arr| {
            arr.iter()
                .take(MAX_LISTED_ENTRIES)
                .enumerate()
                .map(|(i, e)| {
                    let title = json_str(e, &["title"]);
                    PlaylistEntry {
                        index: (i as i64) + 1,
                        id: json_str(e, &["id"]).to_string(),
                        title: if title.is_empty() {
                            format!("Vídeo {}", i + 1)
                        } else {
                            title.to_string()
                        },
                        url: json_str(e, &["url", "webpage_url"]).to_string(),
                        thumbnail: extract_thumbnail(e),
                        duration: e.get("duration").and_then(|d| d.as_f64()),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Argumentos de cookies conforme as configuracoes (arquivo tem prioridade).
/// Vazio = sem cookies. Necessario para conteudo que exige login (YouTube etc.).
fn cookie_args(app: &AppHandle) -> Vec<String> {
    let settings = history::load_settings(app).unwrap_or_default();
    if let Some(file) = settings
        .cookies_file
        .as_ref()
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
    {
        return vec!["--cookies".into(), file];
    }
    if let Some(browser) = settings
        .cookies_browser
        .as_ref()
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
    {
        return vec!["--cookies-from-browser".into(), browser];
    }
    Vec::new()
}

async fn run_json(args: &[String]) -> Result<serde_json::Value, String> {
    let mut cmd = Command::new(ytdlp_exe());
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_console(&mut cmd);

    let output = cmd.output().await.map_err(|e| {
        format!("Nao foi possivel executar o yt-dlp ({e}). Verifique a instalacao.")
    })?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(friendly_ytdlp_error(&err, output.status.code()));
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Erro ao interpretar os metadados: {e}"))
}

/// Traduz erros comuns do yt-dlp (login/cookies) em mensagens acionaveis.
fn friendly_ytdlp_error(errors: &str, code: Option<i32>) -> String {
    let lower = errors.to_lowercase();
    if lower.contains("not a bot") || lower.contains("sign in to confirm") {
        return "O YouTube pediu login para confirmar que você não é um robô. \
                Configure os cookies em \"Cookies do YouTube\" (escolha um navegador \
                ou um arquivo cookies.txt) e tente de novo."
            .into();
    }
    if lower.contains("could not copy") && lower.contains("cookie") {
        return "Não foi possível ler os cookies do navegador — ele está aberto e \
                trava o banco de cookies. Feche o navegador OU use um arquivo \
                cookies.txt (opção mais confiável)."
            .into();
    }
    if (lower.contains("decrypt") || lower.contains("dpapi") || lower.contains("v20"))
        && (lower.contains("cookie") || lower.contains("chrome") || lower.contains("edge"))
    {
        return "O Chrome/Edge recente cifra os cookies (App-Bound Encryption) e o \
                yt-dlp não consegue decifrá-los, mesmo com o navegador fechado. \
                Use um arquivo cookies.txt (exporte com a extensão \"Get cookies.txt \
                LOCALLY\") ou cookies do Firefox."
            .into();
    }
    if lower.contains("private video")
        || lower.contains("members-only")
        || lower.contains("login required")
        || lower.contains("join this channel")
    {
        return "Conteúdo privado ou exclusivo para membros — exige login (cookies).".into();
    }
    if lower.contains("video unavailable") || lower.contains("removed") {
        return "Vídeo indisponível ou removido.".into();
    }
    // Sem padrão conhecido: usa a última linha de ERROR (ou a última qualquer).
    let last = errors
        .lines()
        .rev()
        .find(|l| l.to_lowercase().contains("error") && !l.trim().is_empty())
        .or_else(|| errors.lines().rev().find(|l| !l.trim().is_empty()));
    match last {
        Some(l) => format!("Falhou: {}", l.trim()),
        None => format!(
            "Falhou (código {}). Para YouTube/Instagram, configure os cookies \
             (arquivo cookies.txt é o mais confiável). Senão, verifique o link e a conexão.",
            code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())
        ),
    }
}

#[tauri::command]
pub async fn get_video_info(app: AppHandle, url: String) -> Result<VideoInfo, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("Cole um link valido.".into());
    }

    let cookies = cookie_args(&app);
    let arg = |extra: &[&str]| -> Vec<String> {
        let mut v = cookies.clone();
        v.extend(extra.iter().map(|s| s.to_string()));
        v
    };

    // Primeiro uma leitura "achatada" e rapida para detectar playlist/perfil.
    let flat = run_json(&arg(&["-J", "--flat-playlist", "--no-warnings", &url])).await?;
    let is_playlist = flat.get("_type").and_then(|v| v.as_str()) == Some("playlist");

    if is_playlist {
        let entries = flat.get("entries").and_then(|e| e.as_array());
        let count = entries.map(|e| e.len() as i64).unwrap_or(0);
        let title = json_str(&flat, &["title", "id"]);
        let uploader = json_str(&flat, &["uploader", "channel", "uploader_id"]);
        let extractor = json_str(&flat, &["extractor_key", "extractor"]);
        let thumbnail = entries
            .and_then(|e| e.first())
            .map(extract_thumbnail)
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| extract_thumbnail(&flat));

        return Ok(VideoInfo {
            title: if title.is_empty() { "Playlist".into() } else { title.into() },
            uploader: if uploader.is_empty() { "Desconhecido".into() } else { uploader.into() },
            thumbnail,
            duration: None,
            platform: friendly_platform(extractor),
            max_height: None,
            qualities: build_quality_options(None),
            is_playlist: true,
            playlist_count: Some(count),
            entries: build_entries(entries),
        });
    }

    // Video unico: o resultado "flat" de um video isolado ja vem completo (com
    // formatos), entao reaproveitamos e evitamos uma 2a extracao (lenta no YouTube).
    let has_formats = flat
        .get("formats")
        .and_then(|f| f.as_array())
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    if has_formats {
        return Ok(build_single_info(&flat));
    }

    // Fallback: extracao completa (caso o flat nao tenha trazido os formatos).
    let full = run_json(&arg(&["-J", "--no-playlist", "--no-warnings", &url])).await?;
    Ok(build_single_info(&full))
}

// ------------------------------------------------------------------
// Download (fila + progresso + cancelamento + playlist)
// ------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct IdEvent {
    id: String,
}

#[derive(Clone, Serialize)]
struct ProgressEvent {
    id: String,
    status: String,
    percent: f64,
    speed: Option<f64>,
    eta: Option<f64>,
    downloaded: u64,
    total: u64,
}

#[derive(Clone, Serialize)]
struct ItemEvent {
    id: String,
    item: HistoryItem,
}

#[derive(Clone, Serialize)]
struct DoneEvent {
    id: String,
    count: usize,
}

/// Progresso baseado no sistema de arquivos (o stdout do yt-dlp é bufferizado).
#[derive(Clone, Serialize)]
struct StatsEvent {
    id: String,
    completed: u64,
    downloaded: u64,
}

/// Detecta arquivos intermediarios do yt-dlp pelo "stem": `Titulo.f137`,
/// `Titulo.temp` etc. (que serao mesclados/renomeados depois).
fn is_intermediate(path: &Path) -> bool {
    path.file_stem()
        .and_then(|s| s.to_str())
        .and_then(|s| s.rsplit('.').next())
        .map(|last| {
            last == "temp"
                || (last.starts_with('f')
                    && last.len() >= 2
                    && last[1..].chars().all(|c| c.is_ascii_digit()))
        })
        .unwrap_or(false)
}

/// Deriva um titulo legivel do nome do arquivo: "Titulo [id].mp4" -> "Titulo".
fn title_from_path(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim();
    match stem.rfind(" [") {
        Some(pos) if stem.ends_with(']') => stem[..pos].trim().to_string(),
        _ => stem.to_string(),
    }
}

/// Varre `root` recursivamente: conta os arquivos finais (com extensao `final_ext`,
/// fora intermediarios) e mede o maior `.part` (arquivo em download).
fn collect_progress(
    root: &Path,
    final_ext: &str,
    finals: &mut HashSet<PathBuf>,
    max_part: &mut u64,
) {
    let Ok(rd) = std::fs::read_dir(root) else {
        return;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_progress(&p, final_ext, finals, max_part);
        } else if let Some(ext) = p.extension().and_then(|x| x.to_str()) {
            let ext = ext.to_lowercase();
            if ext == "part" {
                if let Ok(m) = entry.metadata() {
                    *max_part = (*max_part).max(m.len());
                }
            } else if ext == final_ext && !is_intermediate(&p) {
                finals.insert(p);
            }
        }
    }
}

#[derive(Clone, Serialize)]
struct ErrorEvent {
    id: String,
    message: String,
}

fn format_args(quality: &str) -> Vec<String> {
    match quality {
        "audio" => vec![
            "-f".into(),
            "ba/b".into(),
            "-x".into(),
            "--audio-format".into(),
            "mp3".into(),
            "--audio-quality".into(),
            "0".into(),
        ],
        "1080" | "720" | "480" => vec![
            "-f".into(),
            // Cap por altura com fallbacks: video+audio separados <= q, ou combinado
            // <= q, ou o melhor disponivel. O fallback final evita "Requested format
            // is not available" em redes (FB/IG/X/TikTok) cujos formatos nao expoem
            // `height` ou nao tem stream <= q.
            format!(
                "bv*[height<={q}]+ba/b[height<={q}]/bv*+ba/b",
                q = quality
            ),
            "--merge-output-format".into(),
            "mp4".into(),
        ],
        _ => vec![
            "-f".into(),
            "bv*+ba/b".into(),
            "--merge-output-format".into(),
            "mp4".into(),
        ],
    }
}

fn num(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() || s == "NA" || s == "None" {
        None
    } else {
        s.parse::<f64>().ok()
    }
}

/// Lê o percentual textual do yt-dlp (ex.: " 12.3%") deixando só dígitos e ponto.
fn parse_percent_str(s: &str) -> Option<f64> {
    let cleaned: String = s
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        cleaned.parse::<f64>().ok()
    }
}

fn parse_progress(line: &str, id: &str) -> Option<ProgressEvent> {
    let idx = line.find("[PROG]")?;
    let rest = &line[idx + "[PROG]".len()..];
    let parts: Vec<&str> = rest.split('|').collect();
    if parts.len() < 7 {
        return None;
    }
    let status = parts[0].trim().to_string();
    let downloaded = num(parts[2]).unwrap_or(0.0);
    let total = num(parts[3]).or_else(|| num(parts[4])).unwrap_or(0.0);
    let speed = num(parts[5]);
    let eta = num(parts[6]);
    // Preferimos o percentual que o próprio yt-dlp calcula (lida com formatos
    // fragmentados onde total_bytes vem como NA); caímos para a razão de bytes.
    let percent = parse_percent_str(parts[1])
        .or_else(|| {
            if total > 0.0 {
                Some(downloaded / total * 100.0)
            } else {
                None
            }
        })
        .unwrap_or(0.0)
        .clamp(0.0, 100.0);
    Some(ProgressEvent {
        id: id.to_string(),
        status,
        percent,
        speed,
        eta,
        downloaded: downloaded as u64,
        total: total as u64,
    })
}

fn guess_thumbnail(filepath: &str) -> Option<String> {
    let path = PathBuf::from(filepath);
    let stem = path.file_stem()?.to_string_lossy().to_string();
    let dir = path.parent()?;
    for ext in ["jpg", "png", "webp", "jpeg"] {
        let candidate = dir.join(format!("{stem}.{ext}"));
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

enum RunOutcome {
    Completed(usize),
    Cancelled,
    Paused,
}

/// Executa o yt-dlp, emite progresso e um evento por arquivo concluido.
async fn run_download(
    app: &AppHandle,
    request: &DownloadRequest,
    out_dir: PathBuf,
    cancel_rx: &mut oneshot::Receiver<StopReason>,
) -> Result<RunOutcome, String> {
    // Organiza por rede social e, em playlists, por nome da playlist:
    //   <destino>/youtube/Nome da Playlist/Titulo [id].mp4
    //   <destino>/youtube/videos/Titulo [id].mp4
    let platform_dir = platform_folder(&request.platform);
    let out_template = if request.playlist {
        out_dir
            .join(&platform_dir)
            // yt-dlp sanitiza o nome da pasta a partir do título da playlist.
            .join("%(playlist_title,playlist,playlist_id,uploader)s")
            .join("%(title).180B [%(id)s].%(ext)s")
    } else {
        out_dir
            .join(&platform_dir)
            .join("videos")
            .join("%(title).180B [%(id)s].%(ext)s")
    }
    .to_string_lossy()
    .to_string();

    let progress_template = "[PROG]%(progress.status)s|%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s";
    let print_template = "after_move:[DONE]%(title)s\t%(filepath)s";

    let mut args: Vec<String> = Vec::new();
    args.extend(format_args(&request.quality));
    args.extend(cookie_args(app));
    if let Some(loc) = ffmpeg_location() {
        args.push("--ffmpeg-location".into());
        args.push(loc.to_string());
    }
    if request.playlist {
        args.push("--yes-playlist".into());
        // Seleção parcial: só os itens escolhidos pelo usuário.
        if let Some(items) = request
            .playlist_items
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            args.push("--playlist-items".into());
            args.push(items.to_string());
        }
    } else {
        args.push("--no-playlist".into());
    }
    // Corte de trecho (apenas vídeo único faz sentido): baixa só o intervalo.
    if let Some(sec) = request
        .section
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && !request.playlist)
    {
        args.push("--download-sections".into());
        args.push(format!("*{sec}"));
        args.push("--force-keyframes-at-cuts".into());
    }
    args.extend([
        "--newline".into(),
        "--quiet".into(),
        "--progress".into(),
        "--color".into(),
        "never".into(),
        "--no-warnings".into(),
        "--ignore-errors".into(),
        "--progress-template".into(),
        progress_template.into(),
        "--write-thumbnail".into(),
        "--convert-thumbnails".into(),
        "jpg".into(),
        "--print".into(),
        print_template.into(),
        "-o".into(),
        out_template,
        request.url.trim().into(),
    ]);

    // Snapshot dos arquivos de midia ja existentes, p/ contar so os novos.
    let final_ext = if request.quality == "audio" { "mp3" } else { "mp4" };
    let scan_root = out_dir.join(&platform_dir);
    let mut baseline: HashSet<PathBuf> = HashSet::new();
    let mut ignore = 0u64;
    collect_progress(&scan_root, final_ext, &mut baseline, &mut ignore);
    let baseline = Arc::new(baseline);

    let mut cmd = Command::new(ytdlp_exe());
    cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_console(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Nao foi possivel iniciar o download ({e})."))?;

    let stdout = child.stdout.take().ok_or("Falha ao capturar a saida do yt-dlp")?;
    let stderr = child.stderr.take().ok_or("Falha ao capturar os erros do yt-dlp")?;

    // O yt-dlp bufferiza o stdout quando e um pipe, entao [DONE]/progresso chegam
    // atrasados. Para a galeria atualizar 1 a 1 e o contador andar ao vivo,
    // observamos o disco: cada arquivo final novo vira um item da galeria.
    let counter = Arc::new(AtomicUsize::new(0));
    let poll_app = app.clone();
    let poll_id = request.id.clone();
    let poll_root = scan_root.clone();
    let poll_baseline = baseline.clone();
    let poll_ext = final_ext.to_string();
    let poll_platform = request.platform.clone();
    let poll_quality = request.quality.clone();
    let poll_url = request.url.clone();
    let poll_counter = counter.clone();
    let poll_handle = tokio::spawn(async move {
        let mut reported: HashSet<PathBuf> = HashSet::new();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            let mut finals: HashSet<PathBuf> = HashSet::new();
            let mut max_part = 0u64;
            collect_progress(&poll_root, &poll_ext, &mut finals, &mut max_part);
            // Arquivos finais novos (fora do baseline e ainda nao reportados).
            for path in finals.difference(&poll_baseline) {
                if reported.contains(path) {
                    continue;
                }
                reported.insert(path.clone());
                let idx = poll_counter.fetch_add(1, Ordering::SeqCst);
                let fp = path.to_string_lossy().to_string();
                let filesize = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                let duration = probe_duration(&fp).await;
                let item = HistoryItem {
                    id: format!("{}-{}", chrono::Local::now().timestamp_millis(), idx),
                    title: title_from_path(path),
                    platform: poll_platform.clone(),
                    quality: poll_quality.clone(),
                    thumbnail: guess_thumbnail(&fp),
                    filepath: fp,
                    filesize,
                    date: chrono::Local::now().to_rfc3339(),
                    url: poll_url.clone(),
                    favorite: false,
                    duration,
                };
                let _ = history::add_item(&poll_app, item.clone());
                let _ = poll_app.emit(
                    "download-item",
                    ItemEvent {
                        id: poll_id.clone(),
                        item,
                    },
                );
            }
            let _ = poll_app.emit(
                "download-stats",
                StatsEvent {
                    id: poll_id.clone(),
                    completed: reported.len() as u64,
                    downloaded: max_part,
                },
            );
        }
    });

    // stderr: progresso textual (quando vier) + acumulo de mensagens de erro.
    let app_err = app.clone();
    let id_err = request.id.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut errors = String::new();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(ev) = parse_progress(&line, &id_err) {
                let _ = app_err.emit("download-progress", ev);
            } else if line.to_lowercase().contains("error") {
                errors.push_str(line.trim());
                errors.push('\n');
            }
        }
        errors
    });

    // stdout: progresso textual ([PROG]) + eventuais erros (yt-dlp as vezes
    // imprime erros no stdout). Os itens da galeria vem do polling do disco.
    let read_fut = async {
        let mut errors = String::new();
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(ev) = parse_progress(&line, &request.id) {
                let _ = app.emit("download-progress", ev);
            } else if line.to_lowercase().contains("error") {
                errors.push_str(line.trim());
                errors.push('\n');
            }
        }
        errors
    };

    let outcome = tokio::select! {
        stdout_errors = read_fut => {
            let status = child.wait().await.map_err(|e| format!("Falha ao aguardar: {e}"))?;
            let stderr_errors = stderr_task.await.unwrap_or_default();
            let errors = format!("{stderr_errors}{stdout_errors}");
            // Uma última varredura para capturar o arquivo recém-finalizado.
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let count = counter.load(Ordering::SeqCst);
            if count == 0 && !status.success() {
                poll_handle.abort();
                return Err(friendly_ytdlp_error(&errors, status.code()));
            }
            RunOutcome::Completed(count)
        }
        reason = &mut *cancel_rx => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            match reason {
                Ok(StopReason::Pause) => RunOutcome::Paused,
                _ => RunOutcome::Cancelled,
            }
        }
    };
    poll_handle.abort();
    Ok(outcome)
}

#[tauri::command]
pub async fn download_video(
    app: AppHandle,
    state: State<'_, Arc<DownloadManager>>,
    request: DownloadRequest,
) -> Result<(), String> {
    // Valida a pasta de saida de forma sincrona (erro retorna direto pro frontend).
    let out_dir = history::effective_download_dir(&app)?;

    let manager = state.inner().clone();
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<StopReason>();
    manager
        .jobs
        .lock()
        .unwrap()
        .insert(request.id.clone(), cancel_tx);

    let sem = manager.sem.clone();
    let id = request.id.clone();

    tokio::spawn(async move {
        // A fila acontece aqui: espera uma vaga, mas honra cancelar/pausar.
        let permit = tokio::select! {
            p = sem.acquire_owned() => p.ok(),
            reason = &mut cancel_rx => {
                manager.jobs.lock().unwrap().remove(&id);
                let event = match reason {
                    Ok(StopReason::Pause) => "download-paused",
                    _ => "download-cancelled",
                };
                let _ = app.emit(event, IdEvent { id });
                return;
            }
        };
        let _permit = match permit {
            Some(p) => p,
            None => {
                manager.jobs.lock().unwrap().remove(&id);
                return;
            }
        };

        let _ = app.emit("download-started", IdEvent { id: id.clone() });
        let result = run_download(&app, &request, out_dir, &mut cancel_rx).await;
        manager.jobs.lock().unwrap().remove(&id);

        match result {
            Ok(RunOutcome::Completed(count)) => {
                let _ = app.emit("download-done", DoneEvent { id, count });
            }
            Ok(RunOutcome::Cancelled) => {
                let _ = app.emit("download-cancelled", IdEvent { id });
            }
            Ok(RunOutcome::Paused) => {
                let _ = app.emit("download-paused", IdEvent { id });
            }
            Err(message) => {
                let _ = app.emit("download-error", ErrorEvent { id, message });
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_download(state: State<'_, Arc<DownloadManager>>, id: String) -> Result<(), String> {
    if let Some(tx) = state.jobs.lock().unwrap().remove(&id) {
        let _ = tx.send(StopReason::Cancel);
    }
    Ok(())
}

/// Pausa um download: encerra o yt-dlp mas mantem os arquivos parciais (.part)
/// e os ja concluidos. Continuar = chamar `download_video` de novo com o mesmo
/// pedido — o yt-dlp pula o que ja existe e retoma o arquivo parcial.
#[tauri::command]
pub fn pause_download(state: State<'_, Arc<DownloadManager>>, id: String) -> Result<(), String> {
    if let Some(tx) = state.jobs.lock().unwrap().remove(&id) {
        let _ = tx.send(StopReason::Pause);
    }
    Ok(())
}

// ------------------------------------------------------------------
// Sondagem de tamanho dos itens da playlist (prévia antes de baixar)
// ------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct SizeEvent {
    probe_id: String,
    index: i64,
    bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
struct SizeDoneEvent {
    probe_id: String,
}

/// Estima o tamanho de cada item da playlist na qualidade escolhida, sem baixar.
/// Emite `playlist-size` por item e `playlist-sizes-done` no fim. Uma nova
/// sondagem cancela qualquer anterior (ex.: quando o usuario troca a qualidade).
#[tauri::command]
pub async fn fetch_playlist_sizes(
    app: AppHandle,
    state: State<'_, Arc<DownloadManager>>,
    url: String,
    quality: String,
    probe_id: String,
    #[allow(non_snake_case)] count: i64,
) -> Result<(), String> {
    use tokio::task::JoinSet;
    let manager = state.inner().clone();
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    {
        let mut probes = manager.probes.lock().unwrap();
        for (_, tx) in probes.drain() {
            let _ = tx.send(());
        }
        probes.insert(probe_id.clone(), cancel_tx);
    }

    tokio::spawn(async move {
        // Ponte oneshot -> watch (true = cancelar) p/ avisar todos os workers.
        let (ctx, _crx0) = watch::channel(false);
        {
            let ctx = ctx.clone();
            tokio::spawn(async move {
                let _ = cancel_rx.await;
                let _ = ctx.send(true);
            });
        }

        // Divide a playlist em faixas contíguas para vários yt-dlp em paralelo.
        let total = count.max(0) as usize;
        let ranges: Vec<Option<String>> = if total >= 2 {
            let nworkers = total.min(4).max(1);
            let chunk = total.div_ceil(nworkers);
            let mut v = Vec::new();
            let mut s = 1usize;
            while s <= total {
                let e = (s + chunk - 1).min(total);
                v.push(Some(format!("{s}-{e}")));
                s = e + 1;
            }
            v
        } else {
            vec![None] // playlist inteira / desconhecida: um processo só
        };

        let mut set: JoinSet<()> = JoinSet::new();
        for range in ranges {
            let app2 = app.clone();
            let id2 = probe_id.clone();
            let url2 = url.clone();
            let quality2 = quality.clone();
            let mut crx = ctx.subscribe();
            set.spawn(async move {
                let mut args: Vec<String> = Vec::new();
                args.extend(format_args(&quality2));
                args.extend(cookie_args(&app2));
                args.push("--yes-playlist".into());
                if let Some(r) = &range {
                    args.push("--playlist-items".into());
                    args.push(r.clone());
                }
                args.extend([
                    "--simulate".into(),
                    "--no-warnings".into(),
                    "--ignore-errors".into(),
                    "--newline".into(),
                    "--print".into(),
                    "[SIZE]%(playlist_index)s|%(filesize,filesize_approx)s".into(),
                    url2.trim().into(),
                ]);

                let mut cmd = Command::new(ytdlp_exe());
                cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::null());
                hide_console(&mut cmd);
                let mut child = match cmd.spawn() {
                    Ok(c) => c,
                    Err(_) => return,
                };
                let stdout = match child.stdout.take() {
                    Some(s) => s,
                    None => return,
                };

                let read = async {
                    let mut reader = BufReader::new(stdout).lines();
                    while let Ok(Some(line)) = reader.next_line().await {
                        if let Some(idx) = line.find("[SIZE]") {
                            let rest = &line[idx + "[SIZE]".len()..];
                            let mut parts = rest.split('|');
                            let index =
                                parts.next().and_then(|s| s.trim().parse::<i64>().ok());
                            let bytes = parts.next().and_then(num).map(|b| b as u64);
                            if let Some(index) = index {
                                let _ = app2.emit(
                                    "playlist-size",
                                    SizeEvent {
                                        probe_id: id2.clone(),
                                        index,
                                        bytes,
                                    },
                                );
                            }
                        }
                    }
                };

                tokio::select! {
                    _ = read => { let _ = child.wait().await; }
                    _ = crx.changed() => {
                        let _ = child.start_kill();
                        let _ = child.wait().await;
                    }
                }
            });
        }
        while set.join_next().await.is_some() {}

        manager.probes.lock().unwrap().remove(&probe_id);
        let _ = app.emit("playlist-sizes-done", SizeDoneEvent { probe_id });
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_playlist_sizes(
    state: State<'_, Arc<DownloadManager>>,
    probe_id: String,
) -> Result<(), String> {
    if let Some(tx) = state.probes.lock().unwrap().remove(&probe_id) {
        let _ = tx.send(());
    }
    Ok(())
}

/// Abre o arquivo no app padrao do sistema. Comando nativo (nao depende do
/// escopo do plugin opener, que bloqueia caminhos fora de uma lista permitida).
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("Arquivo não encontrado no disco.".into());
    }
    open::that_detached(&path).map_err(|e| format!("Não foi possível abrir o arquivo: {e}"))
}

/// Abre a pasta do arquivo, selecionando-o quando possivel.
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("Arquivo não encontrado no disco.".into());
    }
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("explorer");
        cmd.arg(format!("/select,{}", path));
        hide_console_std(&mut cmd);
        // O explorer retorna codigo != 0 mesmo quando abre; basta disparar.
        cmd.spawn()
            .map_err(|e| format!("Não foi possível abrir a pasta: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let target = p.parent().unwrap_or(p);
        open::that_detached(target).map_err(|e| format!("Não foi possível abrir a pasta: {e}"))
    }
}

#[cfg(target_os = "windows")]
fn hide_console_std(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

const IMPORT_EXTS: &[&str] = &[
    "mp4", "mkv", "webm", "mov", "avi", "flv", "wmv", "m4v", "3gp", "mp3", "m4a",
    "wav", "aac", "opus", "ogg",
];

/// Coleta recursivamente arquivos de mídia para importar (limite de profundidade).
fn collect_media_files(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(root) else {
        return;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_media_files(&p, depth - 1, out);
        } else if let Some(ext) = p.extension().and_then(|x| x.to_str()) {
            if IMPORT_EXTS.contains(&ext.to_lowercase().as_str()) && !is_intermediate(&p) {
                out.push(p);
            }
        }
    }
}

#[derive(Serialize)]
pub struct ImportResult {
    pub history: Vec<HistoryItem>,
    pub added: usize,
}

/// Importa vídeos/áudios já existentes de uma pasta para a galeria (sem duplicar).
#[tauri::command]
pub async fn import_gallery(app: AppHandle, dir: String) -> Result<ImportResult, String> {
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err("Pasta inválida.".into());
    }
    use tokio::task::JoinSet;
    let mut paths: Vec<PathBuf> = Vec::new();
    collect_media_files(&root, 8, &mut paths);

    // Sonda as durações em paralelo (concorrência limitada).
    let mut durations: Vec<Option<f64>> = vec![None; paths.len()];
    {
        const LIMIT: usize = 8;
        let mut iter = paths.iter().enumerate().map(|(i, p)| (i, p.to_string_lossy().to_string()));
        let mut set: JoinSet<(usize, Option<f64>)> = JoinSet::new();
        for _ in 0..LIMIT {
            if let Some((i, p)) = iter.next() {
                set.spawn(async move { (i, probe_duration(&p).await) });
            }
        }
        while let Some(res) = set.join_next().await {
            if let Ok((i, d)) = res {
                durations[i] = d;
            }
            if let Some((i, p)) = iter.next() {
                set.spawn(async move { (i, probe_duration(&p).await) });
            }
        }
    }

    let now = chrono::Local::now().timestamp_millis();
    let items: Vec<HistoryItem> = paths
        .iter()
        .enumerate()
        .map(|(counter, p)| {
            let fp = p.to_string_lossy().to_string();
            let meta = std::fs::metadata(p).ok();
            let filesize = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let date = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .map(|t| chrono::DateTime::<chrono::Local>::from(t).to_rfc3339())
                .unwrap_or_else(|| chrono::Local::now().to_rfc3339());
            HistoryItem {
                id: format!("import-{now}-{counter}"),
                title: title_from_path(p),
                platform: "Local".into(),
                quality: "import".into(),
                thumbnail: guess_thumbnail(&fp),
                filepath: fp,
                filesize,
                date,
                url: String::new(),
                favorite: false,
                duration: durations[counter],
            }
        })
        .collect();

    let (history, added) = history::add_imported(&app, items)?;
    Ok(ImportResult { history, added })
}

/// Preenche a duração dos itens antigos que ainda não a têm. Sonda vários
/// arquivos em paralelo (ffmpeg é lento de spawnar no Windows) p/ ser rápido.
#[tauri::command]
pub async fn backfill_durations(app: AppHandle) -> Result<Vec<HistoryItem>, String> {
    use tokio::task::JoinSet;
    let mut items = history::load_history(&app)?;

    let pending: Vec<(usize, String)> = items
        .iter()
        .enumerate()
        .filter(|(_, it)| it.duration.is_none() && Path::new(&it.filepath).exists())
        .map(|(i, it)| (i, it.filepath.clone()))
        .collect();
    if pending.is_empty() {
        return Ok(items);
    }

    const LIMIT: usize = 8;
    let mut iter = pending.into_iter();
    let mut set: JoinSet<(usize, Option<f64>)> = JoinSet::new();
    for _ in 0..LIMIT {
        if let Some((i, p)) = iter.next() {
            set.spawn(async move { (i, probe_duration(&p).await) });
        }
    }
    let mut changed = false;
    while let Some(res) = set.join_next().await {
        if let Ok((i, dur)) = res {
            if let Some(d) = dur {
                items[i].duration = Some(d);
                changed = true;
            }
        }
        if let Some((i, p)) = iter.next() {
            set.spawn(async move { (i, probe_duration(&p).await) });
        }
    }
    if changed {
        history::replace(&app, &items)?;
    }
    Ok(items)
}

/// Corta um trecho de um vídeo/áudio JÁ existente no disco (re-encode preciso),
/// salva ao lado do original e devolve o novo item da galeria.
#[tauri::command]
pub async fn cut_video(
    app: AppHandle,
    input: String,
    start: String,
    end: String,
) -> Result<HistoryItem, String> {
    let inp = PathBuf::from(&input);
    if !inp.is_file() {
        return Err("Arquivo não encontrado no disco.".into());
    }
    let start_s = parse_time(&start).unwrap_or(0.0).max(0.0);
    let end_s = parse_time(&end); // None = até o fim
    if let Some(e) = end_s {
        if e <= start_s {
            return Err("O fim do corte precisa ser maior que o início.".into());
        }
    }

    let ext = inp
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4")
        .to_lowercase();
    let is_audio = matches!(ext.as_str(), "mp3" | "m4a" | "aac" | "wav" | "opus" | "ogg");
    let out_ext = if is_audio { "mp3" } else { "mp4" };
    let stem = inp.file_stem().and_then(|s| s.to_str()).unwrap_or("video");
    let label = format!(
        "{}-{}",
        start.trim().replace(':', "."),
        if end.trim().is_empty() { "fim".into() } else { end.trim().replace(':', ".") }
    );
    let out_path = inp.with_file_name(format!("{stem} (corte {label}).{out_ext}"));
    let out_str = out_path.to_string_lossy().to_string();

    let mut args: Vec<String> = vec!["-y".into(), "-ss".into(), format!("{start_s}")];
    if let Some(e) = end_s {
        args.push("-t".into());
        args.push(format!("{}", e - start_s));
    }
    args.push("-i".into());
    args.push(input.clone());
    if is_audio {
        args.extend([
            "-c:a".into(), "libmp3lame".into(), "-q:a".into(), "2".into(),
        ]);
    } else {
        args.extend([
            "-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(),
            "-crf".into(), "20".into(), "-c:a".into(), "aac".into(),
            "-movflags".into(), "+faststart".into(),
        ]);
    }
    args.push(out_str.clone());

    let mut cmd = Command::new(ffmpeg_exe());
    cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_console(&mut cmd);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Não foi possível executar o ffmpeg: {e}"))?;
    if !output.status.success() || !out_path.exists() {
        let err = String::from_utf8_lossy(&output.stderr);
        let last = err
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("erro desconhecido");
        return Err(format!("Falha ao cortar: {}", last.trim()));
    }

    let filesize = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
    let duration = probe_duration(&out_str).await;
    let item = HistoryItem {
        id: format!("cut-{}", chrono::Local::now().timestamp_millis()),
        title: format!("{} (corte)", title_from_path(&inp)),
        platform: "Local".into(),
        quality: "corte".into(),
        thumbnail: guess_thumbnail(&out_str),
        filepath: out_str,
        filesize,
        date: chrono::Local::now().to_rfc3339(),
        url: String::new(),
        favorite: false,
        duration,
    };
    history::add_item(&app, item.clone())?;
    Ok(item)
}

// ------------------------------------------------------------------
// Editor de vídeo (ffmpeg): probe, pipeline não-destrutivo, captura de frame
// ------------------------------------------------------------------

#[derive(Clone, Serialize)]
pub struct MediaInfo {
    pub duration: f64,
    pub fps: f64,
    pub width: i64,
    pub height: i64,
}

fn parse_fps(line: &str) -> Option<f64> {
    let idx = line.find(" fps")?;
    let num: String = line[..idx]
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    num.trim().parse().ok()
}

fn parse_resolution(line: &str) -> Option<(i64, i64)> {
    for tok in line.split(|c: char| !(c.is_ascii_digit() || c == 'x')) {
        if let Some((a, b)) = tok.split_once('x') {
            if let (Ok(w), Ok(h)) = (a.parse::<i64>(), b.parse::<i64>()) {
                if w >= 16 && h >= 16 {
                    return Some((w, h));
                }
            }
        }
    }
    None
}

/// Lê duração, fps e resolução do arquivo (para a timeline frame-accurate).
#[tauri::command]
pub async fn probe_media(input: String) -> Result<MediaInfo, String> {
    if !Path::new(&input).is_file() {
        return Err("Arquivo não encontrado.".into());
    }
    let mut cmd = Command::new(ffmpeg_exe());
    cmd.args(["-i", input.as_str()])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let out = cmd.output().await.map_err(|e| format!("ffmpeg: {e}"))?;
    let err = String::from_utf8_lossy(&out.stderr);

    let duration = err
        .find("Duration:")
        .and_then(|idx| {
            let ts = err[idx + "Duration:".len()..]
                .trim_start()
                .split(',')
                .next()?
                .trim();
            if ts.starts_with("N/A") {
                None
            } else {
                parse_time(ts)
            }
        })
        .unwrap_or(0.0);

    let (mut fps, mut width, mut height) = (0.0, 0, 0);
    if let Some(vi) = err.find("Video:") {
        let line = err[vi..].lines().next().unwrap_or("");
        if let Some((w, h)) = parse_resolution(line) {
            width = w;
            height = h;
        }
        fps = parse_fps(line).unwrap_or(0.0);
    }
    Ok(MediaInfo {
        duration,
        fps,
        width,
        height,
    })
}

/// Decompõe a velocidade em fatores que o filtro atempo aceita (0.5–2.0).
fn atempo_chain(mut speed: f64) -> Vec<f64> {
    let mut out = Vec::new();
    if speed <= 0.0 {
        return out;
    }
    while speed > 2.0 {
        out.push(2.0);
        speed /= 2.0;
    }
    while speed < 0.5 {
        out.push(0.5);
        speed *= 2.0;
    }
    out.push(speed);
    out
}

fn default_one() -> f64 {
    1.0
}

#[derive(Deserialize)]
pub struct CropRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Deserialize)]
pub struct EditSpec {
    pub id: String,
    pub input: String,
    #[serde(default)]
    pub start: Option<f64>,
    #[serde(default)]
    pub end: Option<f64>,
    #[serde(default)]
    pub crop: Option<CropRect>,
    #[serde(default)]
    pub scale_w: Option<i64>,
    #[serde(default)]
    pub rotate: i64,
    #[serde(default)]
    pub flip_h: bool,
    #[serde(default)]
    pub flip_v: bool,
    #[serde(default = "default_one")]
    pub speed: f64,
    #[serde(default = "default_one")]
    pub volume: f64,
    #[serde(default)]
    pub mute: bool,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    #[serde(default)]
    pub format: String, // "mp4" | "mp3" | "gif"
    /// Corte sem re-encode quando só houver trim (rápido e sem perda).
    #[serde(default)]
    pub lossless: bool,
}

#[derive(Clone, Serialize)]
struct EditProgress {
    id: String,
    percent: f64,
}

/// Aplica todas as edições numa ÚNICA passada do ffmpeg (não-destrutivo).
/// Emite `edit-progress` e pode ser cancelado por `cancel_edit`.
#[tauri::command]
pub async fn apply_edits(
    app: AppHandle,
    state: State<'_, Arc<DownloadManager>>,
    spec: EditSpec,
) -> Result<HistoryItem, String> {
    let inp = PathBuf::from(&spec.input);
    if !inp.is_file() {
        return Err("Arquivo não encontrado no disco.".into());
    }
    let fmt = if spec.format.is_empty() {
        "mp4"
    } else {
        spec.format.as_str()
    };
    let speed = if spec.speed > 0.0 { spec.speed } else { 1.0 };

    let full = probe_duration(&spec.input).await.unwrap_or(0.0);
    let start = spec.start.unwrap_or(0.0).max(0.0);
    let end = spec.end.unwrap_or(full).max(start);
    let trimmed = (end - start).max(0.0);
    let out_dur = if speed > 0.0 { trimmed / speed } else { trimmed };

    // Cadeia de filtros de vídeo.
    let mut vf: Vec<String> = Vec::new();
    if let Some(c) = &spec.crop {
        vf.push(format!(
            "crop={}:{}:{}:{}",
            c.w.round() as i64,
            c.h.round() as i64,
            c.x.round() as i64,
            c.y.round() as i64
        ));
    }
    if let Some(w) = spec.scale_w {
        vf.push(format!("scale={w}:-2"));
    }
    match spec.rotate.rem_euclid(360) {
        90 => vf.push("transpose=1".into()),
        180 => {
            vf.push("transpose=1".into());
            vf.push("transpose=1".into());
        }
        270 => vf.push("transpose=2".into()),
        _ => {}
    }
    if spec.flip_h {
        vf.push("hflip".into());
    }
    if spec.flip_v {
        vf.push("vflip".into());
    }
    if (speed - 1.0).abs() > 1e-3 {
        vf.push(format!("setpts=PTS/{speed}"));
    }
    if spec.fade_in > 0.0 {
        vf.push(format!("fade=t=in:st=0:d={}", spec.fade_in));
    }
    if spec.fade_out > 0.0 && out_dur > spec.fade_out {
        vf.push(format!(
            "fade=t=out:st={}:d={}",
            out_dur - spec.fade_out,
            spec.fade_out
        ));
    }

    // Cadeia de filtros de áudio.
    let mut af: Vec<String> = Vec::new();
    if (speed - 1.0).abs() > 1e-3 {
        for a in atempo_chain(speed) {
            af.push(format!("atempo={a}"));
        }
    }
    let vol = if spec.mute { 0.0 } else { spec.volume };
    if (vol - 1.0).abs() > 1e-3 {
        af.push(format!("volume={vol}"));
    }
    if spec.fade_in > 0.0 {
        af.push(format!("afade=t=in:st=0:d={}", spec.fade_in));
    }
    if spec.fade_out > 0.0 && out_dur > spec.fade_out {
        af.push(format!(
            "afade=t=out:st={}:d={}",
            out_dur - spec.fade_out,
            spec.fade_out
        ));
    }

    let stem = inp.file_stem().and_then(|s| s.to_str()).unwrap_or("video");
    let out_ext = match fmt {
        "mp3" => "mp3",
        "gif" => "gif",
        _ => "mp4",
    };
    let ts = chrono::Local::now().timestamp();
    let out_path = inp.with_file_name(format!("{stem} (editado {ts}).{out_ext}"));
    let out_str = out_path.to_string_lossy().to_string();

    // Monta os argumentos.
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
    ];
    if start > 0.0 {
        args.push("-ss".into());
        args.push(format!("{start}"));
    }
    if spec.end.is_some() {
        args.push("-t".into());
        args.push(format!("{trimmed}"));
    }
    args.push("-i".into());
    args.push(spec.input.clone());

    // Smart cut: só trim (sem filtros) em mp4 → copia o stream (instantâneo, sem perda).
    let smart = spec.lossless && fmt == "mp4" && vf.is_empty() && af.is_empty();
    if smart {
        args.extend([
            "-c".into(),
            "copy".into(),
            "-avoid_negative_ts".into(),
            "make_zero".into(),
        ]);
    } else {
        match fmt {
        "mp3" => {
            args.push("-vn".into());
            if !af.is_empty() {
                args.push("-af".into());
                args.push(af.join(","));
            }
            args.extend(["-c:a".into(), "libmp3lame".into(), "-q:a".into(), "2".into()]);
        }
        "gif" => {
            let mut g = vf.join(",");
            if !g.is_empty() {
                g.push(',');
            }
            g.push_str(
                "fps=15,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer",
            );
            args.push("-vf".into());
            args.push(g);
            args.push("-an".into());
            args.push("-loop".into());
            args.push("0".into());
        }
        _ => {
            if !vf.is_empty() {
                args.push("-vf".into());
                args.push(vf.join(","));
            }
            if !af.is_empty() {
                args.push("-af".into());
                args.push(af.join(","));
            }
            args.extend([
                "-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(),
                "-crf".into(), "20".into(), "-c:a".into(), "aac".into(),
                "-movflags".into(), "+faststart".into(),
            ]);
        }
        }
    }
    args.push(out_str.clone());

    let mut cmd = Command::new(ffmpeg_exe());
    cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Não foi possível iniciar o ffmpeg ({e})."))?;
    let stdout = child.stdout.take().ok_or("Falha ao ler o ffmpeg")?;
    let stderr = child.stderr.take().ok_or("Falha ao ler o ffmpeg")?;

    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    state
        .edits
        .lock()
        .unwrap()
        .insert(spec.id.clone(), cancel_tx);

    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut last = String::new();
        while let Ok(Some(line)) = reader.next_line().await {
            if !line.trim().is_empty() {
                last = line;
            }
        }
        last
    });

    let app_p = app.clone();
    let id_p = spec.id.clone();
    let prog = async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(rest) = line.strip_prefix("out_time=") {
                if let Some(secs) = parse_time(rest.trim()) {
                    let pct = if out_dur > 0.0 {
                        (secs / out_dur * 100.0).clamp(0.0, 99.0)
                    } else {
                        0.0
                    };
                    let _ = app_p.emit(
                        "edit-progress",
                        EditProgress {
                            id: id_p.clone(),
                            percent: pct,
                        },
                    );
                }
            }
        }
    };

    let cancelled = tokio::select! {
        _ = prog => false,
        _ = &mut cancel_rx => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            true
        }
    };
    state.edits.lock().unwrap().remove(&spec.id);

    if cancelled {
        let _ = std::fs::remove_file(&out_path);
        return Err("Edição cancelada.".into());
    }

    let status = child.wait().await.map_err(|e| format!("ffmpeg: {e}"))?;
    let stderr_last = stderr_task.await.unwrap_or_default();
    if !status.success() || !out_path.exists() {
        let _ = std::fs::remove_file(&out_path);
        return Err(format!("Falha ao processar: {}", stderr_last.trim()));
    }

    let _ = app.emit(
        "edit-progress",
        EditProgress {
            id: spec.id.clone(),
            percent: 100.0,
        },
    );

    let filesize = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
    let duration = probe_duration(&out_str).await;
    let suffix = match fmt {
        "mp3" => "(áudio)",
        "gif" => "(GIF)",
        _ => "(editado)",
    };
    let item = HistoryItem {
        id: format!("edit-{}", chrono::Local::now().timestamp_millis()),
        title: format!("{} {}", title_from_path(&inp), suffix),
        platform: "Local".into(),
        quality: if fmt == "mp3" { "audio".into() } else { "editado".into() },
        thumbnail: guess_thumbnail(&out_str),
        filepath: out_str,
        filesize,
        date: chrono::Local::now().to_rfc3339(),
        url: String::new(),
        favorite: false,
        duration,
    };
    history::add_item(&app, item.clone())?;
    Ok(item)
}

#[tauri::command]
pub fn cancel_edit(state: State<'_, Arc<DownloadManager>>, id: String) -> Result<(), String> {
    if let Some(tx) = state.edits.lock().unwrap().remove(&id) {
        let _ = tx.send(());
    }
    Ok(())
}

/// Exporta o quadro atual como imagem (não entra na galeria de vídeos).
#[tauri::command]
pub async fn capture_frame(
    input: String,
    time: f64,
    format: String,
) -> Result<String, String> {
    let inp = PathBuf::from(&input);
    if !inp.is_file() {
        return Err("Arquivo não encontrado.".into());
    }
    let ext = if format == "png" { "png" } else { "jpg" };
    let stem = inp.file_stem().and_then(|s| s.to_str()).unwrap_or("frame");
    let ts = chrono::Local::now().timestamp_millis();
    let out = inp.with_file_name(format!("{stem} (frame {ts}).{ext}"));
    let out_str = out.to_string_lossy().to_string();

    let mut cmd = Command::new(ffmpeg_exe());
    cmd.args([
        "-y", "-ss", &format!("{}", time.max(0.0)), "-i", input.as_str(),
        "-frames:v", "1", "-update", "1", "-q:v", "2", out_str.as_str(),
    ])
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    hide_console(&mut cmd);
    let status = cmd.status().await.map_err(|e| format!("ffmpeg: {e}"))?;
    if !status.success() || !out.exists() {
        return Err("Não foi possível exportar o quadro.".into());
    }
    Ok(out_str)
}

#[derive(Clone, Serialize)]
pub struct Thumb {
    pub time: f64,
    pub data: String,
}

/// Extrai `count` quadros distribuídos ao longo do vídeo (para a timeline do editor).
#[tauri::command]
pub async fn generate_thumbnails(
    input: String,
    duration: f64,
    count: usize,
) -> Result<Vec<Thumb>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    if !Path::new(&input).is_file() {
        return Err("Arquivo não encontrado.".into());
    }
    if !duration.is_finite() || duration <= 0.0 {
        return Err("Duração inválida.".into());
    }
    let n = count.clamp(1, 20);
    let tmp = std::env::temp_dir().join(format!(
        "cg-thumbs-{}",
        chrono::Local::now().timestamp_millis()
    ));
    let _ = std::fs::create_dir_all(&tmp);

    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let t = (i as f64 + 0.5) * duration / n as f64;
        let ss = format!("{t}");
        let jpg = tmp.join(format!("t{i}.jpg"));
        let jpgs = jpg.to_string_lossy().to_string();
        let mut cmd = Command::new(ffmpeg_exe());
        cmd.args([
            "-y", "-ss", ss.as_str(), "-i", input.as_str(), "-frames:v", "1",
            "-vf", "scale=160:-1", "-q:v", "5", jpgs.as_str(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
        hide_console(&mut cmd);
        let _ = cmd.output().await;
        if let Ok(bytes) = std::fs::read(&jpg) {
            out.push(Thumb {
                time: t,
                data: format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes)),
            });
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(out)
}

#[tauri::command]
pub fn read_image_base64(path: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let bytes = std::fs::read(&path).map_err(|e| format!("Falha ao ler imagem: {e}"))?;
    let mime = if path.to_lowercase().ends_with(".png") {
        "image/png"
    } else {
        "image/jpeg"
    };
    Ok(format!("data:{};base64,{}", mime, STANDARD.encode(bytes)))
}
