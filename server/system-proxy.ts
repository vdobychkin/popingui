import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SYSTEM_PROXY_PREFIX, type ProxyConfig, type ProxyKind } from '../shared/types.ts';

const run = promisify(execFile);

/**
 * Reads the proxy the machine itself is configured to use, so it can be offered
 * as a route without the user retyping what Windows already knows.
 *
 * Two sources, in the order tools actually honour them: the environment
 * (HTTPS_PROXY and friends, which most CLI software obeys) and, on Windows, the
 * per-user Internet Settings key that Chrome, Edge and WinINET read.
 *
 * PAC scripts (`AutoConfigURL`) are deliberately not followed: choosing the
 * proxy would mean running the site's own JavaScript for every target, and the
 * answer would differ per target — which is not a route the switcher can offer.
 */

/** Stable across restarts, so a chosen system route survives one. */
function idFor(kind: ProxyKind, host: string, port: number): string {
  return `${SYSTEM_PROXY_PREFIX}${kind}://${host}:${port}`;
}

const KIND_LABEL: Record<ProxyKind, string> = { http: 'HTTP', socks5: 'SOCKS5', socks4: 'SOCKS4' };

function make(kind: ProxyKind, host: string, port: number, origin: string): ProxyConfig | null {
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    id: idFor(kind, host, port),
    label: `Системный · ${KIND_LABEL[kind]} ${host}:${port}`,
    kind,
    host,
    port,
    source: 'system',
    origin,
  };
}

/** Splits `host:port`, `http://host:port`, `[::1]:8080`. */
function endpoint(text: string): { host: string; port: number } | null {
  let raw = text.trim();
  if (!raw) return null;
  if (!/^[a-z0-9+.-]+:\/\//i.test(raw)) raw = `http://${raw}`;
  try {
    const u = new URL(raw);
    if (!u.hostname || !u.port) return null;
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) };
  } catch {
    return null;
  }
}

function fromEnv(): ProxyConfig[] {
  const out: ProxyConfig[] = [];
  // ALL_PROXY first: it is the broadest declaration, and tools that read only
  // one variable read that one.
  const names = ['ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY'];
  for (const name of names) {
    const value = process.env[name] ?? process.env[name.toLowerCase()];
    if (!value) continue;
    const scheme = /^([a-z0-9+.-]+):\/\//i.exec(value)?.[1]?.toLowerCase() ?? 'http';
    const kind: ProxyKind =
      scheme.startsWith('socks4') ? 'socks4' : scheme.startsWith('socks') ? 'socks5' : 'http';
    const ep = endpoint(value);
    if (!ep) continue;
    const p = make(kind, ep.host, ep.port, name);
    if (p) out.push(p);
  }
  return out;
}

/**
 * `ProxyServer` is either a bare `host:port` for every protocol, or a
 * semicolon-separated `http=host:port;socks=host:port` list. Only the entries
 * this tool can actually dial are returned.
 */
function parseWindowsProxyServer(value: string): { kind: ProxyKind; host: string; port: number }[] {
  const out: { kind: ProxyKind; host: string; port: number }[] = [];
  for (const part of value.split(';')) {
    const [left, right] = part.includes('=') ? part.split('=', 2) : [null, part];
    const ep = endpoint(right ?? '');
    if (!ep) continue;
    const scheme = (left ?? '').trim().toLowerCase();
    // ftp= and https= point at the same HTTP CONNECT proxy as http=; listing
    // each protocol separately would offer the same endpoint three times.
    if (scheme === 'socks') out.push({ kind: 'socks5', ...ep });
    else if (scheme === '' || scheme === 'http' || scheme === 'https') out.push({ kind: 'http', ...ep });
  }
  return out;
}

async function regValue(key: string, name: string): Promise<string | null> {
  try {
    const { stdout } = await run('reg', ['query', key, '/v', name], {
      windowsHide: true,
      timeout: 4000,
    });
    // "    ProxyServer    REG_SZ    127.0.0.1:8080"
    const m = new RegExp(`${name}\\s+REG_[A-Z_]+\\s+(.*)`, 'i').exec(stdout);
    return m?.[1]?.trim() ?? null;
  } catch {
    // Value absent, or no registry on this platform — both mean "not set".
    return null;
  }
}

async function fromWindowsRegistry(): Promise<ProxyConfig[]> {
  if (process.platform !== 'win32') return [];
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const enabled = await regValue(key, 'ProxyEnable');
  // Reported as 0x0/0x1. A configured but disabled proxy is not the machine's
  // current route, so it is not offered.
  if (!enabled || Number(enabled) === 0) return [];
  const server = await regValue(key, 'ProxyServer');
  if (!server) return [];
  return parseWindowsProxyServer(server)
    .map((e) => make(e.kind, e.host, e.port, 'реестр Windows'))
    .filter((p): p is ProxyConfig => p !== null);
}

/**
 * Every system proxy the machine declares, de-duplicated by endpoint. Never
 * throws: a machine with no proxy and a machine whose registry cannot be read
 * are the same answer — an empty list.
 */
export async function detectSystemProxies(): Promise<ProxyConfig[]> {
  const found = [...fromEnv(), ...(await fromWindowsRegistry())];
  const byId = new Map<string, ProxyConfig>();
  for (const p of found) {
    const seen = byId.get(p.id);
    // The same endpoint usually appears twice — once in the registry and once
    // in the environment that mirrors it. One entry, both origins named, so it
    // is clear the two agree rather than one having been missed.
    if (!seen) byId.set(p.id, p);
    else if (seen.origin && p.origin && !seen.origin.includes(p.origin)) {
      seen.origin = `${seen.origin}, ${p.origin}`;
    }
  }
  return [...byId.values()];
}
