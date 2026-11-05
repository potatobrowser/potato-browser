import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, 'src/renderer');
export const PAGES = ['ui', 'newtab', 'settings', 'history', 'bookmarks', 'downloads', 'welcome', 'error'];

export default defineConfig({
  root,
  base: '/',
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome150',
    sourcemap: false,
    rollupOptions: {
      input: Object.fromEntries(PAGES.map((p) => [p, path.join(root, `${p}.html`)])),
    },
  },
});
