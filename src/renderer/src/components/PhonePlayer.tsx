import { useEffect, useRef, useState } from 'react';
import { Play, X } from 'lucide-react';
import type { PhoneSession } from '@shared/types';
import { mb } from '@/lib/api';
import { t } from '@/lib/i18n';
import { deviceId, isWeb } from '@/lib/platform';

/**
 * A play the engine handed to this phone, in the browser's own video player (an iPhone plays the
 * HLS natively; browsers without HLS get hls.js, loaded only then).
 */
export function PhonePlayer() {
  const [session, setSession] = useState<PhoneSession | null>(null);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!isWeb) return;
    return mb.on((e) => {
      if (e.type === 'phone-play' && e.payload.device === deviceId) {
        setSession(e.payload);
        setStarted(false);
        setError(null);
      } else if (e.type === 'phone-end') setSession((s) => (s?.id === e.payload.id ? null : s));
    });
  }, []);

  useEffect(() => {
    const v = video.current;
    if (!session || !v) return;
    let hls: { destroy(): void } | null = null;
    let disposed = false;
    const cannot = () => setError(t("This stream can't play on this phone."));
    const resume = () => {
      if (session.start > 5 && !session.live) v.currentTime = session.start;
    };
    v.addEventListener('loadedmetadata', resume, { once: true });
    v.addEventListener('error', cannot);
    if (session.kind === 'file' || v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = session.src;
    } else {
      void import('hls.js').then(({ default: Hls }) => {
        if (disposed) return;
        if (!Hls.isSupported()) return cannot();
        const h = new Hls({ startPosition: session.live ? -1 : session.start });
        h.on(Hls.Events.ERROR, (_e, data) => data.fatal && cannot());
        h.loadSource(session.src);
        h.attachMedia(v);
        hls = h;
      });
    }
    // A phone lets a page start sound only from a tap: if this isn't allowed, the big button is.
    v.play().then(
      () => setStarted(true),
      () => setStarted(false),
    );
    // Tells the computer the phone is still watching (also while paused), so it keeps the stream.
    const ping = setInterval(() => void mb.phoneProgress(session.id, v.currentTime, v.paused).catch(() => undefined), 15_000);
    return () => {
      disposed = true;
      clearInterval(ping);
      v.removeEventListener('error', cannot);
      hls?.destroy();
      v.removeAttribute('src');
      v.load();
    };
  }, [session]);

  if (!session) return null;
  const close = () => {
    void mb.phoneStop(session.id).catch(() => undefined);
    setSession(null);
  };
  return (
    <div className="fixed inset-0 z-[90] flex flex-col bg-black" role="dialog" aria-modal="true" aria-label={session.title}>
      <div className="flex items-center gap-3 px-3 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button onClick={close} aria-label={t('Close')} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/10 text-screen">
          <X size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">{session.title}</div>
          <div className="font-mono text-[10.5px] uppercase tracking-wider text-usher">{session.live ? t('Live') : t('On this phone')}</div>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 pb-[env(safe-area-inset-bottom)]">
        <video ref={video} controls playsInline className="h-full w-full bg-black" onPlaying={() => setStarted(true)}>
          {session.kind === 'file' && session.subtitles && <track kind="subtitles" src={session.subtitles} default label={t('Subtitles')} />}
        </video>
        {!started && !error && (
          <button
            onClick={() => void video.current?.play().then(() => setStarted(true), () => undefined)}
            aria-label={t('Play')}
            className="absolute inset-0 m-auto grid h-20 w-20 place-items-center rounded-full bg-bulb text-house shadow-2xl"
          >
            <Play size={34} fill="currentColor" />
          </button>
        )}
        {error && (
          <div className="absolute inset-x-4 top-1/2 -translate-y-1/2 rounded-2xl border border-err/40 bg-velvet p-5 text-center text-[14px] leading-relaxed">
            {error}
            <div className="mt-2 text-[12.5px] text-usher">{t('Close this and play it on the computer instead.')}</div>
          </div>
        )}
      </div>
    </div>
  );
}
