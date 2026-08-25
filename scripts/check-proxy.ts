/**
 * Exercises the proxy dialer against locally spawned SOCKS5, SOCKS4a and
 * HTTP CONNECT servers. Everything runs on loopback, so the result reflects the
 * protocol implementation and nothing about the machine's connectivity.
 *
 *   npx tsx scripts/check-proxy.ts
 */
import net from 'node:net';
import http from 'node:http';
import { dial, parseProxy } from '../server/proxy.ts';
import type { ProxyConfig } from '../shared/types.ts';

const BANNER = 'HELLO-FROM-TARGET';
let failures = 0;

function listen(server: net.Server | http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

/** Target service: greets whoever connects, so we can prove the tunnel carries data. */
function makeTarget(): net.Server {
  return net.createServer((sock) => {
    sock.write(BANNER);
    sock.on('data', (d) => sock.write(d));
    sock.on('error', () => {});
  });
}

function pipeTo(client: net.Socket, host: string, port: number): void {
  // Pause until the upstream socket exists: a socket left flowing with no
  // 'data' listener drops whatever arrives in the meantime.
  client.pause();
  const up = net.connect({ host, port }, () => {
    client.pipe(up);
    up.pipe(client);
    client.resume();
  });
  up.on('error', () => client.destroy());
  client.on('error', () => up.destroy());
}

/** Minimal SOCKS5 server. `creds` non-null demands username/password auth. */
function makeSocks5(creds: { user: string; pass: string } | null): net.Server {
  return net.createServer((client) => {
    let stage: 'greet' | 'auth' | 'request' = 'greet';
    let buf = Buffer.alloc(0);

    client.on('error', () => {});
    client.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (stage === 'greet') {
        if (buf.length < 2) return;
        const n = buf[1]!;
        if (buf.length < 2 + n) return;
        const methods = [...buf.subarray(2, 2 + n)];
        buf = buf.subarray(2 + n);
        if (creds) {
          if (!methods.includes(0x02)) return void client.end(Buffer.from([0x05, 0xff]));
          client.write(Buffer.from([0x05, 0x02]));
          stage = 'auth';
        } else {
          client.write(Buffer.from([0x05, 0x00]));
          stage = 'request';
        }
      }

      if (stage === 'auth') {
        if (buf.length < 2) return;
        const ulen = buf[1]!;
        if (buf.length < 2 + ulen + 1) return;
        const plen = buf[2 + ulen]!;
        if (buf.length < 3 + ulen + plen) return;
        const user = buf.subarray(2, 2 + ulen).toString();
        const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        buf = buf.subarray(3 + ulen + plen);
        if (user !== creds!.user || pass !== creds!.pass) {
          return void client.end(Buffer.from([0x01, 0x01]));
        }
        client.write(Buffer.from([0x01, 0x00]));
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
        } else if (atyp === 0x03) {
          const len = buf[4]!;
          if (buf.length < 5 + len + 2) return;
          host = buf.subarray(5, 5 + len).toString();
          offset = 5 + len;
        } else {
          return void client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        }
        const port = buf.readUInt16BE(offset);
        buf = Buffer.alloc(0);
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
        client.removeAllListeners('data');
        pipeTo(client, host === 'target.test' ? '127.0.0.1' : host, port);
      }
    });
  });
}

/** Minimal SOCKS4a server. */
function makeSocks4(): net.Server {
  return net.createServer((client) => {
    let buf = Buffer.alloc(0);
    client.on('error', () => {});
    client.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 9) return;
      const port = buf.readUInt16BE(2);
      const ipIsPlaceholder = buf[4] === 0 && buf[5] === 0 && buf[6] === 0 && buf[7] !== 0;
      const firstNul = buf.indexOf(0x00, 8);
      if (firstNul === -1) return;
      let host: string;
      if (ipIsPlaceholder) {
        const secondNul = buf.indexOf(0x00, firstNul + 1);
        if (secondNul === -1) return;
        host = buf.subarray(firstNul + 1, secondNul).toString();
      } else {
        host = [...buf.subarray(4, 8)].join('.');
      }
      client.removeAllListeners('data');
      client.write(Buffer.from([0x00, 0x5a, 0, 0, 0, 0, 0, 0]));
      pipeTo(client, host === 'target.test' ? '127.0.0.1' : host, port);
    });
  });
}

/** Minimal HTTP CONNECT proxy. `token` non-null demands Basic auth. */
function makeHttpProxy(token: string | null): http.Server {
  const server = http.createServer((_req, res) => {
    res.writeHead(405).end();
  });
  server.on('connect', (req, clientSocket: net.Socket) => {
    if (token && req.headers['proxy-authorization'] !== `Basic ${token}`) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    const [host, port] = (req.url ?? '').split(':');
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    pipeTo(clientSocket, host === 'target.test' ? '127.0.0.1' : (host ?? '127.0.0.1'), Number(port));
  });
  return server;
}

function firstChunk(sock: net.Socket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('нет данных от цели')), timeoutMs);
    sock.once('data', (d: Buffer) => {
      clearTimeout(timer);
      resolve(d.toString());
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function expectOk(name: string, proxy: ProxyConfig, targetPort: number): Promise<void> {
  try {
    const sock = await dial({ host: 'target.test', port: targetPort, timeoutMs: 3000, proxy });
    const greeting = await firstChunk(sock);
    sock.destroy();
    if (greeting !== BANNER) throw new Error(`получено "${greeting}" вместо "${BANNER}"`);
    console.log(`  ✔ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ✖ ${name}: ${(e as Error).message}`);
  }
}

async function expectFail(name: string, proxy: ProxyConfig, targetPort: number, needle: string): Promise<void> {
  try {
    const sock = await dial({ host: 'target.test', port: targetPort, timeoutMs: 3000, proxy });
    sock.destroy();
    failures++;
    console.log(`  ✖ ${name}: подключение прошло, хотя не должно было`);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes(needle)) {
      console.log(`  ✔ ${name} — «${msg}»`);
    } else {
      failures++;
      console.log(`  ✖ ${name}: ожидалось «${needle}», получено «${msg}»`);
    }
  }
}

// ------------------------------------------------------------------- run

const target = makeTarget();
const targetPort = await listen(target);

const s5open = makeSocks5(null);
const s5auth = makeSocks5({ user: 'bob', pass: 'secret' });
const s4 = makeSocks4();
const hOpen = makeHttpProxy(null);
const hAuth = makeHttpProxy(Buffer.from('bob:secret').toString('base64'));

const [p5, p5a, p4, ph, pha] = await Promise.all([
  listen(s5open),
  listen(s5auth),
  listen(s4),
  listen(hOpen),
  listen(hAuth),
]);

const cfg = (url: string): ProxyConfig => {
  const p = parseProxy(url);
  if (!p) throw new Error(`не разобрал ${url}`);
  return p;
};

console.log('разбор строк:');
for (const [input, expect] of [
  ['socks5://127.0.0.1:1080', 'socks5 127.0.0.1:1080'],
  ['http://user:pw@proxy.local:3128', 'http proxy.local:3128'],
  ['10.0.0.1:9050', 'socks5 10.0.0.1:9050'],
  ['socks4a://127.0.0.1:1081', 'socks4 127.0.0.1:1081'],
] as const) {
  const p = parseProxy(input);
  const got = p ? `${p.kind} ${p.host}:${p.port}` : 'null';
  const ok = got === expect;
  if (!ok) failures++;
  console.log(`  ${ok ? '✔' : '✖'} ${input} → ${got}`);
}

console.log('\nтуннелирование:');
await expectOk('SOCKS5 без авторизации', cfg(`socks5://127.0.0.1:${p5}`), targetPort);
await expectOk('SOCKS5 с логином и паролем', cfg(`socks5://bob:secret@127.0.0.1:${p5a}`), targetPort);
await expectOk('SOCKS4a по имени хоста', cfg(`socks4a://127.0.0.1:${p4}`), targetPort);
await expectOk('HTTP CONNECT', cfg(`http://127.0.0.1:${ph}`), targetPort);
await expectOk('HTTP CONNECT с авторизацией', cfg(`http://bob:secret@127.0.0.1:${pha}`), targetPort);

console.log('\nошибки:');
await expectFail('SOCKS5 с неверным паролем', cfg(`socks5://bob:wrong@127.0.0.1:${p5a}`), targetPort, 'логин');
await expectFail('HTTP CONNECT без нужной авторизации', cfg(`http://127.0.0.1:${pha}`), targetPort, '407');
await expectFail('прокси не слушает порт', cfg('socks5://127.0.0.1:1'), targetPort, '');

for (const s of [target, s5open, s5auth, s4, hOpen, hAuth]) s.close();

console.log(failures ? `\nПРОВАЛОВ: ${failures}` : '\nвсе проверки пройдены');
process.exit(failures ? 1 : 0);
