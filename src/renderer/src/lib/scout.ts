// The window's side of "Find elsewhere": a title's IMDb match, and its links as Settings allows.
import { useEffect, useMemo, useState } from 'react';
import { scoutLinks, type ScoutContext, type ScoutLink } from '@shared/scout';
import { SCOUT_SITES } from '@shared/scout-sites';
import type { ImdbRating } from '@shared/types';
import { mb } from './api';
import { useStore } from './store';

/**
 * What to do with a subtitle file fetched by hand from one of these sites: players take one dropped
 * on their window. (Automatic subtitles, from OpenSubtitles, are the ones the app adds itself.)
 */
export const SUBTITLE_FILE_HINT = 'Downloaded a subtitle file? Drag it onto the player window. In VLC you can also use Subtitle → Add Subtitle File.';

/** IMDb's match for a title (cached after the first lookup); `matching` while it is looked up. */
export function useImdbMatch(title: string, year?: string, kind?: string): { imdb: ImdbRating | null; matching: boolean } {
  const key = title ? `${title}|${year ?? ''}|${kind ?? ''}` : '';
  const [found, setFound] = useState<{ key: string; imdb: ImdbRating | null } | null>(null);
  useEffect(() => {
    if (!key) return;
    let stale = false;
    const done = (imdb: ImdbRating | null) => !stale && setFound({ key, imdb });
    mb.imdbRatings([{ title, year, type: kind }]).then(
      ([r]) => done(r ?? null),
      () => done(null),
    );
    return () => void (stale = true);
  }, [key]); // `key` covers title, year and kind
  const current = found?.key === key ? found : null;
  return { imdb: current?.imdb ?? null, matching: Boolean(key) && !current };
}

/** The title's "Find elsewhere" links, in the groups Settings shows; none while it is turned off. */
export function useScoutLinks(ctx: ScoutContext | null): ScoutLink[] {
  const settings = useStore((s) => s.scout);
  return useMemo(
    () => (ctx && settings.enabled ? scoutLinks(SCOUT_SITES, ctx).filter((l) => settings.categories.includes(l.category)) : []),
    [ctx, settings],
  );
}
