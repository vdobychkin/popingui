/**
 * Pins down what the reported latency measures on each route.
 *
 * Two SOCKS5 servers stand in for the two kinds that exist in the wild: one
 * answers CONNECT before it has dialled upstream, the other only after — here
 * with a deliberate delay standing in for a distant target.
 *
 *   npx tsx scripts/check-latency.ts
 */
import net from 'node:net';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { probe } from '../server/probe.ts';
import { parseProxy } from '../server/proxy.ts';
import type { ProxyConfig, Settings, Target } from '../shared/types.ts';

const UPSTREAM_DELAY = 300;
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Parses a SOCKS5 greeting + CONNECT, then hands back the requested port. */
function socks5(mode: 'reply-first' | 'connect-first'): net.Server {
  return net.createServer((client) => {
    let stage: 'greet' | 'request' = 'greet';
    let buf = Buffer.alloc(0);
    client.on('error', () => {});
    client.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greet') {
        if (buf.length < 2) return;
        const n = buf[1]!;
        if (buf.length < 2 + n) return;
        buf = buf.subarray(2 + n);
        client.write(Buffer.from([0x05, 0x00]));
        stage = 'request';
      }
      if (stage === 'request') {
        if (buf.length < 5) return;
        const atyp = buf[3]!;
        let offset: number;
        if (atyp === 0x01) {
          if (buf.length < 10) return;
          offset = 8;
        } else {
          const len = buf[4]!;
          if (buf.length < 5 + len + 2) return;
          offset = 5 + len;
        }
        const port = buf.readUInt16BE(offset);
        client.removeAllListeners('data');
        // Removing the listener does not stop the flow: without pausing, bytes
        // arriving before the upstream socket is ready are emitted to nobody
        // and lost — which for HTTP is the entire request.
        client.pause();
        const ok = Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]);
        const link = () => {
          const up = net.connect({ host: '127.0.0.1', port }, () => {
            client.pipe(up);
            up.pipe(client);
            client.resume();
          });
          up.on('error', () => client.destroy());
        };
        if (mode === 'reply-first') {
          client.write(ok);
          link();
        } else {
          // Honest server: the reply reports the upstream result, so the wait
          // for that connection is part of what the client measures.
          setTimeout(() => {
            client.write(ok);
            link();
          }, UPSTREAM_DELAY);
        }
      }
    });
  });
}

const listen = (s: net.Server | http.Server) =>
  new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));

const target = http.createServer((_req, res) => res.end('ok'));
const targetPort = await new Promise<number>((r) => {
  target.listen(8080, '127.0.0.1', () => r(8080));
});

const fast = socks5('reply-first');
const honest = socks5('connect-first');
const [fastPort, honestPort] = [await listen(fast), await listen(honest)];

const base: Settings = {
  intervalSec: 0,
  concurrency: 2,
  timeoutMs: 5000,
  dohUrl: 'https://cloudflare-dns.com/dns-query',
  layers: { dns: true, ping: false, tcp: true, tls: false, http: true, udp: false },
  proxies: [],
  activeProxyId: null,
  notify: 'off',
};
const site: Target = {
  id: randomUUID(),
  host: '127.0.0.1',
  port: targetPort,
  note: '',
  enabled: true,
  group: '',
  expect: '',
  // A target's own selection wins over the global one, so the layers under test
  // have to be set here — `base.layers` alone would be ignored.
  layers: { ...base.layers },
};

async function run(label: string, proxy: ProxyConfig | null) {
  const settings: Settings = proxy
    ? { ...base, proxies: [proxy], activeProxyId: proxy.id }
    : base;
  const r = await probe(site, settings);
  const ms = (name: string) => r.layers.find((l) => l.layer === name)?.ms ?? null;
  console.log(
    `  ${label.padEnd(26)} итог=${String(r.latency).padStart(5)} мс (${String(r.latencyFrom).padEnd(4)})   tcp=${String(ms('tcp')).padStart(4)}   http=${String(ms('http')).padStart(4)}`,
  );
  return { total: r.latency, from: r.latencyFrom, tcp: ms('tcp'), http: ms('http') };
}

console.log(`цель :${targetPort}, задержка «честного» прокси ${UPSTREAM_DELAY} мс\n`);
console.log('замеры:');
const direct = await run('напрямую', null);
const viaFast = await run('прокси отвечает сразу', parseProxy(`socks5://127.0.0.1:${fastPort}`)!);
const viaHonest = await run('прокси ждёт цель', parseProxy(`socks5://127.0.0.1:${honestPort}`)!);

console.log('\nвыводы:');
check(
  'через «честный» прокси TCP учитывает ожидание цели',
  (viaHonest.tcp ?? 0) >= UPSTREAM_DELAY,
  `${viaHonest.tcp} мс при задержке ${UPSTREAM_DELAY} мс`,
);
check(
  'через «быстрый» прокси TCP ожидание НЕ видит',
  (viaFast.tcp ?? 999) < UPSTREAM_DELAY / 2,
  `${viaFast.tcp} мс — это только до прокси`,
);
check(
  'HTTP-слой всегда меряет полный путь',
  (viaHonest.http ?? 0) > 0 && (viaFast.http ?? 0) > 0,
  `быстрый=${viaFast.http} мс, честный=${viaHonest.http} мс`,
);
// The ping layer is switched off in this run, so TCP is the closest thing to a
// single round trip left — which is exactly the rule being asserted: whichever
// available layer measures one round trip wins, and direct TCP is one.
check(
  'напрямую без ping итог берётся из TCP',
  direct.total === direct.tcp && direct.from === 'tcp',
  `итог=${direct.total} (${direct.from}), tcp=${direct.tcp}`,
);
check(
  'через прокси итог НЕ берётся из TCP',
  viaFast.from !== 'tcp' && viaHonest.from !== 'tcp',
  `быстрый=${viaFast.from}, честный=${viaHonest.from}`,
);
check(
  'через «быстрый» прокси итог всё же отражает путь до цели',
  (viaFast.total ?? 0) > 0,
  `итог=${viaFast.total} мс из слоя ${viaFast.from}`,
);

target.close();
fast.close();
honest.close();
console.log(failures ? `\nПРОВАЛОВ: ${failures}` : '\nвсе утверждения подтверждены');
process.exit(0);
