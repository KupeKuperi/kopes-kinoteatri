import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { FolderOpen, Plus, RotateCw, Trash2 } from 'lucide-react';
import { autoSubtitleLanguage, SCOUT_CATEGORIES, SCOUT_CATEGORY_NAMES } from '@shared/scout';
import type { AddonInfo, GuiSettings, PlayerName, ScoutCategory, SettingsBundle, TuiSettings } from '@shared/types';
import { errorMessage, formatBytes, mb } from '@/lib/api';
import { q, t, tm, useLang } from '@/lib/i18n';
import { useStore } from '@/lib/store';
import { Button, Chip, ErrorPanel, Eyebrow, LinkButton, Spinner, Switch, Toggle } from '@/components/ui';
import { PhoneAccess } from '@/components/PhoneAccess';
import { InstallToolButton } from '@/components/Setup';
import { isWeb } from '@/lib/platform';

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
    <section className="grid grid-cols-[220px_1fr] gap-8 border-t border-seam/70 py-7 max-md:grid-cols-1 max-md:gap-4 max-md:py-5">
      <div>
        <h2 className="font-display text-[22px] font-extrabold uppercase tracking-wide">{t(title)}</h2>
        {note && <p className="mt-1.5 text-[12.5px] leading-relaxed text-usher">{t(note)}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function PathField({ label, value, placeholder, onChange, pick }: { label: string; value: string; placeholder?: string; onChange: (v: string) => void; pick: () => Promise<string | null> }) {
  return (
    <label className="block py-2">
      <span className="mb-1.5 block text-[13px] text-usher">{t(label)}</span>
      <span className="flex gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className="h-10 min-w-0 flex-1 rounded-lg border border-seam bg-velvet px-3 font-mono text-[12px] outline-none placeholder:text-dim focus:border-bulb/60"
        />
        <Button type="button" icon={<FolderOpen size={15} />} onClick={async () => { const p = await pick(); if (p) onChange(p); }}>
          {t('Browse')}
        </Button>
      </span>
    </label>
  );
}

/** ქართული / English: applies at once (the window's own setting, nothing restarts). */
function LanguageGroup() {
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  return (
    <Group title="Language" note="The window speaks Georgian or English. Saved at once.">
      <div className="flex flex-wrap gap-2">
        {(
          [
            ['ka', 'ქართული', 'Georgian'],
            ['en', 'English', 'ინგლისური'],
          ] as const
        ).map(([id, name, other]) => (
          <button
            key={id}
            data-nav=""
            onClick={() => setLang(id)}
            aria-pressed={lang === id}
            className={`w-48 rounded-xl border p-4 text-left transition-colors ${lang === id ? 'border-bulb/70 bg-bulb/10' : 'border-seam bg-velvet hover:bg-curtain'}`}
          >
            <div className="font-display text-[24px] font-bold leading-none">{name}</div>
            <div className="mt-2 font-mono text-[10.5px] text-dim">{other}</div>
          </button>
        ))}
      </div>
    </Group>
  );
}

/**
 * Stremio add-ons for the engine's Addons source: paste a link, and its streams show for titles
 * opened on Addons. The engine reads the list when it starts, so every change restarts it.
 */
function AddonsGroup() {
  const toast = useStore((s) => s.toast);
  const running = useStore((s) => s.downloads.filter((d) => !d.finished).length);
  const refreshStatus = useStore((s) => s.refreshStatus);
  const [addons, setAddons] = useState<AddonInfo[] | null>(null);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    mb.addons().then(setAddons, (e) => toast('error', t('Could not read the add-ons'), errorMessage(e)));
  }, [toast]);

  /** Runs a change (which restarts the engine); `key` marks what is busy meanwhile. */
  const change = async (key: string, fn: () => Promise<AddonInfo[]>, done?: (list: AddonInfo[]) => void) => {
    if (running && !window.confirm(t('Changing add-ons restarts the engine and stops the downloads in progress. Continue?'))) return;
    setBusy(key);
    try {
      const list = await fn();
      setAddons(list);
      done?.(list);
      // The engine restarted: the source menu and Discover reload once it is ready.
      useStore.setState({ providers: [], categories: [], categoriesLoaded: false });
      setTimeout(() => void refreshStatus(), 1500);
    } catch (e) {
      toast('error', key === 'add' ? t('Could not add the add-on') : t('Could not change the add-on'), errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const add = () => {
    const url = link.trim();
    if (!url) return;
    let added: AddonInfo | undefined;
    let slow: number | undefined;
    void change(
      'add',
      async () => {
        const r = await mb.addAddon(url);
        added = r.added;
        slow = r.slow;
        return r.addons;
      },
      () => {
        setLink('');
        if (!added) return;
        toast(
          'success',
          t('{name} added', { name: added.name }),
          added.streams ? t('Choose Addons in the source menu (top right) to find titles through it.') : t('It only lists titles. Add one that provides streams to play them.'),
        );
        if (slow) toast('warning', t('{name} is slow', { name: added.name }), t('It took {seconds} s to list streams. The engine waits only 5 s, so its streams may not show.', { seconds: slow }));
      },
    );
  };

  return (
    <Group title="Add-ons" note="Stremio add-ons bring more places to find streams, such as Georgian dubs. They are used when the source is Addons.">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder={t('Add-on link (ends in manifest.json)')}
          spellCheck={false}
          className="h-10 min-w-0 flex-1 rounded-lg border border-seam bg-velvet px-3 font-mono text-[12px] outline-none placeholder:font-sans placeholder:text-[13px] placeholder:text-dim focus:border-bulb/60"
        />
        <Button type="submit" variant="primary" icon={<Plus size={15} />} busy={busy === 'add'} disabled={!link.trim() || Boolean(busy)}>
          {t('Add')}
        </Button>
      </form>
      {!addons ? (
        <div className="mt-4 flex items-center gap-2 font-mono text-[12px] text-usher">
          <Spinner /> {t('Reading the add-ons…')}
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-seam/60 overflow-hidden rounded-xl border border-seam">
          {addons.map((a) => (
            <li key={a.url} className="flex items-center gap-4 bg-house/40 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-[14px] font-semibold">{a.name}</span>
                  {a.version && <span className="font-mono text-[11px] text-dim">v{a.version}</span>}
                  {a.streams && <span className="rounded bg-bulb/15 px-1.5 py-px font-mono text-[10px] uppercase tracking-wider text-bulb">{t('Streams')}</span>}
                  {a.catalog && <span className="rounded bg-curtain px-1.5 py-px font-mono text-[10px] uppercase tracking-wider text-usher">{t('Titles')}</span>}
                  {a.core && <span className="rounded bg-curtain px-1.5 py-px font-mono text-[10px] uppercase tracking-wider text-usher">{t('Built in')}</span>}
                </div>
                {a.description && <div className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-usher">{a.description}</div>}
                <div className="mt-1 truncate font-mono text-[10.5px] text-dim" title={a.url} data-selectable>
                  {a.url}
                </div>
              </div>
              {a.core ? (
                <span className="max-w-[180px] text-right text-[11.5px] leading-snug text-dim">{t('Finds the titles; always on.')}</span>
              ) : (
                <>
                  {busy === a.url && <Spinner />}
                  <Switch
                    checked={a.enabled}
                    disabled={Boolean(busy)}
                    label={a.enabled ? t('Turn off {name}', { name: a.name }) : t('Turn on {name}', { name: a.name })}
                    onChange={(on) => void change(a.url, () => mb.setAddonEnabled(a.url, on))}
                  />
                  <Button
                    size="sm"
                    variant="quiet"
                    aria-label={t('Remove {name}', { name: a.name })}
                    icon={<Trash2 size={14} />}
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (window.confirm(t('Remove the add-on {name}?', { name: q(a.name) }))) void change(a.url, () => mb.removeAddon(a.url));
                    }}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[12px] leading-relaxed text-dim">{t('Add-on streams come without subtitles. Adding or changing an add-on restarts the engine.')}</p>
    </Group>
  );
}

/** The subtitle choice (saved at once, no engine restart): on the computer and on a phone. */
function SubtitleSelect() {
  const subtitles = useStore((s) => s.subtitles);
  const setSubtitles = useStore((s) => s.setSubtitles);
  return (
    <label className="mt-5 block">
      <span className="mb-1.5 block text-[13px] text-usher">{t('Subtitles')}</span>
      <select
        value={subtitles}
        onChange={(e) => void setSubtitles(e.target.value)}
        className="h-10 w-72 max-w-full rounded-lg border border-seam bg-velvet px-3 text-[13.5px] outline-none [color-scheme:dark] focus:border-bulb/60 max-md:text-[16px]"
      >
        <option value="ask">{t('Ask every time')}</option>
        <option value="off">{t('No subtitles')}</option>
        <optgroup label={t('Load automatically')}>
          {SUBTITLE_LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {t(l)}
            </option>
          ))}
        </optgroup>
      </select>
      <span className="mt-1.5 block text-[12px] text-dim">{t('MovieBox titles come with subtitles. When one lacks this language, you choose. Saved at once.')}</span>
    </label>
  );
}

/** "Find elsewhere": links on a title's page, and automatic subtitles. Saved at once. */
function ScoutGroup() {
  const scout = useStore((s) => s.scout);
  const setScout = useStore((s) => s.setScout);
  // Groups stay in their usual order whichever is turned on last.
  const toggle = (c: ScoutCategory) =>
    void setScout({ categories: SCOUT_CATEGORIES.filter((x) => (x === c ? !scout.categories.includes(c) : scout.categories.includes(x))) });
  return (
    <Group
      title="Find elsewhere"
      note="Links on a title's page that search other sites for it: torrents, streaming services, subtitles and more, from the IMDb Scout Mod list. Saved at once."
    >
      <div className="divide-y divide-seam/60">
        <Toggle label={t('Show the links')} hint={t("Below the streams on a title's page.")} checked={scout.enabled} onChange={(v) => void setScout({ enabled: v })} />
        {scout.enabled && (
          <Toggle
            label={t('List every site')}
            hint={t('Otherwise well-known sites come first and the rest are a click away.')}
            checked={scout.allSites}
            onChange={(v) => void setScout({ allSites: v })}
          />
        )}
      </div>
      {scout.enabled && (
        <div className="mt-3">
          <span className="mb-2 block text-[13px] text-usher">{t('Groups')}</span>
          <div className="flex flex-wrap gap-2">
            {SCOUT_CATEGORIES.map((c) => (
              <Chip key={c} active={scout.categories.includes(c)} onClick={() => toggle(c)}>
                {t(SCOUT_CATEGORY_NAMES[c])}
              </Chip>
            ))}
          </div>
          <span className="mt-1.5 block text-[12px] text-dim">{t('Usenet indexers only answer with an account there.')}</span>
        </div>
      )}
      {scout.enabled && <AutoSubtitlesSettings />}
    </Group>
  );
}

/**
 * Subtitles from OpenSubtitles for plays that start without any in your language. They need the
 * engine's players to be the app's stand-ins, so turning them on or off restarts the engine.
 */
function AutoSubtitlesSettings() {
  const scout = useStore((s) => s.scout);
  const subtitles = useStore((s) => s.subtitles);
  const setScout = useStore((s) => s.setScout);
  const [key, setKey] = useState(scout.openSubtitlesKey);
  const saveKey = () => {
    const trimmed = key.trim();
    setKey(trimmed);
    if (trimmed !== scout.openSubtitlesKey) void setScout({ openSubtitlesKey: trimmed });
  };
  const language = autoSubtitleLanguage(scout, subtitles);
  const status = !scout.openSubtitlesKey
    ? t('Needs an OpenSubtitles API key.')
    : subtitles === 'off'
      ? t('Off while the subtitle setting is “No subtitles”.')
      : language
        ? t('On: {language} subtitles.', { language: t(language) })
        : t('Choose their language: “Ask every time” names none.');
  return (
    <div className="mt-5 border-t border-seam/60 pt-2">
      <Toggle
        label={t('Add subtitles automatically')}
        hint={t('When a play starts without subtitles in your language, the app gets them from OpenSubtitles and VLC or mpv loads them. Turning this on or off restarts the engine.')}
        checked={scout.autoSubtitles}
        onChange={(v) => void setScout({ autoSubtitles: v })}
      />
      {scout.autoSubtitles && (
        <>
          <div className={`mb-3 text-[12.5px] ${language ? 'text-ok' : 'text-bulb'}`}>{status}</div>
          <label className="block py-2">
            <span className="mb-1.5 block text-[13px] text-usher">{t('OpenSubtitles API key')}</span>
            <span className="flex gap-2">
              <input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onBlur={saveKey}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                placeholder={t('Paste the key here')}
                spellCheck={false}
                autoComplete="off"
                className="h-10 min-w-0 flex-1 rounded-lg border border-seam bg-velvet px-3 font-mono text-[12px] outline-none placeholder:font-sans placeholder:text-[13px] placeholder:text-dim focus:border-bulb/60"
              />
              <LinkButton href="https://www.opensubtitles.com/en/consumers">{t('Get a free key')}</LinkButton>
            </span>
            <span className="mt-1.5 block text-[12px] leading-relaxed text-dim">
              {t('OpenSubtitles gives one to anyone with an account (API consumers → New consumer). Without signing in it allows about 10 subtitles a day; the app keeps each one it gets.')}
            </span>
          </label>
          <label className="mt-2 block">
            <span className="mb-1.5 block text-[13px] text-usher">{t('Their language')}</span>
            <select
              value={scout.autoSubtitleLanguage}
              onChange={(e) => void setScout({ autoSubtitleLanguage: e.target.value })}
              className="h-10 w-72 max-w-full rounded-lg border border-seam bg-velvet px-3 text-[13.5px] outline-none [color-scheme:dark] focus:border-bulb/60"
            >
              <option value="">{t('Same as the subtitle setting')}</option>
              {SUBTITLE_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {t(l)}
                </option>
              ))}
            </select>
          </label>
          <SubtitleCache />
        </>
      )}
    </div>
  );
}

/** The subtitle files automatic subtitles keep, and a way to delete them. */
function SubtitleCache() {
  const toast = useStore((s) => s.toast);
  const [info, setInfo] = useState<{ files: number; bytes: number } | null>(null);
  useEffect(() => {
    mb.subtitleCache().then(setInfo, () => undefined);
  }, []);
  if (!info) return null;
  return (
    <div className="mt-3 flex items-center gap-3 text-[12.5px] text-usher">
      <span>
        {!info.files
          ? t('No subtitle files kept yet.')
          : info.files === 1
            ? t('One subtitle file kept · {size}', { size: formatBytes(info.bytes) })
            : t('{n} subtitle files kept · {size}', { n: info.files, size: formatBytes(info.bytes) })}
      </span>
      {info.files > 0 && (
        <Button
          size="sm"
          variant="quiet"
          icon={<Trash2 size={14} />}
          onClick={() => mb.clearSubtitleCache().then(setInfo, (e) => toast('error', t('Could not clear them'), errorMessage(e)))}
        >
          {t('Clear')}
        </Button>
      )}
    </div>
  );
}

/** On a phone: what a phone may change. Everything else is the computer's. */
function PhoneSettings() {
  return (
    <div className="p-8 pb-28 max-md:p-4">
      <h1 className="mb-8 mt-2 font-display text-[44px] font-extrabold uppercase leading-none tracking-wide max-md:mb-5 max-md:text-[28px]">{t('Settings')}</h1>
      <LanguageGroup />
      <Group title="Playback">
        <SubtitleSelect />
      </Group>
      <p className="border-t border-seam/70 pt-5 text-[13px] leading-relaxed text-usher">{t('Sources, add-ons, players and downloads are set on the computer.')}</p>
    </div>
  );
}

export function Settings() {
  return isWeb ? <PhoneSettings /> : <ComputerSettings />;
}

function ComputerSettings() {
  const status = useStore((s) => s.status);
  const env = useStore((s) => s.env);
  const refreshStatus = useStore((s) => s.refreshStatus);
  const toast = useStore((s) => s.toast);
  const [saved, setSaved] = useState<SettingsBundle | null>(null);
  const [tui, setTui] = useState<TuiSettings | null>(null);
  const [gui, setGui] = useState<GuiSettings>({ binaryPath: '', subtitles: 'English' });
  const subtitles = useStore((s) => s.subtitles);
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
      // Only what this page edits: the subtitle and "Find elsewhere" choices save on their own, and
      // this page's copy of them is from when it opened.
      const b = await mb.saveSettings({ tui: tui ?? undefined, gui: { binaryPath: gui.binaryPath } });
      setSaved(b);
      setTui(b.tui);
      setGui(b.gui);
      toast('success', t('Settings saved'), t('The engine restarted with the new settings.'));
      // Enabled sources may have changed: the switcher and Discover reload once the engine is ready.
      useStore.setState({ providers: [], categories: [], categoriesLoaded: false });
      setTimeout(() => void refreshStatus(), 1500);
    } catch (e) {
      toast('error', t('Could not save settings'), errorMessage(e));
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
      <Eyebrow>{t('Shared with the terminal app · {dir}', { dir: env?.configDir })}</Eyebrow>
      <h1 className="mb-8 mt-2 font-display text-[44px] font-extrabold uppercase leading-none tracking-wide">{t('Settings')}</h1>

      <LanguageGroup />

      <Group title="Phone" note="Watch on an iPhone or Android phone, or use it as a remote for this computer.">
        <PhoneAccess />
      </Group>

      <ScoutGroup />

      {error && <ErrorPanel title={t("Couldn't read settings")} message={error} />}
      {!tui && !error && <div className="flex items-center gap-2 font-mono text-[12px] text-usher"><Spinner /> {t('Reading config.json…')}</div>}

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
                  <div className={`mt-2 font-mono text-[10.5px] ${p.found ? 'text-ok' : 'text-dim'}`}>{p.found ? t('Installed') : t('Not found')}</div>
                </button>
              ))}
            </div>
            {!env?.players.vlc && (
              <div className="mt-3 flex items-center gap-3 text-[12.5px] text-usher">
                <InstallToolButton tool="vlc" /> {t("VLC isn't installed. The engine plays through it (or mpv).")}
              </div>
            )}
            <SubtitleSelect />
            <PathField label="VLC location (leave empty to detect)" value={tui.vlcPath ?? ''} placeholder={env?.players.vlc ?? 'vlc.exe'} onChange={(v) => patch({ vlcPath: v || null })} pick={() => mb.pickFile(tui.vlcPath ?? undefined)} />
            <PathField label="mpv location (leave empty to detect)" value={tui.mpvPath ?? ''} placeholder={env?.players.mpv ?? 'mpv.exe'} onChange={(v) => patch({ mpvPath: v || null })} pick={() => mb.pickFile(tui.mpvPath ?? undefined)} />
          </Group>

          <Group title="Downloads" note="Episodes and seasons are saved here. MovieBox downloads also need yt-dlp.">
            <PathField label="Download folder" value={tui.downloadDir ?? ''} placeholder={env?.downloadDir} onChange={(v) => patch({ downloadDir: v || null })} pick={() => mb.pickFolder(tui.downloadDir ?? env?.downloadDir)} />
            <div className="mt-2 break-all font-mono text-[11px] text-usher" data-selectable>
              yt-dlp: {env?.ytDlp ?? t('not installed')} · ffmpeg: {env?.ffmpeg ?? t('not installed')}
            </div>
          </Group>

          <Group title="Sources" note="Where searches look. Switch the active one from the top bar.">
            <div className="divide-y divide-seam/60">
              {Object.entries(tui.providers).map(([name, on]) => (
                <Toggle key={name} label={t(PROVIDER_NAMES[name] ?? name)} checked={on} onChange={(v) => patch({ providers: { ...tui.providers, [name]: v } })} />
              ))}
            </div>
          </Group>

          <AddonsGroup />

          <Group title="Modes">
            <div className="divide-y divide-seam/60">
              <Toggle label={t('Streaming')} hint={t('Movies, series and anime search.')} checked={tui.streamingEnabled} onChange={(v) => patch({ streamingEnabled: v })} />
              <Toggle label={t('Live TV')} hint={t('Channels from your M3U playlists.')} checked={tui.tvEnabled} onChange={(v) => patch({ tvEnabled: v })} />
              <Toggle
                label={t('Update moviebox-tui automatically')}
                hint={t('The terminal app checks for new releases when it starts.')}
                checked={tui.autoUpdate}
                onChange={(v) => patch({ autoUpdate: v })}
              />
            </div>
          </Group>

          <Group title="Engine" note="This window drives the moviebox-tui program installed on your computer.">
            <dl className="grid grid-cols-[140px_1fr] gap-y-2 font-mono text-[12px]">
              <dt className="text-usher">{t('Program')}</dt>
              <dd className="truncate" data-selectable title={status?.binary?.path}>{status?.binary?.path ?? t('Not found')}</dd>
              <dt className="text-usher">{t('Version')}</dt>
              <dd>{status?.binary?.version ?? '—'}</dd>
              <dt className="text-usher">{t('Status')}</dt>
              <dd className={status?.state === 'ready' || status?.state === 'busy' ? 'text-ok' : 'text-bulb'}>{status?.error ? tm(status.error) : status?.state && t(status.state)}</dd>
              <dt className="text-usher">{t('Data folder')}</dt>
              <dd className="truncate" data-selectable>{env?.dataDir}</dd>
            </dl>
            <PathField label="moviebox-tui location (leave empty to detect)" value={gui.binaryPath} placeholder={status?.binary?.path} onChange={(v) => setGui({ ...gui, binaryPath: v })} pick={() => mb.pickFile(gui.binaryPath || undefined)} />
            <Button
              className="mt-3"
              icon={<RotateCw size={15} />}
              busy={restarting}
              title={downloads.length ? t('Restarting stops the downloads in progress.') : undefined}
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
              {t('Restart engine')}
            </Button>
          </Group>
        </>
      )}

      {dirty && (
        <div className="fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-4 rounded-2xl border border-seam bg-velvet/95 px-5 py-3 shadow-2xl backdrop-blur animate-rise">
          <span className="text-[13px] text-usher">
            {!downloads.length
              ? t('Saving restarts the engine.')
              : downloads.length === 1
                ? t('Saving restarts the engine and stops the download in progress.')
                : t('Saving restarts the engine and stops {n} downloads in progress.', { n: downloads.length })}
          </span>
          <Button variant="quiet" onClick={() => { setTui(saved?.tui ?? null); setGui(saved?.gui ?? { binaryPath: '', subtitles }); }}>{t('Discard')}</Button>
          <Button variant="primary" busy={saving} onClick={() => void save()}>{t('Save changes')}</Button>
        </div>
      )}
    </div>
  );
}
