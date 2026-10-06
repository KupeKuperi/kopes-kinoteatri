import { t } from '@/lib/i18n';
import { keyNames } from '@/lib/platform';
import { useStore } from '@/lib/store';
import { Kbd } from './ui';

const GROUPS: Array<[string, Array<[string, string]>]> = [
  ['Anywhere', [
    [`${keyNames.command} K  /`, 'Search'],
    ['← ↑ → ↓', 'Move between items'],
    ['Enter', 'Open or activate'],
    ['Esc', 'Go back'],
    [`${keyNames.section} 1 – 5`, 'Home, Library, Downloads, Live TV, Settings'],
    [`${keyNames.control} \``, 'Show or hide the engine console'],
    ['?', 'This list'],
  ]],
  ['On a title', [
    ['P', 'Play the first stream'],
    ['D', 'Download the first stream'],
    ['F', 'Add to or remove from favorites'],
  ]],
];

export function Shortcuts() {
  const open = useStore((s) => s.shortcutsOpen);
  const setOpen = useStore((s) => s.setShortcuts);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-house/70 backdrop-blur-sm" onClick={() => setOpen(false)}>
      <div className="w-[520px] rounded-2xl border border-seam bg-velvet p-7 shadow-2xl animate-rise" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-display text-3xl font-extrabold uppercase tracking-wide">{t('Keyboard')}</h2>
        {GROUPS.map(([title, rows]) => (
          <div key={title} className="mt-5">
            <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.18em] text-usher">{t(title)}</div>
            <dl className="divide-y divide-seam/60">
              {rows.map(([k, label]) => (
                <div key={k} className="flex items-center justify-between py-2 text-[13.5px]">
                  <dt>{t(label)}</dt>
                  <dd className="flex gap-1">{k.split('  ').map((x) => <Kbd key={x}>{x}</Kbd>)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}
