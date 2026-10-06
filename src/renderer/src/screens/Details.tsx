import { useEffect, useState } from 'react';
import { Download, Play, Star, Subtitles } from 'lucide-react';
import type { DetailsView, ImdbRating, StreamOption } from '@shared/types';
import { formatBytes, imageUrl, imdbPoster, mb } from '@/lib/api';
import { isTyping } from '@/lib/nav';
import { useRoute, useStore } from '@/lib/store';
import { Poster } from '@/components/Poster';
import { Button, Chip, ErrorPanel, Eyebrow, Spinner } from '@/components/ui';

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
    <div className="relative isolate p-8">
      <Backdrop cover={pending?.cover} />
      <div className="flex gap-9">
        <Poster src={pending?.cover} title={pending?.title ?? ''} className="aspect-[2/3] w-[220px] shrink-0 rounded-2xl shadow-2xl ring-1 ring-seam" />
        <div className="flex-1 pt-3">
          <Eyebrow>{[pending?.type, pending?.year].filter(Boolean).join(' · ')}</Eyebrow>
          <h1 className="mt-3 font-display text-[60px] font-extrabold uppercase leading-[0.9]">{pending?.title}</h1>
          <div className="mt-6 flex items-center gap-2 font-mono text-[12px] text-usher">
            <Spinner /> {tuiStatus ?? activity ?? 'Opening…'}
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

function StreamsTable({ view, busy }: { view: DetailsView; busy: boolean }) {
  const play = useStore((s) => s.play);
  const download = useStore((s) => s.download);
  const { state, streams } = view;

  if (state.streamsStatus === 'loading') return <StreamsLoading source={view.info?.provider} />;
  if (state.streamsStatus === 'choose-audio') {
    return <div className="rounded-2xl border border-dashed border-seam p-6 text-[13.5px] text-usher">Choose an audio track above to see its streams.</div>;
  }
  if (!streams.length) {
    const noStreamAddons = /stream add-?ons?/i.test(state.streamsMessage ?? '');
    return (
      <div className="rounded-2xl border border-dashed border-seam p-6 text-[13.5px] leading-relaxed text-usher">
        {noStreamAddons ? (
          <>
            The Addons source only lists titles; it has no add-on installed that provides streams. Switch to MovieBox, 4KHDHub or Dramachi in the
            top-right corner and open the title there to play it.
          </>
        ) : (
          <>
            {state.streamsMessage ?? 'Pick an episode to see its streams.'}{' '}
            {state.streamsStatus === 'empty' && 'Try another episode, another audio track, or another source.'}
          </>
        )}
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
    <div className="overflow-hidden rounded-2xl border border-seam">
      <table className="w-full text-left">
        <thead className="bg-velvet/80 font-mono text-[10px] uppercase tracking-[0.16em] text-dim">
          <tr>
            <th className={th}>Quality</th>
            {has.size && <th className={th}>Size</th>}
            {has.format && <th className={th}>Format</th>}
            {has.audio && <th className={th}>Audio</th>}
            {has.source && <th className={th}>Source</th>}
            {has.release && <th className={th}>Release</th>}
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
              {has.audio && <td className="px-4 py-3 text-[12.5px] text-usher">{s.audio ?? ''}</td>}
              {has.source && <td className="px-4 py-3 text-[13px] text-usher">{s.source ?? ''}</td>}
              {has.release && (
                <td className="max-w-[360px] px-4 py-3 font-mono text-[11px] text-usher" title={s.release} data-selectable>
                  <span className="line-clamp-2 [overflow-wrap:anywhere]">{s.release ?? ''}</span>
                </td>
              )}
              <td className="px-4 py-2.5">
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" variant={s.index === 0 ? 'primary' : 'ghost'} icon={<Play size={13} fill="currentColor" />} disabled={busy} onClick={() => void play(s.index)}>
                    Play
                  </Button>
                  <Button size="sm" variant="quiet" icon={<Download size={14} />} disabled={busy} onClick={() => void download('stream', s.index)} aria-label={`Download ${s.resolution}`}>
                    Download
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
        <Spinner /> Loading streams… {seconds >= 3 && `${seconds}s`}
      </span>
      {seconds >= 6 && (
        <span className="text-[12px] text-dim">
          {source && source !== 'moviebox' ? 'This source looks up every release and can take up to a minute.' : 'Still waiting for the source to answer.'}
        </span>
      )}
    </div>
  );
}

/** A title opened by name (IMDb list, history, favorites) that the active source doesn't have. */
function NotOnSource() {
  const miss = useStore((s) => s.detailsNotFound)!;
  const providers = useStore((s) => s.providers);
  const retry = useStore((s) => s.retryTitleOn);
  const back = useStore((s) => s.back);
  // Addons can't play anything without a stream add-on, so it isn't offered.
  const others = providers.filter((p) => p !== miss.source && p.toLowerCase() !== 'addons');
  return (
    <div className="p-8">
      <div className="max-w-2xl rounded-2xl border border-seam bg-velvet/60 p-7">
        <Eyebrow>Not on {miss.source ?? 'this source'}</Eyebrow>
        <h1 className="mt-2 font-display text-[40px] font-extrabold uppercase leading-[0.95]">{miss.ref.title}</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-usher">
          {miss.source ?? 'The active source'} has no title called “{miss.ref.title}”{miss.ref.year ? ` from ${miss.ref.year}` : ''}.
          {others.length ? ' Look for it on another source:' : ''}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {others.map((p, i) => (
            <Button key={p} variant={i === 0 ? 'primary' : 'ghost'} focusOnMount={i === 0} onClick={() => void retry(p)}>
              Look on {p}
            </Button>
          ))}
          <Button variant="quiet" onClick={back}>
            Back
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
        <Eyebrow className="mr-2">Seasons</Eyebrow>
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
            Season {s.season}
          </Chip>
        ))}
        <Button size="sm" variant="quiet" className="ml-auto" icon={<Download size={14} />} disabled={busy} onClick={() => void download('season', season)}>
          Download season {season}
        </Button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(118px,1fr))] gap-2">
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
              <span className={`font-mono text-[10px] uppercase tracking-[0.16em] ${active ? 'text-bulb' : 'text-dim'}`}>Episode</span>
              <span className="font-display text-[24px] font-bold leading-none">{String(e.episode).padStart(2, '0')}</span>
              {e.title && <span className="truncate text-[11.5px] text-usher">{e.title}</span>}
            </button>
          );
        })}
      </div>
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
  const subtitles = useStore((s) => s.subtitles);
  const { play, download, toggleFavorite, selectAudio, setConsole, back } = useStore.getState();
  const [more, setMore] = useState(false);
  const [imdb, setImdb] = useState<ImdbRating | null>(null);
  const busy = Boolean(busyLabel);

  // IMDb rating for this title (cached after the first lookup).
  const imdbKey = view?.info ? `${view.info.title}|${view.info.year ?? ''}|${view.info.kind}` : '';
  useEffect(() => {
    setImdb(null);
    const v = useStore.getState().details;
    if (!imdbKey || !v?.info) return;
    let stale = false;
    // The screen title is the clean one (cache titles can carry dub tags like "[Hindi]").
    mb.imdbRatings([{ title: v.state.title || v.info.title, year: v.info.year, type: v.info.kind }]).then(
      ([r]) => !stale && setImdb(r ?? null),
      () => undefined,
    );
    return () => void (stale = true);
  }, [imdbKey]);

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
      <div className="p-8">
        <ErrorPanel title="Couldn't open this title" message={error ?? 'Nothing is open.'} onRetry={back} onConsole={() => setConsole(true)} />
      </div>
    );
  }

  const info = view.info;
  // 4KHDHub and Dramachi have no art: IMDb's poster stands in once the title is matched there.
  const cover = info?.cover ?? imdbPoster(imdb?.id);
  const meta = [
    info?.kind === 'series' ? 'Series' : info?.kind === 'movie' ? 'Movie' : undefined,
    info?.year,
    info?.duration,
    imdb ? `IMDb ${imdb.rating.toFixed(1)} · ${compactVotes(imdb.votes)} votes` : info?.rating && `★ ${info.rating}`,
    info?.provider && sourceName(info.provider),
  ].filter(Boolean);
  const facts: Array<[string, string | undefined]> = [
    ['Director', info?.director],
    ['Cast', info?.cast],
    ['Audio', info?.languages],
    ['Formats', info?.formats],
  ];
  const audioLabels = view.state.audioLabels;

  return (
    <div className="relative isolate p-8">
      <Backdrop cover={cover} />
      <div className="flex gap-9">
        <Poster src={cover} title={view.state.title} className="aspect-[2/3] w-[220px] shrink-0 self-start rounded-2xl shadow-2xl ring-1 ring-seam" />
        <div className="min-w-0 flex-1 pt-3">
          <Eyebrow>{meta.join('  ·  ')}</Eyebrow>
          <h1 className="mt-3 font-display text-[60px] font-extrabold uppercase leading-[0.9] tracking-[0.01em]" data-selectable>
            {view.state.title}
          </h1>
          {info?.description && (
            <p className={`mt-5 max-w-3xl text-[15px] leading-relaxed text-screen/85 ${more ? '' : 'line-clamp-3'}`} data-selectable>
              {info.description}
            </p>
          )}
          {info?.description && info.description.length > 260 && (
            <button className="mt-1 text-[12.5px] text-usher hover:text-screen" onClick={() => setMore(!more)}>
              {more ? 'Less' : 'More'}
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
              Play{view.streams[0] ? ` ${view.streams[0].resolution}` : ''}
            </Button>
            <Button size="lg" icon={<Download size={17} />} disabled={busy || !view.streams.length} onClick={() => void download('stream', 0)}>
              Download
            </Button>
            <Button size="lg" variant="quiet" icon={<Star size={17} fill={view.state.favorite ? 'currentColor' : 'none'} className={view.state.favorite ? 'text-bulb' : ''} />} disabled={busy} onClick={() => void toggleFavorite()}>
              {view.state.favorite ? 'In favorites' : 'Add to favorites'}
            </Button>
            {busy && (
              <span className="ml-2 flex items-center gap-2 font-mono text-[12px] text-usher">
                <Spinner /> {tuiStatus ?? busyLabel}
              </span>
            )}
          </div>
          {!ytDlp && info?.provider === 'moviebox' && (
            <div className="mt-3 font-mono text-[11px] text-dim">Downloads from MovieBox need yt-dlp installed.</div>
          )}
        </div>
      </div>

      <div className="mt-12 space-y-9">
        {audioLabels.length > 1 && (
          <section className="flex flex-wrap items-center gap-2">
            <Eyebrow className="mr-2">Audio</Eyebrow>
            {audioLabels.map((label, i) => (
              <Chip key={label} active={view.state.selectedAudio === i} disabled={busy} onClick={() => void selectAudio(i)}>
                {label}
              </Chip>
            ))}
          </section>
        )}

        <Episodes view={view} busy={busy} />

        <section>
          <div className="mb-3 flex items-baseline gap-3">
            <Eyebrow>Streams</Eyebrow>
            {view.current && info?.kind === 'series' && (
              <span className="font-mono text-[11px] text-usher">
                S{String(view.current.season).padStart(2, '0')} · E{String(view.current.episode).padStart(2, '0')}
              </span>
            )}
          </div>
          <StreamsTable view={view} busy={busy} />
        </section>

        <section className="flex items-start gap-3 rounded-2xl border border-seam/70 bg-velvet/50 p-4">
          <Subtitles size={17} className="mt-0.5 shrink-0 text-usher" />
          <div className="text-[13px] leading-relaxed text-usher">
            {view.captions.length > 0 && (
              <>
                <span className="text-screen">Subtitles for this {info?.kind === 'series' ? 'episode' : 'title'}:</span> {view.captions.map((c) => c.language).join(', ')}.{' '}
              </>
            )}
            {subtitles === 'ask'
              ? 'You choose the subtitles each time you play or download.'
              : subtitles === 'off'
                ? 'Plays without subtitles.'
                : `${subtitles} subtitles load automatically when there are some; otherwise you choose.`}{' '}
            <button className="text-screen/80 underline decoration-seam underline-offset-2 hover:text-screen" onClick={() => useStore.getState().go({ name: 'settings' })}>
              Change
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
