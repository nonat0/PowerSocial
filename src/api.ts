import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  CancelledItem,
  DownloadRequest,
  HistoryItem,
  ProgressEvent,
  Settings,
  VideoInfo,
} from "./types";

export function getVideoInfo(url: string): Promise<VideoInfo> {
  return invoke("get_video_info", { url });
}

/** Enfileira um download. Resolve imediatamente; o andamento chega por eventos. */
export function downloadVideo(request: DownloadRequest): Promise<void> {
  return invoke("download_video", { request });
}

export function cancelDownload(id: string): Promise<void> {
  return invoke("cancel_download", { id });
}

/** Pausa o download (mantém os arquivos parciais). Continuar = downloadVideo() de novo. */
export function pauseDownload(id: string): Promise<void> {
  return invoke("pause_download", { id });
}

export function loadCancelled(): Promise<CancelledItem[]> {
  return invoke("load_cancelled");
}

export function addCancelled(item: CancelledItem): Promise<void> {
  return invoke("add_cancelled", { item });
}

export function clearCancelled(): Promise<void> {
  return invoke("clear_cancelled");
}

/** Estima o tamanho de cada item da playlist na qualidade dada (não baixa). */
export function fetchPlaylistSizes(
  url: string,
  quality: string,
  probeId: string,
  count: number
): Promise<void> {
  return invoke("fetch_playlist_sizes", { url, quality, probeId, count });
}

export function cancelPlaylistSizes(probeId: string): Promise<void> {
  return invoke("cancel_playlist_sizes", { probeId });
}

/** Assina os tamanhos de uma sondagem; devolve função para cancelar a assinatura. */
export async function subscribePlaylistSizes(
  probeId: string,
  handlers: {
    onSize: (index: number, bytes: number | null) => void;
    onDone: () => void;
  }
): Promise<UnlistenFn> {
  const unlisteners = await Promise.all([
    listen<{ probe_id: string; index: number; bytes: number | null }>(
      "playlist-size",
      (e) => {
        if (e.payload.probe_id === probeId)
          handlers.onSize(e.payload.index, e.payload.bytes);
      }
    ),
    listen<{ probe_id: string }>("playlist-sizes-done", (e) => {
      if (e.payload.probe_id === probeId) handlers.onDone();
    }),
  ]);
  return () => unlisteners.forEach((un) => un());
}

export function readImageBase64(path: string): Promise<string> {
  return invoke("read_image_base64", { path });
}

export function loadHistory(): Promise<HistoryItem[]> {
  return invoke("load_history");
}

export function removeHistoryItem(id: string, deleteFile: boolean): Promise<void> {
  return invoke("remove_history_item", { id, deleteFile });
}

export function setFavorite(id: string, favorite: boolean): Promise<void> {
  return invoke("set_favorite", { id, favorite });
}

export interface ImportResult {
  history: HistoryItem[];
  added: number;
}

/** Importa vídeos de uma pasta (atualiza existentes por caminho, não duplica). */
export function importGallery(dir: string): Promise<ImportResult> {
  return invoke("import_gallery", { dir });
}

/** Preenche a duração dos itens antigos. Retorna o histórico atualizado. */
export function backfillDurations(): Promise<HistoryItem[]> {
  return invoke("backfill_durations");
}

/** Corta um trecho de um vídeo/áudio existente. Retorna o novo item gerado. */
export function cutVideo(
  input: string,
  start: string,
  end: string
): Promise<HistoryItem> {
  return invoke("cut_video", { input, start, end });
}

export interface Thumb {
  time: number;
  data: string;
}

/** Extrai miniaturas distribuídas ao longo do vídeo (para a timeline do editor). */
export function generateThumbnails(
  input: string,
  duration: number,
  count: number
): Promise<Thumb[]> {
  return invoke("generate_thumbnails", { input, duration, count });
}

export interface MediaInfo {
  duration: number;
  fps: number;
  width: number;
  height: number;
}

/** Lê duração, fps e resolução (para a timeline frame-accurate). */
export function probeMedia(input: string): Promise<MediaInfo> {
  return invoke("probe_media", { input });
}

export interface EditSpec {
  id: string;
  input: string;
  start?: number;
  end?: number;
  crop?: { x: number; y: number; w: number; h: number };
  scale_w?: number;
  rotate?: number;
  flip_h?: boolean;
  flip_v?: boolean;
  speed?: number;
  volume?: number;
  mute?: boolean;
  fade_in?: number;
  fade_out?: number;
  format?: string; // mp4 | mp3 | gif
  lossless?: boolean;
}

/** Aplica todas as edições numa única passada do ffmpeg. Retorna o novo item. */
export function applyEdits(spec: EditSpec): Promise<HistoryItem> {
  return invoke("apply_edits", { spec });
}

export function cancelEdit(id: string): Promise<void> {
  return invoke("cancel_edit", { id });
}

/** Exporta o quadro atual como imagem. Retorna o caminho do arquivo. */
export function captureFrame(
  input: string,
  time: number,
  format: string
): Promise<string> {
  return invoke("capture_frame", { input, time, format });
}

/** Assina o progresso de uma edição (por id). Devolve função p/ cancelar. */
export async function onEditProgress(
  id: string,
  cb: (percent: number) => void
): Promise<UnlistenFn> {
  return listen<{ id: string; percent: number }>("edit-progress", (e) => {
    if (e.payload.id === id) cb(e.payload.percent);
  });
}

export function getDownloadDir(): Promise<string> {
  return invoke("get_download_dir");
}

export function getSettings(): Promise<Settings> {
  return invoke("get_settings");
}

/** Define a fonte de cookies (navegador ou arquivo). Vazio/null limpa. */
export function setCookieSettings(
  browser: string | null,
  file: string | null
): Promise<void> {
  return invoke("set_cookie_settings", { browser, file });
}

/** Abre seletor de arquivo (ex.: cookies.txt). Retorna o caminho ou null. */
export async function pickFile(): Promise<string | null> {
  const result = await openDialog({
    directory: false,
    multiple: false,
    filters: [{ name: "Cookies", extensions: ["txt"] }],
  });
  return typeof result === "string" ? result : null;
}

export function setDownloadDir(dir: string): Promise<void> {
  return invoke("set_download_dir", { dir });
}

export function openFile(path: string): Promise<void> {
  return invoke("open_path", { path });
}

/** Abre um link (URL) no navegador padrão. */
export function openUrl(url: string): Promise<void> {
  return invoke("open_url", { url });
}

export function revealInFolder(path: string): Promise<void> {
  return invoke("reveal_path", { path });
}

export async function pickFolder(current?: string): Promise<string | null> {
  const result = await openDialog({
    directory: true,
    multiple: false,
    defaultPath: current,
  });
  return typeof result === "string" ? result : null;
}

/** Eventos emitidos pelo backend durante um download. */
export interface DownloadEventHandlers {
  onStarted: (id: string) => void;
  onProgress: (ev: ProgressEvent) => void;
  onItem: (id: string, item: HistoryItem) => void;
  onDone: (id: string, count: number) => void;
  onError: (id: string, message: string) => void;
  onCancelled: (id: string) => void;
  onPaused: (id: string) => void;
  onStats: (id: string, completed: number, downloaded: number) => void;
  onItemUrl: (id: string, url: string) => void;
}

/** Assina todos os eventos de download; devolve uma função para cancelar a assinatura. */
export async function subscribeDownloadEvents(
  h: DownloadEventHandlers
): Promise<UnlistenFn> {
  const unlisteners = await Promise.all([
    listen<{ id: string }>("download-started", (e) => h.onStarted(e.payload.id)),
    listen<ProgressEvent>("download-progress", (e) => h.onProgress(e.payload)),
    listen<{ id: string; item: HistoryItem }>("download-item", (e) =>
      h.onItem(e.payload.id, e.payload.item)
    ),
    listen<{ id: string; count: number }>("download-done", (e) =>
      h.onDone(e.payload.id, e.payload.count)
    ),
    listen<{ id: string; message: string }>("download-error", (e) =>
      h.onError(e.payload.id, e.payload.message)
    ),
    listen<{ id: string }>("download-cancelled", (e) =>
      h.onCancelled(e.payload.id)
    ),
    listen<{ id: string }>("download-paused", (e) => h.onPaused(e.payload.id)),
    listen<{ id: string; completed: number; downloaded: number }>(
      "download-stats",
      (e) => h.onStats(e.payload.id, e.payload.completed, e.payload.downloaded)
    ),
    listen<{ id: string; url: string }>("download-item-url", (e) =>
      h.onItemUrl(e.payload.id, e.payload.url)
    ),
  ]);
  return () => unlisteners.forEach((un) => un());
}
