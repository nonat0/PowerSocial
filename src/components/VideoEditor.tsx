import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Crop,
  FlipHorizontal2,
  FlipVertical2,
  Gauge,
  Image as ImageIcon,
  Keyboard,
  Maximize2,
  Music,
  Redo2,
  Repeat,
  RotateCw,
  Scissors,
  Sparkles,
  Undo2,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import type { HistoryItem } from "../types";
import {
  captureFrame,
  generateThumbnails,
  probeMedia,
  revealInFolder,
  type EditSpec,
  type MediaInfo,
  type Thumb,
} from "../api";
import { Button } from "./ui/button";

interface Props {
  item: HistoryItem;
  onClose: () => void;
  onExport: (spec: EditSpec) => void;
}

type Tool = "trim" | "crop" | "transform" | "speed" | "volume" | "export";
type Frac = { x: number; y: number; w: number; h: number };

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];

function tc(t: number, fps: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const f = fps > 0 ? Math.floor((t - Math.floor(t)) * fps) : Math.floor((t % 1) * 100);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
}

export function VideoEditor({ item, onClose, onExport }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);
  const [viewW, setViewW] = useState(0);

  const [media, setMedia] = useState<MediaInfo>({
    duration: 0,
    fps: 0,
    width: 0,
    height: 0,
  });
  const duration = media.duration;
  const fps = media.fps || 30;

  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [current, setCurrent] = useState(0);
  const [loop, setLoop] = useState(false);

  const [pxPerSec, setPxPerSec] = useState(40);
  const [thumbs, setThumbs] = useState<Thumb[]>([]);

  const [tool, setTool] = useState<Tool>("trim");
  const [crop, setCrop] = useState<Frac>({ x: 0, y: 0, w: 1, h: 1 });
  const [rotate, setRotate] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(1);
  const [mute, setMute] = useState(false);
  const [fadeIn, setFadeIn] = useState(0);
  const [fadeOut, setFadeOut] = useState(0);
  const [format, setFormat] = useState("mp4");
  const [lossless, setLossless] = useState(true);

  const [drag, setDrag] = useState<null | "start" | "end" | "seek">(null);
  const [cropDrag, setCropDrag] = useState<null | "move" | "se">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [canPlay, setCanPlay] = useState(true);
  const [showHelp, setShowHelp] = useState(false);

  // ---- undo / redo (snapshots dos parâmetros de edição) ----
  const params = {
    start, end, crop, rotate, flipH, flipV, speed, volume, mute, fadeIn,
    fadeOut, format, lossless,
  };
  const key = JSON.stringify(params);
  const committed = useRef(key);
  const undoStack = useRef<string[]>([]);
  const redoStack = useRef<string[]>([]);
  const restoring = useRef(false);
  const [, tick] = useState(0);

  useEffect(() => {
    if (restoring.current) {
      restoring.current = false;
      committed.current = key;
      return;
    }
    const tmr = setTimeout(() => {
      if (key !== committed.current) {
        undoStack.current.push(committed.current);
        committed.current = key;
        redoStack.current = [];
        tick((t) => t + 1);
      }
    }, 450);
    return () => clearTimeout(tmr);
  }, [key]);

  function restore(snap: string) {
    const p = JSON.parse(snap);
    restoring.current = true;
    setStart(p.start);
    setEnd(p.end);
    setCrop(p.crop);
    setRotate(p.rotate);
    setFlipH(p.flipH);
    setFlipV(p.flipV);
    setSpeed(p.speed);
    setVolume(p.volume);
    setMute(p.mute);
    setFadeIn(p.fadeIn);
    setFadeOut(p.fadeOut);
    setFormat(p.format);
    setLossless(p.lossless);
  }
  function undo() {
    if (!undoStack.current.length) return;
    redoStack.current.push(committed.current);
    const prev = undoStack.current.pop()!;
    committed.current = prev;
    restore(prev);
    tick((t) => t + 1);
  }
  function redo() {
    if (!redoStack.current.length) return;
    undoStack.current.push(committed.current);
    const next = redoStack.current.pop()!;
    committed.current = next;
    restore(next);
    tick((t) => t + 1);
  }

  const src = convertFileSrc(item.filepath);
  const contentW = Math.max(duration * pxPerSec, 1);
  const xOf = (t: number) => t * pxPerSec;

  // px/seg que faz a faixa inteira caber na largura visível (zoom mínimo).
  const fitPx = duration > 0 && viewW > 0 ? viewW / duration : pxPerSec;
  const minPx = Math.max(0.2, fitPx);
  const zoomIn = () =>
    setPxPerSec((p) => Math.min(400, Math.max(p, minPx) * 1.4));
  const zoomOut = () => setPxPerSec((p) => Math.max(minPx, p / 1.4));
  const fitZoom = () => setPxPerSec(Math.min(Math.max(fitPx, 0.2), 400));

  // Mede a largura da faixa e ajusta o zoom inicial para caber tudo.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [canPlay, duration]);

  useEffect(() => {
    if (!fitted.current && duration > 0 && viewW > 0) {
      fitted.current = true;
      setPxPerSec(Math.min(Math.max(viewW / duration, 0.2), 400));
    }
  }, [duration, viewW]);

  // ---- metadados + miniaturas ----
  function onLoaded() {
    const v = videoRef.current;
    const d = v?.duration || 0;
    setMedia((m) => ({ ...m, duration: d }));
    setStart(0);
    setEnd(d);
    probeMedia(item.filepath)
      .then((mi) => setMedia(mi.duration > 0 ? mi : { ...mi, duration: d }))
      .catch(() => {});
  }

  useEffect(() => {
    if (duration <= 0) return;
    const count = Math.min(40, Math.max(8, Math.round(contentW / 110)));
    let active = true;
    generateThumbnails(item.filepath, duration, count)
      .then((t) => active && setThumbs(t))
      .catch(() => {});
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, pxPerSec]);

  // ---- preview ao vivo (CSS) ----
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.playbackRate = speed;
  }, [speed]);
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.volume = mute ? 0 : volume;
  }, [volume, mute]);

  // ---- timeline: arrasto das alças / playhead ----
  function timeFromX(clientX: number): number {
    const el = trackRef.current;
    if (!el || !duration) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(duration, Math.max(0, (clientX - r.left) / pxPerSec));
  }
  function snap(t: number, ignore: "start" | "end" | null): number {
    const cands = [0, duration, current];
    if (ignore !== "start") cands.push(start);
    if (ignore !== "end") cands.push(end);
    const thr = 8 / pxPerSec;
    for (const c of cands) if (Math.abs(t - c) < thr) return c;
    return t;
  }

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const raw = timeFromX(e.clientX);
      if (drag === "start") {
        const v = Math.min(snap(raw, "start"), end - 0.05);
        setStart(v);
        if (videoRef.current) videoRef.current.currentTime = v;
      } else if (drag === "end") {
        const v = Math.max(snap(raw, "end"), start + 0.05);
        setEnd(v);
        if (videoRef.current) videoRef.current.currentTime = v;
      } else if (drag === "seek" && videoRef.current) {
        videoRef.current.currentTime = raw;
      }
    };
    const up = () => setDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, duration, start, end, current, pxPerSec]);

  // ---- crop: mover / redimensionar ----
  useEffect(() => {
    if (!cropDrag) return;
    const move = (e: PointerEvent) => {
      const box = previewRef.current?.getBoundingClientRect();
      if (!box) return;
      const fx = (e.movementX || 0) / box.width;
      const fy = (e.movementY || 0) / box.height;
      setCrop((c) => {
        if (cropDrag === "move") {
          const x = Math.min(Math.max(0, c.x + fx), 1 - c.w);
          const y = Math.min(Math.max(0, c.y + fy), 1 - c.h);
          return { ...c, x, y };
        } else {
          const w = Math.min(Math.max(0.05, c.w + fx), 1 - c.x);
          const h = Math.min(Math.max(0.05, c.h + fy), 1 - c.y);
          return { ...c, w, h };
        }
      });
    };
    const up = () => setCropDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [cropDrag]);

  function setCropAspect(aw: number, ah: number) {
    if (!media.width || !media.height) {
      setCrop({ x: 0, y: 0, w: 1, h: 1 });
      return;
    }
    const A = media.width / media.height;
    const T = aw / ah;
    let w = 1;
    let h = 1;
    if (T / A <= 1) {
      h = 1;
      w = T / A;
    } else {
      w = 1;
      h = A / T;
    }
    setCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
  }

  // ---- loop do trecho ----
  function onTime(e: React.SyntheticEvent<HTMLVideoElement>) {
    const t = e.currentTarget.currentTime;
    setCurrent(t);
    if (loop && t >= end - 0.03 && videoRef.current) {
      videoRef.current.currentTime = start;
    }
  }

  // ---- atalhos ----
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const v = videoRef.current;
      const cur = v?.currentTime ?? current;
      const step = 1 / fps;
      const k = e.key;
      if (e.ctrlKey && (k === "z" || k === "Z") && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (e.ctrlKey && (k === "y" || k === "Y" || k === "Z")) {
        e.preventDefault();
        redo();
        return;
      }
      if (e.ctrlKey && (k === "+" || k === "=")) {
        e.preventDefault();
        zoomIn();
        return;
      }
      if (e.ctrlKey && (k === "-" || k === "_")) {
        e.preventDefault();
        zoomOut();
        return;
      }
      if (k === " ") {
        e.preventDefault();
        if (v) v.paused ? v.play() : v.pause();
      } else if (k === "i" || k === "I" || k === "[") {
        setStart(Math.min(cur, end - 0.05));
      } else if (k === "o" || k === "O" || k === "]") {
        setEnd(Math.max(cur, start + 0.05));
      } else if (k === "," || k === "ArrowLeft") {
        e.preventDefault();
        if (v) v.currentTime = Math.max(0, cur - (e.shiftKey ? 1 : step));
      } else if (k === "." || k === "ArrowRight") {
        e.preventDefault();
        if (v) v.currentTime = Math.min(duration, cur + (e.shiftKey ? 1 : step));
      } else if (k === "j" || k === "J") {
        if (v) v.currentTime = Math.max(0, cur - 1);
      } else if (k === "k" || k === "K") {
        if (v) v.pause();
      } else if (k === "l" || k === "L") {
        if (v) v.play();
      } else if (k === "Home") {
        if (v) v.currentTime = start;
      } else if (k === "End") {
        if (v) v.currentTime = end;
      } else if (k === "+" || k === "=") {
        zoomIn();
      } else if (k === "-" || k === "_") {
        zoomOut();
      } else if (k === "?") {
        setShowHelp((s) => !s);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, start, end, duration, fps, viewW]);

  // ---- exportar (em background, vira job no painel "Em andamento") ----
  function buildSpec(fmt: string): EditSpec {
    const id = crypto.randomUUID();
    const cropped =
      crop.w < 0.999 || crop.h < 0.999 || crop.x > 0.001 || crop.y > 0.001;
    let cropPx: EditSpec["crop"];
    if (cropped && media.width && media.height) {
      const even = (n: number) => Math.max(2, Math.round(n) - (Math.round(n) % 2));
      cropPx = {
        x: Math.round(crop.x * media.width),
        y: Math.round(crop.y * media.height),
        w: even(crop.w * media.width),
        h: even(crop.h * media.height),
      };
    }
    return {
      id,
      input: item.filepath,
      start: start > 0.01 ? start : undefined,
      end: end < duration - 0.01 ? end : undefined,
      crop: cropPx,
      rotate: rotate || undefined,
      flip_h: flipH || undefined,
      flip_v: flipV || undefined,
      speed: speed !== 1 ? speed : undefined,
      volume: volume !== 1 ? volume : undefined,
      mute: mute || undefined,
      fade_in: fadeIn || undefined,
      fade_out: fadeOut || undefined,
      format: fmt,
      lossless: lossless || undefined,
    };
  }

  // Dispara a edição em background (vira job no painel) e fecha o editor.
  function runExport(fmt: string) {
    onExport(buildSpec(fmt));
    onClose();
  }

  async function handleCaptureFrame() {
    setError(null);
    setNotice(null);
    try {
      const t = videoRef.current?.currentTime ?? current;
      const p = await captureFrame(item.filepath, t, "png");
      const name = p.split(/[\\/]/).pop();
      setNotice(`Quadro salvo: ${name}`);
      await revealInFolder(p).catch(() => {});
    } catch (e) {
      setError(String(e));
    }
  }

  const aspect = media.width && media.height ? media.width / media.height : 16 / 9;
  const tickStep =
    TICK_STEPS.find((s) => s * pxPerSec >= 70) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 0.001; t += tickStep) ticks.push(t);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[94vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <h2 className="flex items-center gap-2 truncate text-sm font-semibold">
            <Sparkles className="size-4" /> Editor — {item.title}
          </h2>
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              onClick={undo}
              disabled={undoStack.current.length === 0}
              title="Desfazer (Ctrl+Z)"
            >
              <Undo2 />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={redo}
              disabled={redoStack.current.length === 0}
              title="Refazer (Ctrl+Y)"
            >
              <Redo2 />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => setShowHelp((s) => !s)} title="Atalhos (?)">
              <Keyboard />
            </Button>
            <Button size="icon" variant="ghost" onClick={onClose} aria-label="Fechar">
              <X />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {/* preview */}
          <div
            ref={previewRef}
            className="relative mx-auto overflow-hidden rounded-lg bg-black"
            style={{ aspectRatio: String(aspect), maxHeight: "46vh" }}
          >
            {canPlay ? (
              <video
                ref={videoRef}
                src={src}
                controls
                className="size-full object-contain"
                style={{
                  transform: `rotate(${rotate}deg) scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1})`,
                }}
                onLoadedMetadata={onLoaded}
                onTimeUpdate={onTime}
                onError={() => setCanPlay(false)}
              />
            ) : (
              <div className="grid size-full place-items-center p-6 text-center text-sm text-muted-foreground">
                Não foi possível pré-visualizar este arquivo.
              </div>
            )}

            {/* overlay de crop */}
            {tool === "crop" && canPlay && (
              <>
                <div className="pointer-events-none absolute inset-0 bg-black/50" />
                <div
                  className="absolute cursor-move border-2 border-primary"
                  style={{
                    left: `${crop.x * 100}%`,
                    top: `${crop.y * 100}%`,
                    width: `${crop.w * 100}%`,
                    height: `${crop.h * 100}%`,
                    boxShadow: "0 0 0 9999px rgba(0,0,0,0.0)",
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setCropDrag("move");
                  }}
                >
                  <div className="absolute inset-0 bg-primary/10" />
                  <div
                    className="absolute -bottom-1.5 -right-1.5 size-3.5 cursor-se-resize rounded-sm border border-black/40 bg-white"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setCropDrag("se");
                    }}
                  />
                </div>
              </>
            )}
          </div>

          {/* timecode + zoom */}
          <div className="mt-3 flex items-center justify-between gap-2 text-xs tabular-nums text-muted-foreground">
            <span>
              in <span className="text-foreground">{tc(start, fps)}</span>
            </span>
            <span className="font-medium text-foreground">{tc(current, fps)}</span>
            <span>
              out <span className="text-foreground">{tc(end, fps)}</span> · dur{" "}
              {tc(Math.max(0, end - start), fps)}
            </span>
            <span className="ml-auto flex items-center gap-1">
              <Button size="icon" variant="ghost" className="size-7" onClick={zoomOut} title="Zoom − (Ctrl -)">
                <ZoomOut />
              </Button>
              <Button size="icon" variant="ghost" className="size-7" onClick={zoomIn} title="Zoom + (Ctrl +)">
                <ZoomIn />
              </Button>
              <Button size="sm" variant="ghost" className="h-7" onClick={fitZoom} title="Caber na tela">
                <Maximize2 /> Ajustar
              </Button>
              <Button
                size="sm"
                variant={loop ? "default" : "outline"}
                className="h-7"
                onClick={() => setLoop((l) => !l)}
                title="Repetir o trecho"
              >
                <Repeat /> Loop
              </Button>
            </span>
          </div>

          {/* TIMELINE */}
          {canPlay && duration > 0 && (
            <div
              ref={scrollRef}
              className="mt-1 overflow-x-auto rounded-md border bg-secondary/40"
            >
              <div style={{ width: contentW, minWidth: "100%" }}>
                {/* régua */}
                <div className="relative h-5 border-b border-border/60 text-[10px] text-muted-foreground">
                  {ticks.map((t) => (
                    <div
                      key={t}
                      className="absolute top-0 h-full border-l border-border/60 pl-1"
                      style={{ left: xOf(t) }}
                    >
                      {tc(t, 0).slice(0, 8)}
                    </div>
                  ))}
                </div>
                {/* faixa com miniaturas + alças */}
                <div
                  ref={trackRef}
                  onPointerDown={(e) => {
                    setDrag("seek");
                    if (videoRef.current)
                      videoRef.current.currentTime = timeFromX(e.clientX);
                  }}
                  className="relative h-16 cursor-pointer touch-none select-none"
                >
                  <div className="pointer-events-none absolute inset-0 flex">
                    {thumbs.map((th, i) => (
                      <img
                        key={i}
                        src={th.data}
                        alt=""
                        draggable={false}
                        className="h-full min-w-0 flex-1 object-cover opacity-90"
                      />
                    ))}
                  </div>
                  {/* fora da seleção */}
                  <div
                    className="absolute inset-y-0 left-0 bg-black/55"
                    style={{ width: xOf(start) }}
                  />
                  <div
                    className="absolute inset-y-0 right-0 bg-black/55"
                    style={{ width: contentW - xOf(end) }}
                  />
                  <div
                    className="absolute inset-y-0 border-x-2 border-primary"
                    style={{ left: xOf(start), width: xOf(end) - xOf(start) }}
                  />
                  {/* alças */}
                  <div
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setDrag("start");
                      if (videoRef.current) videoRef.current.currentTime = start;
                    }}
                    className="absolute inset-y-0 z-10 -ml-1 w-2 cursor-ew-resize rounded-sm bg-white shadow ring-1 ring-black/40"
                    style={{ left: xOf(start) }}
                    title="Início (I)"
                  />
                  <div
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setDrag("end");
                      if (videoRef.current) videoRef.current.currentTime = end;
                    }}
                    className="absolute inset-y-0 z-10 -ml-1 w-2 cursor-ew-resize rounded-sm bg-white shadow ring-1 ring-black/40"
                    style={{ left: xOf(end) }}
                    title="Fim (O)"
                  />
                  {/* playhead */}
                  <div
                    className="pointer-events-none absolute inset-y-0 z-20 w-px bg-yellow-400"
                    style={{ left: xOf(current) }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* FERRAMENTAS */}
          <div className="mt-4 flex flex-wrap gap-1 rounded-lg border bg-card p-1">
            {(
              [
                ["trim", "Cortar", Scissors],
                ["crop", "Recortar", Crop],
                ["transform", "Girar", RotateCw],
                ["speed", "Velocidade", Gauge],
                ["volume", "Áudio", Volume2],
                ["export", "Exportar", Sparkles],
              ] as const
            ).map(([t, label, Icon]) => (
              <Button
                key={t}
                size="sm"
                variant={tool === t ? "default" : "ghost"}
                onClick={() => setTool(t)}
              >
                <Icon /> {label}
              </Button>
            ))}
          </div>

          <div className="mt-3 rounded-lg border p-4 text-sm">
            {tool === "trim" && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">
                    Arraste as alças ou use <kbd>I</kbd>/<kbd>O</kbd>.
                  </span>
                  <Button size="sm" variant="outline" onClick={() => setStart(current)}>
                    Início = aqui
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEnd(current)}>
                    Fim = aqui
                  </Button>
                </div>
                <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={lossless}
                    onChange={(e) => setLossless(e.target.checked)}
                    className="size-4 accent-primary"
                  />
                  Corte rápido (sem perda)
                  <span className="text-xs text-muted-foreground">
                    — instantâneo quando só há corte; alinha no keyframe mais próximo.
                  </span>
                </label>
              </div>
            )}

            {tool === "crop" && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">Proporção:</span>
                {(
                  [
                    ["Livre", 0, 0],
                    ["9:16", 9, 16],
                    ["1:1", 1, 1],
                    ["4:5", 4, 5],
                    ["16:9", 16, 9],
                  ] as const
                ).map(([label, aw, ah]) => (
                  <Button
                    key={label}
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      aw === 0
                        ? setCrop({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 })
                        : setCropAspect(aw, ah)
                    }
                  >
                    {label}
                  </Button>
                ))}
                <Button size="sm" variant="ghost" onClick={() => setCrop({ x: 0, y: 0, w: 1, h: 1 })}>
                  Limpar
                </Button>
              </div>
            )}

            {tool === "transform" && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => setRotate((r) => (r + 90) % 360)}>
                  <RotateCw /> Girar 90° ({rotate}°)
                </Button>
                <Button size="sm" variant={flipH ? "default" : "outline"} onClick={() => setFlipH((f) => !f)}>
                  <FlipHorizontal2 /> Espelhar H
                </Button>
                <Button size="sm" variant={flipV ? "default" : "outline"} onClick={() => setFlipV((f) => !f)}>
                  <FlipVertical2 /> Espelhar V
                </Button>
              </div>
            )}

            {tool === "speed" && (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-muted-foreground">Velocidade</span>
                <input
                  type="range"
                  min={0.25}
                  max={4}
                  step={0.05}
                  value={speed}
                  onChange={(e) => setSpeed(parseFloat(e.target.value))}
                  className="w-56 accent-primary"
                />
                <span className="w-12 tabular-nums font-medium">{speed.toFixed(2)}x</span>
                {[0.5, 1, 1.5, 2].map((s) => (
                  <Button key={s} size="sm" variant="outline" onClick={() => setSpeed(s)}>
                    {s}x
                  </Button>
                ))}
              </div>
            )}

            {tool === "volume" && (
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" variant={mute ? "default" : "outline"} onClick={() => setMute((m) => !m)}>
                  {mute ? <VolumeX /> : <Volume2 />} {mute ? "Mudo" : "Som"}
                </Button>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={volume}
                  disabled={mute}
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  className="w-48 accent-primary disabled:opacity-40"
                />
                <span className="w-12 tabular-nums">{Math.round(volume * 100)}%</span>
                <span className="ml-2 text-muted-foreground">Fade in</span>
                <input type="number" min={0} step={0.5} value={fadeIn} onChange={(e) => setFadeIn(Math.max(0, +e.target.value))} className="h-8 w-16 rounded-md border bg-transparent px-2" />
                <span className="text-muted-foreground">out</span>
                <input type="number" min={0} step={0.5} value={fadeOut} onChange={(e) => setFadeOut(Math.max(0, +e.target.value))} className="h-8 w-16 rounded-md border bg-transparent px-2" />
              </div>
            )}

            {tool === "export" && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">Formato:</span>
                {(["mp4", "gif"] as const).map((f) => (
                  <Button key={f} size="sm" variant={format === f ? "default" : "outline"} onClick={() => setFormat(f)}>
                    {f.toUpperCase()}
                  </Button>
                ))}
                <div className="mx-2 h-5 w-px bg-border" />
                <Button size="sm" variant="outline" onClick={() => runExport("mp3")}>
                  <Music /> Extrair áudio (MP3)
                </Button>
                <Button size="sm" variant="outline" onClick={handleCaptureFrame}>
                  <ImageIcon /> Capturar quadro
                </Button>
              </div>
            )}
          </div>

          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          {notice && (
            <p className="mt-3 text-sm text-emerald-500">✓ {notice}</p>
          )}
        </div>

        {/* rodapé / exportar */}
        <div className="flex items-center gap-3 border-t px-4 py-3">
          <span className="text-xs text-muted-foreground">
            Não-destrutivo · render em segundo plano (acompanhe em “Em andamento”).
          </span>
          <Button variant="ghost" className="ml-auto" onClick={onClose}>
            Fechar
          </Button>
          <Button onClick={() => runExport(format)}>
            <Sparkles /> Exportar {format.toUpperCase()}
          </Button>
        </div>
      </div>

      {showHelp && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
          onClick={() => setShowHelp(false)}
        >
          <div
            className="w-full max-w-sm rounded-xl border bg-card p-5 text-sm shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 font-semibold">Atalhos</h3>
            <ul className="space-y-1.5 text-muted-foreground">
              <li><kbd>espaço</kbd> play/pause</li>
              <li><kbd>I</kbd> / <kbd>O</kbd> marcar início / fim</li>
              <li><kbd>,</kbd> <kbd>.</kbd> ou <kbd>←</kbd> <kbd>→</kbd> — quadro a quadro (Shift = 1s)</li>
              <li><kbd>J</kbd> <kbd>K</kbd> <kbd>L</kbd> — voltar / pausar / tocar</li>
              <li><kbd>Home</kbd> / <kbd>End</kbd> — ir ao início / fim do trecho</li>
              <li><kbd>+</kbd> / <kbd>-</kbd> — zoom da timeline</li>
              <li><kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> — desfazer / refazer</li>
              <li><kbd>?</kbd> — esta ajuda</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
