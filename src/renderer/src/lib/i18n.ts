// The window's language: Georgian or English. English text is the key; KA holds the Georgian.
// Messages that come from the engine (errors, the TUI's notifications and status lines) are
// translated by pattern when they are shown (`tm`), since they arrive as English sentences.
import { createElement, Fragment, type ReactNode } from 'react';
import { create } from 'zustand';
import { KA } from './i18n-ka';

export type Lang = 'ka' | 'en';

const STORAGE_KEY = 'mb.language';

function initialLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'ka' || v === 'en') return v;
  } catch {
    /* storage unavailable: use the default */
  }
  return 'ka';
}

export const useLang = create<{ lang: Lang; setLang(lang: Lang): void }>((set) => ({
  lang: initialLang(),
  setLang(lang) {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* not remembered this time */
    }
    document.documentElement.lang = lang;
    set({ lang });
  },
}));
document.documentElement.lang = useLang.getState().lang;

type Params = Record<string, string | number | null | undefined>;

const fill = (text: string, params?: Params) =>
  params ? text.replace(/\{(\w+)\}/g, (_, k: string) => (params[k] === null || params[k] === undefined ? '' : String(params[k]))) : text;

const lookup = (text: string): string => (useLang.getState().lang === 'ka' ? (KA[text] ?? text) : text);

/** `text` (English) in the window's language, with `{name}` placeholders filled in. */
export function t(text: string, params?: Params): string {
  return fill(lookup(text), params);
}

/** Like `t`, for sentences with markup inside: placeholders take React nodes. */
export function tn(text: string, params: Record<string, ReactNode>): ReactNode {
  const parts = lookup(text).split(/\{(\w+)\}/);
  return createElement(
    Fragment,
    null,
    ...parts.map((part, i) => (i % 2 ? createElement(Fragment, { key: i }, params[part]) : part)),
  );
}

// ── Engine messages ─────────────────────────────────────────────────────────

let patterns: Array<{ re: RegExp; names: string[]; ka: string }> | null = null;

/** Every dictionary entry with placeholders, as a pattern that matches the filled-in English. */
function compiled() {
  if (patterns) return patterns;
  patterns = [];
  for (const [en, ka] of Object.entries(KA)) {
    if (!en.includes('{')) continue;
    const names: string[] = [];
    const source = en
      .split(/(\{\w+\})/)
      .map((part) => {
        const m = /^\{(\w+)\}$/.exec(part);
        if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        names.push(m[1]);
        return '(.+?)';
      })
      .join('');
    patterns.push({ re: new RegExp(`^${source}$`, 's'), names, ka });
  }
  // The most specific (longest) English wins when two match.
  patterns.sort((a, b) => b.re.source.length - a.re.source.length);
  return patterns;
}

/**
 * A message from the engine or the main process, in the window's language when the dictionary
 * knows it (exactly, or as a pattern like "Opening {title}"); anything else stays as it came.
 */
export function tm(message: string | null | undefined, depth = 0): string {
  if (!message) return message ?? '';
  if (useLang.getState().lang !== 'ka') return message;
  const text = message.trim();
  const exact = KA[text] ?? (/^[A-Z][A-Z ]+$/.test(text) ? KA[text.charAt(0) + text.slice(1).toLowerCase()] : undefined);
  if (exact !== undefined) return exact;
  // The TUI ends spinner lines with "..." where the dictionary has "…".
  const ellipsis = KA[text.replace(/\.\.\.$/, '…')];
  if (ellipsis !== undefined) return ellipsis;
  if (depth > 2) return message;
  for (const p of compiled()) {
    const m = p.re.exec(text);
    if (!m) continue;
    const params: Params = {};
    // An {error} can be a message itself ("… failed: Network connection failed: …"); titles,
    // names and queries stay exactly as they came.
    p.names.forEach((name, i) => (params[name] = name === 'error' || name === 'what' ? tm(m[i + 1], depth + 1) : m[i + 1]));
    return fill(p.ka, params);
  }
  return message;
}

/** A quoted title or query, with the language's own quotation marks: „…“ in Georgian. */
export const q = (text: string): string => (useLang.getState().lang === 'ka' ? `„${text}“` : `“${text}”`);
