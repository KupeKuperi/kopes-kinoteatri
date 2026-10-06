// Spatial keyboard navigation: arrow keys move focus to the nearest
// `[data-nav]` element in that direction, like a TV remote.

export type Direction = 'up' | 'down' | 'left' | 'right';

export function isTyping(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'button'].includes(el.type);
  return el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable || Boolean(el.closest('.xterm'));
}

const visible = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && !el.closest('[inert]') && !(el as HTMLButtonElement).disabled;
};

function candidates(scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>('[data-nav]')].filter(visible);
}

function nearest(from: DOMRect, items: HTMLElement[], dir: Direction, self: HTMLElement): HTMLElement | null {
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === self) continue;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    let primary: number;
    let secondary: number;
    if (dir === 'right') { if (r.left < from.right - 4) continue; primary = dx; secondary = Math.abs(dy); }
    else if (dir === 'left') { if (r.right > from.left + 4) continue; primary = -dx; secondary = Math.abs(dy); }
    else if (dir === 'down') { if (r.top < from.bottom - 4) continue; primary = dy; secondary = Math.abs(dx); }
    else { if (r.bottom > from.top + 4) continue; primary = -dy; secondary = Math.abs(dx); }
    // Strongly prefer staying in the same row/column.
    const score = primary + secondary * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}

export function focusEl(el: HTMLElement | null | undefined): boolean {
  if (!el) return false;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  return true;
}

/** Moves focus; crosses between the sidebar and the content at their edges. */
export function moveFocus(dir: Direction): boolean {
  const current = document.activeElement as HTMLElement | null;
  // An open dialog keeps the arrow keys inside it.
  const dialog = document.querySelector<HTMLElement>('[data-nav-scope="dialog"]');
  if (dialog) {
    const items = candidates(dialog);
    if (!current || !dialog.contains(current)) return focusEl(items[0]);
    return focusEl(nearest(current.getBoundingClientRect(), items, dir, current));
  }
  const main = document.querySelector<HTMLElement>('main');
  const side = document.querySelector<HTMLElement>('[data-nav-scope="sidebar"]');
  if (!main) return false;

  const inSide = Boolean(current && side?.contains(current));
  const inMain = Boolean(current && main.contains(current) && current.hasAttribute('data-nav'));
  if (!inSide && !inMain) return focusEl(candidates(main)[0] ?? candidates(side ?? document)[0]);

  const scope = inSide ? side! : main;
  const next = nearest(current!.getBoundingClientRect(), candidates(scope), dir, current!);
  if (next) return focusEl(next);
  if (inMain && dir === 'left' && side) return focusEl(side.querySelector<HTMLElement>('[aria-current="page"]') ?? candidates(side)[0]);
  if (inSide && dir === 'right') return focusEl(candidates(main)[0]);
  return false;
}
