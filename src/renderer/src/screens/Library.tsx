import { Info, Monitor, Play, Trash2 } from 'lucide-react';
import type { HistoryEntry } from '@shared/types';
import { episodeTag, errorMessage, formatDuration, mb, timeAgo } from '@/lib/api';
import { t, tm } from '@/lib/i18n';
import { isWeb } from '@/lib/platform';
import { useRoute, useStore } from '@/lib/store';
import { Poster, PosterCard, gridClass } from '@/components/Poster';
import { Button, Empty, Eyebrow } from '@/components/ui';

function HistoryRow({ h }: { h: HistoryEntry }) {
  const resume = useStore((s) => s.resume);
  const resumeOnComputer = useStore((s) => s.resumeOnComputer);
  const openTitle = useStore((s) => s.openTitle);
  const toast = useStore((s) => s.toast);
  const pct = h.durationSeconds && h.progressSeconds ? h.progressSeconds / h.durationSeconds : null;
  return (
    <li className="flex items-center gap-4 rounded-2xl border border-seam/70 bg-velvet/50 p-3 pr-4 max-md:flex-wrap max-md:gap-3 max-md:pr-3">
      <Poster src={h.cover} title={h.title} className="aspect-[2/3] w-14 shrink-0 rounded-lg ring-1 ring-seam" />
      <div className="min-w-0 flex-1 max-md:basis-[calc(100%-4.5rem)]">
        <div className="truncate text-[15px] font-semibold">{h.title}</div>
        <div className="mt-1 font-mono text-[11px] text-usher">
          {[
            episodeTag(h.season, h.episode),
            h.release?.trim().replace(/^S\d+E\d+\s*/i, ''),
            h.completed ? t('Watched') : h.progressSeconds ? t('{time} in', { time: formatDuration(h.progressSeconds) }) : t('Not started'),
            timeAgo(h.timestamp),
          ]
            .filter(Boolean)
            .join('  ·  ')}
        </div>
        {pct !== null && (
          <div className="mt-2 h-1 w-48 max-w-full overflow-hidden rounded-full bg-seam">
            <div className="h-full bg-bulb" style={{ width: `${pct * 100}%` }} />
          </div>
        )}
      </div>
      <Button size="sm" variant="primary" icon={<Play size={13} fill="currentColor" />} onClick={() => void resume(h)}>
        {t('Resume')}
      </Button>
      {isWeb && <Button size="sm" variant="quiet" icon={<Monitor size={14} />} aria-label={t('Resume on the computer')} onClick={() => void resumeOnComputer(h)} />}
      <Button size="sm" icon={<Info size={14} />} onClick={() => void openTitle({ title: h.title, year: h.year, subjectId: h.subjectId, cover: h.cover })}>
        {t('Details')}
      </Button>
      <Button
        size="sm"
        variant="quiet"
        aria-label={t('Remove {title} from history', { title: h.title })}
        icon={<Trash2 size={14} />}
        onClick={() => mb.removeFromHistory(h).catch((e) => toast('error', t('Could not remove'), errorMessage(e)))}
      />
    </li>
  );
}

export function Library() {
  const route = useRoute();
  const go = useStore((s) => s.go);
  const library = useStore((s) => s.library);
  const openFavorite = useStore((s) => s.openFavorite);
  const tab = route.tab === 'favorites' ? 'favorites' : 'history';

  return (
    <div className="p-8 max-md:p-4">
      <Eyebrow>{t('Saved by moviebox-tui on this computer')}</Eyebrow>
      <div className="mt-2 flex items-end gap-6">
        {(['history', 'favorites'] as const).map((tab_) => (
          <button
            key={tab_}
            data-nav=""
            onClick={() => go({ name: 'library', tab: tab_ })}
            className={`font-display text-[44px] font-extrabold uppercase leading-none tracking-wide transition-colors max-md:text-[28px] ${tab === tab_ ? 'text-screen' : 'text-dim hover:text-usher'}`}
          >
            {tab_ === 'history' ? t('History') : t('Favorites')}
            <span className="ml-2 align-top font-mono text-[12px] font-normal">{tab_ === 'history' ? library.history.length : library.favorites.length}</span>
          </button>
        ))}
      </div>

      <div className="mt-8">
        {tab === 'history' ? (
          library.history.length ? (
            <ul className="space-y-2.5">
              {library.history.map((h) => <HistoryRow key={h.key} h={h} />)}
            </ul>
          ) : (
            <Empty title={t('Nothing watched yet')}>{t('Titles you play from here or from the terminal app appear in this list, with where you stopped.')}</Empty>
          )
        ) : library.favorites.length ? (
          <div className={gridClass}>
            {library.favorites.map((f) => (
              <PosterCard key={f.key} title={f.title} cover={f.cover} lines={[f.year, f.kind === 'unknown' ? undefined : tm(f.kind)]} onClick={() => void openFavorite(f)} />
            ))}
          </div>
        ) : (
          <Empty title={t('No favorites yet')}>{t('Open any title and press F to keep it here.')}</Empty>
        )}
      </div>
    </div>
  );
}
