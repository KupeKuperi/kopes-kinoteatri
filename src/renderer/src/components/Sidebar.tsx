import { Download, Home, Library, Radio, Settings, SquareTerminal } from 'lucide-react';
import type { ReactNode } from 'react';
import { t, tm, useLang } from '@/lib/i18n';
import { isWeb, keyNames } from '@/lib/platform';
import { useRoute, useStore, type Section } from '@/lib/store';
import { Kbd, Spinner } from './ui';

export const ITEMS: Array<{ name: Section; label: string; icon: ReactNode; key: string }> = [
  { name: 'home', label: 'Home', icon: <Home size={17} />, key: '1' },
  { name: 'library', label: 'Library', icon: <Library size={17} />, key: '2' },
  { name: 'downloads', label: 'Downloads', icon: <Download size={17} />, key: '3' },
  { name: 'tv', label: 'Live TV', icon: <Radio size={17} />, key: '4' },
  { name: 'settings', label: 'Settings', icon: <Settings size={17} />, key: '5' },
];

export const SECTION_KEYS = Object.fromEntries(ITEMS.map((i) => [i.key, i.name])) as Record<string, Section>;

export function Sidebar() {
  const route = useRoute();
  const go = useStore((s) => s.go);
  const downloads = useStore((s) => s.downloads.filter((d) => !d.finished).length);
  const status = useStore((s) => s.status);
  const setConsole = useStore((s) => s.setConsole);
  const consoleOpen = useStore((s) => s.consoleOpen);
  const current = route.name === 'results' || route.name === 'details' ? null : route.name;

  const busy = status?.state === 'busy' || status?.state === 'starting';
  const line =
    status?.state === 'missing' ? t('moviebox-tui not found')
    : status?.state === 'error' ? t('Engine stopped')
    : status?.state === 'stopped' ? t('Engine stopped')
    : status?.state === 'starting' ? t('Starting engine')
    : tm(status?.tuiStatus ?? status?.activity) || t('Ready');

  return (
    <nav data-nav-scope="sidebar" className="flex w-[216px] shrink-0 flex-col border-r border-seam/60 bg-velvet/60 px-3 pb-3 pt-4 max-md:hidden">
      <ul className="space-y-0.5">
        {ITEMS.map((item) => {
          const active = current === item.name;
          return (
            <li key={item.name}>
              <button
                data-nav=""
                aria-current={active ? 'page' : undefined}
                onClick={() => go({ name: item.name })}
                className={`group flex h-10 w-full items-center gap-3 rounded-lg px-3 text-[14px] transition-colors ${
                  active ? 'bg-curtain text-screen' : 'text-usher hover:bg-curtain/50 hover:text-screen'
                }`}
              >
                <span className={active ? 'text-bulb' : ''}>{item.icon}</span>
                <span className="flex-1 text-left">{t(item.label)}</span>
                {item.name === 'downloads' && downloads > 0 && (
                  <span className="rounded-full bg-bulb px-1.5 font-mono text-[10px] font-medium text-house">{downloads}</span>
                )}
                {!isWeb && (
                  <span className="opacity-0 transition-opacity group-hover:opacity-100">
                    <Kbd>{keyNames.section} {item.key}</Kbd>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-auto rounded-xl border border-seam/70 bg-house/60 p-3">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-dim">
          <span className={`h-1.5 w-1.5 rounded-full ${status?.state === 'ready' ? 'bg-ok' : busy ? 'bg-bulb' : 'bg-err'}`} />
          {t('Engine')}
          <span className="ml-auto normal-case tracking-normal">{status?.binary?.version ? `v${status.binary.version}` : ''}</span>
        </div>
        <div className="mt-2 flex min-h-[18px] items-center gap-2 font-mono text-[11px] text-screen/85" title={line}>
          {busy ? <Spinner /> : <span className="w-[1ch] text-dim">❯</span>}
          <span className="truncate">{line}</span>
        </div>
        {!isWeb && (
        <button
          data-nav=""
          onClick={() => setConsole(!consoleOpen)}
          className="mt-3 flex h-8 w-full items-center gap-2 whitespace-nowrap rounded-md px-2 text-[12.5px] text-usher hover:bg-curtain hover:text-screen"
        >
          <SquareTerminal size={15} className="shrink-0" />
          {consoleOpen ? t('Hide console') : t('Console')}
          <span className="ml-auto">
            <Kbd>{keyNames.control}+`</Kbd>
          </span>
        </button>
        )}
      </div>
    </nav>
  );
}

/** Phones: the sections along the bottom edge, where a thumb reaches them. */
export function BottomNav() {
  const route = useRoute();
  const go = useStore((s) => s.go);
  const downloads = useStore((s) => s.downloads.filter((d) => !d.finished).length);
  const current = route.name === 'results' || route.name === 'details' ? null : route.name;
  // "ჩამოტვირთვები" doesn't fit a phone's tab: its tab says it shorter.
  const georgian = useLang((s) => s.lang) === 'ka';
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-seam/70 bg-house/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      {ITEMS.map((item) => {
        const active = current === item.name;
        return (
          <button
            key={item.name}
            aria-current={active ? 'page' : undefined}
            onClick={() => go({ name: item.name })}
            className={`relative flex min-w-0 flex-1 flex-col items-center gap-1 pb-1.5 pt-2.5 text-[10px] leading-tight tracking-[-0.01em] ${active ? 'text-bulb' : 'text-usher'}`}
          >
            {item.icon}
            <span className="max-w-full truncate">{georgian && item.name === 'downloads' ? t('Downloads (tab)') : t(item.label)}</span>
            {item.name === 'downloads' && downloads > 0 && (
              <span className="absolute right-[22%] top-1.5 rounded-full bg-bulb px-1 font-mono text-[9px] font-medium text-house">{downloads}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
