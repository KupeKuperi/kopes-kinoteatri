import { useEffect, useMemo, useState } from 'react';
import type { ImdbRating, Suggestion } from '@shared/types';
import { imdbPoster, mb } from '@/lib/api';
import { useStore } from '@/lib/store';
import { PosterCard, PosterSkeleton, gridClass } from '@/components/Poster';
import { Chip, Empty, ErrorPanel, Eyebrow, Spinner } from '@/components/ui';

type Filter = 'all' | 'movie' | 'series';

export function Results() {
  const results = useStore((s) => s.results);
  const loading = useStore((s) => s.resultsLoading);
  const error = useStore((s) => s.resultsError);
  const tuiStatus = useStore((s) => s.status?.tuiStatus);
  const source = useStore((s) => s.status?.provider);
  const openResult = useStore((s) => s.openResult);
  const search = useStore((s) => s.search);
  const setConsole = useStore((s) => s.setConsole);
  const openTitle = useStore((s) => s.openTitle);
  const [filter, setFilter] = useState<Filter>('all');
  const [similar, setSimilar] = useState<Suggestion[]>([]);
  const [imdb, setImdb] = useState<Record<number, ImdbRating | null>>({});

  // A new list starts unfiltered.
  useEffect(() => setFilter('all'), [results?.key, results?.label, results?.source]);

  const request = useStore((s) => s.resultsRequest);
  // While loading or after a failure there is no list yet: the request says what was asked for.
  const kind = results?.source ?? request?.kind ?? 'search';
  const isImdb = kind === 'imdb';
  const isBrowse = kind === 'browse';
  const label = loading ?? results?.label ?? request?.label ?? '';
  const empty = !loading && results !== null && results.items.length === 0;

  // IMDb ratings for what the source found (looked up once, then cached on disk).
  const itemsKey = results && !isImdb ? `${results.source}|${results.label}|${results.items.length}` : '';
  useEffect(() => {
    setImdb({});
    if (!itemsKey || !results) return;
    let stale = false;
    const items = results.items;
    mb.imdbRatings(items.map((i) => ({ title: i.title, year: i.year, type: i.type }))).then(
      (rs) => !stale && setImdb(Object.fromEntries(rs.map((r, k) => [items[k].index, r]))),
      () => undefined,
    );
    return () => void (stale = true);
  }, [itemsKey]); // results also change when posters arrive; only a new list needs new ratings

  const items = useMemo(() => {
    // Sources without art (4KHDHub, Dramachi) get IMDb's poster once the title is matched there.
    const all = (results?.items ?? []).map((i) => {
      const r = imdb[i.index];
      return r ? { ...i, imdb: r, cover: i.cover ?? imdbPoster(r.id) } : i;
    });
    if (filter === 'all') return all;
    return all.filter((i) => (i.type ?? '').toLowerCase().startsWith(filter === 'movie' ? 'movie' : 'series'));
  }, [results, filter, imdb]);

  // Nothing matched: offer titles with similar names that moviebox-tui has seen before.
  useEffect(() => {
    setSimilar([]);
    if (!empty || !results) return;
    let stale = false;
    void mb.suggest(results.requested ?? results.label).then((s) => !stale && setSimilar(s), () => undefined);
    return () => void (stale = true);
  }, [empty, results]);

  const summary = !results
    ? null
    : isImdb
      ? `${results.total} titles · ${results.message ?? 'ranked by IMDb rating'} · opens on ${source ?? 'the active source'}`
      : isBrowse
        ? `${results.total} titles · from ${results.provider ?? 'the source'}'s current homepage feed`
        : `${results.total} ${results.total === 1 ? 'title' : 'titles'}`;

  return (
    <div className="p-8">
      <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>{isImdb ? 'IMDb' : isBrowse ? 'Browse' : 'Search'}{results?.provider && !isImdb ? ` · ${results.provider}` : ''}</Eyebrow>
          <h1 className="mt-2 font-display text-[44px] font-extrabold uppercase leading-none tracking-wide">
            {isBrowse || isImdb ? label : <>“{label}”</>}
          </h1>
          <div className="mt-2 flex h-5 items-center gap-2 font-mono text-[11.5px] text-usher">
            {loading ? (
              <>
                <Spinner /> {isImdb ? 'Reading IMDb ratings…' : tuiStatus ?? 'Asking the engine…'}
              </>
            ) : (
              summary
            )}
          </div>
        </div>
        {results && results.items.length > 0 && !isImdb && (
          <div className="flex gap-2">
            <Chip active={filter === 'all'} onClick={() => setFilter('all')}>All</Chip>
            <Chip active={filter === 'movie'} onClick={() => setFilter('movie')}>Movies</Chip>
            <Chip active={filter === 'series'} onClick={() => setFilter('series')}>Series</Chip>
          </div>
        )}
      </header>

      {results?.requested && !loading && (
        <div className="mb-6 rounded-xl border border-bulb/30 bg-bulb/[0.06] px-4 py-3 text-[13.5px] text-screen/90">
          No exact match for <span className="font-semibold">“{results.requested}”</span>. Showing results for{' '}
          <span className="font-semibold">“{results.label}”</span>.
        </div>
      )}

      {error && (
        <ErrorPanel
          title={isImdb || isBrowse ? "Couldn't load this list" : "Search didn't finish"}
          message={error}
          onRetry={() => void (request ? request.retry() : search(label))}
          onConsole={() => setConsole(true)}
        />
      )}

      {loading && (
        <div className={gridClass}>
          {Array.from({ length: 12 }, (_, i) => <PosterSkeleton key={i} />)}
        </div>
      )}

      {empty && (
        <>
          <Empty title="Nothing found">
            {results.message ?? `No titles match “${label}”.`} Try fewer words, check the spelling, or switch the source in the top-right corner.
          </Empty>
          {similar.length > 0 && (
            <section className="mt-10">
              <Eyebrow className="mb-4">Titles with a similar name</Eyebrow>
              <div className={gridClass}>
                {similar.map((t) => (
                  <PosterCard
                    key={`${t.title}-${t.year}`}
                    title={t.title}
                    cover={t.cover}
                    lines={[t.year, t.kind]}
                    onClick={() => void openTitle({ title: t.title, year: t.year, subjectId: t.subjectId, cover: t.cover })}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {!loading && results && results.items.length > 0 && items.length === 0 && (
        <Empty title={filter === 'movie' ? 'No movies here' : 'No series here'}>
          These results have no {filter === 'movie' ? 'movies' : 'series'}. Choose All to see everything.
        </Empty>
      )}

      {!loading && items.length > 0 && (
        <div className={gridClass}>
          {items.map((item, i) => (
            <div key={`${item.index}-${item.title}`} className="animate-rise" style={{ animationDelay: `${Math.min(i, 18) * 18}ms` }}>
              <PosterCard
                autoFocus={i === 0}
                title={item.title}
                cover={item.cover}
                imdb={item.imdb?.rating}
                badge={item.rating}
                flags={item.badges}
                lines={[item.year, item.type]}
                onClick={() =>
                  void (isImdb ? openTitle({ title: item.title, year: item.year, cover: item.cover, imdb: item.imdb }) : openResult(item))
                }
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
