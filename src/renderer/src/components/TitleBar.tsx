import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, History, Search } from 'lucide-react';
import type { ResultItem, ResultsView, Suggestion } from '@shared/types';
import { imageUrl, mb } from '@/lib/api';
import { q as quote, t, tm, tn, useLang } from '@/lib/i18n';
import { isMac, isTouch, isWeb, keyNames } from '@/lib/platform';
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

/** ქარ | ENG: the window's language, switched at once and remembered. */
export function LanguageToggle({ className = '' }: { className?: string }) {
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  return (
    <div role="group" aria-label={t('Language')} className={`no-drag flex h-8 shrink-0 items-center rounded-lg border border-seam bg-velvet p-0.5 ${className}`}>
      {(['ka', 'en'] as const).map((l) => (
        <button
          key={l}
          aria-pressed={lang === l}
          title={l === 'ka' ? t('Switch to Georgian') : t('Switch to English')}
          onClick={() => setLang(l)}
          className={`h-full rounded-md px-2 font-mono text-[10.5px] tracking-wider transition-colors max-md:px-1.5 max-md:text-[10px] ${lang === l ? 'bg-curtain text-bulb' : 'text-usher hover:text-screen'}`}
        >
          {l === 'ka' ? 'ქარ' : 'ENG'}
        </button>
      ))}
    </div>
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
  const streamAddons = useStore((s) => s.env?.streamAddons.length ?? 0);
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

  // Without an add-on that provides streams, the Addons source can only list titles.
  const sources = providers.filter((p) => p.toLowerCase() !== 'addons' || streamAddons > 0 || p === provider);

  let section = '';
  const heading = (row: Row) => {
    const name =
      row.kind === 'live' ? t('Found on {source}', { source: provider ?? 'MovieBox' })
      : row.kind === 'known' ? t('Similar titles')
      : row.kind === 'recent' ? t('Recent searches')
      : '';
    if (!name || name === section) return null;
    section = name;
    return <div className="px-3 pb-1 pt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-dim">{name}</div>;
  };

  return (
    // macOS draws its window buttons at the left of this bar, Windows its caption buttons at the right.
    <header
      className={`flex shrink-0 items-center border-b border-seam/60 bg-house ${
        // A phone's browser: room for its status bar; the desktop: room for the window buttons.
        isWeb ? 'gap-2 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] md:gap-4 md:px-5' : `drag h-11 gap-4 ${isMac ? 'pl-24 pr-5' : 'pl-5 pr-[150px]'}`
      }`}
    >
      <div className="w-[176px] shrink-0 whitespace-nowrap font-display text-[17px] font-extrabold uppercase leading-none tracking-[0.08em] max-md:hidden">
        {t("Kope's")} <span className="text-bulb">{t('Kinoteatri')}</span>
      </div>
      {/* min-w-0: on a phone the box gives way, so the bar never gets wider than the screen. */}
      <div className="no-drag relative mx-auto w-full min-w-0 max-w-[560px]">
        <form
          className={`flex h-8 items-center gap-2 border border-seam bg-velvet px-3 max-md:h-10 ${open ? 'rounded-t-lg border-bulb/60' : 'rounded-lg'} focus-within:border-bulb/60`}
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
            placeholder={t('Search movies, series & anime')}
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded={open}
            aria-controls="search-suggestions"
            aria-activedescendant={open ? `suggestion-${active}` : undefined}
            // 16 px on phones: a smaller font makes iOS zoom the page in on every tap.
            className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-dim max-md:text-[16px]"
          />
          {liveLoading ? <Spinner /> : !isWeb && !isTouch && <Kbd>{keyNames.command} K</Kbd>}
        </form>

        {open && (
          <div
            id="search-suggestions"
            role="listbox"
            onMouseDown={(e) => e.preventDefault()}
            className="absolute inset-x-0 top-8 z-50 max-h-[70vh] overflow-y-auto rounded-b-xl border border-t-0 border-bulb/60 bg-velvet pb-1.5 shadow-2xl max-md:top-10"
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
                        {tn('Search for {query}', { query: <span className="font-semibold">{quote(row.text)}</span> })}
                      </span>
                      {!isWeb && !isTouch && <Kbd>Enter</Kbd>}
                    </>
                  )}
                  {row.kind === 'recent' && (
                    <>
                      <History size={15} className="shrink-0 text-usher" />
                      <span className="min-w-0 flex-1 truncate text-[13.5px] text-screen/90">{row.text}</span>
                    </>
                  )}
                  {(row.kind === 'live' || row.kind === 'known') && (() => {
                    const it = row.kind === 'live' ? row.item : row.s;
                    const kind = row.kind === 'live' ? row.item.type : row.s.kind;
                    return (
                      <>
                        <Thumb src={it.cover} title={it.title} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-semibold">{it.title}</span>
                          <span className="block font-mono text-[10.5px] uppercase tracking-wider text-usher">
                            {[it.year, kind && tm(kind), row.kind === 'live' && row.item.rating ? `★ ${row.item.rating}` : undefined].filter(Boolean).join(' · ')}
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
                <Spinner /> {t('Searching {source}…', { source: provider ?? 'MovieBox' })}
              </div>
            )}
          </div>
        )}
      </div>
      {sources.length > 1 && (
        <div ref={menuRef} className="no-drag relative shrink-0">
          <button
            onClick={() => setMenu(!menu)}
            className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 font-mono text-[11px] uppercase tracking-wider text-usher hover:bg-velvet hover:text-screen max-md:gap-0.5 max-md:px-1 max-md:text-[10px]"
            title={t('Streaming source')}
          >
            <span className="max-w-[110px] truncate max-md:max-w-[64px]">{provider ?? sources[0]}</span>
            <ChevronDown size={13} className="shrink-0" />
          </button>
          {menu && (
            <div className="absolute right-0 top-9 z-50 w-44 overflow-hidden rounded-lg border border-seam bg-velvet py-1 shadow-2xl animate-rise">
              {sources.map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    setMenu(false);
                    void setProvider(p);
                  }}
                  className={`flex w-full items-center justify-between px-3 py-2 text-left text-[13px] hover:bg-curtain ${p === provider ? 'text-bulb' : ''}`}
                >
                  {p}
                  {p === provider && <span className="font-mono text-[10px] uppercase">{t('ACTIVE')}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <LanguageToggle />
    </header>
  );
}
