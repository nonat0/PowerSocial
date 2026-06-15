import { CheckCircle2, Pause, Play, X } from "lucide-react";

import type { Job } from "../types";
import { formatBytes, formatEta, formatSpeed } from "../utils";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { PlatformLogo } from "./PlatformLogo";

interface Props {
  jobs: Job[];
  onPause: (id: string) => void;
  onResume: (job: Job) => void;
  onCancel: (job: Job) => void;
  onDismiss: (id: string) => void;
}

const STATUS: Record<
  Job["status"],
  { label: string; variant: "secondary" | "success" | "destructive" | "outline" }
> = {
  queued: { label: "Na fila", variant: "outline" },
  downloading: { label: "Baixando", variant: "secondary" },
  paused: { label: "Pausado", variant: "outline" },
  done: { label: "Concluído", variant: "success" },
  error: { label: "Erro", variant: "destructive" },
  cancelled: { label: "Cancelado", variant: "outline" },
};

export function JobsPanel({
  jobs,
  onPause,
  onResume,
  onCancel,
  onDismiss,
}: Props) {
  if (jobs.length === 0) return null;

  return (
    <section className="mb-7">
      <h2 className="mb-3 text-base font-semibold">
        Em andamento ({jobs.length})
      </h2>
      <div className="flex flex-col gap-2.5">
        {jobs.map((job) => {
          const status = STATUS[job.status];
          const isRender = job.kind === "render";
          const statusLabel =
            isRender && job.status === "downloading"
              ? "Processando"
              : status.label;
          const showBar =
            job.status === "downloading" || job.status === "paused";
          // Barra = % do arquivo/vídeo atual (reinicia a cada vídeo, via onStats).
          const overall = job.percent;
          // Enquanto o % do vídeo atual ainda não chegou, mostra indeterminada.
          const indeterminate = job.status === "downloading" && job.percent <= 0;
          const finished =
            job.status === "done" ||
            job.status === "error" ||
            job.status === "cancelled";
          return (
            <Card
              key={job.id}
              className="flex-row items-center gap-3 px-4 py-3"
            >
              <PlatformLogo platform={job.platform} size={22} />

              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm" title={job.title}>
                    {job.title}
                  </span>
                  <Badge variant={status.variant} className="shrink-0">
                    {job.status === "done" && <CheckCircle2 />}
                    {statusLabel}
                  </Badge>
                </div>

                {showBar && (
                  <>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                      {indeterminate ? (
                        <div className="h-full w-2/5 animate-pulse rounded-full bg-primary/60" />
                      ) : (
                        <div
                          className={
                            "h-full rounded-full transition-[width] duration-200 " +
                            (job.status === "paused"
                              ? "bg-muted-foreground"
                              : "bg-primary")
                          }
                          style={{ width: `${overall}%` }}
                        />
                      )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-3 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {indeterminate
                          ? isRender
                            ? "Processando…"
                            : "Baixando…"
                          : `${overall.toFixed(0)}%`}
                      </span>
                      {job.isPlaylist && job.total ? (
                        <span>
                          vídeo {Math.min(job.completed + 1, job.total)}/
                          {job.total}
                        </span>
                      ) : null}
                      {job.status === "downloading" && job.downloaded ? (
                        <span>{formatBytes(job.downloaded)}</span>
                      ) : null}
                      {job.status === "downloading" && job.speed ? (
                        <span>{formatSpeed(job.speed)}</span>
                      ) : null}
                      {job.status === "downloading" && job.eta ? (
                        <span>resta {formatEta(job.eta)}</span>
                      ) : null}
                    </div>
                  </>
                )}

                {job.status === "queued" && (
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[repeating-linear-gradient(45deg,var(--secondary),var(--secondary)_8px,var(--border)_8px,var(--border)_16px)]" />
                )}

                {job.status === "error" && (
                  <p className="mt-1.5 text-xs text-destructive">
                    {job.message}
                  </p>
                )}

                {(job.status === "done" || job.status === "cancelled") &&
                  job.isPlaylist && (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {job.completed} arquivo(s)
                    </p>
                  )}
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {job.status === "downloading" && !isRender && (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => onPause(job.id)}
                    title="Pausar"
                  >
                    <Pause />
                  </Button>
                )}
                {job.status === "paused" && (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => onResume(job)}
                    title="Continuar"
                  >
                    <Play />
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => (finished ? onDismiss(job.id) : onCancel(job))}
                  title={finished ? "Dispensar" : "Cancelar"}
                >
                  <X />
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
