import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const shared = { '@shared': resolve('src/shared') };

// Strict CSP for the packaged renderer only — the dev server needs inline
// scripts for React Fast Refresh.
const productionCsp = (): Plugin => ({
  name: 'production-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' mbimg: data:; font-src 'self' data:" />`,
    ),
});

export default defineConfig({
  main: { resolve: { alias: shared } },
  preload: { resolve: { alias: shared } },
  renderer: {
    resolve: { alias: { ...shared, '@': resolve('src/renderer/src') } },
    plugins: [react(), tailwindcss(), productionCsp()],
  },
});
