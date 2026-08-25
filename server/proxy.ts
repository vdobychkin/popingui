import net from 'node:net';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { ProxyConfig, ProxyKind } from '../shared/types.ts';

/**
 * Opens TCP connections either directly or through a proxy. Hand-rolled rather
 * than pulled from a package: the three protocols are small, and the probe
 * needs the raw socket anyway to run its own TLS handshake on top.
 */

const DEFAULT_PORTS: Record<ProxyKind, number> = { http: 8080, socks5: 1080, socks4: 1080 };

/**
 * Accepts `socks5://user:pass@host:1080`, `http://host:3128`, `host:1080`
 * (assumed SOCKS5) and an optional ` name` / `# name` label suffix.
 */
export function parseProxy(input: string): ProxyConfig | null {
  const raw = input.trim();
  if (!raw || raw.startsWith('#')) return null;

  const split = /^(\S+)(?:[\s,;]+(.*))?$/.exec(raw);
  if (!split) return null;
  let text = split[1]!;
  const label = (split[2] ?? '').replace(/^[#\-–—]+\s*/, '').trim();

  let kind: ProxyKind = 'socks5';
  const schemeMatch = /^([a-z0-9]+):\/\//i.exec(text);
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase();
    if (scheme === 'http' || scheme === 'https') kind = 'http';
    else if (scheme === 'socks' || scheme === 'socks5' || scheme === 'socks5h') kind = 'socks5';
    else if (scheme === 'socks4' || scheme === 'socks4a') kind = 'socks4';
    else return null;
  } else {
    text = `socks5://${text}`;
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!url.hostname) return null;

  const port = url.port ? Number(url.port) : DEFAULT_PORTS[kind];
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return {
    id: randomUUID(),
    label: label || `${kind}://${url.hostname}:${port}`,
    kind,
    host: url.hostname,
    port,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

/**
 * Handshake reads stay in paused mode (`readable` + `read`), never flowing.
 * A `data` listener would put the socket in flowing mode, and anything the
 * target sends between removing that listener and the caller attaching its own
 * would be emitted to nobody and lost — for a server that greets first, that is
 * the whole first response.
 */
function readExactly(sock: net.Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const chunk = sock.read(n) as Buffer | null;
      if (!chunk) return;
      cleanup();
      resolve(chunk);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error('прокси закрыл соединение'));
    };
    const onErr = (e: Error) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      sock.off('readable', attempt);
      sock.off('end', onEnd);
      sock.off('error', onErr);
    };
    sock.on('readable', attempt);
    sock.once('end', onEnd);
    sock.once('error', onErr);
    attempt();
  });
}

/** Reads until the CRLFCRLF that ends an HTTP header block. */
function readHeaders(sock: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const attempt = () => {
      const chunk = sock.read() as Buffer | null;
      if (chunk) buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buf.length > 65536) {
          cleanup();
          reject(new Error('прокси прислал слишком длинный заголовок'));
        }
        return;
      }
      cleanup();
      // Anything past the header belongs to the tunnelled stream.
      if (buf.length > end + 4) sock.unshift(buf.subarray(end + 4));
      resolve(buf.subarray(0, end).toString('latin1'));
    };
    const onEnd = () => {
      cleanup();
      reject(new Error('прокси закрыл соединение'));
    };
    const onErr = (e: Error) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      sock.off('readable', attempt);
      sock.off('end', onEnd);
      sock.off('error', onErr);
    };
    sock.on('readable', attempt);
    sock.once('end', onEnd);
    sock.once('error', onErr);
    attempt();
  });
}

function connectRaw(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs);
    const fail = (e: Error) => {
      sock.destroy();
      reject(e);
    };
    sock.once('connect', () => {
      sock.setTimeout(0);
      sock.removeListener('error', fail);
      resolve(sock);
    });
    sock.once('timeout', () => fail(new Error('таймаут подключения')));
    sock.once('error', fail);
  });
}

async function socks5Connect(
  sock: net.Socket,
  host: string,
  port: number,
  proxy: ProxyConfig,
): Promise<void> {
  const wantAuth = Boolean(proxy.username);
  sock.write(wantAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));

  const greeting = await readExactly(sock, 2);
  if (greeting[0] !== 0x05) throw new Error('это не SOCKS5-прокси');
  const method = greeting[1];
  if (method === 0xff) throw new Error('прокси отверг все способы авторизации');

  if (method === 0x02) {
    if (!proxy.username) throw new Error('прокси требует логин и пароль');
    const user = Buffer.from(proxy.username, 'utf8');
    const pass = Buffer.from(proxy.password ?? '', 'utf8');
    sock.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
    const auth = await readExactly(sock, 2);
    if (auth[1] !== 0x00) throw new Error('прокси не принял логин или пароль');
  } else if (method !== 0x00) {
    throw new Error(`прокси предложил неподдерживаемый способ авторизации (0x${method?.toString(16)})`);
  }

  // Hostnames are sent as-is (SOCKS5h): resolution happens at the proxy, which
  // is the entire point of routing a blocked name through it.
  const head = Buffer.from([0x05, 0x01, 0x00]);
  let addr: Buffer;
  if (isIP(host) === 4) {
    addr = Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split('.').map(Number))]);
  } else {
    // IPv6 literals go out as a domain string too: every SOCKS5 server parses
    // them, and it avoids hand-packing the 16-byte form for a rare case.
    const name = Buffer.from(host, 'utf8');
    addr = Buffer.concat([Buffer.from([0x03, name.length]), name]);
  }
  const tail = Buffer.alloc(2);
  tail.writeUInt16BE(port);
  sock.write(Buffer.concat([head, addr, tail]));

  const reply = await readExactly(sock, 4);
  if (reply[1] !== 0x00) throw new Error(`прокси отказал: ${socks5Error(reply[1] ?? 0xff)}`);
  const atyp = reply[3];
  const boundLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : (await readExactly(sock, 1))[0]!;
  await readExactly(sock, boundLen + 2);
}

function socks5Error(code: number): string {
  const map: Record<number, string> = {
    0x01: 'общий сбой SOCKS-сервера',
    0x02: 'соединение запрещено правилами',
    0x03: 'сеть недоступна',
    0x04: 'хост недоступен',
    0x05: 'соединение отклонено',
    0x06: 'истёк TTL',
    0x07: 'команда не поддерживается',
    0x08: 'тип адреса не поддерживается',
  };
  return map[code] ?? `код 0x${code.toString(16)}`;
}

async function socks4Connect(
  sock: net.Socket,
  host: string,
  port: number,
  proxy: ProxyConfig,
): Promise<void> {
  const head = Buffer.alloc(8);
  head[0] = 0x04;
  head[1] = 0x01;
  head.writeUInt16BE(port, 2);
  const literal = isIP(host) === 4;
  if (literal) {
    Buffer.from(host.split('.').map(Number)).copy(head, 4);
  } else {
    // SOCKS4a marker: 0.0.0.x tells the proxy a hostname follows.
    head[4] = 0;
    head[5] = 0;
    head[6] = 0;
    head[7] = 1;
  }
  const user = Buffer.from(proxy.username ?? '', 'utf8');
  const parts = [head, user, Buffer.from([0x00])];
  if (!literal) parts.push(Buffer.from(host, 'utf8'), Buffer.from([0x00]));
  sock.write(Buffer.concat(parts));

  const reply = await readExactly(sock, 8);
  if (reply[1] !== 0x5a) {
    const map: Record<number, string> = {
      0x5b: 'запрос отклонён',
      0x5c: 'прокси не смог связаться с identd',
      0x5d: 'identd не подтвердил пользователя',
    };
    throw new Error(`прокси отказал: ${map[reply[1] ?? 0] ?? `код 0x${reply[1]?.toString(16)}`}`);
  }
}

async function httpConnect(
  sock: net.Socket,
  host: string,
  port: number,
  proxy: ProxyConfig,
): Promise<void> {
  const authority = `${host}:${port}`;
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
  if (proxy.username) {
    const token = Buffer.from(`${proxy.username}:${proxy.password ?? ''}`, 'utf8').toString('base64');
    lines.push(`Proxy-Authorization: Basic ${token}`);
  }
  lines.push('Proxy-Connection: keep-alive', '', '');
  sock.write(lines.join('\r\n'));

  const head = await readHeaders(sock);
  const status = Number(/^HTTP\/\d\.\d\s+(\d{3})/.exec(head)?.[1] ?? 0);
  if (status !== 200) {
    const reason = /^HTTP\/\d\.\d\s+\d{3}\s*(.*)$/m.exec(head)?.[1]?.trim() ?? '';
    if (status === 407) throw new Error('прокси требует авторизацию (407)');
    throw new Error(`прокси отказал: HTTP ${status}${reason ? ` ${reason}` : ''}`);
  }
}

export interface DialOptions {
  /** Hostname or IP to reach. Через прокси имя резолвит сам прокси. */
  host: string;
  port: number;
  timeoutMs: number;
  /** null dials directly. */
  proxy: ProxyConfig | null;
}

/**
 * Returns a connected socket. The caller owns it — destroy it when done, and
 * wrap it in TLS if the protocol calls for it.
 */
export async function dial({ host, port, timeoutMs, proxy }: DialOptions): Promise<net.Socket> {
  if (!proxy) return connectRaw(host, port, timeoutMs);

  const sock = await connectRaw(proxy.host, proxy.port, timeoutMs);
  const guard = setTimeout(() => sock.destroy(new Error('прокси не ответил вовремя')), timeoutMs);
  try {
    if (proxy.kind === 'socks5') await socks5Connect(sock, host, port, proxy);
    else if (proxy.kind === 'socks4') await socks4Connect(sock, host, port, proxy);
    else await httpConnect(sock, host, port, proxy);
    return sock;
  } catch (e) {
    sock.destroy();
    throw e;
  } finally {
    clearTimeout(guard);
  }
}
