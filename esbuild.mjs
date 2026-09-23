// Bundles the Extension Host (Node.js) entrypoint. The Webview bundle (browser target)
// will be added as a separate build context in the next phase — the two never share a bundle.
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

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

if (watch) {
  const ctx = await esbuild.context(extensionHost);
  await ctx.watch();
} else {
  await esbuild.build(extensionHost);
}
