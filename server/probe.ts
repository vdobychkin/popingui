import { promises as dns } from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type {
  LayerName,
  LayerResult,
  LayerSet,
  ProbeResult,
  ProxyConfig,
  Settings,
  Target,
  Verdict,
} from '../shared/types.ts';
import { CERT_WARN_DAYS, DIRECT_ROUTE } from '../shared/types.ts';
import { dial } from './proxy.ts';
import { UdpUnsupported, probeForPort, udpProbe } from './udp.ts';

const now = () => Number(process.hrtime.bigint() / 1000000n);

/** Addresses ISPs hand back instead of NXDOMAIN when a name is filtered. */
const SINKHOLE_HINTS = new Set(['0.0.0.0', '127.0.0.1', '::1']);

/** Substrings that appear on Russian/CIS ISP block pages and generic stubs. */
const STUB_MARKERS = [
  'доступ ограничен',
  'доступ к информационному ресурсу ограничен',
  'ограничен доступ',
  'заблокирован',
  'роскомнадзор',
  'единый реестр',
  'запрещен',
  'access denied by',
  'blocked by',
  'this site is blocked',
  'website is blocked',
];

/** Ports where a bare TLS handshake is the expected greeting. */
const TLS_PORTS = new Set([443, 465, 563, 636, 853, 989, 990, 993, 995, 4443, 5061, 8443, 8883, 9443]);
/** Ports worth issuing an HTTP request against. */
const HTTP_PORTS = new Set([80, 443, 591, 3000, 5000, 8000, 8008, 8080, 8081, 8443, 8888, 9000, 9443]);

function isPrivate(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const p = ip.split('.').map(Number) as [number, number, number, number];
  if (p[0] === 10 || p[0] === 127) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  return false;
}

// ---------------------------------------------------------------- DNS layer

interface DnsOutcome {
  layer: LayerResult;
  /** Address the later layers should dial — always what the OS would use. */
  address: string | null;
  /** A DoH-only address, used later as a control when the system one fails. */
  controlAddress: string | null;
  systemIps: string[];
  dohIps: string[];
  /** System resolver clearly lied (empty answer or sinkhole) while DoH answered. */
  hijacked: boolean;
  /** Answers merely differ — normal for anycast/CDN, needs confirmation. */
  divergent: boolean;
  nxdomain: boolean;
}

/**
 * Uses getaddrinfo rather than dns.resolve4: we want the exact answer the OS
 * (and therefore the user's browser) gets, including hosts file and any
 * resolver the provider pushed via DHCP. dns.resolve4 speaks UDP itself and
 * silently returns nothing in environments where that is filtered.
 */
async function resolveSystem(host: string, timeoutMs: number): Promise<string[]> {
  const lookup = dns.lookup(host, { all: true, family: 4 }).then((rs) => rs.map((r) => r.address));
  return Promise.race([
    lookup,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dns timeout')), timeoutMs)),
  ]);
}

async function resolveDoh(host: string, dohUrl: string, timeoutMs: number): Promise<string[]> {
  const url = `${dohUrl}${dohUrl.includes('?') ? '&' : '?'}name=${encodeURIComponent(host)}&type=A`;
  const res = await fetch(url, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
  const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
  return (body.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
}

async function checkDns(target: Target, s: Settings): Promise<DnsOutcome> {
  const t0 = now();
  if (isIP(target.host)) {
    return {
      layer: { layer: 'dns', status: 'skip', ms: null, detail: 'литеральный IP' },
      address: target.host,
      controlAddress: null,
      systemIps: [target.host],
      dohIps: [],
      hijacked: false,
      divergent: false,
      nxdomain: false,
    };
  }

  const [sysRes, dohRes] = await Promise.allSettled([
    resolveSystem(target.host, s.timeoutMs),
    resolveDoh(target.host, s.dohUrl, s.timeoutMs),
  ]);

  const systemIps = sysRes.status === 'fulfilled' ? sysRes.value : [];
  const dohIps = dohRes.status === 'fulfilled' ? dohRes.value : [];
  const ms = now() - t0;

  const sysFirst = systemIps[0] ?? null;
  const dohOnly = dohIps.find((ip) => !systemIps.includes(ip)) ?? null;
  const extra = { system: systemIps, doh: dohIps.length ? dohIps : ['нет ответа'] };
  const base = { systemIps, dohIps, nxdomain: false, hijacked: false, divergent: false };

  // Nothing anywhere: the name genuinely does not exist (or DNS is dead).
  if (systemIps.length === 0 && dohIps.length === 0) {
    const reason = sysRes.status === 'rejected' ? (sysRes.reason as Error).message : 'пустой ответ';
    return {
      ...base,
      layer: { layer: 'dns', status: 'fail', ms, detail: `не резолвится (${reason})` },
      address: null,
      controlAddress: null,
      nxdomain: true,
    };
  }

  // System resolver blind while DoH answers: resolver-level filtering, and the
  // only case where we dial an address the OS itself would never have used.
  if (systemIps.length === 0) {
    return {
      ...base,
      layer: { layer: 'dns', status: 'fail', ms, detail: 'системный DNS молчит, DoH отвечает', extra },
      address: dohIps[0] ?? null,
      controlAddress: null,
      hijacked: true,
    };
  }

  // Answer points at a bit-bucket: unambiguous sinkholing, no control needed.
  if (systemIps.some((ip) => SINKHOLE_HINTS.has(ip) || isPrivate(ip))) {
    return {
      ...base,
      layer: { layer: 'dns', status: 'fail', ms, detail: `подмена на служебный адрес ${sysFirst}`, extra },
      address: dohOnly ?? sysFirst,
      controlAddress: null,
      hijacked: true,
    };
  }

  // Different-but-plausible addresses. Anycast and CDNs do this constantly, so
  // this is NOT a verdict on its own — it only arms the control probe below.
  if (dohOnly && dohIps.length > 0) {
    return {
      ...base,
      layer: {
        layer: 'dns',
        status: 'ok',
        ms,
        detail: `${sysFirst} (DoH отдаёт ${dohIps[0]} — обычно CDN/anycast)`,
        extra,
      },
      address: sysFirst,
      controlAddress: dohOnly,
      divergent: true,
    };
  }

  return {
    ...base,
    layer: {
      layer: 'dns',
      status: 'ok',
      ms,
      detail: dohIps.length ? `${sysFirst} (совпадает с DoH)` : `${sysFirst}`,
      extra,
    },
    address: sysFirst,
    controlAddress: null,
  };
}

// --------------------------------------------------------------- ping layer

/**
 * Pulls the round-trip time out of `ping` output in whatever encoding the
 * console happened to use.
 *
 * Windows writes its console output in the OEM code page — 866 for a Russian
 * install — while the same text under other tools arrives as 1251 or UTF-8. The
 * digits survive any of them; the word after them ("ms", "мс") does not, and
 * that word is what marks which number is the time. So the buffer is decoded
 * several ways and the first decoding that yields a match wins.
 */
function matchIcmpTime(raw: Buffer): number | null {
  const encodings = ['utf-8', 'cp866', 'windows-1251'];
  for (const enc of encodings) {
    let text: string;
    try {
      text = new TextDecoder(enc).decode(raw);
    } catch {
      continue; // Encoding unavailable in this build.
    }
    const m = /[=<]\s*([\d.,]+)\s*(?:ms|мс)/i.exec(text);
    if (m) return Number(m[1]!.replace(',', '.'));
  }
  return null;
}

/**
 * Shells out to the system `ping`: raw ICMP sockets need elevation on Windows,
 * the bundled binary does not. Output is parsed locale-tolerantly because a
 * Russian Windows prints `время=12мс` where an English one prints `time=12ms`.
 */
function icmpPing(address: string, timeoutMs: number): Promise<LayerResult> {
  const win = process.platform === 'win32';
  const mac = process.platform === 'darwin';
  const args = win
    ? ['-n', '1', '-w', String(timeoutMs), '-4', address]
    : mac
      ? ['-c', '1', '-t', String(Math.max(1, Math.round(timeoutMs / 1000))), address]
      : ['-c', '1', '-W', String(Math.max(1, Math.round(timeoutMs / 1000))), '-n', address];

  return new Promise((resolve) => {
    const t0 = now();
    execFile(
      'ping',
      args,
      { timeout: timeoutMs + 1500, windowsHide: true, encoding: 'buffer' },
      (err, stdout) => {
        const raw = Buffer.concat([stdout ?? Buffer.alloc(0)]);
        const wall = now() - t0;
        const m = matchIcmpTime(raw);
        if (m !== null && !err) {
          return resolve({ layer: 'ping', status: 'ok', ms: m, detail: `ICMP ${m} мс` });
        }
        if (/ttl/i.test(raw.toString('latin1')) && !err) {
          // Alive, but the time could not be read out of this locale's wording.
          // Reporting the wall clock instead would report how long it takes to
          // start ping.exe — tens of milliseconds that are not on the network.
          return resolve({
            layer: 'ping',
            status: 'ok',
            ms: null,
            detail: `ICMP отвечает, время не разобрано (запуск занял ${wall} мс)`,
          });
        }
        resolve({
          layer: 'ping',
          status: 'fail',
          ms: wall,
          detail: 'ICMP без ответа (его часто режут — не приговор)',
        });
      },
    );
  });
}

/**
 * A ClientHello just complete enough that any TLS server answers it — with a
 * ServerHello if it likes the parameters, with an alert if it does not. Either
 * reply is what the measurement wants: proof that a packet reached the target
 * and came back.
 */
export function clientHello(host: string): Buffer {
  const ext: Buffer[] = [];
  const extension = (type: number, payload: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt16BE(type, 0);
    head.writeUInt16BE(payload.length, 2);
    ext.push(head, payload);
  };

  // SNI is skipped for IP literals: the extension may not carry an address, and
  // a server that rejects the hello still answers, which is all that is needed.
  if (!isIP(host)) {
    const name = Buffer.from(host, 'utf8');
    const sni = Buffer.alloc(5 + name.length);
    sni.writeUInt16BE(name.length + 3, 0);
    sni.writeUInt8(0x00, 2);
    sni.writeUInt16BE(name.length, 3);
    name.copy(sni, 5);
    extension(0x0000, sni);
  }
  extension(0x000b, Buffer.from([0x01, 0x00])); // ec_point_formats: uncompressed
  extension(0x000a, Buffer.from([0x00, 0x02, 0x00, 0x1d])); // supported_groups: x25519
  extension(0x000d, Buffer.from([0x00, 0x04, 0x04, 0x03, 0x04, 0x01])); // sig algs
  extension(0x002b, Buffer.from([0x04, 0x03, 0x04, 0x03, 0x03])); // versions: 1.3, 1.2

  const extensions = Buffer.concat(ext);
  const extLen = Buffer.alloc(2);
  extLen.writeUInt16BE(extensions.length);

  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]), // client_version
    randomBytes(32),
    Buffer.from([0x00]), // no session id
    Buffer.from([0x00, 0x08, 0x13, 0x01, 0x13, 0x02, 0xc0, 0x2f, 0x00, 0x2f]), // cipher suites
    Buffer.from([0x01, 0x00]), // compression: none
    extLen,
    extensions,
  ]);

  const hs = Buffer.concat([
    Buffer.from([0x01, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]),
    body,
  ]);
  const rec = Buffer.alloc(5);
  rec[0] = 0x16; // handshake
  rec[1] = 0x03;
  rec[2] = 0x01;
  rec.writeUInt16BE(hs.length, 3);
  return Buffer.concat([rec, hs]);
}

/** Something the target will answer, chosen by what usually listens on a port. */
function pokePayload(host: string, port: number): Buffer {
  if (TLS_PORTS.has(port)) return clientHello(host);
  if (HTTP_PORTS.has(port)) return Buffer.from(`HEAD / HTTP/1.0\r\nHost: ${host}\r\n\r\n`, 'utf8');
  // Nothing is known about this port. A bare newline is the least intrusive
  // thing that line-oriented services (SMTP, IRC, Redis) still answer; if the
  // service stays silent the caller falls back to the connect timing.
  return Buffer.from('\r\n', 'utf8');
}

/**
 * Milliseconds from writing a probe to the first sign of life coming back.
 *
 * A FIN or a reset counts as a sign of life: the target refused to talk, but
 * the refusal still travelled the whole path, which is exactly what is being
 * timed. Returns null when nothing at all comes back in time.
 */
function pokeRoundTrip(sock: net.Socket, payload: Buffer, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ms: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.off('readable', onReadable);
      sock.off('end', onEnd);
      sock.off('error', onEnd);
      resolve(ms);
    };
    const onReadable = () => {
      // Paused mode throughout: a `data` listener would flip the socket to
      // flowing and consume bytes the caller may still need.
      if (sock.readableLength > 0 || sock.read(1) !== null) finish(now() - t0);
    };
    const onEnd = () => finish(now() - t0);
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();

    sock.on('readable', onReadable);
    sock.once('end', onEnd);
    sock.once('error', onEnd);
    const t0 = now();
    sock.write(payload);
    onReadable();
  });
}

/**
 * Stand-in for ICMP on routes that cannot carry it. Direct routes are timed by
 * the TCP connect itself — one SYN, one SYN-ACK, a true round trip. Proxied
 * routes cannot be, and that was the bug behind implausibly low readings: a
 * local SOCKS client (shadowsocks, Tor, most VPN helpers) answers CONNECT the
 * moment it has accepted the request, before it has dialled anything, so the
 * "latency" measured was the round trip to a process on this very machine.
 *
 * So through a proxy the tunnel setup is excluded from the timing: the tunnel
 * is opened first, then a payload the target will answer is written, and what
 * is timed is the wait for that answer — a real round trip to the far end.
 *
 * Three attempts, best of. The minimum of several samples is the closest thing
 * to the path's true round trip, since scheduling delays and proxy overhead can
 * only ever add.
 */
async function tcpPing(
  address: string,
  port: number,
  timeoutMs: number,
  proxy: ProxyConfig | null,
): Promise<LayerResult> {
  const attempts = 3;
  const samples: number[] = [];
  /** Time to the proxy's CONNECT reply — what the old code reported as latency. */
  const tunnels: number[] = [];
  let mute = 0;
  let error = '';

  for (let i = 0; i < attempts; i++) {
    const t0 = now();
    let sock: net.Socket;
    try {
      sock = await dial({ host: address, port, timeoutMs, proxy });
    } catch (e) {
      error = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
      continue;
    }
    const setup = now() - t0;
    if (!proxy) {
      sock.destroy();
      samples.push(setup);
      continue;
    }
    tunnels.push(setup);
    const rtt = await pokeRoundTrip(sock, pokePayload(address, port), timeoutMs);
    sock.destroy();
    if (rtt === null) mute++;
    else samples.push(rtt);
  }

  const via = proxy ? 'через прокси' : 'прямой';
  if (!samples.length) {
    // Через прокси туннель мог открыться, но цель промолчала: соединение есть,
    // а времени пути нет — и выдавать за него время до прокси нельзя.
    if (proxy && tunnels.length) {
      return {
        layer: 'ping',
        status: 'warn',
        ms: null,
        detail: `TCP-пинг через прокси: туннель открыт за ${Math.min(...tunnels)} мс, но цель не ответила`,
        extra: { 'до прокси, мс': tunnels.join(' / '), 'молчаливых попыток': mute },
      };
    }
    return { layer: 'ping', status: 'fail', ms: null, detail: `TCP-пинг ${via}: ${error}` };
  }

  const best = Math.min(...samples);
  const worst = Math.max(...samples);
  const extra: Record<string, string | number> = {
    'замеры, мс': samples.join(' / '),
    потери: `${attempts - samples.length} из ${attempts}`,
  };
  if (proxy && tunnels.length) {
    const tunnel = Math.min(...tunnels);
    extra['до прокси, мс'] = tunnel;
    // Naming it is the point: a proxy that answers CONNECT in a millisecond and
    // then takes fifty to fetch a byte is one that answered before connecting.
    if (best > tunnel * 2 + 5) extra['ответ на CONNECT'] = 'досрочный, время туннеля не считается';
  }
  return {
    layer: 'ping',
    status: 'ok',
    ms: best,
    detail: proxy
      ? `TCP-пинг через прокси: ${best} мс до цели${worst !== best ? ` (худший ${worst})` : ''}, ${samples.length} из ${attempts}`
      : `TCP-пинг ${via}: ${best} мс${worst !== best ? ` (худший ${worst})` : ''}, ${samples.length} из ${attempts}`,
    extra,
  };
}

// ---------------------------------------------------------------- UDP layer

/**
 * Same port, other transport. On 443 that means QUIC, on 53 a real resolver
 * query — see `probeForPort` for the whole list.
 *
 * The status deserves a word. A reply is `ok`. Silence is `warn`, never `fail`:
 * plenty of hosts answer TCP on a port and have nothing at all listening on the
 * UDP one, and that is not a fault. What turns silence into a finding is the
 * combination with a working TCP path, and that judgement belongs to the
 * verdict, not to this layer.
 */
async function udpLayer(
  host: string,
  address: string,
  port: number,
  timeoutMs: number,
  proxy: ProxyConfig | null,
  /** Whether the site advertised HTTP/3; null when the HTTP layer did not run. */
  h3: boolean | null,
): Promise<LayerResult> {
  const probe = probeForPort(port);
  if (!probe) {
    // Sending arbitrary bytes and reading the silence as an answer would be
    // making things up: say plainly that there is no probe for this port.
    return {
      layer: 'udp',
      status: 'skip',
      ms: null,
      detail: `нет UDP-пробы для порта ${port}`,
    };
  }

  try {
    const r = await udpProbe(proxy ? host : address, port, probe, timeoutMs, proxy);
    const extra: Record<string, string | number> = { протокол: r.protocol };
    if (r.relay) extra['релей прокси'] = r.relay;
    if (r.strayBytes) extra['посторонних байт'] = r.strayBytes;

    if (!r.answered && probe.protocol === 'QUIC') {
      switch (quicSilenceMeaning(h3)) {
        case 'expected':
          return {
            layer: 'udp',
            status: 'skip',
            ms: null,
            detail: 'QUIC не отвечает, но сервер и не объявляет HTTP/3 — так и должно быть',
            extra: { ...extra, 'alt-svc': 'HTTP/3 не объявлен' },
          };
        case 'unknown':
          return {
            layer: 'udp',
            status: 'warn',
            ms: null,
            detail: 'QUIC молчит; объявляет ли сервер HTTP/3 — неизвестно, HTTP-слой не отработал',
            extra,
          };
        case 'finding':
          extra['alt-svc'] = 'сервер объявляет HTTP/3';
          return {
            layer: 'udp',
            status: 'warn',
            ms: null,
            detail: `${r.detail} — при том, что сервер объявляет HTTP/3`,
            extra,
          };
      }
    }

    return {
      layer: 'udp',
      status: r.answered ? 'ok' : 'warn',
      ms: r.ms,
      detail: r.detail,
      extra,
    };
  } catch (e) {
    if (e instanceof UdpUnsupported) {
      // The route cannot carry UDP at all. Not the target's fault, so not a
      // failure — skipped, with the reason named.
      return { layer: 'udp', status: 'skip', ms: null, detail: (e as Error).message };
    }
    return {
      layer: 'udp',
      status: 'fail',
      ms: null,
      detail: `${probe.protocol}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`,
    };
  }
}

// ---------------------------------------------------------------- TCP layer

async function tcpConnect(
  address: string,
  port: number,
  timeoutMs: number,
  proxy: ProxyConfig | null,
): Promise<LayerResult> {
  const t0 = now();
  try {
    const sock = await dial({ host: address, port, timeoutMs, proxy });
    sock.destroy();
    return {
      layer: 'tcp',
      status: 'ok',
      ms: now() - t0,
      detail: proxy ? `порт ${port} открыт через прокси` : `порт ${port} открыт`,
    };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return {
      layer: 'tcp',
      status: 'fail',
      ms: now() - t0,
      detail: err.code ?? err.message,
    };
  }
}

// ---------------------------------------------------------------- TLS layer

interface TlsOutcome {
  layer: LayerResult;
  /** True when the connection was cut *after* TCP succeeded — DPI signature. */
  reset: boolean;
  certMismatch: boolean;
  /** Days until the certificate expires; negative once it already has. */
  certDaysLeft: number | null;
}

/** `valid_to` is an OpenSSL date string like "Mar 3 12:00:00 2027 GMT". */
function daysUntil(validTo: string | undefined): number | null {
  if (!validTo) return null;
  const when = Date.parse(validTo);
  if (Number.isNaN(when)) return null;
  return Math.floor((when - Date.now()) / 86_400_000);
}

async function tlsHandshake(
  address: string,
  host: string,
  port: number,
  timeoutMs: number,
  proxy: ProxyConfig | null,
): Promise<TlsOutcome> {
  const t0 = now();
  let carrier: net.Socket;
  try {
    carrier = await dial({ host: address, port, timeoutMs, proxy });
  } catch (e) {
    return {
      layer: { layer: 'tls', status: 'fail', ms: now() - t0, detail: (e as Error).message },
      reset: false,
      certMismatch: false,
      certDaysLeft: null,
    };
  }

  return new Promise((resolve) => {
    const sock = tls.connect({
      socket: carrier,
      // The SNI value DPI boxes look at. RFC 6066 forbids sending an IP
      // literal there, and Node warns about it, so omit it for bare addresses.
      ...(isIP(host) ? {} : { servername: host }),
      rejectUnauthorized: false,
      ALPNProtocols: ['h2', 'http/1.1'],
    });
    let done = false;
    const finish = (o: TlsOutcome) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(o);
    };
    sock.setTimeout(timeoutMs);

    sock.once('secureConnect', () => {
      const ms = now() - t0;
      const cert = sock.getPeerCertificate();
      const identity = tls.checkServerIdentity(host, cert as tls.PeerCertificate);
      const subject = (cert?.subject as { CN?: string } | undefined)?.CN ?? '—';
      const issuer = (cert?.issuer as { CN?: string } | undefined)?.CN ?? '—';
      // rejectUnauthorized is off so we can inspect a hostile certificate
      // instead of just failing — which also means nothing checked the dates.
      const certDaysLeft = daysUntil(cert?.valid_to);
      const validity: Record<string, string | number> =
        certDaysLeft === null
          ? {}
          : { 'дней до истечения': certDaysLeft, 'действует до': cert?.valid_to ?? '—' };

      if (identity) {
        return finish({
          layer: {
            layer: 'tls',
            status: 'fail',
            ms,
            detail: `сертификат не для этого хоста (CN=${subject})`,
            extra: { subject, issuer, alpn: sock.alpnProtocol ?? '—', ...validity },
          },
          reset: false,
          certMismatch: true,
          certDaysLeft,
        });
      }

      const expired = certDaysLeft !== null && certDaysLeft < 0;
      const expiring = certDaysLeft !== null && certDaysLeft >= 0 && certDaysLeft <= CERT_WARN_DAYS;
      finish({
        layer: {
          layer: 'tls',
          status: expired ? 'fail' : expiring ? 'warn' : 'ok',
          ms,
          detail: expired
            ? `сертификат просрочен ${-certDaysLeft} дн. назад (CN=${subject})`
            : expiring
              ? `сертификат истекает через ${certDaysLeft} дн. (CN=${subject})`
              : `${sock.getProtocol() ?? 'TLS'}, CN=${subject}`,
          extra: {
            subject,
            issuer,
            protocol: sock.getProtocol() ?? '—',
            alpn: sock.alpnProtocol ?? '—',
            ...validity,
          },
        },
        reset: false,
        certMismatch: false,
        certDaysLeft,
      });
    });

    sock.once('timeout', () =>
      finish({
        layer: { layer: 'tls', status: 'fail', ms: now() - t0, detail: 'handshake завис' },
        reset: true,
        certMismatch: false,
        certDaysLeft: null,
      }),
    );

    sock.once('error', (e) => {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      const reset = code === 'ECONNRESET' || code === 'EPIPE' || /alert|handshake/i.test(e.message);
      finish({
        layer: { layer: 'tls', status: 'fail', ms: now() - t0, detail: code || e.message },
        reset,
        certMismatch: false,
        certDaysLeft: null,
      });
    });
  });
}

// --------------------------------------------------------------- HTTP layer

interface HttpOutcome {
  layer: LayerResult;
  stub: boolean;
  serverError: boolean;
  /** The target declared expected text and the response did not contain it. */
  missingExpected: boolean;
  /**
   * Whether the server advertised HTTP/3 in `alt-svc`. Null when no response
   * arrived at all, so "does not offer it" and "never asked" stay distinct.
   *
   * This is what makes the UDP layer's silence meaningful: a host that never
   * claims to speak HTTP/3 is under no obligation to answer QUIC, and calling
   * that a blockage would put an amber mark on a large part of the web.
   */
  h3: boolean | null;
}

/** `alt-svc: h3=":443"; ma=86400, h3-29=":443"` — any h3 token counts. */
export function advertisesH3(headers: NodeJS.Dict<string | string[]>): boolean {
  const raw = headers['alt-svc'];
  const text = (Array.isArray(raw) ? raw.join(',') : (raw ?? '')).toLowerCase();
  return /(^|[,\s])h3(-\d+)?\s*=/.test(text);
}

/**
 * What silence on a QUIC port is worth, given whether the server claims to
 * speak HTTP/3.
 *
 * Separated out because it is the whole difference between a useful finding and
 * crying wolf: most of the web does not serve QUIC at all — github.com among
 * them — and reporting every such host as "UDP не проходит" would make the
 * layer noise.
 */
export function quicSilenceMeaning(h3: boolean | null): 'expected' | 'unknown' | 'finding' {
  if (h3 === true) return 'finding'; // it advertises HTTP/3 and then does not answer
  if (h3 === false) return 'expected'; // never offered it; silence is correct
  return 'unknown'; // HTTP layer did not run, so there is no claim to compare against
}

interface RawResponse {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
  url: string;
}

/**
 * One HTTP round trip over a socket we dialled ourselves, so the request takes
 * the same route as the other layers. Node's http client is used for parsing
 * (chunked bodies, header folding) but never opens the connection itself.
 */
function httpOnce(
  url: URL,
  dialHost: string,
  timeoutMs: number,
  proxy: ProxyConfig | null,
): Promise<RawResponse> {
  const secure = url.protocol === 'https:';
  const port = Number(url.port || (secure ? 443 : 80));

  // The socket must come from our dialler, otherwise the request quietly goes
  // out directly and the proxy is bypassed. `options.createConnection` is only
  // honoured when there is no agent, and `agent: false` does not remove the
  // agent — it builds a fresh one — so override the agent's own dialler.
  const agent = secure ? new https.Agent({ maxSockets: 1 }) : new http.Agent({ maxSockets: 1 });
  (
    agent as unknown as {
      createConnection: (o: unknown, cb: (err: Error | null, sock?: net.Socket) => void) => void;
    }
  ).createConnection = (_o, cb) => {
    dial({ host: dialHost, port, timeoutMs, proxy })
      .then((sock) => {
        if (!secure) return cb(null, sock);
        const secured = tls.connect({
          socket: sock,
          ...(isIP(url.hostname) ? {} : { servername: url.hostname }),
          rejectUnauthorized: false,
          // Node's http client speaks HTTP/1.1 only — never offer h2 here.
          ALPNProtocols: ['http/1.1'],
        });
        secured.once('secureConnect', () => cb(null, secured));
        secured.once('error', (e) => cb(e));
      })
      .catch((e: Error) => cb(e));
  };

  return new Promise((resolve, reject) => {
    const done = <T>(fn: (v: T) => void) => (v: T) => {
      agent.destroy();
      fn(v);
    };
    const settle = done(resolve);
    const fail = done(reject);

    const req = (secure ? https : http).request(
      {
        method: 'GET',
        host: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        agent,
        headers: {
          host: url.host,
          // A plain browser UA: some stubs only trigger on browser-looking requests.
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml',
          // No accept-encoding: an identity body needs no decompression.
          connection: 'close',
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (body.length < 20000) body += chunk;
          if (body.length >= 20000) res.destroy();
        });
        const finish = () =>
          settle({ status: res.statusCode ?? 0, headers: res.headers, body, url: url.toString() });
        res.on('end', finish);
        res.on('close', finish);
      },
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error('таймаут')));
    req.once('error', fail);
    req.end();
  });
}

async function httpProbe(
  target: Target,
  timeoutMs: number,
  address: string,
  proxy: ProxyConfig | null,
): Promise<HttpOutcome> {
  // Same criterion the TLS layer uses: anything not on a TLS port is plain
  // HTTP. Treating every non-80 port as https makes 8080 fail with a TLS
  // record error that looks like a block but is just the wrong scheme.
  const secure = TLS_PORTS.has(target.port);
  const scheme = secure ? 'https' : 'http';
  const start = `${scheme}://${target.host}${target.port === 80 || target.port === 443 ? '' : `:${target.port}`}/`;
  // Through a proxy the hostname travels to the proxy, which resolves it;
  // directly we dial the address DNS already gave us.
  const dialHost = proxy ? target.host : address;
  const t0 = now();
  try {
    let url = new URL(start);
    let res = await httpOnce(url, dialHost, timeoutMs, proxy);
    for (let hop = 0; hop < 5; hop++) {
      const location = res.headers.location;
      if (res.status < 300 || res.status >= 400 || typeof location !== 'string') break;
      url = new URL(location, url);
      // Once redirected off the original host, the proxy resolves the new name
      // and a direct probe must resolve it too — dial by hostname from here on.
      res = await httpOnce(url, url.hostname === target.host ? dialHost : url.hostname, timeoutMs, proxy);
    }

    const ms = now() - t0;
    const body = res.body;
    const lower = body.toLowerCase();
    const marker = STUB_MARKERS.find((m) => lower.includes(m));
    const finalHost = new URL(res.url).hostname;
    const redirectedAway =
      finalHost !== target.host && !finalHost.endsWith(`.${target.host}`) && !target.host.endsWith(`.${finalHost}`);
    const title = /<title[^>]*>([\s\S]{0,120}?)<\/title>/i.exec(body)?.[1]?.trim() ?? '';

    if (marker) {
      return {
        layer: {
          layer: 'http',
          status: 'fail',
          ms,
          detail: `заглушка: «${marker}»`,
          extra: { status: res.status, finalUrl: res.url, title },
        },
        stub: true,
        serverError: false,
        missingExpected: false,
        h3: advertisesH3(res.headers),
      };
    }
    if (redirectedAway) {
      return {
        layer: {
          layer: 'http',
          status: 'warn',
          ms,
          detail: `редирект на чужой хост ${finalHost}`,
          extra: { status: res.status, finalUrl: res.url, title },
        },
        stub: true,
        serverError: false,
        missingExpected: false,
        h3: advertisesH3(res.headers),
      };
    }

    // The built-in marker list only knows the block pages we have seen. A
    // per-target expectation catches the ones we have not.
    const expected = target.expect.trim();
    if (expected && !lower.includes(expected.toLowerCase())) {
      return {
        layer: {
          layer: 'http',
          status: 'fail',
          ms,
          detail: `в ответе нет ожидаемого текста «${expected}»`,
          extra: { status: res.status, finalUrl: res.url, title, ожидалось: expected },
        },
        stub: false,
        serverError: false,
        missingExpected: true,
        h3: advertisesH3(res.headers),
      };
    }

    const serverError = res.status >= 500;
    return {
      layer: {
        layer: 'http',
        status: serverError ? 'warn' : 'ok',
        ms,
        detail: `HTTP ${res.status}${title ? ` — ${title}` : ''}${expected ? ' · ожидаемый текст на месте' : ''}`,
        extra: { status: res.status, finalUrl: res.url, title, server: String(res.headers.server ?? '—') },
      },
      stub: false,
      serverError,
      missingExpected: false,
      h3: advertisesH3(res.headers),
    };
  } catch (e) {
    return {
      layer: {
        layer: 'http',
        status: 'fail',
        ms: now() - t0,
        detail: (e as Error).name === 'TimeoutError' ? 'таймаут' : (e as Error).message,
      },
      stub: false,
      serverError: false,
      missingExpected: false,
      // No response at all, so whether it speaks HTTP/3 is simply unknown.
      h3: null,
    };
  }
}

// ------------------------------------------------------------------ verdict

/**
 * Runs the enabled layers in order and folds them into a single verdict.
 * Layers short-circuit: no address means nothing below DNS can run.
 */
export async function probe(target: Target, s: Settings): Promise<ProbeResult> {
  const layers: LayerResult[] = [];
  const skip = (l: LayerResult['layer']): LayerResult => ({
    layer: l,
    status: 'skip',
    ms: null,
    detail: 'выключен',
  });

  const proxy = s.proxies.find((p) => p.id === s.activeProxyId) ?? null;
  const route = proxy ? proxy.label : DIRECT_ROUTE;
  // Layers are chosen per target; the global setting only seeds new ones, so
  // there is a single place to look when asking why a layer did not run.
  const L: LayerSet = target.layers ?? s.layers;

  let address: string | null = null;
  let controlAddress: string | null = null;
  let hijacked = false;
  let divergent = false;
  let nxdomain = false;

  if (L.dns) {
    const d = await checkDns(target, s);
    layers.push(d.layer);
    address = d.address;
    controlAddress = d.controlAddress;
    hijacked = d.hijacked;
    divergent = d.divergent;
    nxdomain = d.nxdomain;
  } else {
    layers.push(skip('dns'));
    address = isIP(target.host) ? target.host : ((await resolveSystem(target.host, s.timeoutMs).catch(() => []))[0] ?? null);
  }

  // Through a proxy the name is resolved at the far end, so a local DNS failure
  // stops nothing — and a target that only works this way is exactly the signal
  // this tool exists to surface.
  const dialTarget = proxy ? target.host : address;

  if (!dialTarget) {
    layers.push(skip('ping'), skip('tcp'), skip('tls'), skip('http'), skip('udp'));
    return {
      targetId: target.id,
      ts: Date.now(),
      verdict: nxdomain ? 'dns-nxdomain' : 'error',
      latency: null,
      latencyFrom: null,
      address: null,
      layers,
      route,
      summary: nxdomain
        ? 'Имя не резолвится ни системным DNS, ни через DoH.'
        : 'Не удалось получить адрес для проверки.',
    };
  }

  if (proxy) {
    const dnsLayer = layers.find((l) => l.layer === 'dns');
    if (dnsLayer && dnsLayer.status !== 'skip') {
      dnsLayer.detail += ' — но подключение идёт через прокси, имя резолвит он';
    }
  }

  // ICMP is not tunnellable — SOCKS and CONNECT carry TCP only — so a proxied
  // route measures liveness by timing TCP connects instead.
  const ping = !L.ping
    ? skip('ping')
    : proxy
      ? await tcpPing(dialTarget, target.port, s.timeoutMs, proxy)
      : await icmpPing(address ?? dialTarget, s.timeoutMs);
  layers.push(ping);

  const tcp = L.tcp ? await tcpConnect(dialTarget, target.port, s.timeoutMs, proxy) : skip('tcp');
  layers.push(tcp);

  // A plain TCP service (DNS, SSH, a game server) must not be judged by a TLS
  // handshake it was never going to answer — that would read as a DPI block.
  const wantTls = L.tls && TLS_PORTS.has(target.port);
  let tlsOut: TlsOutcome | null = null;
  if (!L.tls || !wantTls) {
    layers.push(
      L.tls
        ? { layer: 'tls', status: 'skip', ms: null, detail: `порт ${target.port} — не TLS` }
        : skip('tls'),
    );
  } else if (tcp.status !== 'ok') {
    layers.push({ layer: 'tls', status: 'skip', ms: null, detail: 'TCP не поднялся' });
  } else {
    tlsOut = await tlsHandshake(dialTarget, target.host, target.port, s.timeoutMs, proxy);
    layers.push(tlsOut.layer);
  }

  const wantHttp = L.http && HTTP_PORTS.has(target.port);
  let httpOut: HttpOutcome = {
    layer: skip('http'),
    stub: false,
    serverError: false,
    missingExpected: false,
    h3: null,
  };
  if (!L.http || !wantHttp) {
    if (L.http) {
      httpOut.layer = { layer: 'http', status: 'skip', ms: null, detail: `порт ${target.port} — не HTTP` };
    }
  } else if (tcp.status !== 'ok') {
    httpOut.layer = { layer: 'http', status: 'skip', ms: null, detail: 'TCP не поднялся' };
  } else {
    httpOut = await httpProbe(target, s.timeoutMs, dialTarget, proxy);
  }
  layers.push(httpOut.layer);

  const udp = L.udp
    ? await udpLayer(target.host, dialTarget, target.port, s.timeoutMs, proxy, httpOut.h3)
    : skip('udp');
  layers.push(udp);

  /**
   * Pick the layer whose timing actually says something about the target.
   *
   * Ordered by how close each figure is to one round trip. The ping layer is
   * exactly that by construction on both routes, so it leads; a TLS handshake
   * and an HTTP request are several round trips plus server work, and are only
   * used when nothing cleaner succeeded.
   *
   * TCP is the one that changes place. Direct, a connect is a genuine SYN /
   * SYN-ACK exchange. Through a proxy it may end at the CONNECT reply, which
   * many proxies send before they have dialled upstream — so proxied routes
   * rank it last, below even a server-side HTTP timing.
   */
  const candidates: [LayerName, LayerResult | undefined][] = proxy
    ? [
        ['ping', ping],
        ['tls', tlsOut?.layer],
        ['http', httpOut.layer],
        ['tcp', tcp],
      ]
    : [
        ['ping', ping],
        ['tcp', tcp],
        ['tls', tlsOut?.layer],
        ['http', httpOut.layer],
      ];
  const picked = candidates.find(([, l]) => l?.status === 'ok' && l.ms !== null);
  const latency = picked?.[1]?.ms ?? null;
  const latencyFrom = picked?.[0] ?? null;

  // Control probe: the system-supplied address failed, but DoH knows another
  // one. If that one works, the failure was manufactured by the resolver —
  // this is what separates real DNS hijacking from ordinary CDN variance.
  let controlWorks = false;
  // Meaningless behind a proxy: the local resolver's answer was never used.
  if (!proxy && divergent && controlAddress && (tcp.status === 'fail' || tlsOut?.layer.status === 'fail')) {
    const ctlTcp = await tcpConnect(controlAddress, target.port, s.timeoutMs, null);
    if (ctlTcp.status === 'ok') {
      const ctlTls =
        wantTls ? await tlsHandshake(controlAddress, target.host, target.port, s.timeoutMs, null) : null;
      controlWorks = !ctlTls || (ctlTls.layer.status === 'ok' && !ctlTls.certMismatch);
    }
    const dnsLayer = layers.find((l) => l.layer === 'dns');
    if (dnsLayer) {
      dnsLayer.status = controlWorks ? 'fail' : 'warn';
      dnsLayer.detail = controlWorks
        ? `адрес от системного DNS (${address}) мёртв, адрес от DoH (${controlAddress}) работает`
        : `${address} не отвечает, запасной ${controlAddress} тоже — DNS ни при чём`;
    }
  }

  let verdict: Verdict;
  let summary: string;

  // DNS comes first for the user's browser too, so when the system resolver is
  // the barrier it is reported as the verdict even if deeper layers also fail —
  // the summary still names the second barrier, because fixing DNS alone
  // (DoH, another resolver) will not be enough in that case.
  if (hijacked && !proxy) {
    const alsoBlocked =
      tlsOut?.layer.status === 'fail' ? 'а на найденном адресе ещё и рвут TLS по SNI' : null;
    verdict = 'dns-hijack';
    summary = alsoBlocked
      ? `Системный DNS не отдаёт адрес (через DoH он есть), ${alsoBlocked} — блокировка в два слоя.`
      : 'Системный резолвер не отдаёт настоящий адрес — блокировка на уровне DNS провайдера.';
  } else if (controlWorks) {
    verdict = 'dns-hijack';
    summary = `Через адрес от DoH (${controlAddress}) ресурс открывается, через адрес системного DNS — нет. Подмена ответов резолвером.`;
  } else if (tcp.status === 'fail') {
    verdict = ping.status === 'ok' ? 'ip-block' : 'timeout';
    summary = proxy
      ? `Прокси не смог подключиться к ${target.host}:${target.port} — ${tcp.detail}. Проверьте, жив ли сам прокси.`
      : ping.status === 'ok'
        ? `Хост пингуется, но порт ${target.port} не отвечает — блок по IP:порту или фильтр на пути.`
        : 'Ни пинг, ни TCP — хост недоступен целиком (или лежит).';
  } else if (tlsOut?.certMismatch) {
    verdict = 'tls-mitm';
    summary = 'TLS поднялся, но сертификат выписан не на этот хост — перехват трафика.';
  } else if (tlsOut && tlsOut.certDaysLeft !== null && tlsOut.certDaysLeft < 0) {
    verdict = 'tls-expired';
    summary = `Сертификат просрочен ${-tlsOut.certDaysLeft} дн. назад — браузеры такой сайт уже не откроют.`;
  } else if (tlsOut && tlsOut.layer.status === 'fail') {
    verdict = 'tls-block';
    summary = tlsOut.reset
      ? 'TCP-соединение есть, а TLS-рукопожатие рвут — классический DPI по SNI.'
      : 'TLS не устанавливается при живом TCP.';
  } else if (httpOut.missingExpected) {
    verdict = 'content-mismatch';
    summary = `Ответ пришёл, но ожидаемого текста «${target.expect.trim()}» в нём нет — подмена содержимого или ресурс сломан.`;
  } else if (httpOut.stub) {
    verdict = 'http-stub';
    summary = 'Ответ приходит, но это страница-заглушка, а не сам ресурс.';
  } else if (httpOut.serverError) {
    verdict = 'http-error';
    summary = 'Сервер отвечает ошибкой 5xx — проблема на стороне ресурса, не блокировка.';
  } else if (tlsOut && tlsOut.certDaysLeft !== null && tlsOut.certDaysLeft <= CERT_WARN_DAYS) {
    verdict = 'tls-expiring';
    summary = `Ресурс доступен, но сертификат истекает через ${tlsOut.certDaysLeft} дн.`;
  } else if (
    udp.status === 'warn' &&
    tcp.status === 'ok' &&
    // For QUIC the finding needs the server's own claim that it speaks HTTP/3.
    // Without it, silence is the ordinary state of a host that has no QUIC —
    // and unknown (HTTP layer off) is not a claim either.
    (udp.extra?.['протокол'] !== 'QUIC' || quicSilenceMeaning(httpOut.h3) === 'finding')
  ) {
    // Silence over UDP only means something next to a TCP path that works. On
    // its own it is unremarkable — most hosts serve nothing on the UDP port.
    verdict = 'udp-silent';
    const proto = String(udp.extra?.['протокол'] ?? 'UDP');
    summary =
      proto === 'QUIC'
        ? `Сервер объявляет HTTP/3, TCP на порт ${target.port} проходит, а QUIC молчит — похоже, UDP режут на пути. Браузер это скрывает: он молча откатывается на TCP и работает медленнее.`
        : `TCP проходит, а по UDP на порт ${target.port} ответа нет (${proto}). Либо сервис не слушает UDP, либо датаграммы не доходят.`;
  } else if (proxy) {
    verdict = 'ok';
    summary = hijacked
      ? `Через «${route}» ресурс открывается, хотя системный DNS его не резолвит — блокировка обходится прокси.`
      : `Через «${route}» ресурс открывается.`;
  } else if (ping.status === 'fail' && L.ping) {
    verdict = 'ok-no-icmp';
    summary = 'Ресурс работает; ICMP отфильтрован (нормально для большинства CDN).';
  } else {
    verdict = 'ok';
    summary = 'Все проверки пройдены.';
  }

  return {
    targetId: target.id,
    ts: Date.now(),
    verdict,
    latency,
    latencyFrom,
    address: proxy ? null : address,
    layers,
    route,
    summary,
  };
}
