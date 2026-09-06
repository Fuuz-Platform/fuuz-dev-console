// Bundles the Chrome extension into dist/ — the panel (React), the MAIN-world
// console hook, the isolated relay, the service worker and the devtools page,
// plus the static manifest/HTML/CSS. `--watch` rebuilds on change.
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

const watch = process.argv.includes('--watch');
const outdir = 'dist';
fs.mkdirSync(outdir, { recursive: true });

const options = {
  entryPoints: {
    panel: 'src/panel/index.tsx',
    hook: 'src/extension/hook.ts',
    relay: 'src/extension/relay.ts',
    background: 'src/extension/background.ts',
    devtools: 'src/extension/devtools.ts',
    // The script runner. Its own bundle because it loads in a sandboxed page with
    // no extension APIs — nothing it needs is in the panel bundle.
    sandbox: 'src/extension/sandbox.ts',
  },
  bundle: true,
  format: 'iife',
  outdir,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  jsx: 'automatic',
  target: ['chrome111'],
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  loader: { '.css': 'css' },
  logLevel: 'info',
};

for (const file of ['manifest.json', 'devtools.html', 'panel.html', 'sandbox.html']) {
  fs.copyFileSync(path.join('src/extension', file), path.join(outdir, file));
}

// Icons: the manifest set plus the DevTools panel's own.
fs.mkdirSync(path.join(outdir, 'icons'), { recursive: true });
// Only the rasterised sizes ship; the SVG sources stay in src as the master.
for (const icon of fs.readdirSync('src/extension/icons').filter((f) => f.endsWith('.png'))) {
  fs.copyFileSync(path.join('src/extension/icons', icon), path.join(outdir, 'icons', icon));
}

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[build] watching…');
} else {
  await esbuild.build(options);
  console.log(`[build] ${outdir}/ — load it with chrome://extensions → Load unpacked`);
}
