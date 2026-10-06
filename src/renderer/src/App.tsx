import { useEffect, useRef, useState } from 'react';
import { errorMessage, mb } from '@/lib/api';
import { isTyping, moveFocus, type Direction } from '@/lib/nav';
import { isMac } from '@/lib/platform';
import { useRoute, useStore } from '@/lib/store';
import { EngineConsole } from '@/components/EngineConsole';
import { Shortcuts } from '@/components/Shortcuts';
import { SubtitleChooser } from '@/components/SubtitleChooser';
import { SECTION_KEYS, Sidebar } from '@/components/Sidebar';
import { SEARCH_INPUT_ID, TitleBar } from '@/components/TitleBar';
import { Toasts } from '@/components/Toasts';
import { Button, Spinner } from '@/components/ui';
import { Details } from '@/screens/Details';
import { Downloads } from '@/screens/Downloads';
import { Home } from '@/screens/Home';
import { Library } from '@/screens/Library';
import { LiveTv } from '@/screens/LiveTv';
import { Results } from '@/screens/Results';
import { Settings } from '@/screens/Settings';

const ARROWS: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

function EngineMissing() {
  const status = useStore((s) => s.status);
  const refreshStatus = useStore((s) => s.refreshStatus);
  const step = useStore((s) => s.setupStep);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (status?.state !== 'missing') return null;
  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      const r = await mb.installEngine();
      useStore.setState({ status: r.status, env: r.env });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setInstalling(false);
    }
  };
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-house/90 backdrop-blur">
      <div className="max-w-lg rounded-3xl border border-seam bg-velvet p-9">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-bulb">One more step</div>
        <h1 className="mt-3 font-display text-[44px] font-extrabold uppercase leading-[0.92]">Install the engine</h1>
        <p className="mt-4 text-[14px] leading-relaxed text-usher">
          Kope's Kinoteatri finds and plays titles through moviebox-tui, a free open-source program that isn't on this computer yet. Install
          its official release from GitHub (a few MB, checked against its published checksum), or point to the program if you already have it.
        </p>
        {error && <p className="mt-4 rounded-lg border border-err/30 bg-err/10 px-3 py-2 text-[13px] text-screen/90">{error}</p>}
        {installing && (
          <p className="mt-4 flex items-center gap-2 font-mono text-[12px] text-usher">
            <Spinner /> {step ?? 'Installing…'}
          </p>
        )}
        <div className="mt-6 flex flex-wrap gap-2.5">
          <Button variant="primary" busy={installing} onClick={() => void install()}>
            Install moviebox-tui
          </Button>
          <Button
            disabled={installing}
            onClick={async () => {
              const p = await mb.pickFile();
              if (p) {
                await mb.saveSettings({ gui: { binaryPath: p } });
                setTimeout(() => void refreshStatus(), 1200);
              }
            }}
          >
            I have it: locate it
          </Button>
          <Button variant="quiet" disabled={installing} onClick={() => void mb.restartEngine().then(refreshStatus)}>
            Look again
          </Button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const init = useStore((s) => s.init);
  const mainRef = useRef<HTMLElement>(null);
  const asking = useStore((s) => s.subtitleChoice !== null);

  useEffect(() => init(), [init]);

  // Each screen starts at the top.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [route]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const typing = isTyping(document.activeElement);
      // Shortcuts use physical keys (e.code) so they work with any keyboard layout.
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
        e.preventDefault();
        const input = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null;
        input?.focus();
        input?.select();
        return;
      }
      if (e.ctrlKey && (e.key === '`' || e.code === 'Backquote')) {
        e.preventDefault();
        st.setConsole(!st.consoleOpen);
        return;
      }
      // Sections: ⌘1–5 on a Mac (⌥ types characters there), Alt 1–5 elsewhere.
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      if ((isMac ? e.metaKey : e.altKey) && digit && SECTION_KEYS[digit]) {
        e.preventDefault();
        st.go({ name: SECTION_KEYS[digit] });
        return;
      }
      if (document.activeElement?.closest('.xterm')) return; // the console gets its own keys
      if (e.key === 'Escape') {
        if (st.subtitleChoice) void st.chooseSubtitle(-1);
        else if (st.shortcutsOpen) st.setShortcuts(false);
        else if (typing) (document.activeElement as HTMLElement).blur();
        else if (st.consoleOpen) st.setConsole(false);
        else st.back();
        return;
      }
      if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.code === 'Slash' && !e.shiftKey) {
        e.preventDefault();
        document.getElementById(SEARCH_INPUT_ID)?.focus();
      } else if (e.code === 'Slash' && e.shiftKey) {
        st.setShortcuts(!st.shortcutsOpen);
      } else if (ARROWS[e.key] && moveFocus(ARROWS[e.key])) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const screen = {
    home: <Home />,
    results: <Results />,
    details: <Details />,
    library: <Library />,
    downloads: <Downloads />,
    tv: <LiveTv />,
    settings: <Settings />,
  }[route.name];

  return (
    <div className="flex h-full flex-col">
      {/* While the subtitle dialog is open nothing behind it takes focus or clicks. */}
      <div className="contents" inert={asking}>
      <TitleBar />
      <div className="relative flex min-h-0 flex-1">
        <Sidebar />
        <main ref={mainRef} className="relative min-w-0 flex-1 overflow-y-auto">
          <div key={route.name + (route.tab ?? '')} className="mx-auto max-w-[1500px] animate-rise">
            {screen}
          </div>
        </main>
        <EngineConsole />
        <EngineMissing />
      </div>
      </div>
      <Toasts />
      <Shortcuts />
      <SubtitleChooser />
    </div>
  );
}
