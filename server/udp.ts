import dgram from 'node:dgram';
import net from 'node:net';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { ProxyConfig } from '../shared/types.ts';

/**
 * UDP reachability, direct and through a SOCKS5 relay.
 *
 * The rule that shapes everything here: over UDP, silence means nothing. There
 * is no handshake, and a closed port is supposed to answer with ICMP Port
 * Unreachable — but that does not reliably reach the socket (measured on
 * Windows: a closed local port produces no socket error at all). So "no reply"
 * cannot be reported as "closed", and the only trustworthy signal is a reply
 * that is recognisably an answer to what was sent.
 *
 * Which means a probe has to speak the protocol of whatever listens on the
 * port. Guessing by port number is crude, but it is the same guess the rest of
 * the world makes, and being wrong only costs a "no probe for this port".
 */

const now = () => Number(process.hrtime.bigint() / 1000000n);

export interface UdpProbe {
  /** What was sent, ready for the wire. */
  payload: Buffer;
  /** Human name of the protocol spoken. */
  protocol: string;
  /** True when the datagram is a plausible answer rather than noise. */
  accepts: (reply: Buffer) => boolean;
  /** Extra wording for the layer detail on success. */
  describe?: (reply: Buffer) => string;
}

// ------------------------------------------------------------------- QUIC

/**
 * A long-header packet carrying a version no server implements.
 *
 * RFC 9000 §6: a server receiving a version it does not support MUST answer
 * with a Version Negotiation packet. That makes it the cheapest possible proof
 * that QUIC reaches the host — no handshake keys, no AEAD, no TLS. A real
 * Initial packet would need header protection and a full ClientHello to get the
 * same yes/no answer.
 *
 * 0x0a0a0a0a is a reserved "greased" version, chosen precisely so that it will
 * never become a real one.
 */
export function quicVersionProbe(): Buffer {
  // Padded to 1200: servers are allowed to drop smaller datagrams outright, as
  // an anti-amplification measure, and several do.
  const p = Buffer.alloc(1200);
  p[0] = 0xc0; // long header, fixed bit set
  p.writeUInt32BE(0x0a0a0a0a, 1);
  p[5] = 8;
  randomBytes(8).copy(p, 6); // destination connection id
  p[14] = 8;
  randomBytes(8).copy(p, 15); // source connection id
  return p;
}

function isVersionNegotiation(reply: Buffer): boolean {
  // Long header with a zero version field is, by definition, Version Negotiation.
  return reply.length >= 5 && (reply[0]! & 0x80) !== 0 && reply.readUInt32BE(1) === 0;
}

/** Any QUIC long-header packet counts: the point is that QUIC got through. */
function isQuic(reply: Buffer): boolean {
  return reply.length >= 5 && (reply[0]! & 0x80) !== 0;
}

// -------------------------------------------------------------------- DNS

/** A minimal A-record query for a name the resolver has to look up. */
function dnsQueryProbe(name: string): { payload: Buffer; id: Buffer } {
  const id = randomBytes(2);
  const labels = name
    .split('.')
    .map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'ascii')]));
  return {
    id,
    payload: Buffer.concat([
      id,
      Buffer.from([0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]), // RD set, 1 question
      ...labels,
      Buffer.from([0x00, 0, 1, 0, 1]), // root label, QTYPE A, QCLASS IN
    ]),
  };
}

const DNS_RCODE: Record<number, string> = {
  0: 'ответ получен',
  1: 'резолвер не понял запрос',
  2: 'сбой резолвера',
  3: 'имени нет',
  5: 'резолвер отказал',
};

// ------------------------------------------------------------------ NTP

/** Client-mode packet, version 4. The reply is 48 bytes in server mode. */
function ntpProbe(): Buffer {
  const p = Buffer.alloc(48);
  p[0] = 0x23; // LI 0, VN 4, mode 3 (client)
  return p;
}

// ----------------------------------------------------------------- STUN

/** Binding request: 20-byte header with the magic cookie and a random id. */
function stunProbe(): { payload: Buffer; id: Buffer } {
  const id = randomBytes(12);
  const p = Buffer.alloc(20);
  p.writeUInt16BE(0x0001, 0); // Binding Request
  p.writeUInt16BE(0, 2); // no attributes
  p.writeUInt32BE(0x2112a442, 4); // magic cookie
  id.copy(p, 8);
  return { payload: p, id };
}

/**
 * Picks the probe for a port. Returns null when nothing is known about it —
 * better to report "no probe" than to send noise and read silence as a verdict.
 *
 * Only the port matters: none of the payloads name the host. The QUIC one is a
 * version-negotiation trigger, which carries no SNI, and the DNS query asks
 * about a fixed name rather than the target.
 */
export function probeForPort(port: number): UdpProbe | null {
  if (port === 443 || port === 8443 || port === 784) {
    return {
      payload: quicVersionProbe(),
      protocol: 'QUIC',
      accepts: isQuic,
      describe: (r) =>
        isVersionNegotiation(r)
          ? 'QUIC отвечает (version negotiation)'
          : 'QUIC отвечает',
    };
  }
  if (port === 53 || port === 5353) {
    // The name asked about is deliberately one that exists everywhere, so a
    // "no such name" answer really does mean the resolver is misbehaving.
    const { payload, id } = dnsQueryProbe('example.com');
    return {
      payload,
      protocol: 'DNS',
      accepts: (r) => r.length >= 12 && r[0] === id[0] && r[1] === id[1] && (r[2]! & 0x80) !== 0,
      describe: (r) => `резолвер ответил: ${DNS_RCODE[r[3]! & 0x0f] ?? `код ${r[3]! & 0x0f}`}`,
    };
  }
  if (port === 123) {
    return {
      payload: ntpProbe(),
      protocol: 'NTP',
      // Mode 4 (server) or 5 (broadcast) in the low three bits.
      accepts: (r) => r.length >= 48 && [4, 5].includes(r[0]! & 0x07),
      describe: () => 'сервер времени ответил',
    };
  }
  if (port === 3478 || port === 19302) {
    const { payload, id } = stunProbe();
    return {
      payload,
      protocol: 'STUN',
      accepts: (r) =>
        r.length >= 20 && r.readUInt32BE(4) === 0x2112a442 && r.subarray(8, 20).equals(id),
      describe: () => 'STUN-сервер ответил',
    };
  }
  return null;
}

// ------------------------------------------------------- SOCKS5 UDP relay

/**
 * Wraps a datagram in the SOCKS5 UDP request header (RFC 1928 §7):
 * RSV(2) FRAG(1) ATYP(1) DST.ADDR DST.PORT(2) DATA.
 */
function wrapUdp(host: string, port: number, data: Buffer): Buffer {
  const v4 = isIP(host) === 4;
  const addr = v4
    ? Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split('.').map(Number))])
    : Buffer.concat([Buffer.from([0x03, host.length]), Buffer.from(host, 'utf8')]);
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  return Buffer.concat([Buffer.from([0x00, 0x00, 0x00]), addr, p, data]);
}

/** Strips that same header off a reply. Returns null if it is malformed. */
function unwrapUdp(msg: Buffer): Buffer | null {
  if (msg.length < 10) return null;
  // FRAG other than 0 means a fragmented relay, which nothing sane emits and
  // which cannot be reassembled from a single datagram.
  if (msg[2] !== 0x00) return null;
  const atyp = msg[3];
  const head = atyp === 0x01 ? 8 : atyp === 0x04 ? 20 : atyp === 0x03 ? 5 + msg[4]! : -1;
  if (head < 0 || msg.length < head + 2) return null;
  return msg.subarray(head + 2);
}

interface Association {
  host: string;
  port: number;
  /** Must stay open: closing it tears the association down. */
  control: net.Socket;
}

function readExactly(sock: net.Socket, n: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const chunk = sock.read(n) as Buffer | null;
      if (!chunk) return;
      cleanup();
      resolve(chunk);
    };
    const fail = (e: Error) => {
      cleanup();
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error('прокси не ответил вовремя')), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      sock.off('readable', attempt);
      sock.off('end', onEnd);
      sock.off('error', fail);
    };
    const onEnd = () => fail(new Error('прокси закрыл соединение'));
    sock.on('readable', attempt);
    sock.once('end', onEnd);
    sock.once('error', fail);
    attempt();
  });
}

const SOCKS_REPLY: Record<number, string> = {
  0x01: 'общий сбой SOCKS-сервера',
  0x02: 'запрещено правилами',
  0x03: 'сеть недоступна',
  0x04: 'хост недоступен',
  0x05: 'соединение отклонено',
  0x07: 'прокси не поддерживает UDP ASSOCIATE',
  0x08: 'тип адреса не поддерживается',
};

/** Raised when the route itself cannot carry UDP, as opposed to the target failing. */
export class UdpUnsupported extends Error {}

/**
 * Opens a SOCKS5 UDP association and returns where to send datagrams.
 *
 * The caller owns `control` and must keep it open while sending, then destroy
 * it — the relay port lives and dies with that TCP connection.
 */
async function udpAssociate(proxy: ProxyConfig, timeoutMs: number): Promise<Association> {
  if (proxy.kind !== 'socks5') {
    // Not a failure of the target, and not a bug: HTTP CONNECT tunnels TCP only,
    // and SOCKS4 has no UDP command at all. (RFC 9298 defines UDP over HTTP, but
    // essentially no ordinary proxy implements it.)
    throw new UdpUnsupported(
      proxy.kind === 'http'
        ? 'HTTP-прокси не умеет UDP: CONNECT туннелирует только TCP'
        : 'SOCKS4 не умеет UDP',
    );
  }

  const control = net.connect({ host: proxy.host, port: proxy.port });
  control.setTimeout(timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      control.once('connect', resolve);
      control.once('timeout', () => reject(new Error('таймаут подключения к прокси')));
      control.once('error', reject);
    });
    control.setTimeout(0);

    const wantAuth = Boolean(proxy.username);
    control.write(wantAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
    const greeting = await readExactly(control, 2, timeoutMs);
    if (greeting[0] !== 0x05) throw new Error('это не SOCKS5-прокси');
    if (greeting[1] === 0xff) throw new Error('прокси отверг все способы авторизации');
    if (greeting[1] === 0x02) {
      if (!proxy.username) throw new Error('прокси требует логин и пароль');
      const user = Buffer.from(proxy.username, 'utf8');
      const pass = Buffer.from(proxy.password ?? '', 'utf8');
      control.write(
        Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]),
      );
      const auth = await readExactly(control, 2, timeoutMs);
      if (auth[1] !== 0x00) throw new Error('прокси не принял логин или пароль');
    }

    // 0.0.0.0:0 as the expected source: the port this process will send from is
    // not known until the socket is bound, and every relay accepts the wildcard.
    control.write(Buffer.from([0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    const head = await readExactly(control, 4, timeoutMs);
    if (head[1] !== 0x00) {
      const why = SOCKS_REPLY[head[1] ?? 0xff] ?? `код 0x${head[1]?.toString(16)}`;
      // 0x07 is the polite way of saying "UDP is not on the menu here".
      if (head[1] === 0x07) throw new UdpUnsupported(why);
      throw new Error(`прокси отказал: ${why}`);
    }

    const atyp = head[3];
    const len = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : (await readExactly(control, 1, timeoutMs))[0]!;
    const rest = await readExactly(control, len + 2, timeoutMs);
    let host: string;
    if (atyp === 0x01) host = Array.from(rest.subarray(0, 4)).join('.');
    else if (atyp === 0x03) host = rest.subarray(0, len).toString('utf8');
    else host = 'неизвестно';
    const port = rest.readUInt16BE(len);

    // A relay that answers 0.0.0.0 means "same host as this control connection"
    // — common in xray and shadowsocks. Sending to 0.0.0.0 would go nowhere.
    if (host === '0.0.0.0' || host === 'неизвестно') host = proxy.host;
    if (!port) throw new Error('прокси не выдал порт релея');

    return { host, port, control };
  } catch (e) {
    control.destroy();
    throw e;
  }
}

// -------------------------------------------------------------- the probe

export interface UdpOutcome {
  /** Round trip of the datagram exchange, ms. Null when nothing came back. */
  ms: number | null;
  protocol: string;
  detail: string;
  /** True when a recognisable answer arrived. */
  answered: boolean;
  /** Junk that is not an answer to what was asked — worth showing, not counting. */
  strayBytes: number;
  /** Relay endpoint, when the route went through one. */
  relay?: string;
}

/**
 * Sends one datagram and waits for an answer, direct or through a proxy.
 *
 * The association handshake happens over TCP and says nothing about the UDP
 * path, so it is set up first and excluded from the timing — the same rule that
 * makes the proxied TCP ping honest.
 */
export async function udpProbe(
  host: string,
  port: number,
  probe: UdpProbe,
  timeoutMs: number,
  proxy: ProxyConfig | null,
): Promise<UdpOutcome> {
  const assoc = proxy ? await udpAssociate(proxy, timeoutMs) : null;
  const sock = dgram.createSocket(isIP(host) === 6 ? 'udp6' : 'udp4');
  let stray = 0;

  try {
    return await new Promise<UdpOutcome>((resolve, reject) => {
      const done = (r: UdpOutcome) => {
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(
        () =>
          done({
            ms: null,
            protocol: probe.protocol,
            answered: false,
            strayBytes: stray,
            detail: `${probe.protocol}: ответа нет за ${timeoutMs} мс`,
            ...(assoc ? { relay: `${assoc.host}:${assoc.port}` } : {}),
          }),
        timeoutMs,
      );

      sock.on('message', (msg) => {
        const payload = assoc ? unwrapUdp(msg) : msg;
        if (!payload || !probe.accepts(payload)) {
          // Keep listening: a relay can pass through unrelated traffic, and one
          // stray datagram must not be read as the answer.
          stray += msg.length;
          return;
        }
        done({
          ms: now() - t0,
          protocol: probe.protocol,
          answered: true,
          strayBytes: stray,
          detail: probe.describe ? probe.describe(payload) : `${probe.protocol}: ответ получен`,
          ...(assoc ? { relay: `${assoc.host}:${assoc.port}` } : {}),
        });
      });
      sock.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });

      const t0 = now();
      if (assoc) sock.send(wrapUdp(host, port, probe.payload), assoc.port, assoc.host);
      // connect() first, so that an ICMP error can at least in principle be
      // delivered to this socket; on a direct route that is the only way it ever
      // reaches userspace at all.
      else sock.connect(port, host, () => sock.send(probe.payload));
    });
  } finally {
    try {
      sock.close();
    } catch {
      /* already closed */
    }
    assoc?.control.destroy();
  }
}
