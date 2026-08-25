/**
 * Exercises the per-target scheduler against two local HTTP servers — one that
 * answers instantly, one that stalls — and asserts the properties that make
 * overlapping runs safe:
 *
 *   • probes actually overlap (more than one in flight at once)
 *   • never more in flight than the concurrency setting
 *   • a slow target does not hold up a fast one
 *   • nothing piles up without bound at a sub-second interval
 *
 *   npx tsx scripts/check-scheduler.ts
 */
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Monitor } from '../server/app.ts';
import { listStates, setSettings } from '../server/store.ts';
import { ALL_LAYERS } from '../shared/types.ts';

const FAST_PORT = 8000;
const SLOW_PORT = 8080;
const SLOW_MS = 1500;
const RUN_MS = 9000;

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const listen = (s: http.Server, port: number) =>
  new Promise<void>((r) => s.listen(port, '127.0.0.1', () => r()));

/**
 * Both servers count how many requests they are serving at once.
 *
 * That count, and not the monitor's own `inFlight`, is what proves a target is
 * not probed twice over: `inFlight` is a Set keyed by target id, so it cannot
 * exceed one entry per target no matter how many probes are actually running.
 * The target being asked twice at the same moment is visible only here.
 */
const open = { fast: 0, slow: 0 };
const peak = { fast: 0, slow: 0 };
const serve = (who: 'fast' | 'slow', delay: number) =>
  http.createServer((_q, res) => {
    open[who]++;
    peak[who] = Math.max(peak[who], open[who]);
    setTimeout(() => {
      open[who]--;
      res.end('ok');
    }, delay);
  });

const fast = serve('fast', 0);
const slow = serve('slow', SLOW_MS);
await listen(fast, FAST_PORT);
await listen(slow, SLOW_PORT);

const dataDir = mkdtempSync(path.join(tmpdir(), 'popingui-sched-'));
// Write the target list before starting: an empty data directory is seeded
// with real internet hosts, and those would occupy the worker pool and make
// this a test of the network rather than of the scheduler.
writeFileSync(
  path.join(dataDir, 'targets.json'),
  JSON.stringify([
    { id: 'fast', host: '127.0.0.1', port: FAST_PORT, note: 'fast', enabled: true, group: '', expect: '', layers: { ...ALL_LAYERS } },
    { id: 'slow', host: '127.0.0.1', port: SLOW_PORT, note: 'slow', enabled: true, group: '', expect: '', layers: { ...ALL_LAYERS } },
  ]),
  'utf8',
);

const monitor = new Monitor({ port: 8899, dataDir, distDir: null, sweepOnStart: false });
await monitor.start();

setSettings({
  intervalSec: 0.1,
  concurrency: 4,
  timeoutMs: 4000,
  // Only the layers these plain HTTP servers can answer; DNS/ICMP would just
  // add noise and latency that has nothing to do with scheduling.
  layers: { dns: false, ping: false, tcp: true, tls: false, http: true, udp: false },
});

console.log(`быстрая цель :${FAST_PORT}, медленная :${SLOW_PORT} (${SLOW_MS} мс), интервал 0,1 с, лимит 4\n`);

const targetCount = listStates().length;
let maxInFlight = 0;
let sawOverlap = 0;
let maxQueued = 0;
const sampler = setInterval(() => {
  const p = monitor.progress();
  maxInFlight = Math.max(maxInFlight, p.inFlight);
  maxQueued = Math.max(maxQueued, p.queued);
  if (p.inFlight > 1) sawOverlap++;
}, 25);

await new Promise((r) => setTimeout(r, RUN_MS));
clearInterval(sampler);

const byNote = (note: string) => listStates().find((s) => s.target.note === note)!;
const fastProbes = byNote('fast').history.length;
const slowProbes = byNote('slow').history.length;
const fastVerdict = byNote('fast').last?.verdict;

console.log('замеры:');
console.log(`  целей в списке: ${targetCount}`);
console.log(`  проб быстрой цели: ${fastProbes}, медленной: ${slowProbes}`);
console.log(`  пик одновременных проб: ${maxInFlight}, пик очереди: ${maxQueued}`);
console.log(`  пик одновременных запросов к одной цели: быстрая ${peak.fast}, медленная ${peak.slow}`);

console.log('\nпроверки:');
check(
  'цель не пробуется дважды одновременно',
  peak.fast <= 1 && peak.slow <= 1,
  `быстрая ${peak.fast}, медленная ${peak.slow}`,
);
check('пробы идут внахлёст', maxInFlight > 1 && sawOverlap > 0, `пик ${maxInFlight}`);
check('лимит параллельности соблюдён', maxInFlight <= 4, `пик ${maxInFlight} при лимите 4`);
check(
  'медленная цель не тормозит быструю',
  fastProbes > slowProbes * 2,
  `${fastProbes} против ${slowProbes}`,
);
check('очередь не разрастается', maxQueued <= 4, `пик ${maxQueued}`);
check('быстрая цель опрашивается часто', fastProbes >= 10, `${fastProbes} проб за ${RUN_MS / 1000} с`);
check('результаты осмысленные', fastVerdict === 'ok' || fastVerdict === 'ok-no-icmp', String(fastVerdict));

/**
 * An explicit re-check of a target that is already being probed must wait for
 * the running probe instead of racing it. Two overlapping probes of one target
 * both write `state.last`, and the slower one — started with the older settings
 * — can land last: edit a target's layers and the grid shows a result from the
 * layer set that was just switched off.
 */
console.log('\nповторная проверка поверх идущей:');
monitor.stopSweep();
await new Promise((r) => setTimeout(r, 300));
setSettings({ intervalSec: 0 }); // manual only, so nothing else queues the target

const slowId = byNote('slow').target.id;
peak.slow = 0;
const before = byNote('slow').history.length;
// Four re-checks in quick succession, well inside one probe of the slow target.
void monitor.sweep([slowId]);
for (let i = 0; i < 3; i++) {
  await new Promise((r) => setTimeout(r, 120));
  void monitor.sweep([slowId]);
}
await new Promise((r) => setTimeout(r, SLOW_MS * 3));
const added = byNote('slow').history.length - before;
console.log(`  проб добавилось: ${added}, пик одновременных запросов к цели: ${peak.slow}`);
check('четыре запроса не вылились в четыре параллельные пробы', peak.slow <= 1, `пик ${peak.slow}`);
check('повторные запросы не потеряны и не размножены', added >= 1 && added <= 2, `${added} проб`);

// Pausing must actually stop the scheduler, not just drop the current queue.
monitor.stopSweep();
await new Promise((r) => setTimeout(r, 1200));
const afterPause = listStates().reduce((n, s) => n + s.history.length, 0);
await new Promise((r) => setTimeout(r, 1200));
const later = listStates().reduce((n, s) => n + s.history.length, 0);
check('пауза останавливает опрос', later === afterPause, `${afterPause} -> ${later}`);

await monitor.stop();
fast.close();
slow.close();
rmSync(dataDir, { recursive: true, force: true });
console.log(failures ? `\nПРОВАЛОВ: ${failures}` : '\nвсе проверки пройдены');
process.exit(failures ? 1 : 0);
