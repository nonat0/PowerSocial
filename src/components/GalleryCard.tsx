import { useEffect, useState } from "react";
import {
  FolderOpen,
  Globe,
  MoreVertical,
  Pencil,
  Play,
  Star,
  Trash2,
  X,
} from "lucide-react";

import type { HistoryItem } from "../types";
import {
  openFile,
  openUrl,
  readImageBase64,
  removeHistoryItem,
  revealInFolder,
  setFavorite,
  type EditSpec,
} from "../api";
import { formatBytes, formatDate, formatDuration } from "../utils";
import { cn } from "../lib/utils";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { PlatformLogo } from "./PlatformLogo";
import { VideoEditor } from "./VideoEditor";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

interface Props {
  item: HistoryItem;
  onRemoved: (id: string) => void;
  onToggleFavorite: (id: string, favorite: boolean) => void;
  onExport: (spec: EditSpec, source: HistoryItem) => void;
}

export function GalleryCard({
  item,
  onRemoved,
  onToggleFavorite,
  onExport,
}: Props) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    let active = true;
    if (item.thumbnail) {
      readImageBase64(item.thumbnail)
        .then((data) => active && setThumb(data))
        .catch(() => active && setThumb(null));
    }
    return () => {
      active = false;
    };
  }, [item.thumbnail]);

  async function handleOpen() {
    try {
      setOpenError(null);
      await openFile(item.filepath);
    } catch (e) {
      const msg = String(e);
      setMissing(/não encontrado|not found/i.test(msg));
      setOpenError(msg);
    }
  }

  async function handleReveal() {
    try {
      setOpenError(null);
      await revealInFolder(item.filepath);
    } catch (e) {
      const msg = String(e);
      setMissing(/não encontrado|not found/i.test(msg));
      setOpenError(msg);
    }
  }

  async function handleRemove(deleteFile: boolean) {
    await removeHistoryItem(item.id, deleteFile);
    onRemoved(item.id);
  }

  function handleFavorite(e: React.MouseEvent) {
    e.stopPropagation();
    const next = !item.favorite;
    onToggleFavorite(item.id, next);
    setFavorite(item.id, next).catch(() => {});
  }

  const isAudio = item.quality === "audio";
  const qualityLabel = isAudio
    ? "MP3"
    : item.quality === "best"
    ? "Máx"
    : `${item.quality}p`;

  return (
    <Card
      className={cn(
        "gap-0 overflow-hidden py-0 transition-colors hover:border-ring",
        missing && "opacity-60"
      )}
    >
      <div
        className="group relative aspect-video cursor-pointer overflow-hidden bg-secondary"
        onClick={handleOpen}
        title="Abrir arquivo"
      >
        {thumb ? (
          <img
            src={thumb}
            alt={item.title}
            className="size-full object-cover"
          />
        ) : (
          <div className="grid size-full place-items-center text-4xl">
            {isAudio ? "🎵" : "🎬"}
          </div>
        )}
        <span className="absolute left-2 top-2 grid place-items-center rounded-md bg-black/55 p-1 backdrop-blur-sm">
          <PlatformLogo platform={item.platform} size={18} />
        </span>
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/35 opacity-0 transition-opacity group-hover:opacity-100">
          <Play className="size-9 fill-white text-white" />
        </div>
        <button
          onClick={handleFavorite}
          title={item.favorite ? "Remover dos favoritos" : "Favoritar"}
          aria-label="Favoritar"
          className="absolute right-2 top-2 z-10 grid place-items-center rounded-md bg-black/55 p-1.5 backdrop-blur-sm transition-colors hover:bg-black/75"
        >
          <Star
            className={
              "size-4 " +
              (item.favorite
                ? "fill-yellow-400 text-yellow-400"
                : "text-white")
            }
          />
        </button>
      </div>

      <div className="p-3.5">
        <p className="line-clamp-2 text-sm font-medium leading-snug" title={item.title}>
          {item.title}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{qualityLabel}</span>
          {item.duration ? (
            <>
              <span>•</span>
              <span>{formatDuration(item.duration)}</span>
            </>
          ) : null}
          <span>•</span>
          <span>{formatBytes(item.filesize)}</span>
          <span>•</span>
          <span>{formatDate(item.date)}</span>
        </div>

        {missing ? (
          <p className="mt-2 text-xs text-destructive">
            Arquivo não encontrado no disco
          </p>
        ) : (
          openError && (
            <p className="mt-2 text-xs text-destructive">{openError}</p>
          )
        )}

        <div className="mt-3 flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="flex-1"
            onClick={handleOpen}
          >
            <Play /> Abrir
          </Button>
          {!isAudio && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditorOpen(true)}
            >
              <Pencil /> Editar
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="outline" aria-label="Mais ações">
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {item.url && (
                <DropdownMenuItem onClick={() => openUrl(item.url).catch(() => {})}>
                  <Globe /> Abrir na web
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={handleReveal}>
                <FolderOpen /> Mostrar na pasta
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => handleRemove(false)}>
                <X /> Remover da galeria
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => handleRemove(true)}
              >
                <Trash2 /> Excluir do disco
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {editorOpen && (
        <VideoEditor
          item={item}
          onClose={() => setEditorOpen(false)}
          onExport={(spec) => onExport(spec, item)}
        />
      )}
    </Card>
  );
}
