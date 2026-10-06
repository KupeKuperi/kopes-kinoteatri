import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, History, Search } from 'lucide-react';
import type { ResultItem, ResultsView, Suggestion } from '@shared/types';
import { imageUrl, mb } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Kbd, Spinner } from './ui';

export const SEARCH_INPUT_ID = 'global-search';

type Row =
  | { kind: 'search'; text: string }
  | { kind: 'live'; item: ResultItem; view: ResultsView }
  | { kind: 'known'; s: Suggestion }
  | { kind: 'recent'; text: string };

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const LIVE_DELAY = 450;

function Thumb({ src, title }: { src?: string; title: string }) {
  const url = imageUrl(src);
  return url ? (
    <img src={url} alt="" className="h-[42px] w-[28px] shrink-0 rounded object-cover ring-1 ring-seam" draggable={false} />
  ) : (
    <span className="flex h-[42px] w-[28px] shrink-0 items-center justify-center rounded bg-curtain font-display text-[13px] font-bold uppercase text-usher">{title.slice(0, 1)}</span>
  );
}

export function TitleBar() {
  const search = useStore((s) => s.search);
  const openTitle = useStore((s) => s.openTitle);
  const openFromView = useStore((s) => s.openFromView);
  const recent = useStore((s) => s.recent);
  const providers = useStore((s) => s.providers);
  const provider = useStore((s) => s.status?.provider);
  const setProvider = useStore((s) => s.setProvider);
  // Only searches put their text in the box (not Discover or IMDb list names).
  const lastQuery = useStore((s) => (s.results?.source === 'search' ? s.results.requested ?? s.results.label : null));

  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [known, setKnown] = useState<Suggestion[]>([]);
  const [live, setLive] = useState<{ query: string; view: ResultsView } | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const isMac = window.mb.platform === 'darwin';

  // Posters and ratings for live results arrive a moment after the list itself.
  useEffect(
    () =>
      mb.on((e) => {
        if (e.type === 'results') setLive((l) => (l && l.query === e.payload.label ? { query: l.query, view: e.payload } : l));
      }),
    [],
  );

  // Show the query of the result page you are on — unless you are typing.
  useEffect(() => {
    if (lastQuery && document.activeElement !== inputRef.current) setQ(lastQuery);
  }, [lastQuery]);

  // Instant suggestions on every keystroke; a live search once typing pauses.
  useEffect(() => {
    const text = q.trim();
    setActive(0);
    if (!focused || text.length < 2) {
      setKnown([]);
      setLiveLoading(false);
      return;
    }
    let stale = false;
    void mb.suggest(text).then((s) => !stale && setKnown(s), () => undefined);
    if (text.length < 3 || live?.query === text) {
      setLiveLoading(false);
      return () => void (stale = true);
    }
    const timer = setTimeout(() => {
      setLiveLoading(true);
      mb.suggestLive(text).then(
        (view) => {
          if (stale) return;
          if (view) setLive({ query: text, view });
          setLiveLoading(false);
        },
        () => !stale && setLiveLoading(false),
      );
    }, LIVE_DELAY);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [q, focused]);

  const rows = useMemo<Row[]>(() => {
    const text = q.trim();
    if (!text) return recent.slice(0, 6).map((r) => ({ kind: 'recent', text: r }));
    const out: Row[] = [{ kind: 'search', text }];
    const liveRows = live && norm(live.query) === norm(text) ? live.view.items.slice(0, 6) : [];
    const seen = new Set(liveRows.map((i) => `${norm(i.title)}|${i.year ?? ''}`));
    for (const item of liveRows) out.push({ kind: 'live', item, view: live!.view });
    for (const s of known) {
      const key = `${norm(s.title)}|${s.year ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: 'known', s });
      if (out.length >= 11) break;
    }
    for (const r of recent) {
      if (r !== text && norm(r).includes(norm(text)) && out.length < 13) out.push({ kind: 'recent', text: r });
    }
    return out;
  }, [q, live, known, recent]);

  const open = focused && rows.length > 0;

  const activate = (row: Row | undefined) => {
    if (!row) return;
    inputRef.current?.blur();
    if (row.kind === 'search') void search(row.text);
    else if (row.kind === 'recent') {
      setQ(row.text);
      void search(row.text);
    } else if (row.kind === 'live') void openFromView(row.view, row.item);
    else void openTitle({ title: row.s.title, year: row.s.year, subjectId: row.s.subjectId, cover: row.s.cover });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      inputRef.current?.blur();
    }
  };

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  let section = '';
  const heading = (row: Row) => {
    const name = row.kind === 'live' ? `From ${provider ?? 'MovieBox'}` : row.kind === 'known' ? 'Similar titles' : row.kind === 'recent' ? 'Recent searches' : '';
    if (!name || name === section) return null;
    section = name;
    return <div className="px-3 pb-1 pt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-dim">{name}</div>;
  };

  return (
    <header className={`drag flex h-11 shrink-0 items-center gap-4 border-b border-seam/60 bg-house ${isMac ? 'pl-24' : 'pl-5'} pr-[150px]`}>
      <div className="w-[176px] shrink-0 whitespace-nowrap font-display text-[17px] font-extrabold uppercase leading-none tracking-[0.08em]">
        Kope's <span className="text-bulb">Kinoteatri</span>
      </div>
      <div className="no-drag relative mx-auto w-full max-w-[560px]">
        <form
          className={`flex h-8 items-center gap-2 border border-seam bg-velvet px-3 ${open ? 'rounded-t-lg border-bulb/60' : 'rounded-lg'} focus-within:border-bulb/60`}
          onSubmit={(e) => {
            e.preventDefault();
            activate(rows[active] ?? (q.trim() ? { kind: 'search', text: q.trim() } : undefined));
          }}
        >
          <span className="font-mono text-[13px] text-bulb">❯</span>
          <input
            ref={inputRef}
            id={SEARCH_INPUT_ID}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={onKeyDown}
            placeholder="Search movies, series & anime"
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded={open}
            aria-controls="search-suggestions"
            aria-activedescendant={open ? `suggestion-${active}` : undefined}
            className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-dim"
          />
          {liveLoading ? <Spinner /> : <Kbd>Ctrl K</Kbd>}
        </form>

        {open && (
          <div
            id="search-suggestions"
            role="listbox"
            onMouseDown={(e) => e.preventDefault()}
            className="absolute inset-x-0 top-8 z-50 max-h-[70vh] overflow-y-auto rounded-b-xl border border-t-0 border-bulb/60 bg-velvet pb-1.5 shadow-2xl"
          >
            {rows.map((row, i) => (
              <div key={i}>
                {heading(row)}
                <button
                  id={`suggestion-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => activate(row)}
                  className={`flex w-full items-center gap-3 px-3 text-left ${row.kind === 'live' || row.kind === 'known' ? 'py-1.5' : 'py-2'} ${i === active ? 'bg-curtain' : ''}`}
                >
                  {row.kind === 'search' && (
                    <>
                      <Search size={15} className="shrink-0 text-bulb" />
                      <span className="min-w-0 flex-1 truncate text-[13.5px]">
                        Search for <span className="font-semibold">“{row.text}”</span>
                      </span>
                      <Kbd>Enter</Kbd>
                    </>
                  )}
                  {row.kind === 'recent' && (
                    <>
                      <History size={15} className="shrink-0 text-usher" />
                      <span className="min-w-0 flex-1 truncate text-[13.5px] text-screen/90">{row.text}</span>
                    </>
                  )}
                  {(row.kind === 'live' || row.kind === 'known') && (() => {
                    const t = row.kind === 'live' ? row.item : row.s;
                    const kind = row.kind === 'live' ? row.item.type : row.s.kind;
                    return (
                      <>
                        <Thumb src={t.cover} title={t.title} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-semibold">{t.title}</span>
                          <span className="block font-mono text-[10.5px] uppercase tracking-wider text-usher">
                            {[t.year, kind, row.kind === 'live' && row.item.rating ? `★ ${row.item.rating}` : undefined].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                      </>
                    );
                  })()}
                </button>
              </div>
            ))}
            {liveLoading && q.trim().length >= 3 && (
              <div className="flex items-center gap-2 px-3 py-2 font-mono text-[11px] text-usher">
                <Spinner /> Searching {provider ?? 'MovieBox'}…
              </div>
            )}
          </div>
        )}
      </div>
      {providers.length > 1 && (
        <div ref={menuRef} className="no-drag relative">
          <button
            onClick={() => setMenu(!menu)}
            className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 font-mono text-[11px] uppercase tracking-wider text-usher hover:bg-velvet hover:text-screen"
            title="Streaming source"
          >
            {provider ?? providers[0]}
            <ChevronDown size={13} />
          </button>
          {menu && (
            <div className="absolute right-0 top-9 z-50 w-44 overflow-hidden rounded-lg border border-seam bg-velvet py-1 shadow-2xl animate-rise">
              {providers.map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    setMenu(false);
                    void setProvider(p);
                  }}
                  className={`flex w-full items-center justify-between px-3 py-2 text-left text-[13px] hover:bg-curtain ${p === provider ? 'text-bulb' : ''}`}
                >
                  {p}
                  {p === provider && <span className="font-mono text-[10px]">ACTIVE</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </header>
  );
}
