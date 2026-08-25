/**
 * Proves the ping layer measures the path to the target, not the path to the
 * proxy.
 *
 * The proxy here is the kind that caused the implausible 2–3 ms readings: it
 * answers CONNECT the instant it has parsed the request — as shadowsocks, Tor
 * and most VPN helpers running on localhost do — and only then relays, over a
 * link with a deliberate delay standing in for a distant server.
 *
 *   npx tsx scripts/check-tcp-ping.ts
 */
import net from 'node:net';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { clientHello, probe } from '../server/probe.ts';
import { parseProxy } from '../server/proxy.ts';
import type { Settings, Target } from '../shared/types.ts';
import { ALL_LAYERS } from '../shared/types.ts';

/** One-way delay of the simulated link, so a round trip costs twice this. */
const LINK_DELAY = 120;

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/**
 * SOCKS5 server that replies to CONNECT immediately and then relays every
 * chunk `LINK_DELAY` later, in both directions.
 */
function laggyProxy(): net.Server {
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
        // Pause before the upstream socket exists, or bytes that arrive in the
        // meantime are emitted to nobody and lost.
        client.pause();
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));

        const up = net.connect({ host: '127.0.0.1', port }, () => {
          client.on('data', (d) => setTimeout(() => up.write(d), LINK_DELAY));
          up.on('data', (d) => setTimeout(() => client.write(d), LINK_DELAY));
          client.resume();
        });
        up.on('error', () => client.destroy());
      }
    });
  });
}

const listen = (s: net.Server | http.Server, port = 0) =>
  new Promise<number>((r) =>
    s.listen(port, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)),
  );

// 8080 is in the known-HTTP set, so the ping layer pokes it with a HEAD.
const site = http.createServer((_req, res) => res.end('ok'));
const sitePort = await listen(site, 8080);
// A port nothing is known about, answered by a server that never speaks first
// and never answers — the case where no round trip can be measured at all.
const mute = net.createServer(() => {});
const mutePort = await listen(mute);

const proxy = laggyProxy();
const proxyPort = await listen(proxy);
const cfg = parseProxy(`socks5://127.0.0.1:${proxyPort}  Тормозной`)!;

const base: Settings = {
  intervalSec: 0,
  concurrency: 2,
  timeoutMs: 3000,
  dohUrl: 'https://cloudflare-dns.com/dns-query',
  layers: { dns: false, ping: true, tcp: true, tls: false, http: false, udp: false },
  proxies: [cfg],
  activeProxyId: cfg.id,
  notify: 'off',
};
const target = (port: number): Target => ({
  id: randomUUID(),
  host: '127.0.0.1',
  port,
  note: '',
  enabled: true,
  group: '',
  expect: '',
  layers: { ...ALL_LAYERS },
});

console.log(`прокси отвечает на CONNECT сразу, канал добавляет ${LINK_DELAY} мс в каждую сторону\n`);

const r = await probe(target(sitePort), base);
const ping = r.layers.find((l) => l.layer === 'ping')!;
const tcp = r.layers.find((l) => l.layer === 'tcp')!;
console.log('замеры:');
console.log(`  ping = ${ping.ms} мс — ${ping.detail}`);
console.log(`  tcp  = ${tcp.ms} мс — ${tcp.detail}`);
console.log(`  итог = ${r.latency} мс (слой ${r.latencyFrom})\n`);

console.log('проверки:');
check(
  'TCP-слой обманут: видит только время до прокси',
  (tcp.ms ?? 999) < LINK_DELAY,
  `${tcp.ms} мс при задержке канала ${LINK_DELAY} мс`,
);
check(
  'ping измеряет полный круг до цели',
  (ping.ms ?? 0) >= LINK_DELAY * 1.5,
  `${ping.ms} мс, ожидалось около ${LINK_DELAY * 2}`,
);
check(
  'время открытия туннеля не попало в результат',
  (ping.ms ?? 0) < LINK_DELAY * 2 + 250,
  `${ping.ms} мс`,
);
check('итог берётся из ping', r.latencyFrom === 'ping' && r.latency === ping.ms, String(r.latencyFrom));
check(
  'время до прокси показано отдельно',
  ping.extra?.['до прокси, мс'] !== undefined,
  String(ping.extra?.['до прокси, мс']),
);
check(
  'досрочный ответ на CONNECT назван',
  String(ping.extra?.['ответ на CONNECT'] ?? '').includes('досрочный'),
  String(ping.extra?.['ответ на CONNECT'] ?? 'не отмечен'),
);

console.log('\nмолчаливая цель:');
const silent = await probe(target(mutePort), base);
const silentPing = silent.layers.find((l) => l.layer === 'ping')!;
console.log(`  ping — ${silentPing.detail}`);
check(
  'молчание не выдаётся за измеренную задержку',
  silentPing.ms === null,
  `ms=${silentPing.ms}, статус ${silentPing.status}`,
);
check('соединение при этом состоялось — это предупреждение, не отказ', silentPing.status === 'warn');

console.log('\nсформированный ClientHello:');
const hello = clientHello('example.com');
const recLen = hello.readUInt16BE(3);
const hsLen = (hello[6]! << 16) | (hello[7]! << 8) | hello[8]!;
check('это TLS-запись рукопожатия', hello[0] === 0x16 && hello[1] === 0x03);
check('длина записи совпадает с телом', recLen === hello.length - 5, `${recLen} / ${hello.length - 5}`);
check('длина рукопожатия совпадает с телом', hsLen === hello.length - 9, `${hsLen} / ${hello.length - 9}`);
check('это ClientHello', hello[5] === 0x01);
check('SNI содержит имя хоста', hello.includes(Buffer.from('example.com', 'utf8')));
check('для IP-адреса SNI не отправляется', !clientHello('1.2.3.4').includes(Buffer.from('1.2.3.4')));

site.close();
mute.close();
proxy.close();
console.log(failures ? `\nПРОВАЛОВ: ${failures}` : '\nвсе проверки пройдены');
process.exit(failures ? 1 : 0);
