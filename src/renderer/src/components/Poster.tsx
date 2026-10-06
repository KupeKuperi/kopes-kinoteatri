import { useEffect, useState } from 'react';
import { imageUrl } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useFocusOnMount } from './ui';

/** Poster art with a typographic fallback when the image is missing or fails. */
export function Poster({ src, title, className = '' }: { src?: string; title: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const url = imageUrl(src);
  // A card can be reused for another title: start over when the picture changes.
  useEffect(() => {
    setFailed(false);
    setLoaded(false);
  }, [url]);
  return (
    <div className={`relative overflow-hidden bg-velvet ${className}`}>
      {(!url || failed) && (
        <div className="absolute inset-0 flex items-end bg-[linear-gradient(160deg,var(--color-curtain),var(--color-velvet))] p-3">
          <span className="font-display text-[22px] font-extrabold uppercase leading-[0.95] tracking-wide text-screen/80 line-clamp-4 max-md:text-[15px]">{title}</span>
        </div>
      )}
      {url && !failed && (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={`h-full w-full object-cover transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
      {url && !failed && !loaded && <div className="skeleton absolute inset-0" />}
    </div>
  );
}

export function PosterCard({
  title,
  cover,
  lines,
  badge,
  imdb,
  flags,
  progress,
  onClick,
  autoFocus,
}: {
  title: string;
  cover?: string;
  lines: Array<string | undefined>;
  /** Source's own rating (shown when there is no IMDb rating). */
  badge?: string;
  imdb?: number;
  flags?: string[];
  progress?: number;
  onClick: () => void;
  autoFocus?: boolean;
}) {
  const ref = useFocusOnMount<HTMLButtonElement>(Boolean(autoFocus));
  return (
    <button ref={ref} data-nav="" onClick={onClick} className="marquee group flex w-full flex-col rounded-xl text-left">
      <div className="relative w-full">
        <Poster src={cover} title={title} className="aspect-[2/3] w-full rounded-xl ring-1 ring-seam transition-transform duration-200 group-hover:-translate-y-0.5" />
        {imdb !== undefined ? (
          <span title={t('IMDb rating')} className="absolute right-2 top-2 rounded-md bg-bulb px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-house shadow">
            IMDb {imdb.toFixed(1)}
          </span>
        ) : (
          badge && (
            <span title={t('Rating from the source')} className="absolute right-2 top-2 rounded-md bg-house/85 px-1.5 py-0.5 font-mono text-[10.5px] text-bulb backdrop-blur-sm">
              ★ {badge}
            </span>
          )
        )}
        {flags?.includes('CAM') && (
          <span
            title={t('Recorded in a cinema: lower picture and sound quality')}
            className="absolute left-2 top-2 rounded-md bg-err/90 px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wider text-house"
          >
            CAM
          </span>
        )}
        {progress !== undefined && (
          <span className="absolute inset-x-2 bottom-2 h-1 overflow-hidden rounded-full bg-house/70">
            <span className="block h-full rounded-full bg-bulb" style={{ width: `${Math.max(4, Math.min(100, progress * 100))}%` }} />
          </span>
        )}
      </div>
      <div className="mt-2.5 px-0.5">
        <div className="line-clamp-2 text-[14px] font-semibold leading-snug max-md:text-[12.5px]">{title}</div>
        <div className="mt-1 truncate font-mono text-[10.5px] uppercase tracking-wider text-usher">{lines.filter(Boolean).join(' · ')}</div>
      </div>
    </button>
  );
}

export function PosterSkeleton() {
  return (
    <div>
      <div className="skeleton aspect-[2/3] w-full rounded-xl" />
      <div className="skeleton mt-3 h-3.5 w-4/5 rounded" />
      <div className="skeleton mt-2 h-2.5 w-1/2 rounded" />
    </div>
  );
}

export const gridClass =
  'grid grid-cols-[repeat(auto-fill,minmax(152px,1fr))] gap-x-5 gap-y-7 max-md:grid-cols-[repeat(auto-fill,minmax(100px,1fr))] max-md:gap-x-3 max-md:gap-y-5';
