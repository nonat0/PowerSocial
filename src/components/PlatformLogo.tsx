import { cn } from "../lib/utils";

const LOGOS: Record<string, string> = {
  YouTube: "/youtube.ico",
  Instagram: "/instagram.ico",
  Facebook: "/facebook.ico",
  X: "/x.ico",
};

/** Logo original da rede social (arquivos .ico em public/). */
export function PlatformLogo({
  platform,
  className,
  size = 20,
}: {
  platform: string;
  className?: string;
  size?: number;
}) {
  const src = LOGOS[platform];
  if (!src) {
    return (
      <span
        title={platform}
        className={cn(
          "grid place-items-center rounded bg-secondary text-[10px] font-semibold uppercase text-secondary-foreground",
          className
        )}
        style={{ width: size, height: size }}
      >
        {platform.slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={platform}
      title={platform}
      width={size}
      height={size}
      className={cn("shrink-0 rounded object-contain", className)}
    />
  );
}
