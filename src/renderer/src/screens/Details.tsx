import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Download, ExternalLink, Monitor, Play, Star, Subtitles } from 'lucide-react';
import { autoSubtitleLanguage, SCOUT_CATEGORIES, SCOUT_CATEGORY_NAMES, subtitleLinks, type ScoutContext, type ScoutLink } from '@shared/scout';
import type { DetailsView, ScoutCategory, StreamOption } from '@shared/types';
import { formatBytes, imageUrl, imdbPoster } from '@/lib/api';
import { q, t, tm } from '@/lib/i18n';
import { isTyping } from '@/lib/nav';
import { isWeb } from '@/lib/platform';
import { SUBTITLE_FILE_HINT, useImdbMatch, useScoutLinks } from '@/lib/scout';
import { useRoute, useStore } from '@/lib/store';
import { Poster } from '@/components/Poster';
import { Button, Chip, ErrorPanel, Eyebrow, LinkButton, Spinner } from '@/components/ui';

const SOURCE_NAMES: Record<string, string> = { moviebox: 'MovieBox', fourkhdhub: '4KHDHub', '4khd': '4KHDHub', '4khdhub': '4KHDHub', dramachi: 'Dramachi', addons: 'Addons' };
const sourceName = (id: string) => SOURCE_NAMES[id] ?? id;
const compactVotes = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

function Backdrop({ cover }: { cover?: string }) {
  const bg = imageUrl(cover);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[520px] overflow-hidden">
      {bg && <img src={bg} alt="" className="h-full w-full scale-110 object-cover opacity-30 blur-3xl" />}
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgb(22_13_18/0.3),var(--color-house)_92%)]" />
    </div>
  );
}

function Loading() {
  const pending = useStore((s) => s.detailsLoading);
  const tuiStatus = useStore((s) => s.status?.tuiStatus);
  const activity = useStore((s) => s.status?.activity);
  return (
    <div className="relative isolate p-8 max-md:p-4">
      <Backdrop cover={pending?.cover} />
      <div className="flex gap-9 max-md:flex-col max-md:gap-5">
        <Poster src={pending?.cover} title={pending?.title ?? ''} className="aspect-[2/3] w-[220px] shrink-0 rounded-2xl shadow-2xl ring-1 ring-seam max-md:w-[132px]" />
        <div className="flex-1 pt-3">
          <Eyebrow>{[pending?.type, pending?.year].filter(Boolean).join(' · ')}</Eyebrow>
          <h1 className="mt-3 font-display text-[60px] font-extrabold uppercase leading-[0.9] max-md:text-[30px]">{pending?.title}</h1>
          <div className="mt-6 flex items-center gap-2 font-mono text-[12px] text-usher">
            <Spinner /> {tm(tuiStatus ?? activity) || t('Opening…')}
          </div>
          <div className="mt-6 space-y-2.5">
            <div className="skeleton h-3.5 w-11/12 rounded" />
            <div className="skeleton h-3.5 w-4/5 rounded" />
            <div className="skeleton h-3.5 w-2/3 rounded" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** `help`: where else to look, shown when the source has no streams for this title or episode. */
function StreamsTable({ view, busy, help }: { view: DetailsView; busy: boolean; help: ReactNode }) {
  const play = useStore((s) => s.play);
  const playOnComputer = useStore((s) => s.playOnComputer);
  const download = useStore((s) => s.download);
  const { state, streams } = view;

  if (state.streamsStatus === 'loading') return <StreamsLoading source={view.info?.provider} />;
  if (state.streamsStatus === 'choose-audio') {
    return <div className="rounded-2xl border border-dashed border-seam p-6 text-[13.5px] text-usher">{t('Choose an audio track above to see its streams.')}</div>;
  }
  if (!streams.length) {
    const noStreamAddons = /stream add-?ons?/i.test(state.streamsMessage ?? '');
    return (
      <div className="rounded-2xl border border-dashed border-seam p-6 text-[13.5px] leading-relaxed text-usher">
        {noStreamAddons ? (
          t(
            'The Addons source only lists titles until you add an add-on that provides streams (Settings → Add-ons). Or switch to MovieBox, 4KHDHub or Dramachi in the top-right corner and open the title there.',
          )
        ) : (
          <>
            {tm(state.streamsMessage) || t('Pick an episode to see its streams.')}{' '}
            {state.streamsStatus === 'empty' && t('Try another episode, another audio track, or another source.')}
          </>
        )}
        {(noStreamAddons || state.streamsStatus === 'empty') && help}
      </div>
    );
  }
  // Columns the engine left empty for this title are hidden.
  const has = {
    size: streams.some((s) => s.size || s.sizeBytes),
    format: streams.some((s) => s.tags || s.codec),
    audio: streams.some((s) => s.audio),
    source: streams.some((s) => s.source),
    release: streams.some((s) => s.release),
  };
  const th = 'px-4 py-2.5 font-normal';
  return (
    <>
    {/* Phones: one card per stream. */}
    <ul className="space-y-2 md:hidden">
      {streams.map((s: StreamOption) => (
        <li key={s.index} className="flex items-center gap-3 rounded-2xl border border-seam bg-house/40 p-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="font-display text-[22px] font-bold leading-none">{qualityLabel(s.resolution)}</span>
              <span className="truncate font-mono text-[11px] text-usher">{[s.size ?? formatBytes(s.sizeBytes), s.tags ?? s.codec, s.audio && tm(s.audio)].filter(Boolean).join(' · ')}</span>
            </div>
            {(s.source || s.release) && <div className="mt-1 line-clamp-2 font-mono text-[10.5px] text-dim [overflow-wrap:anywhere]">{[s.source, s.release].filter(Boolean).join(' · ')}</div>}
          </div>
          <Button size="sm" variant={s.index === 0 ? 'primary' : 'ghost'} icon={<Play size={13} fill="currentColor" />} disabled={busy} onClick={() => void play(s.index)} aria-label={t('Play {quality}', { quality: s.resolution })} />
          {isWeb && <Button size="sm" variant="quiet" icon={<Monitor size={14} />} disabled={busy} onClick={() => void playOnComputer(s.index)} aria-label={t('Play on the computer')} />}
        </li>
      ))}
    </ul>
    <div className="overflow-hidden rounded-2xl border border-seam max-md:hidden">
      <table className="w-full text-left">
        <thead className="bg-velvet/80 font-mono text-[10px] uppercase tracking-[0.16em] text-dim">
          <tr>
            <th className={th}>{t('Quality')}</th>
            {has.size && <th className={th}>{t('Size')}</th>}
            {has.format && <th className={th}>{t('Format')}</th>}
            {has.audio && <th className={th}>{t('Audio')}</th>}
            {has.source && <th className={th}>{t('Source')}</th>}
            {has.release && <th className={th}>{t('Release')}</th>}
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody className="divide-y divide-seam/70">
          {streams.map((s: StreamOption) => (
            <tr key={s.index} className="bg-house/40 transition-colors hover:bg-curtain/50">
              <td className="px-4 py-3">
                <span className="font-display text-[22px] font-bold leading-none">{qualityLabel(s.resolution)}</span>
                {qualityLabel(s.resolution) !== s.resolution && <span className="ml-1.5 font-mono text-[10.5px] text-usher">{s.resolution}</span>}
              </td>
              {has.size && <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-usher">{s.size ?? formatBytes(s.sizeBytes)}</td>}
              {has.format && <td className="px-4 py-3 font-mono text-[11px] uppercase text-usher">{s.tags ?? s.codec ?? ''}</td>}
              {has.audio && <td className="px-4 py-3 text-[12.5px] text-usher">{tm(s.audio)}</td>}
              {has.source && <td className="px-4 py-3 text-[13px] text-usher">{s.source ?? ''}</td>}
              {has.release && (
                <td className="max-w-[360px] px-4 py-3 font-mono text-[11px] text-usher" title={s.release} data-selectable>
                  <span className="line-clamp-2 [overflow-wrap:anywhere]">{s.release ?? ''}</span>
                </td>
              )}
              <td className="px-4 py-2.5">
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" variant={s.index === 0 ? 'primary' : 'ghost'} icon={<Play size={13} fill="currentColor" />} disabled={busy} onClick={() => void play(s.index)}>
                    {t('Play')}
                  </Button>
                  <Button size="sm" variant="quiet" icon={<Download size={14} />} disabled={busy} onClick={() => void download('stream', s.index)} aria-label={t('Download {quality}', { quality: s.resolution })}>
                    {t('Download')}
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  );
}

/** 2160p is better known as 4K. */
const qualityLabel = (resolution: string) => (resolution === '2160p' ? '4K' : resolution === '4320p' ? '8K' : resolution);

/** Streams can take a while on some sources; say so instead of spinning silently. */
function StreamsLoading({ source }: { source?: string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex h-28 flex-col items-center justify-center gap-1.5 rounded-2xl border border-seam bg-velvet/60">
      <span className="flex items-center gap-2 font-mono text-[12px] text-usher">
        <Spinner /> {t('Loading streams…')} {seconds >= 3 && t('{s}s', { s: seconds })}
      </span>
      {seconds >= 6 && (
        <span className="text-[12px] text-dim">
          {source && source !== 'moviebox' ? t('This source looks up every release and can take up to a minute.') : t('Still waiting for the source to answer.')}
        </span>
      )}
    </div>
  );
}

/** The app's sources other than `current` that a title can be looked for on. */
function useOtherSources(current: string | null | undefined): string[] {
  const providers = useStore((s) => s.providers);
  const streamAddons = useStore((s) => s.env?.streamAddons.length ?? 0);
  // Addons can't play anything without an add-on that provides streams, so then it isn't offered.
  return providers.filter((p) => p !== current && (p.toLowerCase() !== 'addons' || streamAddons > 0));
}

/** A title opened by name (IMDb list, history, favorites) that the active source doesn't have. */
function NotOnSource() {
  const miss = useStore((s) => s.detailsNotFound)!;
  const retry = useStore((s) => s.retryTitleOn);
  const back = useStore((s) => s.back);
  const others = useOtherSources(miss.source);
  return (
    <div className="p-8 max-md:p-4">
      <div className="max-w-2xl rounded-2xl border border-seam bg-velvet/60 p-7 max-md:p-5">
        <Eyebrow>{miss.source ? t('Not on {source}', { source: miss.source }) : t('Not on this source')}</Eyebrow>
        <h1 className="mt-2 font-display text-[40px] font-extrabold uppercase leading-[0.95] max-md:text-[28px]">{miss.ref.title}</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-usher">
          {!miss.source
            ? t('The active source has no title called {title}.', { title: q(miss.ref.title) })
            : miss.ref.year
              ? t('{source} has no title called {title} from {year}.', { source: miss.source, title: q(miss.ref.title), year: miss.ref.year })
              : t('{source} has no title called {title}.', { source: miss.source, title: q(miss.ref.title) })}
          {others.length ? ` ${t('Look for it on another source:')}` : ''}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {others.map((p, i) => (
            <Button key={p} variant={i === 0 ? 'primary' : 'ghost'} focusOnMount={i === 0} onClick={() => void retry(p)}>
              {t('Look on {source}', { source: p })}
            </Button>
          ))}
          <Button variant="quiet" onClick={back}>
            {t('Back')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Episodes({ view, busy }: { view: DetailsView; busy: boolean }) {
  const selectSeason = useStore((s) => s.selectSeason);
  const selectEpisode = useStore((s) => s.selectEpisode);
  const download = useStore((s) => s.download);
  const seasons = view.info?.seasons ?? [];
  const [shown, setShown] = useState<number | null>(null);
  const season = shown ?? view.current?.season ?? seasons[0]?.season ?? 1;
  const episodes = seasons.find((s) => s.season === season)?.episodes ?? [];

  useEffect(() => setShown(null), [view.info?.subjectId]);
  if (!seasons.length) return null;

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Eyebrow className="mr-2">{t('Seasons')}</Eyebrow>
        {seasons.map((s) => (
          <Chip
            key={s.season}
            active={s.season === season}
            disabled={busy}
            onClick={() => {
              setShown(s.season);
              if (s.season !== view.current?.season) void selectSeason(s.season);
            }}
          >
            {t('Season {n}', { n: s.season })}
          </Chip>
        ))}
        <Button size="sm" variant="quiet" className="ml-auto" icon={<Download size={14} />} disabled={busy} onClick={() => void download('season', season)}>
          {t('Download season {n}', { n: season })}
        </Button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(118px,1fr))] gap-2 max-md:grid-cols-[repeat(auto-fill,minmax(84px,1fr))]">
        {episodes.map((e) => {
          const active = view.current?.season === e.season && view.current?.episode === e.episode;
          return (
            <button
              key={e.episode}
              data-nav=""
              disabled={busy}
              aria-current={active ? 'true' : undefined}
              onClick={() => void selectEpisode(e.season, e.episode)}
              className={`marquee flex h-[62px] flex-col justify-center rounded-xl border px-3 text-left transition-colors disabled:opacity-60 ${
                active ? 'border-bulb/70 bg-bulb/10' : 'border-seam bg-velvet/70 hover:bg-curtain'
              }`}
            >
              <span className={`font-mono text-[10px] uppercase tracking-[0.16em] ${active ? 'text-bulb' : 'text-dim'}`}>{t('Episode')}</span>
              <span className="font-display text-[24px] font-bold leading-none">{String(e.episode).padStart(2, '0')}</span>
              {e.title && <span className="truncate text-[11.5px] text-usher">{e.title}</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

const hostOf = (url: string) => new URL(url).hostname.replace(/^www\./, '');

const SCOUT_ID = 'find-elsewhere';

/** Where else to look when this source has no streams: the app's other sources, then other sites. */
function NoStreamsHelp({ links, busy, onMore }: { links: ScoutLink[]; busy: boolean; onMore: () => void }) {
  const current = useStore((s) => s.status?.provider);
  const retry = useStore((s) => s.retryTitleOn);
  const others = useOtherSources(current);
  // The first few of the torrent and streaming short lists.
  const picks = [...links.filter((l) => l.category === 'torrent' && l.curated).slice(0, 4), ...links.filter((l) => l.category === 'streaming' && l.curated).slice(0, 3)];
  if (!others.length && !picks.length) return null;
  return (
    <div className="mt-4 space-y-4 border-t border-seam/60 pt-4">
      {others.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1">{t('Look for it on another source:')}</span>
          {others.map((p) => (
            <Button key={p} size="sm" disabled={busy} onClick={() => void retry(p)}>
              {t('Look on {source}', { source: p })}
            </Button>
          ))}
        </div>
      )}
      {picks.length > 0 && (
        <div>
          <div className="mb-2 text-screen">{t('Or find it on another site:')}</div>
          <div className="flex flex-wrap gap-2">
            {picks.map((l) => (
              <LinkButton key={l.id} href={l.url}>
                {t('Search on {site}', { site: l.name })}
              </LinkButton>
            ))}
            <Button size="sm" variant="quiet" onClick={onMore}>
              {t('More sites')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Does the source have subtitles in the subtitle setting's language for what is on screen? */
function hasWantedSubtitles(view: DetailsView, preference: string): boolean {
  if (preference === 'ask') return view.captions.length > 0;
  const want = preference.toLowerCase();
  return view.captions.some((c) => c.language.toLowerCase().startsWith(want));
}

/**
 * The subtitle line: what the source has, the setting, and subtitle sites for the title. When the
 * source lacks the language you want, it says automatic subtitles will add them, or (with those
 * off) the sites open by themselves. Not on a phone: its player can't take a file from elsewhere.
 */
function SubtitleNote({ view, links, onMore }: { view: DetailsView; links: ScoutLink[]; onMore: () => void }) {
  const subtitles = useStore((s) => s.subtitles);
  const scout = useStore((s) => s.scout);
  const sites = useMemo(() => (isWeb ? [] : subtitleLinks(links, subtitles)), [links, subtitles]);
  const lacking = subtitles !== 'off' && view.streams.length > 0 && !hasWantedSubtitles(view, subtitles);
  const auto = isWeb ? null : autoSubtitleLanguage(scout, subtitles);
  const autoAdds = auto !== null && view.streams.length > 0 && !hasWantedSubtitles(view, auto);
  const [shown, setShown] = useState<boolean | null>(null);
  const open = sites.length > 0 && (shown ?? (lacking && !autoAdds));
  const info = view.info;
  return (
    <section className="flex items-start gap-3 rounded-2xl border border-seam/70 bg-velvet/50 p-4">
      <Subtitles size={17} className="mt-0.5 shrink-0 text-usher" />
      <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-usher">
        {view.captions.length > 0 && (
          <>
            <span className="text-screen">{info?.kind === 'series' ? t('Subtitles for this episode:') : t('Subtitles for this title:')}</span>{' '}
            {view.captions.map((c) => tm(c.language)).join(', ')}.{' '}
          </>
        )}
        {subtitles === 'ask'
          ? t('You choose the subtitles each time you play or download.')
          : subtitles === 'off'
            ? t('Plays without subtitles.')
            : t('{language} subtitles load automatically when there are some; otherwise you choose.', { language: t(subtitles) })}{' '}
        <button className="text-screen/80 underline decoration-seam underline-offset-2 hover:text-screen" onClick={() => useStore.getState().go({ name: 'settings' })}>
          {t('Change')}
        </button>
        {sites.length > 0 && (
          <>
            {' · '}
            <button className="text-screen/80 underline decoration-seam underline-offset-2 hover:text-screen" aria-expanded={open} onClick={() => setShown(!open)}>
              {t('Find subtitles')}
            </button>
          </>
        )}
        {autoAdds && auto && (
          <div className="mt-2 text-screen">
            {view.captions.length
              ? t('When it asks, choose “No subtitles”: {language} subtitles from OpenSubtitles are added to the player.', { language: t(auto) })
              : t('{language} subtitles from OpenSubtitles are added to the player when you play.', { language: t(auto) })}
          </div>
        )}
        {open && (
          <div className="mt-3">
            {lacking && <div className="mb-2 text-screen">{subtitles === 'ask' ? t('This source has no subtitles here. Other sites may:') : t('No {language} subtitles here. Other sites may have them:', { language: t(subtitles) })}</div>}
            <div className="flex flex-wrap gap-2">
              {sites.slice(0, 5).map((l) => (
                <LinkButton key={l.id} href={l.url}>
                  {l.name}
                </LinkButton>
              ))}
              {sites.length > 5 && (
                <Button size="sm" variant="quiet" onClick={onMore}>
                  {t('More subtitle sites')}
                </Button>
              )}
            </div>
            <p className="mt-2 text-[12px] text-dim">{t(SUBTITLE_FILE_HINT)}</p>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * "Find elsewhere": searches for the title on other sites (IMDb Scout Mod's list). Links only:
 * they open in the browser, and nothing checks what each site has. `group` is chosen here or by
 * the blocks that point here ("More sites").
 */
function ScoutPanel({ links, matching, matched, group: picked, onGroup }: { links: ScoutLink[]; matching: boolean; matched: boolean; group: ScoutCategory | null; onGroup: (g: ScoutCategory) => void }) {
  const settings = useStore((s) => s.scout);
  const [expanded, setExpanded] = useState(false);

  if (!settings.enabled || !settings.categories.length) return null;
  if (matching) {
    return (
      <section id={SCOUT_ID}>
        <Eyebrow>{t('Find elsewhere')}</Eyebrow>
        <div className="mt-3 flex items-center gap-2 font-mono text-[12px] text-usher">
          <Spinner /> {t('Matching the title on IMDb…')}
        </div>
      </section>
    );
  }

  const groups = SCOUT_CATEGORIES.filter((c) => settings.categories.includes(c) && links.some((l) => l.category === c));
  if (!groups.length) return null;
  const group = picked && groups.includes(picked) ? picked : groups[0];
  const inGroup = links.filter((l) => l.category === group);
  const short = inGroup.filter((l) => l.curated);
  // The short list first, unless Settings asks for every site (or the group has no short list).
  const all = settings.allSites || expanded || !short.length;
  const shown = all ? inGroup : short;
  return (
    <section id={SCOUT_ID}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Eyebrow className="mr-2">{t('Find elsewhere')}</Eyebrow>
        {groups.map((c) => (
          <Chip key={c} active={c === group} onClick={() => onGroup(c)}>
            {t(SCOUT_CATEGORY_NAMES[c])}
          </Chip>
        ))}
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(172px,1fr))] gap-2 max-md:grid-cols-2">
        {shown.map((l) => (
          <li key={l.id}>
            <a
              href={l.url}
              target="_blank"
              rel="noreferrer"
              data-nav=""
              title={l.url}
              className="marquee group flex h-[54px] items-center gap-2.5 rounded-xl border border-seam bg-velvet/70 px-3 transition-colors hover:bg-curtain"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] text-screen">{l.name}</span>
                <span className="block truncate font-mono text-[10px] text-dim">{hostOf(l.url)}</span>
              </span>
              <ExternalLink size={13} className="shrink-0 text-dim transition-colors group-hover:text-screen" />
            </a>
          </li>
        ))}
      </ul>
      {!settings.allSites && short.length > 0 && inGroup.length > short.length && (
        <Button size="sm" variant="quiet" className="mt-2" onClick={() => setExpanded(!expanded)}>
          {expanded ? t('Fewer sites') : t('Show all {n} sites', { n: inGroup.length })}
        </Button>
      )}
      <p className="mt-2 text-[12px] leading-relaxed text-dim">
        {!matched && `${t("IMDb doesn't know this title, so only sites that search by name are listed.")} `}
        {t("Searches for this title on other sites, from the IMDb Scout Mod list. They open in your browser; the app doesn't check what each site has.")}
      </p>
    </section>
  );
}

export function Details() {
  const view = useStore((s) => s.details);
  const loading = useStore((s) => s.detailsLoading);
  const error = useStore((s) => s.detailsError);
  const busyLabel = useStore((s) => s.detailsBusy);
  const tuiStatus = useStore((s) => s.status?.tuiStatus);
  const ytDlp = useStore((s) => s.env?.ytDlp);
  const route = useRoute();
  const notFound = useStore((s) => s.detailsNotFound);
  const { play, playOnComputer, download, toggleFavorite, selectAudio, setConsole, back } = useStore.getState();
  const [more, setMore] = useState(false);
  const [scoutGroup, setScoutGroup] = useState<ScoutCategory | null>(null);
  const busy = Boolean(busyLabel);

  // IMDb rating for this title (cached after the first lookup). The screen title is the clean one
  // (cache titles can carry dub tags like "[Hindi]").
  const title = view?.info ? view.state.title || view.info.title : '';
  const year = view?.info?.year;
  const kind = view?.info?.kind ?? '';
  const { imdb, matching } = useImdbMatch(title, year, kind);

  // "Find elsewhere" links, shared by its panel, the no-streams help and the subtitle line.
  const season = view?.current?.season;
  const episode = view?.current?.episode;
  const scoutCtx = useMemo<ScoutContext | null>(() => (title ? { imdbId: imdb?.id, title, year, kind, season, episode } : null), [title, imdb?.id, year, kind, season, episode]);
  const allLinks = useScoutLinks(scoutCtx);
  const links = matching ? [] : allLinks;
  const showScoutGroup = (group: ScoutCategory) => {
    setScoutGroup(group);
    requestAnimationFrame(() => document.getElementById(SCOUT_ID)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  useEffect(() => {
    if (route.name !== 'details') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || isTyping(document.activeElement) || busy || useStore.getState().subtitleChoice) return;
      const v = useStore.getState().details;
      if (!v) return;
      // Physical keys (e.code): with a Georgian or other layout, e.key is a different letter.
      const k = e.code;
      if (k === 'KeyF') void toggleFavorite();
      else if (k === 'KeyP' && v.streams.length) void play(0);
      else if (k === 'KeyD' && v.streams.length) void download('stream', 0);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [route.name, busy, play, download, toggleFavorite]);

  if (loading) return <Loading />;
  if (notFound) return <NotOnSource />;
  if (error || !view) {
    return (
      <div className="p-8 max-md:p-4">
        <ErrorPanel title={t("Couldn't open this title")} message={error ?? t('Nothing is open.')} onRetry={back} onConsole={() => setConsole(true)} />
      </div>
    );
  }

  const info = view.info;
  // 4KHDHub and Dramachi have no art: IMDb's poster stands in once the title is matched there.
  const cover = info?.cover ?? imdbPoster(imdb?.id);
  const meta = [
    info?.kind === 'series' ? t('Series') : info?.kind === 'movie' ? t('Movie') : undefined,
    info?.year,
    info?.duration && tm(info.duration),
    imdb ? t('IMDb {rating} · {votes} votes', { rating: imdb.rating.toFixed(1), votes: compactVotes(imdb.votes) }) : info?.rating && `★ ${info.rating}`,
    info?.provider && sourceName(info.provider),
  ].filter(Boolean);
  const facts: Array<[string, string | undefined]> = [
    [t('Director'), info?.director],
    [t('Cast'), info?.cast],
    [t('Audio'), info?.languages],
    [t('Formats'), info?.formats],
  ];
  const audioLabels = view.state.audioLabels;

  return (
    <div className="relative isolate p-8 max-md:p-4">
      <Backdrop cover={cover} />
      <div className="flex gap-9 max-md:flex-col max-md:gap-5">
        <Poster src={cover} title={view.state.title} className="aspect-[2/3] w-[220px] shrink-0 self-start rounded-2xl shadow-2xl ring-1 ring-seam max-md:w-[132px]" />
        <div className="min-w-0 flex-1 pt-3">
          <Eyebrow>{meta.join('  ·  ')}</Eyebrow>
          <h1 className="mt-3 font-display text-[60px] font-extrabold uppercase leading-[0.9] tracking-[0.01em] max-md:text-[30px]" data-selectable>
            {view.state.title}
          </h1>
          {info?.description && (
            <p className={`mt-5 max-w-3xl text-[15px] leading-relaxed text-screen/85 ${more ? '' : 'line-clamp-3'}`} data-selectable>
              {info.description}
            </p>
          )}
          {info?.description && info.description.length > 260 && (
            <button className="mt-1 text-[12.5px] text-usher hover:text-screen" onClick={() => setMore(!more)}>
              {more ? t('Less') : t('More')}
            </button>
          )}
          {info?.tagline && <p className="mt-3 max-w-3xl text-[14px] italic text-screen/70">“{info.tagline.replace(/^["“]|["”]$/g, '')}”</p>}
          {info?.tags.length ? <div className="mt-3 font-mono text-[11px] uppercase tracking-wider text-usher">{info.tags.join(' · ')}</div> : null}
          {facts.some(([, v]) => v) && (
            <dl className="mt-4 grid max-w-3xl grid-cols-[84px_1fr] gap-x-4 gap-y-1 text-[12.5px]">
              {facts
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-dim">{k}</dt>
                    <dd className="line-clamp-2 text-usher" data-selectable>
                      {v}
                    </dd>
                  </div>
                ))}
            </dl>
          )}

          <div className="mt-7 flex flex-wrap items-center gap-2.5">
            <Button variant="primary" size="lg" focusOnMount icon={<Play size={17} fill="currentColor" />} disabled={busy || !view.streams.length} onClick={() => void play(0)}>
              {view.streams[0] ? t('Play {quality}', { quality: view.streams[0].resolution }) : t('Play')}
            </Button>
            {isWeb && (
              <Button size="lg" variant="ghost" icon={<Monitor size={17} />} disabled={busy || !view.streams.length} onClick={() => void playOnComputer(0)}>
                {t('On the computer')}
              </Button>
            )}
            <Button size="lg" icon={<Download size={17} />} disabled={busy || !view.streams.length} onClick={() => void download('stream', 0)} title={isWeb ? t('Downloads to the computer') : undefined}>
              {t('Download')}
            </Button>
            <Button size="lg" variant="quiet" icon={<Star size={17} fill={view.state.favorite ? 'currentColor' : 'none'} className={view.state.favorite ? 'text-bulb' : ''} />} disabled={busy} onClick={() => void toggleFavorite()}>
              {view.state.favorite ? t('In favorites') : t('Add to favorites')}
            </Button>
            {busy && (
              <span className="ml-2 flex items-center gap-2 font-mono text-[12px] text-usher">
                <Spinner /> {tm(tuiStatus) || busyLabel}
              </span>
            )}
          </div>
          {!ytDlp && info?.provider === 'moviebox' && (
            <div className="mt-3 font-mono text-[11px] text-dim">{t('Downloads from MovieBox need yt-dlp installed.')}</div>
          )}
        </div>
      </div>

      <div className="mt-12 space-y-9 max-md:mt-8 max-md:space-y-7">
        {audioLabels.length > 1 && (
          <section className="flex flex-wrap items-center gap-2">
            <Eyebrow className="mr-2">{t('Audio')}</Eyebrow>
            {audioLabels.map((label, i) => (
              <Chip key={label} active={view.state.selectedAudio === i} disabled={busy} onClick={() => void selectAudio(i)}>
                {tm(label)}
              </Chip>
            ))}
          </section>
        )}

        <Episodes view={view} busy={busy} />

        <section>
          <div className="mb-3 flex items-baseline gap-3">
            <Eyebrow>{t('Streams')}</Eyebrow>
            {view.current && info?.kind === 'series' && (
              <span className="font-mono text-[11px] text-usher">
                S{String(view.current.season).padStart(2, '0')} · E{String(view.current.episode).padStart(2, '0')}
              </span>
            )}
          </div>
          <StreamsTable view={view} busy={busy} help={<NoStreamsHelp links={links} busy={busy} onMore={() => showScoutGroup('torrent')} />} />
        </section>

        {/* Keyed by title, so what was opened or expanded resets for the next one. */}
        <SubtitleNote key={`subtitles-${info?.subjectId}`} view={view} links={links} onMore={() => showScoutGroup('subtitles')} />

        <ScoutPanel key={`scout-${info?.subjectId}`} links={links} matching={matching} matched={Boolean(imdb)} group={scoutGroup} onGroup={setScoutGroup} />
      </div>
    </div>
  );
}
