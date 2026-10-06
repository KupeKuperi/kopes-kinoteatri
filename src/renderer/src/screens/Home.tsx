import { Info, Monitor, Play } from 'lucide-react';
import type { HistoryEntry } from '@shared/types';
import { episodeTag, formatDuration, imageUrl, timeAgo } from '@/lib/api';
import { t, tm } from '@/lib/i18n';
import { isWeb } from '@/lib/platform';
import { useStore } from '@/lib/store';
import { Poster, PosterCard, gridClass } from '@/components/Poster';
import { SEARCH_INPUT_ID } from '@/components/TitleBar';
import { Button, Empty, Eyebrow, SectionTitle } from '@/components/ui';
import { NoPlayerBanner } from '@/components/Setup';

const progressOf = (h: HistoryEntry) => (h.durationSeconds && h.progressSeconds ? h.progressSeconds / h.durationSeconds : undefined);

function progressLine(h: HistoryEntry) {
  const parts = [episodeTag(h.season, h.episode)];
  if (h.progressSeconds)
    parts.push(
      h.durationSeconds
        ? t('{done} of {total}', { done: formatDuration(h.progressSeconds), total: formatDuration(h.durationSeconds) })
        : t('{time} in', { time: formatDuration(h.progressSeconds) }),
    );
  else parts.push(t('Not started'));
  return parts.filter(Boolean).join('  ·  ');
}

function Hero({ entry }: { entry: HistoryEntry }) {
  const resume = useStore((s) => s.resume);
  const resumeOnComputer = useStore((s) => s.resumeOnComputer);
  const openTitle = useStore((s) => s.openTitle);
  const bg = imageUrl(entry.cover);
  return (
    <section className="relative isolate overflow-hidden rounded-3xl border border-seam/70">
      {bg && <img src={bg} alt="" className="absolute inset-0 -z-10 h-full w-full scale-110 object-cover opacity-35 blur-2xl" />}
      <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,var(--color-house)_18%,rgb(22_13_18/0.65)_60%,rgb(22_13_18/0.2))]" />
      {/* Poster beside the text; the buttons under the text (on a phone, a row of their own). */}
      <div className="grid grid-cols-[168px_1fr] items-end gap-x-8 p-8 max-md:grid-cols-[92px_1fr] max-md:gap-x-4 max-md:gap-y-4 max-md:p-4">
        <Poster src={entry.cover} title={entry.title} className="row-span-2 aspect-[2/3] w-[168px] rounded-xl shadow-2xl ring-1 ring-seam max-md:row-span-1 max-md:w-[92px]" />
        <div className="min-w-0 pb-1">
          <Eyebrow className="text-bulb">{t('Pick up where you left off · {when}', { when: timeAgo(entry.timestamp) })}</Eyebrow>
          <h1 className="mt-3 font-display text-[64px] font-extrabold uppercase leading-[0.9] tracking-[0.01em] line-clamp-2 max-md:mt-2 max-md:text-[28px]">{entry.title}</h1>
          <div className="mt-4 font-mono text-[12px] text-usher max-md:mt-2">{progressLine(entry)}</div>
          {progressOf(entry) !== undefined && (
            <div className="mt-3 h-1 w-72 max-w-full overflow-hidden rounded-full bg-seam">
              <div className="h-full bg-bulb" style={{ width: `${progressOf(entry)! * 100}%` }} />
            </div>
          )}
        </div>
        <div className="col-start-2 mt-6 flex flex-wrap gap-2.5 max-md:col-span-2 max-md:col-start-1 max-md:mt-0">
          <Button variant="primary" size="lg" icon={<Play size={17} fill="currentColor" />} onClick={() => void resume(entry)} focusOnMount>
            {t('Resume')}
          </Button>
          {isWeb && <Button size="lg" variant="quiet" icon={<Monitor size={17} />} aria-label={t('Resume on the computer')} onClick={() => void resumeOnComputer(entry)} />}
          <Button size="lg" icon={<Info size={17} />} onClick={() => void openTitle({ title: entry.title, year: entry.year, subjectId: entry.subjectId, cover: entry.cover })}>
            {t('Details')}
          </Button>
        </div>
      </div>
    </section>
  );
}

function Welcome() {
  return (
    <section className="rounded-3xl border border-seam/70 bg-[radial-gradient(ellipse_at_top_left,var(--color-curtain),var(--color-house)_70%)] p-10 max-md:p-5">
      <Eyebrow className="text-bulb">{t("Tonight's programme")}</Eyebrow>
      <h1 className="mt-3 max-w-3xl font-display text-[64px] font-extrabold uppercase leading-[0.9] max-md:text-[32px]">{t('Find something to watch')}</h1>
      <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-usher">
        {t('Search movies, series, anime and Asian dramas. Whatever you start plays in your own player and shows up here next time.')}
      </p>
      <div className="mt-7">
        <Button variant="primary" size="lg" focusOnMount onClick={() => document.getElementById(SEARCH_INPUT_ID)?.focus()}>
          {t('Start searching')}
        </Button>
      </div>
    </section>
  );
}

const IMDB_LISTS = [
  { kind: 'movies', label: 'Top Rated Movies', eyebrow: 'IMDb · all time' },
  { kind: 'series', label: 'Top Rated Series', eyebrow: 'IMDb · all time' },
  { kind: 'new-movies', label: 'Best New Movies', eyebrow: 'IMDb · this year and last' },
  { kind: 'new-series', label: 'Best New Series', eyebrow: 'IMDb · this year and last' },
];

function DiscoverTile({ eyebrow, label, onClick }: { eyebrow: string; label: string; onClick: () => void }) {
  return (
    <button
      data-nav=""
      onClick={onClick}
      className="marquee group flex min-h-[118px] flex-col justify-between gap-3 rounded-2xl border border-seam bg-velvet p-5 text-left transition-colors hover:bg-curtain max-md:min-h-[92px] max-md:gap-2 max-md:p-3.5"
    >
      <Eyebrow>{eyebrow}</Eyebrow>
      <span className="font-display text-[28px] font-extrabold uppercase leading-[0.95] tracking-wide group-hover:text-bulb max-md:text-[19px]">{tm(label)}</span>
    </button>
  );
}

export function Home() {
  const library = useStore((s) => s.library);
  const categories = useStore((s) => s.categories);
  const categoriesLoaded = useStore((s) => s.categoriesLoaded);
  const categoriesError = useStore((s) => s.categoriesError);
  const reloadCategories = useStore((s) => s.reloadCategories);
  const openImdbList = useStore((s) => s.openImdbList);
  const source = useStore((s) => s.status?.provider);
  // The sources' "Top Rated" lists only re-sort today's homepage feed; IMDb's lists replace them.
  const sourceLists = categories.filter((c) => !/top rated/i.test(c.label));
  const browse = useStore((s) => s.browse);
  const resume = useStore((s) => s.resume);
  const openFavorite = useStore((s) => s.openFavorite);
  const go = useStore((s) => s.go);
  const [first, ...rest] = library.continueWatching;

  return (
    <div className="space-y-12 p-8 max-md:space-y-9 max-md:p-4">
      <NoPlayerBanner />
      {first ? <Hero entry={first} /> : <Welcome />}

      {rest.length > 0 && (
        <section>
          <SectionTitle aside={<Button size="sm" variant="quiet" onClick={() => go({ name: 'library', tab: 'history' })}>{t('All history')}</Button>}>{t('Continue watching')}</SectionTitle>
          <div className={gridClass}>
            {rest.slice(0, 12).map((h) => (
              <PosterCard key={h.key} title={h.title} cover={h.cover} progress={progressOf(h) ?? 0} lines={[episodeTag(h.season, h.episode) || h.year, timeAgo(h.timestamp)]} onClick={() => void resume(h)} />
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionTitle>{t('Discover')}</SectionTitle>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4 max-md:grid-cols-2 max-md:gap-3">
          {IMDB_LISTS.map((l) => (
            <DiscoverTile key={l.kind} eyebrow={t(l.eyebrow)} label={l.label} onClick={() => void openImdbList(l.kind)} />
          ))}
          {sourceLists.map((c) => (
            <DiscoverTile key={c.index} eyebrow={`${source ?? t('Source')} · ${tm(c.group)}`} label={c.label} onClick={() => void browse(c)} />
          ))}
          {!categoriesLoaded && [0, 1].map((i) => <div key={`s${i}`} className="skeleton h-[118px] rounded-2xl" />)}
        </div>
        {categoriesLoaded && categoriesError && (
          <p className="mt-3 flex flex-wrap items-center gap-3 text-[12.5px] text-usher">
            {t("{source}: couldn't read its own lists. {error}", { source: source ?? t('Source'), error: categoriesError })}
            <Button size="sm" variant="quiet" onClick={() => void reloadCategories()}>
              {t('Try again')}
            </Button>
          </p>
        )}
        {categoriesLoaded && !categoriesError && sourceLists.length === 0 && (
          <p className="mt-3 text-[12.5px] text-usher">
            {t('{source} has no Discover lists of its own. The IMDb lists work with every source: opening a title looks it up on {source}.', { source: source ?? 'MovieBox' })}
          </p>
        )}
      </section>

      <section>
        <SectionTitle aside={library.favorites.length > 0 && <Button size="sm" variant="quiet" onClick={() => go({ name: 'library', tab: 'favorites' })}>{t('All favorites')}</Button>}>{t('Favorites')}</SectionTitle>
        {library.favorites.length ? (
          <div className={gridClass}>
            {library.favorites.slice(0, 12).map((f) => (
              <PosterCard key={f.key} title={f.title} cover={f.cover} lines={[f.year, f.kind === 'unknown' ? undefined : tm(f.kind)]} onClick={() => void openFavorite(f)} />
            ))}
          </div>
        ) : (
          <Empty title={t('No favorites yet')}>{t('Open any title and press F, or use the star button, to keep it here.')}</Empty>
        )}
      </section>
    </div>
  );
}
