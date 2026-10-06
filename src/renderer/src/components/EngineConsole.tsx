import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { X } from 'lucide-react';
import { mb } from '@/lib/api';
import { useStore } from '@/lib/store';

// Must match the engine's pty size (src/main/engine/session.ts).
const COLS = 110;
const ROWS = 80;

/** Live view of the hidden TUI the app drives. Keys typed here go straight to it. */
export function EngineConsole() {
  const open = useStore((s) => s.consoleOpen);
  const setConsole = useStore((s) => s.setConsole);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !host.current) return;
    const term = new Terminal({
      cols: COLS,
      rows: ROWS,
      // System terminal fonts: they carry the block and box-drawing glyphs the TUI draws with.
      fontFamily: '"Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 12,
      lineHeight: 1.05,
      cursorBlink: false,
      allowProposedApi: true,
      theme: { background: '#120a0f', foreground: '#f4eadf', cursor: '#ffc65c', selectionBackground: '#ffc65c55' },
    });
    term.open(host.current);
    let disposed = false;
    // Paint the current screen, then stream live output.
    void mb.consoleSnapshot().then((snap) => !disposed && term.write(snap));
    const off = mb.on((e) => e.type === 'console-data' && term.write(e.payload));
    const input = term.onData((d) => mb.consoleInput(d));
    term.focus();
    return () => {
      disposed = true;
      off();
      input.dispose();
      term.dispose();
    };
  }, [open]);

  if (!open) return null;
  return (
    <section className="absolute inset-x-0 bottom-0 z-40 flex h-[52%] flex-col border-t border-seam bg-[#120a0f] shadow-[0_-20px_60px_rgba(0,0,0,0.5)] animate-rise">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-seam/70 px-4">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-bulb">Engine console</span>
        <span className="text-[12.5px] text-usher">The terminal app this window drives. Keys you type here go straight to it.</span>
        <button onClick={() => setConsole(false)} className="ml-auto rounded p-1 text-usher hover:bg-curtain hover:text-screen" aria-label="Close console">
          <X size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div ref={host} className="w-max" />
      </div>
    </section>
  );
}
