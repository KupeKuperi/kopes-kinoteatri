import { useEffect, useMemo, useState } from 'react';
import { FileUp, Plus, RefreshCw, X } from 'lucide-react';
import type { TvChannel, TvView } from '@shared/types';
import { errorMessage, imageUrl, mb } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Button, Chip, Empty, ErrorPanel, Eyebrow, Spinner } from '@/components/ui';

function ChannelTile({ ch, onPlay, busy }: { ch: TvChannel; onPlay: () => void; busy: boolean }) {
  const [failed, setFailed] = useState(false);
  const logo = imageUrl(ch.logo);
  return (
    <button data-nav="" onClick={onPlay} disabled={busy} className="marquee flex h-[132px] flex-col justify-between rounded-2xl border border-seam bg-velvet/70 p-4 text-left transition-colors hover:bg-curtain disabled:opacity-60">
      <div className="flex h-12 items-center">
        {logo && !failed ? (
          <img src={logo} alt="" onError={() => setFailed(true)} className="max-h-12 max-w-[120px] object-contain" />
        ) : (
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-curtain font-display text-[20px] font-extrabold uppercase text-bulb">{ch.name.slice(0, 2)}</span>
        )}
      </div>
      <div>
        <div className="line-clamp-2 text-[14px] font-semibold leading-snug">{ch.name}</div>
        {ch.group && <div className="mt-0.5 truncate font-mono text-[10.5px] uppercase tracking-wider text-usher">{ch.group}</div>}
      </div>
    </button>
  );
}

export function LiveTv() {
  const toast = useStore((s) => s.toast);
  const [view, setView] = useState<TvView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [adding, setAdding] = useState(false);
  const [tuning, setTuning] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [group, setGroup] = useState<string | null>(null);

  const load = (force = false) =>
    mb.tv(force).then(
      (v) => {
        setView(v);
        setError(null);
      },
      (e) => setError(errorMessage(e)),
    );
  useEffect(() => {
    void load();
  }, []);

  const groups = useMemo(() => [...new Set((view?.channels ?? []).map((c) => c.group).filter((g): g is string => Boolean(g)))].sort(), [view]);
  const channels = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (view?.channels ?? []).filter((c) => (!group || c.group === group) && (!q || c.name.toLowerCase().includes(q)));
  }, [view, filter, group]);

  const add = async () => {
    const s = source.trim();
    if (!s) return;
    setAdding(true);
    try {
      setView(await mb.tvAddPlaylist(s));
      setSource('');
      toast('success', 'Playlist added', s);
    } catch (e) {
      toast('error', 'Could not add playlist', errorMessage(e));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (p: TvView['playlists'][number]) => {
    if (!window.confirm(`Remove the playlist “${p.name ?? p.source}”?\n\nIts ${p.channelCount ?? ''} channels disappear from Live TV. You can add it again any time.`)) return;
    setRemoving(p.source);
    try {
      setView(await mb.tvRemovePlaylist(p.source));
      toast('success', 'Playlist removed', p.name ?? p.source);
    } catch (e) {
      toast('error', 'Could not remove the playlist', errorMessage(e));
    } finally {
      setRemoving(null);
    }
  };

  const tune = async (ch: TvChannel) => {
    setTuning(ch.name);
    try {
      await mb.tvPlay(ch.name, ch.group);
      toast('info', `Tuning to ${ch.name}`, 'The player opens in a moment.');
    } catch (e) {
      toast('error', `Could not play ${ch.name}`, errorMessage(e));
    } finally {
      setTuning(null);
    }
  };

  return (
    <div className="space-y-8 p-8">
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <Eyebrow>M3U playlists · plays in your player</Eyebrow>
          <h1 className="mt-2 font-display text-[44px] font-extrabold uppercase leading-none tracking-wide">Live TV</h1>
        </div>
        <form
          className="flex w-full max-w-[560px] items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="Playlist URL or file path (.m3u)"
            spellCheck={false}
            className="h-10 min-w-0 flex-1 rounded-lg border border-seam bg-velvet px-3 text-[13.5px] outline-none placeholder:text-dim focus:border-bulb/60"
          />
          <Button type="button" variant="quiet" aria-label="Choose a playlist file" icon={<FileUp size={16} />} onClick={async () => { const f = await mb.pickFile(); if (f) setSource(f); }} />
          <Button type="submit" variant="primary" busy={adding} icon={<Plus size={16} />} disabled={!source.trim() || adding}>
            Add playlist
          </Button>
        </form>
      </header>

      {error && <ErrorPanel title="Couldn't read playlists" message={error} onRetry={() => void load(true)} />}

      {view && view.playlists.length > 0 && (
        <section className="flex flex-wrap items-center gap-2">
          <Eyebrow className="mr-2">Playlists</Eyebrow>
          {view.playlists.map((p) => (
            <span key={p.source} title={p.source} className="flex max-w-[380px] items-center gap-1 rounded-full border border-seam bg-velvet py-1 pl-3 pr-1 font-mono text-[11px] text-usher">
              <span className="truncate">{p.name} · {p.channelCount ?? '?'} ch</span>
              <button
                data-nav=""
                aria-label={`Remove playlist ${p.name ?? p.source}`}
                title="Remove this playlist"
                disabled={Boolean(removing) || Boolean(tuning)}
                onClick={() => void remove(p)}
                className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-dim hover:bg-curtain hover:text-err disabled:opacity-40"
              >
                {removing === p.source ? <Spinner /> : <X size={13} />}
              </button>
            </span>
          ))}
          <Button size="sm" variant="quiet" icon={<RefreshCw size={13} />} onClick={() => void load(true)}>
            Reload
          </Button>
        </section>
      )}

      {!view && !error && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
          {Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton h-[132px] rounded-2xl" />)}
        </div>
      )}

      {view && view.channels.length === 0 && <Empty title="No channels yet">{view.message} Paste a playlist URL or pick an .m3u file above.</Empty>}

      {view && view.channels.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter ${view.channels.length} channels`}
              className="h-8 w-60 rounded-full border border-seam bg-velvet px-3.5 text-[13px] outline-none placeholder:text-dim focus:border-bulb/60"
            />
            <Chip active={!group} onClick={() => setGroup(null)}>All</Chip>
            {groups.slice(0, 24).map((g) => (
              <Chip key={g} active={group === g} onClick={() => setGroup(g)}>{g}</Chip>
            ))}
            {tuning && (
              <span className="ml-auto flex items-center gap-2 font-mono text-[12px] text-usher">
                <Spinner /> Tuning to {tuning}…
              </span>
            )}
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {channels.slice(0, 600).map((ch) => (
              <ChannelTile key={ch.index} ch={ch} busy={Boolean(tuning)} onPlay={() => void tune(ch)} />
            ))}
          </div>
          {channels.length > 600 && <div className="font-mono text-[11px] text-usher">Showing 600 of {channels.length}. Filter to narrow the list.</div>}
        </>
      )}
    </div>
  );
}
