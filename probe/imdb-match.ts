// IMDb matching check against the live Cinemeta search and the ratings dataset.
//   npx esbuild probe/imdb-match.ts --bundle --platform=node --format=cjs --packages=external --outfile=probe/out/imdb-match.cjs && node probe/out/imdb-match.cjs <cache dir>
import fs from 'node:fs';
import { ImdbService } from '../src/main/data/imdb';

const dir = process.argv[2] ?? 'probe/out/imdb-cache';
fs.rmSync(`${dir}/ids-v2.json`, { force: true });
const imdb = new ImdbService(dir);
const cases: Array<[string, string, string]> = [
  ['Dune', '2021', 'Movie'],
  ['Dune: Part Two', '2024', 'Movie'],
  ['Interstellar', '2014', 'Movie'],
  ['The Dunes', '2019', 'Movie'],
  ['Game of Thrones', '2017', 'Series'],
  ["Frieren: Beyond Journey's End", '2023', 'Series'],
  ['Queen of Tears', '2024', 'Series'],
  ['Bleach: Thousand-Year Blood War', '2022', 'Series'],
  ['Squid Game', '2021', 'Series'],
  ['The Office', '2005', 'Series'],
  ['The Lord of the Rings: The Fellowship of the Ring', '2001', 'Movie'],
  ['Oppenheimer', '2023', 'Movie'],
  ['Spirited Away', '2001', 'Movie'],
];

const main = async () => {
  for (const [title, year, kind] of cases) {
    const r = await imdb.lookup(title, year, kind);
    console.log(`${title} (${year}, ${kind}) → ${r ? `${r.id} ${r.rating} (${r.votes} votes)` : 'no match'}`);
  }
};

void main();
