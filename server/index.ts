// Must come first: it sizes the libuv thread pool that DNS lookups run on.
import './threadpool.ts';
import path from 'node:path';
import { Monitor } from './app.ts';

/**
 * Standalone CLI entry: `npm run dev:server` and `npm start`.
 *
 * POPINGUI_PORT rather than PORT: a bare PORT is set by all sorts of tooling
 * and would silently move the API onto the dev server's own port.
 */
const monitor = new Monitor({
  port: Number(process.env.POPINGUI_PORT ?? 8787),
  dataDir: path.resolve(process.cwd(), 'data'),
  distDir: process.env.NODE_ENV === 'production' ? path.resolve(process.cwd(), 'dist') : null,
});

await monitor.start();
const ui = process.env.NODE_ENV === 'production' ? monitor.url : 'http://127.0.0.1:5273';
console.log(`popingui: API на :${monitor.port}, интерфейс ${ui}`);
