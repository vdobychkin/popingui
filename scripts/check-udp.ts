/**
 * UDP-слой: прямо и через SOCKS5 UDP ASSOCIATE.
 *
 * Всё на loopback — свой DNS-«резолвер», свой SOCKS5 с релеем, свой прокси,
 * который UDP не умеет. Живой сети здесь нет намеренно: проверяется разбор
 * протокола и поведение при молчании, а не доступность интернета.
 *
 *   npx tsx scripts/check-udp.ts
 */
import dgram from 'node:dgram';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { advertisesH3, probe, quicSilenceMeaning } from '../server/probe.ts';
import { parseProxy } from '../server/proxy.ts';
import { probeForPort, quicVersionProbe, udpProbe, UdpUnsupported } from '../server/udp.ts';
import type { LayerResult, Settings, Target } from '../shared/types.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const bind = (s: dgram.Socket, port = 0) =>
  new Promise<number>((resolve, reject) => {
    // Без обработчика ошибки занятый порт не отклоняет промис, а просто вешает
    // скрипт: 5353 на Windows обычно уже занят mDNS.
    s.once('error', reject);
    s.bind(port, '127.0.0.1', () => resolve(s.address().port));
  });

/** Пробует порты по очереди: нужные слою номера могут быть заняты. */
async function bindAny(s: dgram.Socket, candidates: number[]): Promise<number> {
  for (const p of candidates) {
    try {
      return await bind(s, p);
    } catch {
      s.removeAllListeners('error');
    }
  }
  throw new Error(`не удалось занять ни один из портов: ${candidates.join(', ')}`);
}

const listen = (s: net.Server, port = 0) =>
  new Promise<number>((r) => s.listen(port, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));

// ------------------------------------------------------------------ цели

/** Отвечает на DNS-запрос: тот же идентификатор, флаг ответа, RCODE 0. */
const resolver = dgram.createSocket('udp4');
resolver.on('message', (msg, rinfo) => {
  const reply = Buffer.from(msg);
  reply[2] = 0x81; // QR=1, RD=1
  reply[3] = 0x80; // RA=1, RCODE=0
  resolver.send(reply, rinfo.port, rinfo.address);
});
// Порт произвольный: пробу для него собираем явно, а выбор пробы по номеру
// порта проверяется отдельно — так тест не зависит от того, свободен ли 53.
const resolverPort = await bind(resolver);
const dnsProbe = probeForPort(53)!;

/** Принимает датаграммы и не отвечает никогда. */
const mute = dgram.createSocket('udp4');
const mutePort = await bindAny(mute, [3478, 19302]);

/** Отвечает на QUIC-пробу пакетом Version Negotiation. */
const quic = dgram.createSocket('udp4');
quic.on('message', (msg, rinfo) => {
  const dcidLen = msg[5]!;
  const scidLen = msg[6 + dcidLen]!;
  const dcid = msg.subarray(6, 6 + dcidLen);
  const scid = msg.subarray(7 + dcidLen, 7 + dcidLen + scidLen);
  // В ответе идентификаторы меняются местами, версия — нулевая.
  const head = Buffer.alloc(5);
  head[0] = 0x80;
  head.writeUInt32BE(0x00000000, 1);
  const ver = Buffer.alloc(4);
  ver.writeUInt32BE(0x00000001);
  quic.send(
    Buffer.concat([
      head,
      Buffer.from([scid.length]),
      scid,
      Buffer.from([dcid.length]),
      dcid,
      ver,
    ]),
    rinfo.port,
    rinfo.address,
  );
});
const quicPort = await bindAny(quic, [8443, 443, 784]);

// ----------------------------------------------------------------- прокси

/**
 * SOCKS5 с UDP ASSOCIATE. `mode` задаёт, что отвечать на команду 0x03:
 * выдать релей, отказать кодом 0x07 или соврать адресом 0.0.0.0.
 */
function socksUdp(mode: 'relay' | 'refuse' | 'wildcard'): { server: net.Server; relayed: () => number } {
  let relayed = 0;
  const server = net.createServer((client) => {
    let stage = 0;
    client.on('error', () => {});
    client.on('data', async (d) => {
      if (stage === 0) {
        stage = 1;
        client.write(Buffer.from([0x05, 0x00]));
        return;
      }
      if (stage !== 1) return;
      stage = 2;
      if (d[1] !== 0x03) return client.write(Buffer.from([0x05, 0x07, 0, 1, 0, 0, 0, 0, 0, 0]));
      if (mode === 'refuse') return client.write(Buffer.from([0x05, 0x07, 0, 1, 0, 0, 0, 0, 0, 0]));

      // Релей: разворачивает заголовок, шлёт дальше, ответ заворачивает обратно.
      const relay = dgram.createSocket('udp4');
      const port = await bind(relay);
      let back: { port: number; address: string } | null = null;
      relay.on('message', (msg, rinfo) => {
        if (!back) {
          back = rinfo;
          relayed++;
          const atyp = msg[3];
          const head = atyp === 0x01 ? 8 : 5 + msg[4]!;
          const dstPort = msg.readUInt16BE(head);
          const body = msg.subarray(head + 2);
          const up = dgram.createSocket('udp4');
          up.on('message', (answer) => {
            relay.send(
              Buffer.concat([msg.subarray(0, head + 2), answer]),
              back!.port,
              back!.address,
            );
            up.close();
          });
          up.send(body, dstPort, '127.0.0.1');
          setTimeout(() => {
            try {
              up.close();
            } catch {}
          }, 4000).unref();
        }
      });
      const addr = mode === 'wildcard' ? [0, 0, 0, 0] : [127, 0, 0, 1];
      const p = Buffer.alloc(2);
      p.writeUInt16BE(port);
      client.write(Buffer.concat([Buffer.from([0x05, 0x00, 0x00, 0x01]), Buffer.from(addr), p]));
      client.on('close', () => {
        try {
          relay.close();
        } catch {}
      });
    });
  });
  return { server, relayed: () => relayed };
}

const good = socksUdp('relay');
const goodPort = await listen(good.server);
const wildcard = socksUdp('wildcard');
const wildcardPort = await listen(wildcard.server);
const refusing = socksUdp('refuse');
const refusingPort = await listen(refusing.server);

// --------------------------------------------------------------- проверки

console.log('выбор пробы по порту:');
check('443 — QUIC', probeForPort(443)?.protocol === 'QUIC');
check('53 — DNS', probeForPort(53)?.protocol === 'DNS');
check('123 — NTP', probeForPort(123)?.protocol === 'NTP');
check('3478 — STUN', probeForPort(3478)?.protocol === 'STUN');
check('22 — пробы нет', probeForPort(22) === null);

console.log('\nпакет QUIC:');
const q = quicVersionProbe();
check('добит до 1200 байт', q.length === 1200, `${q.length} Б`);
check('длинный заголовок', (q[0]! & 0x80) !== 0);
check('версия заведомо неизвестная', q.readUInt32BE(1) === 0x0a0a0a0a, `0x${q.readUInt32BE(1).toString(16)}`);

console.log('\nпрямые пробы:');
const dns = await udpProbe('127.0.0.1', resolverPort, dnsProbe, 2000, null);
check('DNS: ответ распознан', dns.answered, dns.detail);
check('DNS: замерено время', dns.ms !== null && dns.ms < 2000, `${dns.ms} мс`);

const vn = await udpProbe('127.0.0.1', quicPort, probeForPort(quicPort)!, 2000, null);
check('QUIC: version negotiation распознан', vn.answered, vn.detail);
check('QUIC: назван именно VN', vn.detail.includes('version negotiation'), vn.detail);

const silent = await udpProbe('127.0.0.1', mutePort, probeForPort(mutePort)!, 800, null);
check('молчание не выдаётся за ответ', !silent.answered, silent.detail);
check('и не выдаётся за измеренное время', silent.ms === null, String(silent.ms));

console.log('\nчерез SOCKS5 UDP ASSOCIATE:');
const socks = parseProxy(`socks5://127.0.0.1:${goodPort}  UDP-релей`)!;
const viaRelay = await udpProbe('127.0.0.1', resolverPort, dnsProbe, 3000, socks);
check('ответ пришёл через релей', viaRelay.answered, viaRelay.detail);
check('релей действительно использован', good.relayed() > 0, `датаграмм через релей: ${good.relayed()}`);
check('адрес релея показан', Boolean(viaRelay.relay), String(viaRelay.relay));

const wild = parseProxy(`socks5://127.0.0.1:${wildcardPort}  Релей 0.0.0.0`)!;
const viaWild = await udpProbe('127.0.0.1', resolverPort, dnsProbe, 3000, wild);
check('релей 0.0.0.0 заменён на адрес прокси', viaWild.answered, String(viaWild.relay));

console.log('\nмаршруты без UDP:');
const noUdp = parseProxy(`socks5://127.0.0.1:${refusingPort}  Без UDP`)!;
let refusedWith = '';
try {
  await udpProbe('127.0.0.1', resolverPort, dnsProbe, 2000, noUdp);
} catch (e) {
  refusedWith = e instanceof UdpUnsupported ? `UdpUnsupported: ${(e as Error).message}` : `другое: ${(e as Error).message}`;
}
check('отказ 0x07 — это «маршрут не умеет UDP»', refusedWith.startsWith('UdpUnsupported'), refusedWith);

const httpProxy = parseProxy(`http://127.0.0.1:${refusingPort}  HTTP`)!;
let httpRefused = '';
try {
  await udpProbe('127.0.0.1', resolverPort, dnsProbe, 2000, httpProxy);
} catch (e) {
  httpRefused = e instanceof UdpUnsupported ? (e as Error).message : `другое: ${(e as Error).message}`;
}
check('HTTP-прокси отсекается без обращения к сети', httpRefused.includes('CONNECT'), httpRefused);

// ------------------------------------------------------------ слой целиком

const base: Settings = {
  intervalSec: 0,
  concurrency: 2,
  timeoutMs: 1500,
  dohUrl: 'https://cloudflare-dns.com/dns-query',
  layers: { dns: false, ping: false, tcp: false, tls: false, http: false, udp: true },
  proxies: [],
  activeProxyId: null,
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
  layers: { ...base.layers },
});
const layerOf = (ls: LayerResult[]) => ls.find((l) => l.layer === 'udp')!;

console.log('\nслой в составе пробы:');
const okLayer = layerOf((await probe(target(quicPort), base)).layers);
check('ответ — статус ok', okLayer.status === 'ok', `${okLayer.status}: ${okLayer.detail}`);
check('протокол назван', okLayer.extra?.['протокол'] === 'QUIC', String(okLayer.extra?.['протокол']));

const warnLayer = layerOf((await probe(target(mutePort), base)).layers);
check('молчание — предупреждение, не отказ', warnLayer.status === 'warn', warnLayer.status);
check('без придуманного времени', warnLayer.ms === null, String(warnLayer.ms));

const noProbeLayer = layerOf((await probe(target(22), base)).layers);
check('порт без пробы пропускается', noProbeLayer.status === 'skip', noProbeLayer.detail);

// TCP работает, а UDP молчит — ради этого вердикта всё и затевалось.
const tcpAlive = net.createServer(() => {});
await listen(tcpAlive, mutePort);
const both: Settings = {
  ...base,
  layers: { dns: false, ping: false, tcp: true, tls: false, http: false, udp: true },
};
const combined = await probe({ ...target(mutePort), layers: both.layers }, both);
console.log(`\nTCP жив, UDP молчит: вердикт «${combined.verdict}»`);
console.log(`  ${combined.summary}`);
check('вердикт — udp-silent', combined.verdict === 'udp-silent', combined.verdict);

/**
 * Молчание QUIC само по себе ничего не значит: большая часть сайтов QUIC не
 * раздаёт вовсе (github.com в их числе), и красить их в жёлтый — врать.
 * Решает объявление HTTP/3 в заголовке alt-svc.
 */
console.log('\nразбор alt-svc:');
check('h3 объявлен', advertisesH3({ 'alt-svc': 'h3=":443"; ma=86400' }));
check('старая метка h3-29 тоже считается', advertisesH3({ 'alt-svc': 'h3-29=":443"' }));
check('несколько значений', advertisesH3({ 'alt-svc': ['h2=":443"', 'h3=":443"'] }));
check('заголовка нет', !advertisesH3({}));
check('только h2 — это не h3', !advertisesH3({ 'alt-svc': 'h2=":443"' }));
// «h3» внутри другого слова не должно срабатывать.
check('чужая подстрока не считается', !advertisesH3({ 'alt-svc': 'xh3=":443"' }));

console.log('\nчто значит молчание QUIC:');
check('объявляет HTTP/3 и молчит — находка', quicSilenceMeaning(true) === 'finding');
check('не объявляет — так и должно быть', quicSilenceMeaning(false) === 'expected');
check('HTTP-слой не отработал — неизвестно', quicSilenceMeaning(null) === 'unknown');

// На QUIC-порту без HTTP-слоя вердикта быть не должно: сравнить не с чем.
const quicMute = dgram.createSocket('udp4');
const quicMutePort = await bindAny(quicMute, [784, 443]);
const quicTcp = net.createServer(() => {});
await listen(quicTcp, quicMutePort);
const unknown = await probe({ ...target(quicMutePort), layers: both.layers }, both);
const unknownUdp = layerOf(unknown.layers);
console.log(`\nQUIC-порт ${quicMutePort}, HTTP-слой выключен: вердикт «${unknown.verdict}»`);
console.log(`  ${unknownUdp.detail}`);
check('без данных об HTTP/3 вердикт не выносится', unknown.verdict !== 'udp-silent', unknown.verdict);
check('но слой честно говорит, что не знает', unknownUdp.detail.includes('неизвестно'), unknownUdp.detail);
quicMute.close();
quicTcp.close();

// А без живого TCP молчание UDP вердикта не меняет.
const udpOnly = await probe(target(mutePort), base);
check('без TCP молчание UDP вердикта не портит', udpOnly.verdict !== 'udp-silent', udpOnly.verdict);

resolver.close();
mute.close();
quic.close();
tcpAlive.close();
good.server.close();
wildcard.server.close();
refusing.server.close();
console.log(failures ? `\nПРОВАЛОВ: ${failures}` : '\nвсе проверки пройдены');
process.exit(failures ? 1 : 0);
