// Builds main + preloads with esbuild and the React renderer with Vite into dist/.
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const prod = process.argv.includes('--prod');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });

const define = {
  'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development'),
  __APP_VERSION__: JSON.stringify(pkg.version),
  __API_BASE__: JSON.stringify(process.env.POTATO_API_BASE_BUILD || 'https://potatobrowser.com'),
};

const common = {
  bundle: true,
  sourcemap: prod ? false : 'inline',
  minify: prod,
  legalComments: 'none',
  define,
  logLevel: 'warning',
  absWorkingDir: root,
};

await Promise.all([
  build({
    ...common,
    entryPoints: { 'main/index': 'src/main/index.ts' },
    outdir: 'dist',
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
  }),
  // Sandboxed preloads can only require('electron'); everything else is bundled.
  build({
    ...common,
    entryPoints: { 'preload/ui': 'src/preload/ui.ts', 'preload/web': 'src/preload/web.ts' },
    outdir: 'dist',
    platform: 'browser',
    format: 'cjs',
    target: 'chrome150',
    external: ['electron'],
  }),
  viteBuild({ configFile: path.join(root, 'vite.config.mts'), logLevel: 'warn', define }),
]);

console.log(`built ${pkg.productName} ${pkg.version}${prod ? ' (prod)' : ''}`);
