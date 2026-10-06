import { useCallback, useEffect, useState } from 'react';
import { Check, FolderOpen, Play, Square, Subtitles, Trash2 } from 'lucide-react';
import type { DownloadFile } from '@shared/types';
import { errorMessage, formatBytes, mb, timeAgo } from '@/lib/api';
import { q, t, tm, tn } from '@/lib/i18n';
import { isWeb } from '@/lib/platform';
import { useStore } from '@/lib/store';
import { Button, Empty, Eyebrow, SectionTitle } from '@/components/ui';
import { InstallToolButton } from '@/components/Setup';

const subtitleNames = (langs: string[]) => langs.map((l) => l.toUpperCase()).join(', ');

export function Downloads() {
  const active = useStore((s) => s.downloads);
  const env = useStore((s) => s.env);
  const toast = useStore((s) => s.toast);
  const [dir, setDir] = useState('');
  const [files, setFiles] = useState<DownloadFile[] | null>(null);
  const running = active.filter((d) => !d.finished).length;

  const load = useCallback(
    () =>
      mb.downloads().then((r) => {
        setDir(r.dir);
        setFiles(r.files);
      }),
    [],
  );

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), running ? 2000 : 6000);
    return () => clearInterval(t);
  }, [running, load]);

  // The TUI's "cancel" stops the download and keeps what arrived, so downloading it again continues.
  const stop = () => mb.cancelDownloads().catch((e) => toast('error', t('Could not stop the download'), errorMessage(e)));

  const removeUnfinished = async (f: DownloadFile) => {
    const question = t('Delete the unfinished download of {name}?\n\nThe {size} already downloaded is removed; downloading it again starts from the beginning.', {
      name: q(f.name),
      size: formatBytes(f.size),
    });
    if (!window.confirm(question)) return;
    try {
      await mb.deleteUnfinished(f.path);
      await load();
    } catch (e) {
      toast('error', t('Could not delete it'), errorMessage(e));
    }
  };

  return (
    <div className="space-y-10 p-8 max-md:space-y-8 max-md:p-4">
      <header>
        <Eyebrow>{t('Saved to {dir}', { dir: dir || '…' })}</Eyebrow>
        <h1 className="mt-2 font-display text-[44px] font-extrabold uppercase leading-none tracking-wide max-md:text-[28px]">{t('Downloads')}</h1>
      </header>

      {!env?.ytDlp && (
        <div className="rounded-2xl border border-bulb/35 bg-bulb/[0.06] p-5">
          <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-bulb">{t('yt-dlp is not installed')}</div>
          <p className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-screen/85">
            {t('MovieBox streams download through yt-dlp, which isn\'t on this computer, so those downloads stop with “Missing yt-dlp”.')}
          </p>
          <div className={`mt-3 flex flex-wrap items-center gap-3 ${isWeb ? 'hidden' : ''}`}>
            <InstallToolButton tool="yt-dlp" />
            <span className="text-[12.5px] text-usher">
              {tn('or run {command}', {
                command: (
                  <code className="rounded bg-house px-1.5 py-0.5 font-mono text-[12px] text-screen" data-selectable>
                    winget install yt-dlp.yt-dlp
                  </code>
                ),
              })}
            </span>
          </div>
        </div>
      )}

      <section>
        <SectionTitle
          aside={
            running > 0 && (
              <Button size="sm" variant="danger" icon={<Square size={12} fill="currentColor" />} onClick={() => void stop()} title={t('Stops downloading. Download the same title again to continue where it stopped.')}>
                {t('Stop')}
              </Button>
            )
          }
        >
          {t('In progress')}
        </SectionTitle>
        {active.length ? (
          <ul className="space-y-2.5">
            {active.map((d, i) => (
              <li key={i} className="rounded-2xl border border-seam bg-velvet/60 p-4">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="truncate text-[14px] font-semibold" data-selectable>{d.label || t('Download')}</span>
                  {d.finished ? (
                    <span className="flex items-center gap-1.5 font-mono text-[12px] uppercase tracking-wider text-ok"><Check size={15} /> {t('Finished')}</span>
                  ) : (
                    <span className="font-display text-[26px] font-bold leading-none text-bulb">{d.percent !== null ? `${d.percent.toFixed(1)}%` : ''}</span>
                  )}
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-seam">
                  <div className={`h-full rounded-full transition-[width] duration-500 ${d.finished ? 'bg-ok' : 'bg-bulb'}`} style={{ width: `${d.finished ? 100 : (d.percent ?? 0)}%` }} />
                </div>
                {!d.finished && <div className="mt-2 font-mono text-[11px] text-usher">{tm(d.status)}</div>}
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-2xl border border-dashed border-seam p-6 text-[13.5px] text-usher">
            {t("Nothing downloading. Start one from a title's streams, or download a whole season.")}
          </div>
        )}
      </section>

      <section>
        <SectionTitle aside={dir && !isWeb && <Button size="sm" variant="quiet" icon={<FolderOpen size={14} />} onClick={() => void mb.openPath(dir).catch((e) => toast('error', t('Folder not found'), errorMessage(e)))}>{t('Open folder')}</Button>}>
          {t('On this computer')}
        </SectionTitle>
        {files === null ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>
        ) : files.length ? (
          <ul className="divide-y divide-seam/70 overflow-hidden rounded-2xl border border-seam">
            {files.map((f) => (
              <li key={f.path} className="flex items-center gap-4 bg-house/40 px-4 py-3 hover:bg-curtain/40">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px]" title={f.path} data-selectable>{f.name}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-usher">
                    <span>{formatBytes(f.size)} · {timeAgo(f.modified / 1000)}</span>
                    {f.subtitles?.length ? (
                      <span className="flex items-center gap-1"><Subtitles size={12} /> {subtitleNames(f.subtitles)}</span>
                    ) : null}
                    {f.partial && <span className="text-bulb">{t('unfinished · download it again to continue')}</span>}
                  </div>
                </div>
                {/* Opening, showing and deleting act on the computer's files: not from a phone. */}
                {isWeb ? null : f.partial ? (
                  <Button size="sm" variant="quiet" icon={<Trash2 size={14} />} onClick={() => void removeUnfinished(f)}>
                    {t('Delete')}
                  </Button>
                ) : (
                  <Button size="sm" icon={<Play size={13} fill="currentColor" />} onClick={() => void mb.openPath(f.path).catch((e) => toast('error', t('Could not open'), errorMessage(e)))}>
                    {t('Open')}
                  </Button>
                )}
                {!isWeb && (
                  <Button size="sm" variant="quiet" icon={<FolderOpen size={14} />} onClick={() => void (f.partial ? mb.openPath(dirOf(f.path)) : mb.revealPath(f.path)).catch((e) => toast('error', t('Folder not found'), errorMessage(e)))}>
                    {t('Show')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={t('No downloaded files')}>
            {t('Finished downloads land in {dir}. You can change the folder in Settings.', { dir: dir || t('the download folder') })}
          </Empty>
        )}
      </section>
    </div>
  );
}

/** Folder of a path (an unfinished download's final file doesn't exist yet, so Show opens its folder). */
const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
