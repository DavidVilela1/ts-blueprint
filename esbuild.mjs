// Two independent bundles that never share code at runtime (only the dependency-free
// src/types/ipc.ts is imported by both):
//   1. Extension Host  -> dist/extension.js  (Node.js, CommonJS, `vscode` external)
//   2. Webview client  -> dist/webview.js + dist/webview.css  (browser, IIFE)
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Fails the Webview build if host-only modules sneak into the browser bundle. */
const forbidHostModules = {
  name: 'forbid-host-modules',
  setup(build) {
    const forbidden = /^(vscode|typescript|node:.*)$/;
    build.onResolve({ filter: forbidden }, (args) => ({
      errors: [{ text: `"${args.path}" cannot be imported from Webview code (imported by ${args.importer}).` }],
    }));
  },
};

/** @type {import('esbuild').BuildOptions} */
const extensionHost = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'], // provided by the VS Code runtime
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const webview = {
  entryPoints: { webview: 'src/webview/main.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['chrome120'], // VS Code's Electron runtime
  sourcemap: production ? false : 'inline',
  minify: production,
  plugins: [forbidHostModules],
  logLevel: 'info',
};

if (watch) {
  const contexts = await Promise.all([esbuild.context(extensionHost), esbuild.context(webview)]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all([esbuild.build(extensionHost), esbuild.build(webview)]);
}
