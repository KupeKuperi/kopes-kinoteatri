// Builds src/shared/scout-sites.ts, the catalog behind the "Find elsewhere" links on a title's
// page, from the site lists of IMDb Scout Mod (vendor/IMDb-Scout-Mod, a userscript). The app
// never runs the userscript: it only uses the site names and search URL templates taken from it.
//
// Run after updating the vendored copy, and commit the result:
//   node scripts/extract-scout-sites.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'vendor/IMDb-Scout-Mod/IMDb_Scout_Mod.user.js');
const OUT = path.join(root, 'src/shared/scout-sites.ts');

// Upstream's arrays and the group each goes in. Left out: private_sites, chinese_sites,
// french_sites and german_sites (trackers that need an account) and pre_databases (scene
// release names, not titles). icon_sites_main is upstream's row of links to film sites; they
// have no movie/TV flags and show on every title (`everyTitle`).
const ARRAYS = [
  ['public_sites', 'torrent'],
  ['streaming_sites', 'streaming'],
  ['subs_sites', 'subtitles'],
  ['usenet_sites', 'usenet'],
  ['other_sites', 'other'],
  ['icon_sites_main', 'other', { everyTitle: true }],
];

// Sites whose upstream array doesn't say what they are (mostly icon_sites_main).
const CATEGORY = {
  JustWatch: 'streaming',
  'JustWatch (CA)': 'streaming',
  Reelgood: 'streaming',
  Netflix: 'streaming',
  uNoGS: 'streaming',
  'Prime Video': 'streaming',
  'Amazon Prime (DE)': 'streaming',
  'Apple TV': 'streaming',
  Max: 'streaming',
  Mubi: 'streaming',
  'Criterion Channel': 'streaming',
  'Stremio (Web)': 'streaming',
  SubSource: 'subtitles',
  'Sous-titre (FR)': 'subtitles',
  'Ktuvit (IL)': 'subtitles',
  AnimeTorrents: 'torrent',
  DDU: 'torrent',
  'TPB-Proxy': 'torrent',
  'TPB-Proxy2': 'torrent',
  'Sky of Usenet (DE)': 'usenet',
};

// Adult sites, private trackers upstream files under subtitles, and upstream's developer test entry.
const EXCLUDE = new Set(['PornoLab', 'PornoLab-ID', 'MrSkin', 'AZnude', 'xBytesV2', 'xBytesV2-Req', '_OMDb (for Dev tests)']);
// Impostor copies of dead sites: upstream keeps them, marked "(Fake)".
const EXCLUDE_NAME = /\(Fake\)/;
// Local servers (Jackett, Seerr, Everything) and keys the user would have to fill in.
const EXCLUDE_URL = /localhost|127\.0\.0\.1|voidtools\.replacement|_APIKEY_/;

// Not upstream: the title's own IMDb page.
const EXTRA = [{ name: 'IMDb', category: 'other', searchUrl: 'https://www.imdb.com/title/%tt%/', both: true }];

// The short list a title's page shows first, per group, in this order. A movie-only or TV-only
// entry is listed for that kind of title only.
const CURATED = {
  torrent: ['1337x', 'TheRARBG', 'TPB', 'YTS.mx', 'Knaben', 'BitSearch', 'EXTTor', 'LimeTor', 'Rutor'],
  streaming: ['JustWatch', 'Reelgood', 'Netflix', 'Prime Video', 'Apple TV', 'Max', 'Tubi', 'Stremio (Web)'],
  subtitles: ['OpenSubtitles', 'OpenSubtitles.com (EN)', 'Subdl', 'SubSource', 'Addic7ed', 'TVsubtitles'],
  usenet: ['NZBKing', 'NZBgeek', 'DrunkenSlug', 'NZBfinder', 'NZBplanet', 'DOGnzb'],
  other: ['IMDb', 'Letterboxd', 'TMDB-ID', 'Trakt', 'Rotten Tomatoes', 'Metacritic', 'YouTube', 'Wikipedia', 'Box Office Mojo'],
};

// Every placeholder upstream knows, and the ones the app can fill in. The others (TVDb, TVmaze
// and Douban ids, TMDb's original title) need lookups on more services.
const PARAMS = /%(tt|nott|tvdbid|tvmazeid|tmdbid|tmdb_orig_title|doubanid|search_string_orig|search_string|year|seriesid|seasonid|episodeid)%/g;
const SUPPORTED = new Set(['tt', 'nott', 'search_string', 'search_string_orig', 'year', 'tmdbid', 'seriesid', 'seasonid', 'episodeid']);

const src = fs.readFileSync(SOURCE, 'utf8');
const version = /@version\s+(\S+)/.exec(src)?.[1] ?? 'unknown';

/**
 * Upstream's `var name = [ … ];`, evaluated on its own: plain object literals (strings, regexes,
 * booleans), in an empty context, so nothing else in the userscript runs.
 */
function readArray(name) {
  const start = src.indexOf(`var ${name} = [`);
  if (start < 0) throw new Error(`${name} is not in the userscript any more.`);
  const end = src.indexOf('\n];', start);
  const list = vm.runInNewContext(src.slice(src.indexOf('[', start), end + 2), Object.create(null), { timeout: 5000 });
  if (!Array.isArray(list) || !list.every((s) => typeof s?.name === 'string' && typeof s?.searchUrl === 'string')) {
    throw new Error(`${name} doesn't look like a site list any more.`);
  }
  return list;
}

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

const skipped = [];
const sites = new Map();
const candidates = [
  ...EXTRA.map((s) => [s, s.category, {}]),
  ...ARRAYS.flatMap(([name, category, opts = {}]) => readArray(name).map((s) => [s, category, opts])),
];
for (const [site, category, { everyTitle }] of candidates) {
  const why = (() => {
    if (EXCLUDE.has(site.name) || EXCLUDE_NAME.test(site.name)) return 'excluded';
    if (site.mPOST) return 'needs a POST form';
    // The link opens goToUrl when there is one (searchUrl is then an API the userscript checks).
    const link = site.goToUrl ?? site.searchUrl;
    if (!/^https?:\/\//.test(link) || EXCLUDE_URL.test(link)) return 'not a public web link';
    const params = [...link.matchAll(PARAMS)].map((m) => m[1]);
    if (!params.length) return 'not about the title';
    const unsupported = params.filter((p) => !SUPPORTED.has(p));
    if (unsupported.length) return `needs ${unsupported.join(', ')}`;
    return null;
  })();
  if (why) {
    skipped.push(`${site.name}: ${why}`);
    continue;
  }
  const both = Boolean(site.both || everyTitle);
  const id = slug(site.name) + (site.TV ? '-tv' : '');
  if (sites.has(id)) {
    skipped.push(`${site.name}: duplicate`);
    continue;
  }
  const cat = CATEGORY[site.name] ?? category;
  const rank = CURATED[cat].indexOf(site.name);
  sites.set(id, {
    id,
    name: site.name,
    category: cat,
    searchUrl: site.searchUrl,
    ...(site.goToUrl ? { goToUrl: site.goToUrl } : {}),
    ...(site.TV ? { TV: true } : both ? { both: true } : {}),
    ...(typeof site.spaceEncode === 'string' && site.spaceEncode !== '+' ? { spaceEncode: site.spaceEncode } : {}),
    ...(rank >= 0 ? { curated: true } : {}),
    rank: rank >= 0 ? rank : Infinity,
  });
}

for (const [cat, names] of Object.entries(CURATED)) {
  for (const name of names) {
    if (![...sites.values()].some((s) => s.name === name && s.category === cat)) console.warn(`! Curated ${cat} site "${name}" is not in the list (renamed or dropped upstream?)`);
  }
}

// Group by group, the short list first (in its order), then the rest by name.
const order = Object.keys(CURATED);
const list = [...sites.values()].sort(
  (a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.rank - b.rank || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || Number(Boolean(a.TV)) - Number(Boolean(b.TV)),
);

const body = list.map(({ rank: _rank, ...s }) => `  ${JSON.stringify(s)},`).join('\n');
fs.writeFileSync(
  OUT,
  `// Generated by scripts/extract-scout-sites.mjs from IMDb Scout Mod ${version}
// (vendor/IMDb-Scout-Mod, https://github.com/Purfview/IMDb-Scout-Mod, MIT). Don't edit by hand:
// change the script and run it again.
import type { ScoutSite } from './scout';

export const SCOUT_SITES: ScoutSite[] = [
${body}
];
`,
);

const count = (cat) => list.filter((s) => s.category === cat);
console.log(`IMDb Scout Mod ${version}: ${list.length} sites written to ${path.relative(root, OUT)}`);
for (const cat of order) console.log(`  ${cat.padEnd(10)} ${String(count(cat).length).padStart(3)} (${count(cat).filter((s) => s.curated).length} on the short list)`);
console.log(`  skipped    ${String(skipped.length).padStart(3)}${process.argv.includes('--verbose') ? `\n    ${skipped.join('\n    ')}` : ' (--verbose lists them)'}`);
