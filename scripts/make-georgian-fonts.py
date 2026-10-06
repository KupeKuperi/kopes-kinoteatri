"""Builds the window's two Georgian fonts from Noto Sans Georgian (variable: weight and width).

  kino-georgian.woff2       the font as published (Georgian letters only).
  kino-georgian-caps.woff2  the same font with Mkhedruli letters drawn as their capitals
                            (Mtavruli). Uppercase text uses it: the browser leaves Georgian
                            alone under `text-transform: uppercase`, and the text itself stays
                            ordinary Mkhedruli (copying it, searching it, screen readers).

Needs fonttools and brotli (pip install fonttools brotli). Run from the project folder:
  python scripts/make-georgian-fonts.py
"""
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'node_modules/@fontsource-variable/noto-sans-georgian/files/noto-sans-georgian-georgian-wdth-normal.woff2'
OUT = ROOT / 'src/renderer/src/assets/fonts'

# Mkhedruli ა (U+10D0) … ჺ (U+10FA) and ჽ ჾ ჿ (U+10FD–10FF); each capital is 0xBC0 further on.
MKHEDRULI = list(range(0x10D0, 0x10FB)) + list(range(0x10FD, 0x1100))
TO_CAPITAL = 0x1C90 - 0x10D0


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    plain = TTFont(SOURCE)
    plain.flavor = 'woff2'
    plain.save(OUT / 'kino-georgian.woff2')

    caps = TTFont(SOURCE)
    best = caps.getBestCmap()
    swapped = 0
    for table in caps['cmap'].tables:
        if not table.isUnicode():
            continue
        for cp in MKHEDRULI:
            capital = best.get(cp + TO_CAPITAL)
            if cp in table.cmap and capital:
                table.cmap[cp] = capital
                swapped += 1
    if not swapped:
        raise SystemExit('No Mtavruli glyphs found: is this the Georgian subset of Noto Sans Georgian?')
    caps.flavor = 'woff2'
    caps.save(OUT / 'kino-georgian-caps.woff2')
    print(f'wrote {OUT}: {swapped} code points drawn as capitals')


if __name__ == '__main__':
    main()
