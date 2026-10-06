import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { isTyping } from '@/lib/nav';

/**
 * Focuses the element once it mounts — unless the user is typing or has put
 * focus somewhere themselves (a slow page must not steal keystrokes).
 */
export function useFocusOnMount<T extends HTMLElement>(enabled = true) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (!enabled || !ref.current || isTyping(active)) return;
    if (active && active !== document.body && document.contains(active)) return;
    ref.current.focus({ preventScroll: true });
  }, [enabled]);
  return ref;
}

const BRAILLE = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

/** The same braille spinner the TUI draws, so both sides speak one language. */
export function Spinner({ className = '' }: { className?: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % BRAILLE.length), 80);
    return () => clearInterval(t);
  }, []);
  return (
    <span aria-hidden className={`inline-block w-[1ch] font-mono text-bulb ${className}`}>
      {BRAILLE[i]}
    </span>
  );
}

type Variant = 'primary' | 'ghost' | 'quiet' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-bulb text-house hover:bg-[#ffd27f] active:bg-bulb-deep font-semibold',
  ghost: 'bg-curtain/70 text-screen hover:bg-curtain border border-seam',
  quiet: 'text-usher hover:text-screen hover:bg-curtain/60',
  danger: 'text-err hover:bg-err/10 border border-err/30',
};

export function Button({
  variant = 'ghost',
  size = 'md',
  icon,
  busy,
  children,
  className = '',
  nav = true,
  focusOnMount = false,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; icon?: ReactNode; busy?: boolean; nav?: boolean; focusOnMount?: boolean }) {
  const sizes = { sm: 'h-8 px-3 text-[13px] gap-1.5', md: 'h-10 px-4 text-sm gap-2', lg: 'h-12 px-6 text-[15px] gap-2.5' };
  const ref = useFocusOnMount<HTMLButtonElement>(focusOnMount);
  return (
    <button
      ref={ref}
      disabled={disabled || busy}
      data-nav={nav ? '' : undefined}
      className={`inline-flex items-center justify-center rounded-lg transition-colors disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap ${sizes[size]} ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {busy ? <Spinner className={variant === 'primary' ? '!text-house' : ''} /> : icon}
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-seam bg-velvet px-1.5 py-px font-mono text-[10px] text-usher">{children}</kbd>;
}

export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`font-mono text-[10.5px] uppercase tracking-[0.18em] text-usher ${className}`}>{children}</div>;
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <h2 className="font-display text-[26px] font-extrabold uppercase leading-none tracking-wide">{children}</h2>
      {aside}
    </div>
  );
}

export function Chip({ active, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      data-nav=""
      aria-pressed={active}
      className={`h-8 rounded-full px-3.5 text-[13px] transition-colors ${active ? 'bg-screen text-house font-semibold' : 'bg-velvet text-usher hover:text-screen border border-seam'}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex items-center justify-between gap-6 py-3">
      <span className="min-w-0">
        <span className="block text-[14px]">{label}</span>
        {hint && <span className="mt-0.5 block text-[12.5px] text-usher">{hint}</span>}
      </span>
      <button
        data-nav=""
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-bulb' : 'bg-seam'}`}
      >
        <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full transition-transform ${checked ? 'translate-x-5 bg-house' : 'translate-x-0 bg-screen'}`} />
      </button>
    </label>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-seam px-8 py-14 text-center">
      <div className="font-display text-2xl font-bold uppercase tracking-wide">{title}</div>
      {children && <div className="mt-2 max-w-md text-[13.5px] leading-relaxed text-usher">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorPanel({ title, message, onRetry, onConsole }: { title: string; message: string; onRetry?: () => void; onConsole?: () => void }) {
  return (
    <div className="rounded-2xl border border-err/30 bg-err/[0.06] p-6">
      <div className="font-display text-xl font-bold uppercase tracking-wide text-err">{title}</div>
      <p className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-screen/85" data-selectable>
        {message}
      </p>
      <div className="mt-4 flex gap-2">
        {onRetry && <Button onClick={onRetry}>Try again</Button>}
        {onConsole && (
          <Button variant="quiet" onClick={onConsole}>
            Show engine console
          </Button>
        )}
      </div>
    </div>
  );
}
