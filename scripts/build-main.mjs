/**
 * Bundles the Electron main process — including the probe server, express and
 * ws — into a single CommonJS file. Bundling keeps node_modules out of the
 * installer and sidesteps shipping a .ts-capable loader.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['electron/main.ts'],
  outfile: 'build/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
  // electron is provided by the runtime; the two ws speedups are optional
  // native addons that ws itself require()s inside a try/catch.
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  logLevel: 'info',
});
