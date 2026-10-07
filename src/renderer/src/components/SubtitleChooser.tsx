import { useEffect, useMemo, useRef } from 'react';
import { Subtitles } from 'lucide-react';
import { autoSubtitleLanguage, subtitleLinks, type ScoutContext } from '@shared/scout';
import { t, tm } from '@/lib/i18n';
import { isWeb } from '@/lib/platform';
import { SUBTITLE_FILE_HINT, useImdbMatch, useScoutLinks } from '@/lib/scout';
import { useStore } from '@/lib/store';
import { Button, Eyebrow, LinkButton } from './ui';

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Subtitle sites for the title being played (the open title's details when it is that one), the
 * subtitle setting's language first. None on a phone: its player can't take a file from elsewhere.
 */
function useSubtitleSites(playing: string | undefined, preference: string) {
  const open = useStore((s) => s.details);
  const openTitle = open?.info ? open.state.title || open.info.title : '';
  const same = Boolean(playing && openTitle && norm(playing).includes(norm(openTitle)));
  const title = same ? openTitle : (playing ?? '');
  const year = same ? open?.info?.year : undefined;
  const kind = same ? (open?.info?.kind ?? '') : '';
  const season = same ? open?.current?.season : undefined;
  const episode = same ? open?.current?.episode : undefined;
  const { imdb, matching } = useImdbMatch(isWeb ? '' : title, year, kind);
  const ctx = useMemo<ScoutContext | null>(() => (title && !isWeb ? { imdbId: imdb?.id, title, year, kind, season, episode } : null), [title, imdb?.id, year, kind, season, episode]);
  const links = useScoutLinks(ctx);
  return matching ? [] : subtitleLinks(links, preference);
}

/**
 * The engine's question before it plays or downloads a title with subtitles. It only reaches the
 * window when the subtitle setting is "Ask every time" or the title lacks the chosen language.
 */
export function SubtitleChooser() {
  const choice = useStore((s) => s.subtitleChoice);
  const preference = useStore((s) => s.subtitles);
  const choose = useStore((s) => s.chooseSubtitle);
  const box = useRef<HTMLDivElement>(null);
  const sites = useSubtitleSites(choice?.title, preference);
  const scout = useStore((s) => s.scout);

  // Start on the likeliest answer: the preferred language, else English, else the first language.
  const options = choice?.options ?? [];
  const find = (name: string) => options.findIndex((o, i) => i > 0 && o.toLowerCase().startsWith(name.toLowerCase()));
  // Automatic subtitles bring the language the source lacks once "No subtitles" is chosen.
  const auto = isWeb || choice?.purpose !== 'play' ? null : autoSubtitleLanguage(scout, preference);
  const autoAdds = auto !== null && find(auto) < 0;
  const focusIndex = autoAdds ? 0 : ([find(preference), find('English'), options.length > 1 ? 1 : 0].find((i) => i >= 0) ?? 0);

  useEffect(() => {
    if (choice) box.current?.querySelector<HTMLButtonElement>('[data-autofocus]')?.focus();
  }, [choice]);

  if (!choice) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-house/70 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={t('Choose subtitles')}>
      <div ref={box} data-nav-scope="dialog" className="max-h-[82vh] w-[520px] overflow-y-auto rounded-2xl border border-seam bg-velvet p-7 shadow-2xl animate-rise max-md:w-[calc(100vw-24px)] max-md:p-5">
        <Eyebrow className="flex items-center gap-2">
          <Subtitles size={14} /> {choice.purpose === 'download' ? t('Before downloading') : t('Before playing')}
        </Eyebrow>
        <h2 className="mt-2 font-display text-[32px] font-extrabold uppercase leading-[0.95] tracking-wide">{choice.title || t('Subtitles')}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-usher">
          {choice.purpose === 'download' ? t('Which subtitles should be saved with the video?') : t('Which subtitles should load into the player?')}
        </p>
        {autoAdds && auto && (
          <p className="mt-3 rounded-lg bg-bulb/10 px-3 py-2 text-[12.5px] leading-snug text-screen">
            {t('There are no {language} ones here. Choose “No subtitles” and {language} subtitles from OpenSubtitles are added to the player.', { language: t(auto) })}
          </p>
        )}
        <div className="mt-5 grid grid-cols-2 gap-2">
          {options.map((o, i) => (
            <Button
              key={`${i}-${o}`}
              data-autofocus={i === focusIndex ? '' : undefined}
              variant={i === 0 ? 'quiet' : 'ghost'}
              className="!justify-start"
              onClick={() => void choose(i)}
            >
              {tm(o)}
            </Button>
          ))}
        </div>
        {sites.length > 0 && (
          <div className="mt-5 rounded-xl border border-seam/70 bg-house/40 p-3.5">
            <div className="text-[12.5px] text-usher">{t('Not the subtitles you want? Look on other sites:')}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {sites.slice(0, 3).map((l) => (
                <LinkButton key={l.id} href={l.url}>
                  {l.name}
                </LinkButton>
              ))}
            </div>
            <p className="mt-2 text-[11.5px] leading-snug text-dim">{t(SUBTITLE_FILE_HINT)}</p>
          </div>
        )}
        <div className="mt-6 flex items-center justify-between gap-3 border-t border-seam/70 pt-4">
          <span className="text-[12px] leading-snug text-dim">{t('Settings → Playback sets the language picked without asking.')}</span>
          <Button variant="quiet" onClick={() => void choose(-1)}>
            {t('Cancel')}
          </Button>
        </div>
      </div>
    </div>
  );
}
