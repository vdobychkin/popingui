import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ALL_LAYERS,
  HISTORY_SIZE,
  MIN_INTERVAL_SEC,
  type LayerSet,
  type ProxyConfig,
  type Settings,
  type Target,
  type TargetState,
  isSystemProxy,
} from '../shared/types.ts';
import { parseProxy } from './proxy.ts';
import { detectSystemProxies } from './system-proxy.ts';

/**
 * Where targets and settings live. A packaged app must not write next to its
 * executable, so the Electron main process overrides this with userData.
 */
let dataDir = path.resolve(process.cwd(), 'data');

export function setDataDir(dir: string): void {
  dataDir = dir;
}

const targetsFile = () => path.join(dataDir, 'targets.json');
const settingsFile = () => path.join(dataDir, 'settings.json');

export const DEFAULT_SETTINGS: Settings = {
  intervalSec: 60,
  concurrency: 16,
  timeoutMs: 4000,
  dohUrl: 'https://cloudflare-dns.com/dns-query',
  layers: { ...ALL_LAYERS },
  proxies: [],
  activeProxyId: null,
  notify: 'bad',
};

const SEED_HOSTS = ['example.com', 'cloudflare.com', 'github.com'];

/** In-memory source of truth; disk is just persistence. */
const states = new Map<string, TargetState>();
let settings: Settings = { ...DEFAULT_SETTINGS };

/**
 * Accepts anything a user is likely to paste: bare hosts, URLs with scheme and
 * path, `host:port`, optional `# note` or `,note` suffix. Returns null on junk.
 */
export function parseTargetLine(line: string): Omit<Target, 'id' | 'enabled'> | null {
  const raw = line.trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('//')) return null;

  // First whitespace/comma/semicolon-delimited token is the address; whatever
  // follows is a free-form note, with any leading comment marker stripped.
  const split = /^([^\s,;]+)(?:[\s,;]+(.*))?$/.exec(raw);
  if (!split) return null;
  let text = split[1]!;
  const note = (split[2] ?? '').replace(/^[#\-–—]+\s*/, '').trim();
  if (!text) return null;

  let port: number | null = null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const u = new URL(text);
      port = u.port ? Number(u.port) : u.protocol === 'http:' ? 80 : 443;
      text = u.hostname;
    } catch {
      return null;
    }
  } else {
    const m = /^\[?([^\]]+)\]?:(\d{1,5})$/.exec(text);
    if (m && !text.includes('::')) {
      text = m[1]!;
      port = Number(m[2]);
    }
  }

  const host = text.replace(/\/.*$/, '').toLowerCase();
  if (!host || /\s/.test(host)) return null;

  return { host, port: port ?? 443, note, group: '', expect: '', layers: { ...ALL_LAYERS } };
}

function newState(target: Target): TargetState {
  return { target, last: null, history: [], uptime: 0, probing: false, probingSince: null, queued: false };
}

function clampInterval(sec: number): number {
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return Math.max(MIN_INTERVAL_SEC, sec);
}

export function listStates(): TargetState[] {
  return [...states.values()];
}

export function getState(id: string): TargetState | undefined {
  return states.get(id);
}

export function getSettings(): Settings {
  return settings;
}

export function setSettings(patch: Partial<Settings>): Settings {
  const proxies = patch.proxies ?? settings.proxies;
  // Never point the active route at a proxy that is no longer in the list —
  // that would silently probe directly while the UI claims otherwise.
  const requested = patch.activeProxyId === undefined ? settings.activeProxyId : patch.activeProxyId;
  const activeProxyId = proxies.some((p) => p.id === requested) ? requested : null;

  settings = {
    ...settings,
    ...patch,
    layers: { ...settings.layers, ...(patch.layers ?? {}) },
    concurrency: Math.min(128, Math.max(1, patch.concurrency ?? settings.concurrency)),
    timeoutMs: Math.min(30000, Math.max(500, patch.timeoutMs ?? settings.timeoutMs)),
    // 0 disables auto polling; anything above it is floored, so a stray tiny
    // value from the API cannot turn the scheduler into a busy loop.
    intervalSec: clampInterval(patch.intervalSec ?? settings.intervalSec),
    proxies,
    activeProxyId,
  };
  void persistSettings();
  return settings;
}

/**
 * Replaces the detected system entries with a freshly read set, leaving the
 * user's own list alone. Kept separate from `addProxies` because these are not
 * the user's to add or remove — they mirror the OS and are re-read at start.
 */
export async function refreshSystemProxies(): Promise<Settings> {
  const detected = await detectSystemProxies();
  const manual = settings.proxies.filter((p) => !isSystemProxy(p));
  return setSettings({ proxies: [...manual, ...detected] });
}

/** Parses pasted proxy lines and appends the ones that are new. */
export function addProxies(lines: string[]): ProxyConfig[] {
  const added: ProxyConfig[] = [];
  for (const line of lines) {
    const parsed = parseProxy(line);
    if (!parsed) continue;
    const dup = settings.proxies.some(
      (p) => p.kind === parsed.kind && p.host === parsed.host && p.port === parsed.port,
    );
    if (dup) continue;
    added.push(parsed);
  }
  if (added.length) setSettings({ proxies: [...settings.proxies, ...added] });
  return added;
}

export function removeProxy(id: string): Settings {
  // Deleting a system entry would only make it reappear on the next refresh.
  if (settings.proxies.some((p) => p.id === id && isSystemProxy(p))) return settings;
  return setSettings({
    proxies: settings.proxies.filter((p) => p.id !== id),
    activeProxyId: settings.activeProxyId === id ? null : settings.activeProxyId,
  });
}

export function addTargets(lines: string[], layers?: LayerSet): TargetState[] {
  const added: TargetState[] = [];
  for (const line of lines) {
    const parsed = parseTargetLine(line);
    if (!parsed) continue;
    const dup = [...states.values()].find(
      (s) => s.target.host === parsed.host && s.target.port === parsed.port,
    );
    if (dup) continue;
    const target: Target = {
      id: randomUUID(),
      enabled: true,
      ...parsed,
      layers: { ...(layers ?? settings.layers) },
    };
    const state: TargetState = newState(target);
    states.set(target.id, state);
    added.push(state);
  }
  if (added.length) void persistTargets();
  return added;
}

export function updateTarget(id: string, patch: Partial<Target>): TargetState | undefined {
  const state = states.get(id);
  if (!state) return undefined;
  state.target = { ...state.target, ...patch, id };
  void persistTargets();
  return state;
}

export function removeTargets(ids: string[]): void {
  let changed = false;
  for (const id of ids) changed = states.delete(id) || changed;
  if (changed) void persistTargets();
}

export function recordResult(state: TargetState): void {
  const last = state.last;
  if (!last) return;
  state.history.push({ ts: last.ts, verdict: last.verdict, latency: last.latency });
  if (state.history.length > HISTORY_SIZE) state.history.shift();
  const good = state.history.filter((h) => h.verdict === 'ok' || h.verdict === 'ok-no-icmp').length;
  state.uptime = state.history.length ? good / state.history.length : 0;
}

async function persistTargets(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const targets = [...states.values()].map((s) => s.target);
  await writeFile(targetsFile(), JSON.stringify(targets, null, 2), 'utf8');
}

async function persistSettings(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  // System entries are re-read from the OS at every start; writing them would
  // leave a stale copy that outlives the setting it mirrors. `activeProxyId` is
  // still written, so a chosen system route is restored once detection re-adds
  // the entry it names.
  const onDisk: Settings = { ...settings, proxies: settings.proxies.filter((p) => !isSystemProxy(p)) };
  await writeFile(settingsFile(), JSON.stringify(onDisk, null, 2), 'utf8');
}

/**
 * Brings a layer set written by an earlier version up to date.
 *
 * `icmp` was renamed to `ping` once proxied routes started measuring liveness
 * over TCP; the old key is dropped and the user's choice kept under the new name.
 *
 * `udp` is newer still, and defaults to **off** here rather than on. Enabling a
 * layer behind the user's back would change what their existing targets do —
 * some would start reporting "UDP не проходит" on hosts that were green. New
 * targets added after the upgrade still get it from the defaults.
 */
function migrateLayers(raw: unknown): LayerSet {
  const l = (raw ?? {}) as Partial<LayerSet> & { icmp?: boolean };
  return {
    ...ALL_LAYERS,
    ...l,
    ping: l.ping ?? l.icmp ?? true,
    udp: l.udp ?? false,
    icmp: undefined,
  } as LayerSet;
}

export async function load(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(settingsFile(), 'utf8')) as Partial<Settings>;
    settings = { ...DEFAULT_SETTINGS, ...parsed, layers: migrateLayers(parsed.layers) };
  } catch {
    /* first run */
  }
  try {
    const targets = JSON.parse(await readFile(targetsFile(), 'utf8')) as Target[];
    for (const t of targets) {
      // Files written by older versions lack `expect` and `layers`; probes read
      // both unconditionally, so fill them in rather than crashing on undefined.
      const target: Target = { ...t, expect: t.expect ?? '', layers: migrateLayers(t.layers) };
      states.set(target.id, newState(target));
    }
  } catch {
    addTargets(SEED_HOSTS);
  }
}
