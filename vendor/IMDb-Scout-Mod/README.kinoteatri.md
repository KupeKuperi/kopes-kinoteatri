# Vendored IMDb-Scout-Mod

This is a snapshot of https://github.com/Purfview/IMDb-Scout-Mod (commit 0b2740e, 2026-10-07,
MIT license), a userscript that adds torrent / usenet / streaming / ratings links on IMDb pages.

Kope's Kinoteatri takes its site list from here: `scripts/extract-scout-sites.mjs` reads the site
arrays in `IMDb_Scout_Mod.user.js` (names and search URL templates only) and writes
`src/shared/scout-sites.ts`, which the "Find elsewhere" links on a title's page are built from.
The app never loads or runs the userscript itself, and this folder isn't packaged with it.

Update by re-running the install steps, then regenerate the catalog and commit both:

    rm -rf vendor/IMDb-Scout-Mod
    git clone --depth 1 https://github.com/Purfview/IMDb-Scout-Mod.git vendor/IMDb-Scout-Mod
    rm -rf vendor/IMDb-Scout-Mod/.git
    node scripts/extract-scout-sites.mjs

The script warns when a site on the app's short list was renamed or dropped upstream.
