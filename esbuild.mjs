// Two independent bundles that never share code at runtime (only the dependency-free
// src/types/ipc.ts is imported by both):
//   1. Extension Host  -> dist/extension.js  (Node.js, CommonJS, `vscode` external)
//   2. Webview client  -> dist/webview.js + dist/webview.css  (browser, IIFE)
//
// Usage:
//   node esbuild.mjs                 one-off development build
//   node esbuild.mjs --production    minified build, no source maps (used by vsce)
//   node esbuild.mjs --watch         rebuild both bundles on change (used by .vscode/tasks.json)
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

/**
 * Watch-mode reporter shared by BOTH build contexts.
 *
 * VS Code's background problem matcher (see .vscode/tasks.json) needs one "started" line and one
 * "finished" line per build cycle. The two bundles build concurrently, so a shared counter makes
 * sure "finished" is printed only after the LAST in-flight bundle completes; otherwise the
 * debugger could launch before dist/webview.js exists.
 *
 * Diagnostics are printed one per line as `file:line:column: severity: message`, the exact
 * shape the problem matcher's regexp expects. Paths are relative to the workspace root.
 */
let inFlight = 0;
let cycleErrors = 0;
let cycleWarnings = 0;

function reportMessage(severity, message, bundle) {
  const text = `[${bundle}] ${message.text}`;
  const loc = message.location;
  if (loc) {
    console.log(`${loc.file}:${loc.line}:${loc.column + 1}: ${severity}: ${text}`);
  } else {
    console.log(`esbuild.mjs:1:1: ${severity}: ${text}`);
  }
}

function watchReporter(bundle) {
  return {
    name: 'watch-reporter',
    setup(build) {
      build.onStart(() => {
        if (inFlight === 0) {
          cycleErrors = 0;
          cycleWarnings = 0;
          console.log(`[watch] build started (${new Date().toLocaleTimeString()})`);
        }
        inFlight++;
      });
      build.onEnd((result) => {
        for (const message of result.errors) reportMessage('error', message, bundle);
        for (const message of result.warnings) reportMessage('warning', message, bundle);
        cycleErrors += result.errors.length;
        cycleWarnings += result.warnings.length;
        inFlight = Math.max(0, inFlight - 1);
        if (inFlight === 0) {
          console.log(`[watch] build finished with ${cycleErrors} error(s) and ${cycleWarnings} warning(s)`);
        }
      });
    },
  };
}

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
  sourcesContent: false,
  minify: production,
  // In watch mode the reporter prints everything, in a format the problem matcher parses.
  logLevel: watch ? 'silent' : 'info',
  plugins: watch ? [watchReporter('extension')] : [],
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
  logLevel: watch ? 'silent' : 'info',
  plugins: watch ? [forbidHostModules, watchReporter('webview')] : [forbidHostModules],
};

if (watch) {
  const contexts = await Promise.all([esbuild.context(extensionHost), esbuild.context(webview)]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));

  const shutdown = async () => {
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else {
  await Promise.all([esbuild.build(extensionHost), esbuild.build(webview)]);
}
