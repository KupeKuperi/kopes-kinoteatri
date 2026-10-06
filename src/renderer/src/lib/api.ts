export const mb = window.mb;

/** Strips Electron's "Error invoking remote method 'x': Error: " prefix. */
export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
}

/** Remote images go through the main process's caching `mbimg://` protocol. */
export function imageUrl(url?: string | null): string | undefined {
  return url && /^https?:\/\//.test(url) ? `mbimg://img/${encodeURIComponent(url)}` : undefined;
}

/** IMDb's poster for a title (via metahub, the same art Stremio uses): for sources that have none. */
export const imdbPoster = (imdbId?: string | null) => (imdbId ? `https://images.metahub.space/poster/medium/${imdbId}/img` : undefined);

export function formatBytes(n?: number): string {
  if (!n || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}

export function formatDuration(seconds?: number): string {
  if (!seconds || seconds < 1) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

export function episodeTag(season?: number, episode?: number): string {
  if (!season || !episode) return '';
  return `S${String(season).padStart(2, '0')} · E${String(episode).padStart(2, '0')}`;
}

export function timeAgo(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 90) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  const days = Math.round(diff / 86400);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
