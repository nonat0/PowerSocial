import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-react";

import { cn } from "@/lib/utils";

const appWindow = getCurrentWindow();

/** Barra de título customizada (a janela usa `decorations: false`). */
export function Titlebar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    appWindow.isMaximized().then(setMaximized).catch(() => {});
    appWindow
      .onResized(() => {
        appWindow.isMaximized().then(setMaximized).catch(() => {});
      })
      .then((un) => (unlisten = un))
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  return (
    <header
      data-tauri-drag-region
      className="flex h-10 shrink-0 select-none items-center justify-between border-b bg-background/80 pl-4 pr-1 backdrop-blur"
    >
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 text-sm font-medium"
      >
        <span className="grid size-5 place-items-center rounded bg-primary text-[11px] text-primary-foreground">
          ◆
        </span>
        Creator Gallery
      </div>

      <div className="flex items-center">
        <WindowButton
          label="Minimizar"
          onClick={() => appWindow.minimize()}
          icon={<Minus className="size-4" />}
        />
        <WindowButton
          label={maximized ? "Restaurar" : "Maximizar"}
          onClick={() => appWindow.toggleMaximize()}
          icon={
            maximized ? (
              <Copy className="size-3.5" />
            ) : (
              <Square className="size-3.5" />
            )
          }
        />
        <WindowButton
          label="Fechar"
          danger
          onClick={() => appWindow.close()}
          icon={<X className="size-4" />}
        />
      </div>
    </header>
  );
}

function WindowButton({
  label,
  onClick,
  icon,
  danger,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground",
        danger ? "hover:bg-destructive hover:text-white" : "hover:bg-accent"
      )}
    >
      {icon}
    </button>
  );
}
