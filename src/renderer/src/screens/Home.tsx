import { Info, Play } from 'lucide-react';
import type { HistoryEntry } from '@shared/types';
import { episodeTag, formatDuration, imageUrl, timeAgo } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Poster, PosterCard, gridClass } from '@/components/Poster';
import { SEARCH_INPUT_ID } from '@/components/TitleBar';
import { Button, Empty, Eyebrow, SectionTitle } from '@/components/ui';
import { NoPlayerBanner } from '@/components/Setup';

const progressOf = (h: HistoryEntry) => (h.durationSeconds && h.progressSeconds ? h.progressSeconds / h.durationSeconds : undefined);

function progressLine(h: HistoryEntry) {
  const parts = [episodeTag(h.season, h.episode)];
  if (h.progressSeconds) parts.push(h.durationSeconds ? `${formatDuration(h.progressSeconds)} of ${formatDuration(h.durationSeconds)}` : `${formatDuration(h.progressSeconds)} in`);
  else parts.push('Not started');
  return parts.filter(Boolean).join('  ·  ');
}

function Hero({ entry }: { entry: HistoryEntry }) {
  const resume = useStore((s) => s.resume);
  const openTitle = useStore((s) => s.openTitle);
  const bg = imageUrl(entry.cover);
  return (
    <section className="relative isolate overflow-hidden rounded-3xl border border-seam/70">
      {bg && <img src={bg} alt="" className="absolute inset-0 -z-10 h-full w-full scale-110 object-cover opacity-35 blur-2xl" />}
      <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,var(--color-house)_18%,rgb(22_13_18/0.65)_60%,rgb(22_13_18/0.2))]" />
      <div className="flex items-end gap-8 p-8">
        <Poster src={entry.cover} title={entry.title} className="aspect-[2/3] w-[168px] shrink-0 rounded-xl shadow-2xl ring-1 ring-seam" />
        <div className="min-w-0 pb-1">
          <Eyebrow className="text-bulb">Pick up where you left off · {timeAgo(entry.timestamp)}</Eyebrow>
          <h1 className="mt-3 font-display text-[64px] font-extrabold uppercase leading-[0.9] tracking-[0.01em] line-clamp-2">{entry.title}</h1>
          <div className="mt-4 font-mono text-[12px] text-usher">{progressLine(entry)}</div>
          {progressOf(entry) !== undefined && (
            <div className="mt-3 h-1 w-72 overflow-hidden rounded-full bg-seam">
              <div className="h-full bg-bulb" style={{ width: `${progressOf(entry)! * 100}%` }} />
            </div>
          )}
          <div className="mt-6 flex gap-2.5">
            <Button variant="primary" size="lg" icon={<Play size={17} fill="currentColor" />} onClick={() => void resume(entry)} focusOnMount>
              Resume
            </Button>
            <Button size="lg" icon={<Info size={17} />} onClick={() => void openTitle({ title: entry.title, year: entry.year, subjectId: entry.subjectId, cover: entry.cover })}>
              Details
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Welcome() {
  return (
    <section className="rounded-3xl border border-seam/70 bg-[radial-gradient(ellipse_at_top_left,var(--color-curtain),var(--color-house)_70%)] p-10">
      <Eyebrow className="text-bulb">Tonight's programme</Eyebrow>
      <h1 className="mt-3 max-w-3xl font-display text-[64px] font-extrabold uppercase leading-[0.9]">Find something to watch</h1>
      <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-usher">
        Search movies, series, anime and Asian dramas. Whatever you start plays in your own player and shows up here next time.
      </p>
      <div className="mt-7">
        <Button variant="primary" size="lg" focusOnMount onClick={() => document.getElementById(SEARCH_INPUT_ID)?.focus()}>
          Start searching
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
      className="marquee group flex h-[118px] flex-col justify-between rounded-2xl border border-seam bg-velvet p-5 text-left transition-colors hover:bg-curtain"
    >
      <Eyebrow>{eyebrow}</Eyebrow>
      <span className="font-display text-[28px] font-extrabold uppercase leading-[0.95] tracking-wide group-hover:text-bulb">{label}</span>
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
    <div className="space-y-12 p-8">
      <NoPlayerBanner />
      {first ? <Hero entry={first} /> : <Welcome />}

      {rest.length > 0 && (
        <section>
          <SectionTitle aside={<Button size="sm" variant="quiet" onClick={() => go({ name: 'library', tab: 'history' })}>All history</Button>}>Continue watching</SectionTitle>
          <div className={gridClass}>
            {rest.slice(0, 12).map((h) => (
              <PosterCard key={h.key} title={h.title} cover={h.cover} progress={progressOf(h) ?? 0} lines={[episodeTag(h.season, h.episode) || h.year, timeAgo(h.timestamp)]} onClick={() => void resume(h)} />
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionTitle>Discover</SectionTitle>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4">
          {IMDB_LISTS.map((l) => (
            <DiscoverTile key={l.kind} eyebrow={l.eyebrow} label={l.label} onClick={() => void openImdbList(l.kind)} />
          ))}
          {sourceLists.map((c) => (
            <DiscoverTile key={c.index} eyebrow={`${source ?? 'Source'} · ${c.group}`} label={c.label} onClick={() => void browse(c)} />
          ))}
          {!categoriesLoaded && [0, 1].map((i) => <div key={`s${i}`} className="skeleton h-[118px] rounded-2xl" />)}
        </div>
        {categoriesLoaded && categoriesError && (
          <p className="mt-3 flex flex-wrap items-center gap-3 text-[12.5px] text-usher">
            Couldn’t read {source ?? 'the source'}’s own lists: {categoriesError}
            <Button size="sm" variant="quiet" onClick={() => void reloadCategories()}>
              Try again
            </Button>
          </p>
        )}
        {categoriesLoaded && !categoriesError && sourceLists.length === 0 && (
          <p className="mt-3 text-[12.5px] text-usher">
            {source ?? 'This source'} has no Discover lists of its own. The IMDb lists work with every source: opening a title looks it up on {source ?? 'the active source'}.
          </p>
        )}
      </section>

      <section>
        <SectionTitle aside={library.favorites.length > 0 && <Button size="sm" variant="quiet" onClick={() => go({ name: 'library', tab: 'favorites' })}>All favorites</Button>}>Favorites</SectionTitle>
        {library.favorites.length ? (
          <div className={gridClass}>
            {library.favorites.slice(0, 12).map((f) => (
              <PosterCard key={f.key} title={f.title} cover={f.cover} lines={[f.year, f.kind === 'unknown' ? undefined : f.kind]} onClick={() => void openFavorite(f)} />
            ))}
          </div>
        ) : (
          <Empty title="No favorites yet">Open any title and press F, or use the star button, to keep it here.</Empty>
        )}
      </section>
    </div>
  );
}
