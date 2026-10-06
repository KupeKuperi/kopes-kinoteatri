import { useState, type ReactNode } from 'react';
import { Download, MonitorPlay } from 'lucide-react';
import { errorMessage, mb } from '@/lib/api';
import { t } from '@/lib/i18n';
import { isMac, isWeb, isWindows } from '@/lib/platform';
import { useStore } from '@/lib/store';
import { Button } from './ui';

const TOOL_NAMES = { vlc: 'VLC', 'yt-dlp': 'yt-dlp' } as const;

/** Installs VLC or yt-dlp with winget (Windows asks for permission for VLC), then refreshes what's found. */
export function InstallToolButton({ tool, children, size = 'sm' }: { tool: 'vlc' | 'yt-dlp'; children?: ReactNode; size?: 'sm' | 'md' }) {
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  const name = TOOL_NAMES[tool];
  return (
    <Button
      size={size}
      variant="primary"
      busy={busy}
      icon={<Download size={14} />}
      title={
        isWindows
          ? tool === 'vlc'
            ? t('Installs VLC with winget. Windows asks for permission.')
            : t('Installs yt-dlp (and ffmpeg) with winget.')
          : isMac
            ? t('Installs {name} with Homebrew, or opens its download page.', { name })
            : t('Opens the {name} download page.', { name })
      }
      onClick={async () => {
        setBusy(true);
        toast('info', t('Installing {name}…', { name }), isWindows && tool === 'vlc' ? t('Windows may ask for permission. This takes a minute.') : t('This takes a minute.'));
        try {
          const r = await mb.installTool(tool);
          useStore.setState({ env: r.env });
          if (r.manual) toast('info', t('Get {name} from its website', { name }), t('The download page opened in your browser. Install {name}, then come back.', { name }));
          else toast('success', t('{name} is installed', { name }), tool === 'vlc' ? t('Titles now play in VLC.') : t('MovieBox downloads work now.'));
        } catch (e) {
          toast('error', t("Couldn't install {name}", { name }), errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {children ?? t('Install {name}', { name })}
    </Button>
  );
}

/** Shown on Home while no video player is installed: nothing can play until there is one. */
export function NoPlayerBanner() {
  const players = useStore((s) => s.env?.players);
  // A phone plays by itself; the computer's player doesn't matter there.
  if (isWeb || !players || players.vlc || players.mpv || players.iina) return null;
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-bulb/35 bg-bulb/[0.06] p-5">
      <MonitorPlay size={22} className="shrink-0 text-bulb" />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-bulb">{t('No video player yet')}</div>
        <p className="mt-1 text-[13.5px] leading-relaxed text-screen/85">
          {t('Everything plays in VLC (or mpv), and neither is on this computer. Install VLC, free and open source, to start watching.')}
        </p>
      </div>
      <InstallToolButton tool="vlc" size="md" />
    </div>
  );
}
