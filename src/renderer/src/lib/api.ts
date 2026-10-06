import { t, tm } from './i18n';

export const mb = window.mb;

/** Strips Electron's "Error invoking remote method 'x': Error: " prefix; in the window's language. */
export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return tm(msg.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ''));
}

/** Remote images go through the main process's caching `mbimg://` protocol (or the phone server's /img). */
export function imageUrl(url?: string | null): string | undefined {
  if (!url || !/^https?:\/\//.test(url)) return undefined;
  return mb.imageBase ? `${mb.imageBase}${encodeURIComponent(url)}` : `mbimg://img/${encodeURIComponent(url)}`;
}

/** IMDb's poster for a title (via metahub, the same art Stremio uses): for sources that have none. */
export const imdbPoster = (imdbId?: string | null) => (imdbId ? `https://images.metahub.space/poster/medium/${imdbId}/img` : undefined);

export function formatBytes(n?: number): string {
  if (!n || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${t(units[i])}`;
}

export function formatDuration(seconds?: number): string {
  if (!seconds || seconds < 1) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h) return t('{h}h {m}m', { h, m });
  if (m) return t('{m}m {s}s', { m, s: s.toString().padStart(2, '0') });
  return t('{s}s', { s });
}

export function episodeTag(season?: number, episode?: number): string {
  if (!season || !episode) return '';
  return `S${String(season).padStart(2, '0')} · E${String(episode).padStart(2, '0')}`;
}

export function timeAgo(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 90) return t('just now');
  if (diff < 3600) return t('{n} min ago', { n: Math.round(diff / 60) });
  if (diff < 86400) return t('{n} h ago', { n: Math.round(diff / 3600) });
  const days = Math.round(diff / 86400);
  return days === 1 ? t('yesterday') : t('{n} days ago', { n: days });
}
