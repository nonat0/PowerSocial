export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatSpeed(bytesPerSec: number | null): string {
  if (!bytesPerSec) return "";
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(seconds: number | null): string {
  if (seconds == null || seconds < 0) return "";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m > 0) return `${m}m ${rem.toString().padStart(2, "0")}s`;
  return `${rem}s`;
}

/** Formata a digitação como tempo, agrupando da direita: 12345 -> "1:23:45". */
export function maskTime(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(-6);
  if (!d) return "";
  const ss = d.slice(-2);
  const mm = d.slice(-4, -2);
  const hh = d.slice(-6, -4);
  return [hh, mm, ss].filter((x) => x !== "").join(":");
}

export function formatDuration(seconds: number | null): string {
  if (seconds == null) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  const mm = m.toString().padStart(2, "0");
  const ss = rem.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const PLATFORM_COLORS: Record<string, string> = {
  YouTube: "#ff0033",
  Instagram: "#e1306c",
  Facebook: "#1877f2",
  X: "#1d9bf0",
  TikTok: "#25f4ee",
};

export function platformColor(platform: string): string {
  return PLATFORM_COLORS[platform] ?? "#8b5cf6";
}
