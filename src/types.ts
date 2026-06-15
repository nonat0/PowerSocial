export interface QualityOption {
  id: string;
  label: string;
  available: boolean;
}

export interface PlaylistEntry {
  index: number;
  id: string;
  title: string;
  url: string;
  thumbnail: string;
  duration: number | null;
}

export interface VideoInfo {
  title: string;
  uploader: string;
  thumbnail: string;
  duration: number | null;
  platform: string;
  max_height: number | null;
  qualities: QualityOption[];
  is_playlist: boolean;
  playlist_count: number | null;
  entries: PlaylistEntry[];
}

export interface DownloadRequest {
  id: string;
  url: string;
  quality: string;
  title: string;
  platform: string;
  playlist: boolean;
  /** Itens selecionados no formato do yt-dlp (ex.: "1,3,5-7"). Vazio = todos. */
  playlist_items?: string;
  /** Corte "INICIO-FIM" (ex.: "00:01:00-00:02:30"). Vazio = vídeo inteiro. */
  section?: string;
}

export interface Settings {
  download_dir: string | null;
  cookies_browser: string | null;
  cookies_file: string | null;
}

export interface HistoryItem {
  id: string;
  title: string;
  platform: string;
  quality: string;
  filepath: string;
  thumbnail: string | null;
  filesize: number;
  date: string;
  url: string;
  favorite?: boolean;
  duration?: number | null;
}

export interface ProgressEvent {
  id: string;
  status: string;
  percent: number;
  speed: number | null;
  eta: number | null;
  downloaded: number;
  total: number;
}

export type JobStatus =
  | "queued"
  | "downloading"
  | "paused"
  | "done"
  | "error"
  | "cancelled";

export type JobKind = "download" | "render";

/** Estado de um download na fila (somente no frontend). */
export interface Job {
  id: string;
  title: string;
  platform: string;
  isPlaylist: boolean;
  total: number | null; // nº de itens da playlist, se souber
  completed: number; // arquivos já concluídos
  status: JobStatus;
  percent: number;
  speed: number | null;
  eta: number | null;
  downloaded?: number; // bytes do arquivo atual (polling do disco)
  message?: string;
  request?: DownloadRequest; // guardado para pausar/continuar
  kind?: JobKind; // "download" (padrão) ou "render" (edição/ffmpeg)
}

/** Um download cancelado, com o momento em que parou (persistido). */
export interface CancelledItem {
  id: string;
  title: string;
  platform: string;
  url: string;
  isPlaylist: boolean;
  completed: number;
  total: number | null;
  percent: number;
  moment: string;
  date: string;
}
