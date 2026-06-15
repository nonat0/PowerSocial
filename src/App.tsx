import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Download,
  Folder,
  FolderInput,
  Globe,
  KeyRound,
  Loader2,
  Scissors,
  Search,
  Trash2,
  X as XIcon,
} from "lucide-react";

import type { CancelledItem, HistoryItem, Job, VideoInfo } from "./types";
import {
  addCancelled,
  applyEdits,
  backfillDurations,
  cancelDownload,
  cancelEdit,
  cancelPlaylistSizes,
  clearCancelled,
  downloadVideo,
  onEditProgress,
  type EditSpec,
  fetchPlaylistSizes,
  getDownloadDir,
  getSettings,
  getVideoInfo,
  importGallery,
  loadCancelled,
  loadHistory,
  openFile,
  openUrl,
  pauseDownload,
  pickFile,
  pickFolder,
  setCookieSettings,
  setDownloadDir,
  subscribeDownloadEvents,
  subscribePlaylistSizes,
} from "./api";
import { Titlebar } from "./components/Titlebar";
import { GalleryCard } from "./components/GalleryCard";
import { JobsPanel } from "./components/JobsPanel";
import { PlatformLogo } from "./components/PlatformLogo";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Checkbox } from "./components/ui/checkbox";
import { Card, CardContent } from "./components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { Badge } from "./components/ui/badge";
import { formatBytes, formatDate, formatDuration, maskTime } from "./utils";

const PLATFORM_FILTERS = [
  "Todos",
  "Favoritos",
  "YouTube",
  "Instagram",
  "Facebook",
  "X",
  "Local",
];

function App() {
  const [url, setUrl] = useState("");
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [quality, setQuality] = useState("best");
  const [playlistMode, setPlaylistMode] = useState<"single" | "all" | "select">(
    "all"
  );
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [cutEnabled, setCutEnabled] = useState(false);
  const [cutStart, setCutStart] = useState("");
  const [cutEnd, setCutEnd] = useState("");
  const [importing, setImporting] = useState(false);
  const [sizes, setSizes] = useState<Record<number, number | null>>({});
  const [sizesLoading, setSizesLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [downloadDir, setDir] = useState("");
  const [search, setSearch] = useState("");
  const [platformFilter, setPlatformFilter] = useState("Todos");
  const [view, setView] = useState<"galeria" | "downloads">("galeria");
  const [downloadsTab, setDownloadsTab] = useState<"baixados" | "cancelados">(
    "baixados"
  );
  const [sortBy, setSortBy] = useState<
    "data" | "nome" | "tamanho" | "duracao"
  >("data");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [cancelled, setCancelled] = useState<CancelledItem[]>([]);
  const [cookieBrowser, setCookieBrowser] = useState("");
  const [cookieFile, setCookieFile] = useState("");

  useEffect(() => {
    loadHistory()
      .then((h) => {
        setHistory(h);
        // Preenche a duração dos itens antigos em background (não bloqueia a UI).
        backfillDurations().then(setHistory).catch(() => {});
      })
      .catch(() => {});
    loadCancelled().then(setCancelled).catch(() => {});
    getDownloadDir().then(setDir).catch(() => {});
    getSettings()
      .then((s) => {
        setCookieBrowser(s.cookies_browser ?? "");
        setCookieFile(s.cookies_file ?? "");
      })
      .catch(() => {});

    const updateJob = (id: string, patch: Partial<Job>) =>
      setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));

    const unsubPromise = subscribeDownloadEvents({
      onStarted: (id) => updateJob(id, { status: "downloading" }),
      // % do arquivo atual (yt-dlp reseta por formato; usamos o máximo p/ não
      // recuar entre vídeo→áudio). O reset por vídeo acontece no onStats.
      onProgress: (ev) =>
        setJobs((prev) =>
          prev.map((j) =>
            j.id === ev.id
              ? {
                  ...j,
                  status: "downloading",
                  percent: Math.max(j.percent, ev.percent),
                  speed: ev.speed,
                  eta: ev.eta,
                }
              : j
          )
        ),
      onItem: (_id, item) => {
        // Cada arquivo finalizado entra na galeria 1 a 1 (vindo do polling).
        setHistory((prev) => [item, ...prev.filter((i) => i.id !== item.id)]);
      },
      // Concluídos (tempo real). Ao trocar de vídeo, a barra reinicia em 0%.
      onStats: (id, completed, downloaded) =>
        setJobs((prev) =>
          prev.map((j) => {
            if (j.id !== id) return j;
            if (j.status !== "downloading" && j.status !== "queued") return j;
            const videoChanged = completed > j.completed;
            return {
              ...j,
              status: "downloading",
              completed,
              downloaded,
              percent: videoChanged ? 0 : j.percent,
            };
          })
        ),
      onDone: (id, count) => {
        updateJob(id, {
          status: "done",
          completed: Math.max(count, 0),
          percent: 100,
        });
        setTimeout(() => dismissJob(id), 6000);
      },
      onError: (id, message) => updateJob(id, { status: "error", message }),
      onCancelled: (id) => updateJob(id, { status: "cancelled" }),
      onPaused: (id) => updateJob(id, { status: "paused" }),
      onItemUrl: (id, url) =>
        setHistory((prev) =>
          prev.map((i) => (i.id === id ? { ...i, url } : i))
        ),
    });

    return () => {
      unsubPromise.then((un) => un());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Estima o tamanho de cada vídeo ao abrir "escolher vídeos" (e ao trocar a qualidade).
  useEffect(() => {
    if (!info?.is_playlist || playlistMode !== "select") {
      setSizes({});
      setSizesLoading(false);
      return;
    }
    const probeId = crypto.randomUUID();
    let active = true;
    setSizes({});
    setSizesLoading(true);

    const unsubPromise = subscribePlaylistSizes(probeId, {
      onSize: (index, bytes) =>
        active && setSizes((prev) => ({ ...prev, [index]: bytes })),
      onDone: () => active && setSizesLoading(false),
    });
    fetchPlaylistSizes(
      url,
      quality,
      probeId,
      info.playlist_count ?? info.entries.length
    ).catch(() => {
      if (active) setSizesLoading(false);
    });

    return () => {
      active = false;
      cancelPlaylistSizes(probeId).catch(() => {});
      unsubPromise.then((un) => un());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, playlistMode, quality]);

  function dismissJob(id: string) {
    setJobs((prev) => prev.filter((j) => j.id !== id));
  }

  async function handleAnalyze() {
    if (!url.trim()) return;
    setError(null);
    setInfo(null);
    setAnalyzing(true);
    try {
      const result = await getVideoInfo(url);
      setInfo(result);
      setPlaylistMode(result.is_playlist ? "all" : "single");
      setSelected(new Set(result.entries.map((e) => e.index)));
      setQuality(result.qualities.find((q) => q.available)?.id ?? "best");
      setCutEnabled(false);
      setCutStart("");
      setCutEnd("");
    } catch (e) {
      setError(String(e));
    } finally {
      setAnalyzing(false);
    }
  }

  function handleDownload() {
    if (!info) return;
    const isPlaylist = info.is_playlist && playlistMode !== "single";

    if (playlistMode === "select" && selected.size === 0) {
      setError("Selecione ao menos um vídeo da playlist.");
      return;
    }
    setError(null);

    const playlist_items =
      playlistMode === "select"
        ? Array.from(selected)
            .sort((a, b) => a - b)
            .join(",")
        : undefined;
    const total = !isPlaylist
      ? null
      : playlistMode === "select"
      ? selected.size
      : info.playlist_count;

    // Corte só vale para vídeo único (não playlist).
    const section =
      !isPlaylist && cutEnabled && (cutStart.trim() || cutEnd.trim())
        ? `${cutStart.trim() || "0:00"}-${cutEnd.trim() || "inf"}`
        : undefined;

    const id = crypto.randomUUID();
    const request = {
      id,
      url,
      quality,
      title: info.title,
      platform: info.platform,
      playlist: isPlaylist,
      playlist_items,
      section,
    };
    const job: Job = {
      id,
      title: info.title,
      platform: info.platform,
      isPlaylist,
      total,
      completed: 0,
      status: "queued",
      percent: 0,
      speed: null,
      eta: null,
      request,
    };
    setJobs((prev) => [job, ...prev]);

    downloadVideo(request).catch((e) =>
      setJobs((prev) =>
        prev.map((j) =>
          j.id === id ? { ...j, status: "error", message: String(e) } : j
        )
      )
    );

    setInfo(null);
    setUrl("");
    setPlaylistMode("all");
    setSelected(new Set());
    setCutEnabled(false);
    setCutStart("");
    setCutEnd("");
  }

  function handlePause(id: string) {
    pauseDownload(id).catch(() => {});
  }

  function handleResume(job: Job) {
    if (!job.request) return;
    setJobs((prev) =>
      prev.map((j) =>
        j.id === job.id ? { ...j, status: "queued", message: undefined } : j
      )
    );
    downloadVideo(job.request).catch((e) =>
      setJobs((prev) =>
        prev.map((j) =>
          j.id === job.id ? { ...j, status: "error", message: String(e) } : j
        )
      )
    );
  }

  // Exporta uma edição em background: vira um job de "render" no painel.
  async function handleExport(spec: EditSpec, source: HistoryItem) {
    const id = spec.id;
    const fmt = (spec.format ?? "mp4").toUpperCase();
    setJobs((prev) => [
      {
        id,
        title: `${source.title} → ${fmt}`,
        platform: source.platform,
        isPlaylist: false,
        total: null,
        completed: 0,
        status: "downloading",
        percent: 0,
        speed: null,
        eta: null,
        kind: "render",
      } as Job,
      ...prev,
    ]);
    const un = await onEditProgress(id, (pct) =>
      setJobs((prev) =>
        prev.map((j) => (j.id === id ? { ...j, percent: pct } : j))
      )
    ).catch(() => undefined);
    applyEdits(spec)
      .then((created) => {
        setHistory((prev) => [
          created,
          ...prev.filter((i) => i.id !== created.id),
        ]);
        setJobs((prev) =>
          prev.map((j) =>
            j.id === id ? { ...j, status: "done", percent: 100 } : j
          )
        );
        setTimeout(() => dismissJob(id), 6000);
      })
      .catch((e) =>
        setJobs((prev) =>
          prev.map((j) =>
            j.id === id ? { ...j, status: "error", message: String(e) } : j
          )
        )
      )
      .finally(() => {
        if (un) un();
      });
  }

  function handleCancel(job: Job) {
    if (job.kind === "render") {
      cancelEdit(job.id).catch(() => {});
      setJobs((prev) => prev.filter((j) => j.id !== job.id));
      return;
    }
    cancelDownload(job.id).catch(() => {});
    // Marca já no front: se o job estava pausado, o backend não emite evento
    // (o processo já morreu), então o status precisa ser atualizado aqui.
    setJobs((prev) =>
      prev.map((j) => (j.id === job.id ? { ...j, status: "cancelled" } : j))
    );
    // Registra o momento em que parou (persistido na aba "Cancelados").
    const moment = job.isPlaylist
      ? `item ${Math.min(job.completed + 1, job.total ?? job.completed + 1)}${
          job.total ? `/${job.total}` : ""
        } · ${job.percent.toFixed(0)}% do arquivo`
      : `${job.percent.toFixed(0)}%`;
    const item: CancelledItem = {
      id: job.id,
      title: job.title,
      platform: job.platform,
      url: job.request?.url ?? "",
      isPlaylist: job.isPlaylist,
      completed: job.completed,
      total: job.total,
      percent: job.percent,
      moment,
      date: new Date().toISOString(),
    };
    setCancelled((prev) => [item, ...prev]);
    addCancelled(item).catch(() => {});
  }

  async function handleClearCancelled() {
    await clearCancelled().catch(() => {});
    setCancelled([]);
  }

  function toggleSelected(index: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function handleCookieBrowser(browser: string) {
    setCookieBrowser(browser);
    setCookieFile("");
    await setCookieSettings(browser || null, null).catch(() => {});
  }

  async function handlePickCookieFile() {
    const file = await pickFile();
    if (!file) return;
    setCookieFile(file);
    setCookieBrowser("");
    await setCookieSettings(null, file).catch(() => {});
  }

  async function handleClearCookieFile() {
    setCookieFile("");
    await setCookieSettings(cookieBrowser || null, null).catch(() => {});
  }

  async function handlePickFolder() {
    const picked = await pickFolder(downloadDir);
    if (picked) {
      await setDownloadDir(picked);
      setDir(picked);
    }
  }

  async function handleImport() {
    const dir = await pickFolder(downloadDir);
    if (!dir) return;
    setImporting(true);
    setError(null);
    try {
      const res = await importGallery(dir);
      setHistory(res.history);
      setView("galeria");
      if (res.added === 0) {
        setError("Nenhum vídeo novo encontrado nessa pasta.");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setImporting(false);
    }
  }

  function handleToggleFavorite(id: string, favorite: boolean) {
    setHistory((prev) =>
      prev.map((i) => (i.id === id ? { ...i, favorite } : i))
    );
  }

  const matchesSearch = (i: { title: string; platform: string }) =>
    !search.trim() ||
    i.title.toLowerCase().includes(search.toLowerCase()) ||
    i.platform.toLowerCase().includes(search.toLowerCase());
  const matchesFilter = (i: { platform: string; favorite?: boolean }) => {
    if (platformFilter === "Todos") return true;
    if (platformFilter === "Favoritos") return !!i.favorite;
    return i.platform === platformFilter;
  };
  const countInFilter = (
    list: Array<{ platform: string; favorite?: boolean }>,
    p: string
  ) =>
    p === "Todos"
      ? list.length
      : p === "Favoritos"
      ? list.filter((i) => i.favorite).length
      : list.filter((i) => i.platform === p).length;

  function applyFilters<
    T extends { title: string; platform: string; favorite?: boolean }
  >(list: T[]): T[] {
    return list.filter((i) => matchesSearch(i) && matchesFilter(i));
  }

  // "Baixados" = só o que veio da web (exclui importados/cortes locais).
  const downloadsHistory = history.filter((i) => i.platform !== "Local");

  // Fonte ativa só para contar no strip de filtros.
  const filterSource: Array<{ platform: string; favorite?: boolean; title: string }> =
    view === "galeria"
      ? history
      : downloadsTab === "cancelados"
      ? cancelled
      : downloadsHistory;
  const sourceSearched = filterSource.filter(matchesSearch);
  const countFor = (p: string) => countInFilter(sourceSearched, p);

  function sortItems<
    T extends {
      date: string;
      title: string;
      filesize?: number;
      duration?: number | null;
    }
  >(list: T[]): T[] {
    const s = [...list].sort((a, b) => {
      let r = 0;
      if (sortBy === "data")
        r = new Date(a.date).getTime() - new Date(b.date).getTime();
      else if (sortBy === "nome")
        r = a.title.localeCompare(b.title, "pt-BR", {
          numeric: true,
          sensitivity: "base",
        });
      else if (sortBy === "tamanho") r = (a.filesize ?? 0) - (b.filesize ?? 0);
      else if (sortBy === "duracao")
        r = (a.duration ?? -1) - (b.duration ?? -1);
      return r;
    });
    return sortDir === "desc" ? s.reverse() : s;
  }

  const filteredHistory = sortItems(applyFilters(history));
  const filteredDownloads = sortItems(applyFilters(downloadsHistory));
  const filteredCancelled = sortItems(applyFilters(cancelled));
  const downloadsTotalBytes = filteredDownloads.reduce(
    (s, i) => s + (i.filesize || 0),
    0
  );

  const selectedBytes = info
    ? info.entries.reduce(
        (sum, e) =>
          selected.has(e.index) && typeof sizes[e.index] === "number"
            ? sum + (sizes[e.index] as number)
            : sum,
        0
      )
    : 0;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <Titlebar />

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-6 py-6 pb-16">
          {/* Topo: subtítulo + pasta de destino */}
          <div className="mb-6 flex items-end justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                Baixe vídeos e áudios
              </h1>
              <p className="text-sm text-muted-foreground">
                YouTube, Instagram, Facebook e X — em alta qualidade.
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Salvando em
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant={view === "downloads" ? "default" : "outline"}
                  size="sm"
                  onClick={() =>
                    setView((v) => (v === "downloads" ? "galeria" : "downloads"))
                  }
                  title="Ver downloads (baixados e cancelados)"
                >
                  <Download /> Downloads
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleImport}
                  disabled={importing}
                  title="Importar vídeos de uma pasta existente"
                >
                  {importing ? <Loader2 className="animate-spin" /> : <FolderInput />}
                  Importar galeria
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePickFolder}
                  title={downloadDir}
                  className="max-w-[280px]"
                >
                  <Folder />
                  <span className="truncate">
                    {downloadDir || "Escolher pasta"}
                  </span>
                </Button>
              </div>
            </div>
          </div>

          {/* Downloader */}
          <Card className="mb-7 gap-4 py-5">
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="Cole o link do YouTube, Instagram, Facebook ou X…"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
                  className="h-11 text-base"
                />
                <Button
                  size="lg"
                  className="h-11"
                  onClick={handleAnalyze}
                  disabled={analyzing || !url.trim()}
                >
                  {analyzing && <Loader2 className="animate-spin" />}
                  {analyzing ? "Analisando…" : "Analisar"}
                </Button>
              </div>

              {/* Cookies */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <KeyRound className="size-4" /> Cookies do YouTube
                </span>
                <Select
                  value={cookieBrowser || "none"}
                  onValueChange={(v) =>
                    handleCookieBrowser(v === "none" ? "" : v)
                  }
                  disabled={!!cookieFile}
                >
                  <SelectTrigger size="sm" className="w-[150px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Nenhum</SelectItem>
                    <SelectItem value="chrome">Chrome</SelectItem>
                    <SelectItem value="edge">Edge</SelectItem>
                    <SelectItem value="firefox">Firefox</SelectItem>
                    <SelectItem value="brave">Brave</SelectItem>
                    <SelectItem value="opera">Opera</SelectItem>
                    <SelectItem value="vivaldi">Vivaldi</SelectItem>
                  </SelectContent>
                </Select>
                {cookieFile ? (
                  <span className="inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-sm">
                    📄 {cookieFile.split(/[\\/]/).pop()}
                    <button
                      onClick={handleClearCookieFile}
                      title="Remover"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePickCookieFile}
                  >
                    Usar arquivo cookies.txt…
                  </Button>
                )}
                <span className="basis-full text-xs text-muted-foreground">
                  Para Chrome/Edge, feche o navegador antes de baixar — ou use um
                  arquivo cookies.txt.
                </span>
              </div>

              {error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive-foreground">
                  {error}
                </div>
              )}

              {info && (
                <div className="flex flex-col gap-4 border-t pt-4 sm:flex-row">
                  <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-lg bg-secondary sm:w-72">
                    {info.thumbnail ? (
                      <img
                        src={info.thumbnail}
                        alt={info.title}
                        className="size-full object-cover"
                      />
                    ) : (
                      <div className="grid size-full place-items-center text-4xl">
                        {info.is_playlist ? "🎞️" : "🎬"}
                      </div>
                    )}
                    {info.duration != null && (
                      <span className="absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 text-xs text-white">
                        {formatDuration(info.duration)}
                      </span>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <span className="inline-flex items-center gap-2 text-sm font-medium">
                      <PlatformLogo platform={info.platform} size={18} />
                      {info.platform}
                    </span>
                    <h2 className="mt-2 line-clamp-2 text-base font-semibold leading-snug">
                      {info.title}
                    </h2>
                    <p className="mb-3 text-sm text-muted-foreground">
                      {info.uploader}
                    </p>

                    {info.is_playlist && (
                      <div className="mb-3">
                        <div className="inline-flex flex-wrap gap-1 rounded-md border p-1">
                          {(
                            [
                              ["single", "Apenas este vídeo"],
                              [
                                "all",
                                `Toda a playlist${
                                  info.playlist_count
                                    ? ` (${info.playlist_count})`
                                    : ""
                                }`,
                              ],
                              ["select", "Escolher vídeos"],
                            ] as const
                          ).map(([mode, label]) => (
                            <Button
                              key={mode}
                              size="sm"
                              variant={
                                playlistMode === mode ? "default" : "ghost"
                              }
                              onClick={() => setPlaylistMode(mode)}
                            >
                              {label}
                            </Button>
                          ))}
                        </div>

                        {playlistMode === "select" &&
                          info.entries.length > 0 && (
                            <div className="mt-3 overflow-hidden rounded-lg border">
                              <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                                <span>
                                  {selected.size} selecionado(s) ·{" "}
                                  {formatBytes(selectedBytes)}
                                  {sizesLoading ? " (calculando…)" : ""}
                                </span>
                                <div className="flex gap-1">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 px-2 text-xs"
                                    onClick={() =>
                                      setSelected(
                                        new Set(
                                          info.entries.map((e) => e.index)
                                        )
                                      )
                                    }
                                  >
                                    Todos
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 px-2 text-xs"
                                    onClick={() => setSelected(new Set())}
                                  >
                                    Nenhum
                                  </Button>
                                </div>
                              </div>
                              <ul className="max-h-64 overflow-y-auto p-1">
                                {info.entries.map((entry) => (
                                  <li key={entry.index}>
                                    <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                                      <Checkbox
                                        checked={selected.has(entry.index)}
                                        onCheckedChange={() =>
                                          toggleSelected(entry.index)
                                        }
                                      />
                                      <span className="tabular-nums text-muted-foreground">
                                        {entry.index}.
                                      </span>
                                      <span
                                        className="flex-1 truncate"
                                        title={entry.title}
                                      >
                                        {entry.title}
                                      </span>
                                      {entry.duration != null && (
                                        <span className="tabular-nums text-xs text-muted-foreground">
                                          {formatDuration(entry.duration)}
                                        </span>
                                      )}
                                      <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
                                        {sizes[entry.index] === undefined
                                          ? sizesLoading
                                            ? "…"
                                            : "—"
                                          : typeof sizes[entry.index] ===
                                            "number"
                                          ? formatBytes(
                                              sizes[entry.index] as number
                                            )
                                          : "—"}
                                      </span>
                                    </label>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                      </div>
                    )}

                    {(!info.is_playlist || playlistMode === "single") && (
                      <div className="mb-3">
                        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
                          <Checkbox
                            checked={cutEnabled}
                            onCheckedChange={(v) => setCutEnabled(!!v)}
                          />
                          <Scissors className="size-4" /> Cortar trecho
                        </label>
                        {cutEnabled && (
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                            <span className="text-muted-foreground">de</span>
                            <Input
                              value={cutStart}
                              onChange={(e) =>
                                setCutStart(maskTime(e.target.value))
                              }
                              inputMode="numeric"
                              placeholder="0:00"
                              className="h-8 w-24"
                            />
                            <span className="text-muted-foreground">até</span>
                            <Input
                              value={cutEnd}
                              onChange={(e) =>
                                setCutEnd(maskTime(e.target.value))
                              }
                              inputMode="numeric"
                              placeholder="fim"
                              className="h-8 w-24"
                            />
                            <span className="text-xs text-muted-foreground">
                              formato h:mm:ss ou m:ss
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-muted-foreground">
                        Qualidade
                      </span>
                      <Select value={quality} onValueChange={setQuality}>
                        <SelectTrigger className="min-w-[180px] flex-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {info.qualities.map((q) => (
                            <SelectItem
                              key={q.id}
                              value={q.id}
                              disabled={!q.available}
                            >
                              {q.label}
                              {!q.available ? " (indisponível)" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button onClick={handleDownload}>
                        <Download /> Baixar
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <JobsPanel
            jobs={jobs}
            onPause={handlePause}
            onResume={handleResume}
            onCancel={handleCancel}
            onDismiss={dismissJob}
          />

          {/* Cabeçalho da área (Galeria ou Downloads) + ordenação/busca */}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">
              {view === "galeria" ? (
                <>
                  Galeria{" "}
                  <span className="font-normal text-muted-foreground">
                    ({filteredHistory.length})
                  </span>
                </>
              ) : (
                <>
                  Downloads{" "}
                  <span className="font-normal text-muted-foreground">
                    ({downloadsHistory.length} · {formatBytes(downloadsTotalBytes)})
                  </span>
                </>
              )}
            </h2>
            <div className="flex items-center gap-2">
              <Select
                value={sortBy}
                onValueChange={(v) => setSortBy(v as typeof sortBy)}
              >
                <SelectTrigger size="sm" className="w-[150px]">
                  <span className="text-muted-foreground">Ordenar:</span>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="data">Data</SelectItem>
                  <SelectItem value="nome">Nome</SelectItem>
                  <SelectItem value="tamanho">Tamanho</SelectItem>
                  <SelectItem value="duracao">Duração</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="icon"
                variant="outline"
                className="size-9"
                title={sortDir === "desc" ? "Decrescente" : "Crescente"}
                onClick={() =>
                  setSortDir((d) => (d === "desc" ? "asc" : "desc"))
                }
              >
                {sortDir === "desc" ? <ArrowDown /> : <ArrowUp />}
              </Button>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Buscar…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-9 w-44 pl-8"
                />
              </div>
            </div>
          </div>

          {/* Tira de filtros por rede (sempre visível, sem popup) */}
          <div className="mb-4 flex flex-wrap items-center gap-1.5 rounded-lg border bg-card p-1.5">
            {PLATFORM_FILTERS.map((p) => {
              const activeFilter = platformFilter === p;
              return (
                <Button
                  key={p}
                  size="sm"
                  variant={activeFilter ? "default" : "ghost"}
                  onClick={() => setPlatformFilter(p)}
                >
                  {p}
                  <Badge
                    variant={activeFilter ? "secondary" : "outline"}
                    className="ml-1 px-1.5 tabular-nums"
                  >
                    {countFor(p)}
                  </Badge>
                </Button>
              );
            })}
          </div>

          {/* SEÇÃO: Galeria (grade visual) */}
          {view === "galeria" && (
            <section>
              {history.length === 0 ? (
                <EmptyState
                  icon="🎞️"
                  title="Sua galeria está vazia."
                  hint="Cole um link acima para baixar seu primeiro conteúdo."
                />
              ) : filteredHistory.length === 0 ? (
                <EmptyState title={`Nenhum vídeo para “${platformFilter}”.`} />
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
                  {filteredHistory.map((item) => (
                    <GalleryCard
                      key={item.id}
                      item={item}
                      onRemoved={(id) =>
                        setHistory((prev) => prev.filter((i) => i.id !== id))
                      }
                      onToggleFavorite={handleToggleFavorite}
                      onExport={handleExport}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* SEÇÃO: Downloads (abas Baixados / Cancelados) */}
          {view === "downloads" && (
            <section>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex gap-1 rounded-lg border bg-card p-1">
                  {(
                    [
                      ["baixados", "Baixados", downloadsHistory.length],
                      ["cancelados", "Cancelados", cancelled.length],
                    ] as const
                  ).map(([tab, label, count]) => (
                    <Button
                      key={tab}
                      size="sm"
                      variant={downloadsTab === tab ? "default" : "ghost"}
                      onClick={() => setDownloadsTab(tab)}
                    >
                      {label}
                      <Badge
                        variant={
                          downloadsTab === tab ? "secondary" : "outline"
                        }
                        className="ml-1 px-1.5 tabular-nums"
                      >
                        {count}
                      </Badge>
                    </Button>
                  ))}
                </div>
                {downloadsTab === "cancelados" && cancelled.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleClearCancelled}
                    title="Limpar cancelados"
                  >
                    <Trash2 /> Limpar
                  </Button>
                )}
              </div>

              {downloadsTab === "baixados" ? (
                downloadsHistory.length === 0 ? (
                  <EmptyState icon="📥" title="Nenhum download ainda." />
                ) : filteredDownloads.length === 0 ? (
                  <EmptyState
                    title={`Nenhum baixado para “${platformFilter}”.`}
                  />
                ) : (
                  <div className="flex flex-col gap-2">
                    {filteredDownloads.map((item) => (
                      <Card
                        key={item.id}
                        className="flex-row items-center gap-3 px-4 py-3"
                      >
                        <PlatformLogo platform={item.platform} size={22} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm" title={item.title}>
                            {item.title}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatBytes(item.filesize)} ·{" "}
                            {formatDate(item.date)}
                          </p>
                        </div>
                        {item.url && (
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Abrir na web"
                            onClick={() => openUrl(item.url).catch(() => {})}
                          >
                            <Globe />
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => openFile(item.filepath).catch(() => {})}
                        >
                          Abrir
                        </Button>
                      </Card>
                    ))}
                  </div>
                )
              ) : cancelled.length === 0 ? (
                <EmptyState
                  icon="🚫"
                  title="Nenhum download cancelado."
                  hint="Cancelamentos aparecem aqui com o ponto em que pararam."
                />
              ) : filteredCancelled.length === 0 ? (
                <EmptyState
                  title={`Nenhum cancelado para “${platformFilter}”.`}
                />
              ) : (
                <div className="flex flex-col gap-2">
                  {filteredCancelled.map((item) => (
                    <Card
                      key={item.id}
                      className="flex-row items-center gap-3 px-4 py-3"
                    >
                      <PlatformLogo platform={item.platform} size={22} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm" title={item.title}>
                          {item.title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Cancelado em {item.moment}
                          {item.isPlaylist
                            ? ` · ${item.completed} arquivo(s) salvos`
                            : ""}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatDate(item.date)}
                      </span>
                    </Card>
                  ))}
                </div>
              )}
            </section>
          )}

          <footer className="mt-10 border-t pt-5 text-center text-xs leading-relaxed text-muted-foreground">
            Baixe apenas conteúdo próprio ou com autorização. Respeite os
            direitos autorais e os termos de uso de cada plataforma.
          </footer>
        </div>
      </main>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  hint,
}: {
  icon?: string;
  title: string;
  hint?: string;
}) {
  return (
    <div className="grid place-items-center rounded-lg border border-dashed py-16 text-center">
      {icon && <span className="mb-3 text-5xl">{icon}</span>}
      <p className="text-muted-foreground">{title}</p>
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default App;
