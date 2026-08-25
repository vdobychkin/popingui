/**
 * Checks the status-change detection that feeds desktop notifications: the
 * first sweep must stay silent, and only genuine healthy <-> unhealthy
 * crossings may be reported. Runs the real Monitor against a local server that
 * is stopped and restarted between sweeps.
 *
 *   npx tsx scripts/check-transitions.ts
 */
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Monitor } from '../server/app.ts';
import type { Target, Transition } from '../shared/types.ts';
import { ALL_LAYERS } from '../shared/types.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const PORT = 8080; // in the HTTP layer's port list
const dataDir = mkdtempSync(path.join(tmpdir(), 'popingui-data-'));

const target: Target = {
  id: randomUUID(),
  host: '127.0.0.1',
  port: PORT,
  note: '',
  enabled: true,
  group: '',
  expect: '', layers: { ...ALL_LAYERS },
};
writeFileSync(path.join(dataDir, 'targets.json'), JSON.stringify([target]));
writeFileSync(
  path.join(dataDir, 'settings.json'),
  JSON.stringify({ intervalSec: 0, concurrency: 2, timeoutMs: 2000, layers: { dns: true, ping: false, tcp: true, tls: false, http: true } }),
);

function start(): Promise<{ close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => res.end('ok'));
  const sockets = new Set<net.Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () =>
      resolve({
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      }),
    );
  });
}

let site: { close: () => Promise<void> } | null = await start();

const monitor = new Monitor({ port: 8899, dataDir, distDir: null, sweepOnStart: false });
const batches: Transition[][] = [];
monitor.on('transitions', (t: Transition[]) => batches.push(t));
await monitor.start();

const verdict = () => monitor.states()[0]?.last?.verdict ?? 'нет результата';

/**
 * Transitions are emitted on a debounce rather than at a sweep boundary, so a
 * probe result and its notification no longer land in the same tick. Wait for
 * the batch to be flushed — or for the window to pass with nothing in it.
 */
const FLUSH_MS = 3500;
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, FLUSH_MS));
}

console.log('переходы статуса:');

await monitor.sweep();
await settle();
check('первый прогон: доступен', verdict() === 'ok' || verdict() === 'ok-no-icmp', verdict());
check('первый прогон молчит', batches.length === 0, `событий: ${batches.length}`);

await monitor.sweep();
await settle();
check('повтор без изменений молчит', batches.length === 0, `событий: ${batches.length}`);

await site.close();
site = null;
await monitor.sweep();
await settle();
check('падение замечено', batches.length === 1, `событий: ${batches.length}`);
check('помечено как ухудшение', batches.at(-1)?.[0]?.worse === true, `verdict=${verdict()}`);
check(
  'переход содержит хост и порт',
  batches.at(-1)?.[0]?.host === '127.0.0.1' && batches.at(-1)?.[0]?.port === PORT,
  JSON.stringify(batches.at(-1)?.[0] ?? null),
);

site = await start();
await monitor.sweep();
await settle();
check('восстановление замечено', batches.length === 2, `событий: ${batches.length}`);
check('помечено как улучшение', batches.at(-1)?.[0]?.worse === false, `verdict=${verdict()}`);

await monitor.sweep();
await settle();
check('стабильное состояние молчит', batches.length === 2, `событий: ${batches.length}`);

await site.close();
await monitor.stop();
rmSync(dataDir, { recursive: true, force: true });
console.log(failures ? `\nПРОВАЛОВ: ${failures}` : '\nвсе проверки пройдены');
process.exit(failures ? 1 : 0);
