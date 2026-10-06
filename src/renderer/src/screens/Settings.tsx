import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { FolderOpen, RotateCw } from 'lucide-react';
import type { GuiSettings, PlayerName, SettingsBundle, TuiSettings } from '@shared/types';
import { errorMessage, mb } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Button, ErrorPanel, Eyebrow, Spinner, Toggle } from '@/components/ui';
import { InstallToolButton } from '@/components/Setup';

const PROVIDER_NAMES: Record<string, string> = {
  moviebox: 'MovieBox',
  fourkhdhub: '4KHDHub',
  dramachi: 'Dramachi — Asian dramas',
  bdix_circleftp: 'CircleFTP (BDIX networks only)',
  bdix_dhakaflix: 'DhakaFlix (BDIX networks only)',
};

/** Languages the engine names subtitles in (its own list, plus Georgian). */
const SUBTITLE_LANGUAGES = [
  'English', 'Arabic', 'Bengali', 'Chinese', 'Czech', 'Danish', 'Dutch', 'Filipino', 'Finnish', 'French', 'Georgian', 'German',
  'Greek', 'Hebrew', 'Hindi', 'Hungarian', 'Indonesian', 'Italian', 'Japanese', 'Korean', 'Malay', 'Norwegian', 'Persian',
  'Polish', 'Portuguese', 'Romanian', 'Russian', 'Spanish', 'Swedish', 'Tamil', 'Telugu', 'Thai', 'Turkish', 'Ukrainian',
  'Urdu', 'Vietnamese',
];

function Group({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <section className="grid grid-cols-[220px_1fr] gap-8 border-t border-seam/70 py-7">
      <div>
        <h2 className="font-display text-[22px] font-extrabold uppercase tracking-wide">{title}</h2>
        {note && <p className="mt-1.5 text-[12.5px] leading-relaxed text-usher">{note}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function PathField({ label, value, placeholder, onChange, pick }: { label: string; value: string; placeholder?: string; onChange: (v: string) => void; pick: () => Promise<string | null> }) {
  return (
    <label className="block py-2">
      <span className="mb-1.5 block text-[13px] text-usher">{label}</span>
      <span className="flex gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className="h-10 min-w-0 flex-1 rounded-lg border border-seam bg-velvet px-3 font-mono text-[12px] outline-none placeholder:text-dim focus:border-bulb/60"
        />
        <Button type="button" icon={<FolderOpen size={15} />} onClick={async () => { const p = await pick(); if (p) onChange(p); }}>
          Browse
        </Button>
      </span>
    </label>
  );
}

export function Settings() {
  const status = useStore((s) => s.status);
  const env = useStore((s) => s.env);
  const refreshStatus = useStore((s) => s.refreshStatus);
  const toast = useStore((s) => s.toast);
  const [saved, setSaved] = useState<SettingsBundle | null>(null);
  const [tui, setTui] = useState<TuiSettings | null>(null);
  const [gui, setGui] = useState<GuiSettings>({ binaryPath: '', subtitles: 'English' });
  const subtitles = useStore((s) => s.subtitles);
  const setSubtitles = useStore((s) => s.setSubtitles);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const downloads = useStore((s) => s.downloads);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshStatus();
    mb.settings().then(
      (b) => {
        setSaved(b);
        setTui(b.tui);
        setGui(b.gui);
      },
      (e) => setError(errorMessage(e)),
    );
  }, [refreshStatus]);

  // The subtitle choice saves on its own (no engine restart), so it never makes the page dirty.
  const dirty = useMemo(
    () => saved && (JSON.stringify(saved.tui) !== JSON.stringify(tui) || saved.gui.binaryPath !== gui.binaryPath),
    [saved, tui, gui],
  );
  const patch = (p: Partial<TuiSettings>) => tui && setTui({ ...tui, ...p });

  const save = async () => {
    setSaving(true);
    try {
      const b = await mb.saveSettings({ tui: tui ?? undefined, gui });
      setSaved(b);
      setTui(b.tui);
      setGui(b.gui);
      toast('success', 'Settings saved', 'The engine restarted with the new settings.');
      // Enabled sources may have changed: the switcher and Discover reload once the engine is ready.
      useStore.setState({ providers: [], categories: [], categoriesLoaded: false });
      setTimeout(() => void refreshStatus(), 1500);
    } catch (e) {
      toast('error', 'Could not save settings', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const players: Array<{ id: PlayerName; label: string; found: string | null | undefined }> = [
    { id: 'vlc', label: 'VLC', found: env?.players.vlc },
    { id: 'mpv', label: 'mpv', found: env?.players.mpv },
    ...(window.mb.platform === 'darwin' ? [{ id: 'iina' as PlayerName, label: 'IINA', found: env?.players.iina }] : []),
  ];

  return (
    <div className="p-8 pb-28">
      <Eyebrow>Shared with the terminal app · {env?.configDir}</Eyebrow>
      <h1 className="mb-8 mt-2 font-display text-[44px] font-extrabold uppercase leading-none tracking-wide">Settings</h1>

      {error && <ErrorPanel title="Couldn't read settings" message={error} />}
      {!tui && !error && <div className="flex items-center gap-2 font-mono text-[12px] text-usher"><Spinner /> Reading config.json…</div>}

      {tui && (
        <>
          <Group title="Playback" note="Everything plays in an external player. The engine passes it the stream, subtitles and resume position.">
            <div className="flex flex-wrap gap-2">
              {players.map((p) => (
                <button
                  key={p.id}
                  data-nav=""
                  onClick={() => patch({ defaultPlayer: p.id })}
                  aria-pressed={tui.defaultPlayer === p.id}
                  className={`w-48 rounded-xl border p-4 text-left transition-colors ${tui.defaultPlayer === p.id ? 'border-bulb/70 bg-bulb/10' : 'border-seam bg-velvet hover:bg-curtain'}`}
                >
                  <div className="font-display text-[24px] font-bold uppercase leading-none">{p.label}</div>
                  <div className={`mt-2 font-mono text-[10.5px] ${p.found ? 'text-ok' : 'text-dim'}`}>{p.found ? 'Installed' : 'Not found'}</div>
                </button>
              ))}
            </div>
            {!env?.players.vlc && window.mb.platform === 'win32' && (
              <div className="mt-3 flex items-center gap-3 text-[12.5px] text-usher">
                <InstallToolButton tool="vlc" /> VLC isn't installed. The engine plays through it (or mpv).
              </div>
            )}
            <label className="mt-5 block">
              <span className="mb-1.5 block text-[13px] text-usher">Subtitles</span>
              <select
                value={subtitles}
                onChange={(e) => void setSubtitles(e.target.value)}
                className="h-10 w-72 rounded-lg border border-seam bg-velvet px-3 text-[13.5px] outline-none [color-scheme:dark] focus:border-bulb/60"
              >
                <option value="ask">Ask every time</option>
                <option value="off">No subtitles</option>
                <optgroup label="Load automatically">
                  {SUBTITLE_LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </optgroup>
              </select>
              <span className="mt-1.5 block text-[12px] text-dim">MovieBox titles come with subtitles. When one lacks this language, you choose. Saved at once.</span>
            </label>
            <PathField label="VLC location (leave empty to detect)" value={tui.vlcPath ?? ''} placeholder={env?.players.vlc ?? 'vlc.exe'} onChange={(v) => patch({ vlcPath: v || null })} pick={() => mb.pickFile(tui.vlcPath ?? undefined)} />
            <PathField label="mpv location (leave empty to detect)" value={tui.mpvPath ?? ''} placeholder={env?.players.mpv ?? 'mpv.exe'} onChange={(v) => patch({ mpvPath: v || null })} pick={() => mb.pickFile(tui.mpvPath ?? undefined)} />
          </Group>

          <Group title="Downloads" note="Episodes and seasons are saved here. MovieBox downloads also need yt-dlp.">
            <PathField label="Download folder" value={tui.downloadDir ?? ''} placeholder={env?.downloadDir} onChange={(v) => patch({ downloadDir: v || null })} pick={() => mb.pickFolder(tui.downloadDir ?? env?.downloadDir)} />
            <div className="mt-2 break-all font-mono text-[11px] text-usher" data-selectable>
              yt-dlp: {env?.ytDlp ?? 'not installed'} · ffmpeg: {env?.ffmpeg ?? 'not installed'}
            </div>
          </Group>

          <Group title="Sources" note="Where searches look. Switch the active one from the top bar.">
            <div className="divide-y divide-seam/60">
              {Object.entries(tui.providers).map(([name, on]) => (
                <Toggle key={name} label={PROVIDER_NAMES[name] ?? name} checked={on} onChange={(v) => patch({ providers: { ...tui.providers, [name]: v } })} />
              ))}
            </div>
          </Group>

          <Group title="Modes">
            <div className="divide-y divide-seam/60">
              <Toggle label="Streaming" hint="Movies, series and anime search." checked={tui.streamingEnabled} onChange={(v) => patch({ streamingEnabled: v })} />
              <Toggle label="Live TV" hint="Channels from your M3U playlists." checked={tui.tvEnabled} onChange={(v) => patch({ tvEnabled: v })} />
              <Toggle label="Update moviebox-tui automatically" hint="The terminal app checks for new releases when it starts." checked={tui.autoUpdate} onChange={(v) => patch({ autoUpdate: v })} />
            </div>
          </Group>

          <Group title="Engine" note="This window drives the moviebox-tui program installed on your computer.">
            <dl className="grid grid-cols-[140px_1fr] gap-y-2 font-mono text-[12px]">
              <dt className="text-usher">Program</dt>
              <dd className="truncate" data-selectable title={status?.binary?.path}>{status?.binary?.path ?? 'Not found'}</dd>
              <dt className="text-usher">Version</dt>
              <dd>{status?.binary?.version ?? '—'}</dd>
              <dt className="text-usher">Status</dt>
              <dd className={status?.state === 'ready' || status?.state === 'busy' ? 'text-ok' : 'text-bulb'}>{status?.error ?? status?.state}</dd>
              <dt className="text-usher">Data folder</dt>
              <dd className="truncate" data-selectable>{env?.dataDir}</dd>
            </dl>
            <PathField label="moviebox-tui location (leave empty to detect)" value={gui.binaryPath} placeholder={status?.binary?.path} onChange={(v) => setGui({ ...gui, binaryPath: v })} pick={() => mb.pickFile(gui.binaryPath || undefined)} />
            <Button
              className="mt-3"
              icon={<RotateCw size={15} />}
              busy={restarting}
              title={downloads.length ? 'Restarting stops the downloads in progress.' : undefined}
              onClick={async () => {
                setRestarting(true);
                try {
                  await mb.restartEngine();
                  await refreshStatus();
                } finally {
                  setRestarting(false);
                }
              }}
            >
              Restart engine
            </Button>
          </Group>
        </>
      )}

      {dirty && (
        <div className="fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-4 rounded-2xl border border-seam bg-velvet/95 px-5 py-3 shadow-2xl backdrop-blur animate-rise">
          <span className="text-[13px] text-usher">
            Saving restarts the engine{downloads.length ? ` and stops ${downloads.length === 1 ? 'the download' : `${downloads.length} downloads`} in progress` : ''}.
          </span>
          <Button variant="quiet" onClick={() => { setTui(saved?.tui ?? null); setGui(saved?.gui ?? { binaryPath: '', subtitles }); }}>Discard</Button>
          <Button variant="primary" busy={saving} onClick={() => void save()}>Save changes</Button>
        </div>
      )}
    </div>
  );
}
