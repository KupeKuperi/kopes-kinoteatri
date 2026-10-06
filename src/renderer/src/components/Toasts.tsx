import { X } from 'lucide-react';
import { t } from '@/lib/i18n';
import { useStore } from '@/lib/store';

const TONE = {
  success: 'border-ok/40 text-ok',
  info: 'border-seam text-bulb',
  warning: 'border-bulb/50 text-bulb',
  error: 'border-err/45 text-err',
} as const;

/** Notifications: the app's own, plus every toast the TUI raises. */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[340px] flex-col gap-2 max-md:inset-x-3 max-md:bottom-[calc(5rem+env(safe-area-inset-bottom))] max-md:w-auto"
    >
      {toasts.map((toast) => (
        <div key={toast.id} className={`pointer-events-auto animate-rise rounded-xl border bg-velvet/95 p-3.5 shadow-2xl backdrop-blur ${TONE[toast.kind]}`}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.16em]">{toast.title}</div>
              {toast.message && <div className="mt-1 text-[13px] leading-snug text-screen/90" data-selectable>{toast.message}</div>}
            </div>
            <button onClick={() => dismiss(toast.id)} className="text-dim hover:text-screen" aria-label={t('Dismiss')}>
              <X size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
