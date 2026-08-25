/**
 * End-to-end check of a probe taken through a proxy: a local HTTP target, a
 * local SOCKS5 proxy, and the real `probe()` pipeline driving both. Loopback
 * only, so it says nothing about this machine's internet access.
 *
 *   npx tsx scripts/check-probe-proxy.ts
 */
import net from 'node:net';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { probe } from '../server/probe.ts';
import { parseProxy } from '../server/proxy.ts';
import type { Settings, Target } from '../shared/types.ts';
import { ALL_LAYERS } from '../shared/types.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** The HTTP layer only runs on ports it recognises, so bind one of those. */
async function listenOnKnownHttpPort(server: http.Server): Promise<number> {
  for (const port of [8080, 8000, 8008, 8081, 8888, 9000, 3000, 5000]) {
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) return port;
  }
  throw new Error('нет свободного порта из списка HTTP-портов');
}

const target = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', server: 'test-target' });
  res.end('<html><head><title>Тестовая цель</title></head><body>ok</body></html>');
});
const targetPort = await listenOnKnownHttpPort(target);

/** Records what the proxy was asked to reach, proving traffic really went through it. */
const seen: string[] = [];
const socks = net.createServer((client) => {
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
      let host: string;
      let offset: number;
      if (atyp === 0x01) {
        if (buf.length < 10) return;
        host = [...buf.subarray(4, 8)].join('.');
        offset = 8;
      } else {
        const len = buf[4]!;
        if (buf.length < 5 + len + 2) return;
        host = buf.subarray(5, 5 + len).toString();
        offset = 5 + len;
      }
      const port = buf.readUInt16BE(offset);
      seen.push(`${host}:${port}`);
      client.removeAllListeners('data');
      // Pause until upstream is ready, otherwise bytes arriving with no
      // 'data' listener are emitted to nobody and silently dropped.
      client.pause();
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
      const up = net.connect({ host: '127.0.0.1', port }, () => {
        client.pipe(up);
        up.pipe(client);
        client.resume();
      });
      up.on('error', () => client.destroy());
    }
  });
});
const socksPort = await new Promise<number>((resolve) => {
  socks.listen(0, '127.0.0.1', () => resolve((socks.address() as net.AddressInfo).port));
});

const proxy = parseProxy(`socks5://127.0.0.1:${socksPort}  Тестовый SOCKS`)!;
const base: Settings = {
  intervalSec: 0,
  concurrency: 4,
  timeoutMs: 4000,
  dohUrl: 'https://cloudflare-dns.com/dns-query',
  layers: { dns: true, ping: true, tcp: true, tls: true, http: true, udp: false },
  proxies: [proxy],
  activeProxyId: null,
  notify: 'bad',
};
const site: Target = {
  id: randomUUID(),
  host: '127.0.0.1',
  port: targetPort,
  note: '',
  enabled: true,
  group: '',
  expect: '', layers: { ...ALL_LAYERS },
};

console.log(`цель 127.0.0.1:${targetPort}, SOCKS5 на :${socksPort}\n`);

console.log('через прокси:');
const viaProxy = await probe(site, { ...base, activeProxyId: proxy.id });
const layer = (name: string) => viaProxy.layers.find((l) => l.layer === name);
check('маршрут помечен именем прокси', viaProxy.route === 'Тестовый SOCKS', viaProxy.route);
check('вердикт «доступен»', viaProxy.verdict === 'ok', viaProxy.verdict);
check('TCP поднялся', layer('tcp')?.status === 'ok', layer('tcp')?.detail ?? '');
check('HTTP ответил', layer('http')?.status === 'ok', layer('http')?.detail ?? '');
// ICMP cannot cross a SOCKS tunnel, so the ping layer must fall back to timing
// TCP connects through the proxy rather than skipping the check entirely.
check('пинг работает через прокси', layer('ping')?.status === 'ok', layer('ping')?.detail ?? '');
check(
  'пинг через прокси сделан по TCP',
  (layer('ping')?.detail ?? '').includes('TCP-пинг через прокси'),
  layer('ping')?.detail ?? '',
);
check('пинг через прокси дал число', typeof layer('ping')?.ms === 'number', String(layer('ping')?.ms));
check('прокси реально использован', seen.length >= 2, `запросов через прокси: ${seen.join(', ')}`);
check('в summary назван маршрут', viaProxy.summary.includes('Тестовый SOCKS'), viaProxy.summary);

console.log('\nнапрямую:');
const beforeDirect = seen.length;
const direct = await probe(site, base);
check('маршрут «Напрямую»', direct.route === 'Напрямую', direct.route);
check('вердикт доступности', direct.verdict === 'ok' || direct.verdict === 'ok-no-icmp', direct.verdict);
check(
  'прокси не задействован',
  seen.length === beforeDirect,
  `запросов через прокси было ${beforeDirect}, стало ${seen.length}`,
);

console.log('\nмёртвый прокси:');
const dead = parseProxy('socks5://127.0.0.1:1  Мёртвый')!;
const broken = await probe(site, { ...base, proxies: [dead], activeProxyId: dead.id });
check('вердикт не «доступен»', broken.verdict !== 'ok', broken.verdict);
check(
  'summary указывает на прокси',
  broken.summary.toLowerCase().includes('прокси'),
  broken.summary,
);

target.close();
socks.close();
console.log(failures ? `\nПРОВАЛОВ: ${failures}` : '\nвсе проверки пройдены');
process.exit(failures ? 1 : 0);
