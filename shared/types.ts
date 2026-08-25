/** Shared contract between server probe engine and the UI. */

/**
 * `ping` rather than `icmp`: the layer answers "is it alive and how fast", and
 * the method depends on the route. Direct routes send a real ICMP echo; proxy
 * routes cannot — SOCKS and CONNECT carry TCP only — so they time repeated TCP
 * connects instead.
 */
export type LayerName = 'dns' | 'ping' | 'tcp' | 'tls' | 'http' | 'udp';

export const LAYER_ORDER: LayerName[] = ['dns', 'ping', 'tcp', 'tls', 'http', 'udp'];

export const LAYER_LABEL: Record<LayerName, string> = {
  dns: 'DNS',
  ping: 'PING',
  tcp: 'TCP',
  tls: 'TLS',
  http: 'HTTP',
  udp: 'UDP',
};

/** What each layer is for, shown where targets are configured. */
export const LAYER_HINT: Record<LayerName, string> = {
  dns: 'Резолв имени и сверка с DoH — ловит подмену ответов провайдером',
  ping: 'ICMP-эхо напрямую, TCP-пинг через прокси',
  tcp: 'Установка соединения с портом',
  tls: 'Рукопожатие с реальным SNI — ловит обрыв по DPI и подмену сертификата',
  http: 'Запрос страницы — ловит заглушки и подмену содержимого',
  udp: 'Тот же порт по UDP: QUIC на 443, запрос к резолверу на 53 — ловит блокировку QUIC при живом TCP',
};

export type LayerSet = Record<LayerName, boolean>;

export const ALL_LAYERS: LayerSet = {
  dns: true,
  ping: true,
  tcp: true,
  tls: true,
  http: true,
  udp: true,
};

export type LayerStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface LayerResult {
  layer: LayerName;
  status: LayerStatus;
  /** Milliseconds spent in this layer, null when skipped. */
  ms: number | null;
  /** Short human label shown in the grid cell tooltip. */
  detail: string;
  /** Free-form extras rendered in the target detail panel. */
  extra?: Record<string, string | number | boolean | string[]>;
}

/**
 * Verdict describes *how* a resource is unreachable, not only *that* it is.
 * That distinction is the whole point of the tool.
 */
export type Verdict =
  | 'ok' // everything answered
  | 'ok-no-icmp' // reachable, ICMP filtered somewhere (very common)
  | 'dns-nxdomain' // name does not resolve at all
  | 'dns-hijack' // system resolver disagrees with DoH -> DNS-level blocking
  | 'ip-block' // DNS fine, TCP never connects -> IP/port blackholed
  | 'tls-block' // TCP connects but TLS with real SNI dies -> DPI/SNI filtering
  | 'tls-mitm' // TLS completes with a certificate not valid for the host
  | 'tls-expired' // certificate is past its validity window
  | 'tls-expiring' // certificate still valid, but not for much longer
  | 'content-mismatch' // answered, but the expected text is missing
  | 'http-stub' // HTTP answers, but with a block page / ISP stub
  | 'http-error' // HTTP reachable, server-side error status
  | 'udp-silent' // TCP path fine, nothing comes back over UDP (QUIC filtered?)
  | 'timeout' // nothing responded in time
  | 'error' // probe itself failed
  | 'pending';

export interface ProbeResult {
  targetId: string;
  /** Epoch ms when the probe finished. */
  ts: number;
  verdict: Verdict;
  /** Best representative latency, ms. See `latencyFrom` for what produced it. */
  latency: number | null;
  /**
   * Which layer the latency came from. Worth showing: through a proxy the TCP
   * figure can be the time to the proxy rather than to the target, because a
   * proxy may answer CONNECT before it has dialled upstream.
   */
  latencyFrom: LayerName | null;
  /** Address actually used for the connection attempts. */
  address: string | null;
  layers: LayerResult[];
  /** One-line explanation of the verdict, already localized. */
  summary: string;
  /** Label of the route this result came from — "Напрямую" or a proxy name. */
  route: string;
}

export type ProxyKind = 'http' | 'socks5' | 'socks4';

/**
 * Where a proxy entry came from. System entries are read from the OS settings
 * on every start, never persisted and never editable — the OS owns them, and a
 * stale copy on disk would quietly send probes through a proxy the machine
 * stopped using.
 */
export type ProxySource = 'manual' | 'system';

/** Prefix of the generated ids of detected system proxies. */
export const SYSTEM_PROXY_PREFIX = 'system:';

export interface ProxyConfig {
  id: string;
  /** User-facing name shown in the route switcher. */
  label: string;
  kind: ProxyKind;
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Absent in files written before system detection existed — treat as manual. */
  source?: ProxySource;
  /** Where a system entry was read from, e.g. "реестр Windows" or "HTTPS_PROXY". */
  origin?: string;
}

export const isSystemProxy = (p: ProxyConfig): boolean => p.source === 'system';

export const DIRECT_ROUTE = 'Напрямую';

export interface Target {
  id: string;
  /** Hostname or IP. Never includes scheme or port. */
  host: string;
  port: number;
  /** Optional user label. */
  note: string;
  enabled: boolean;
  group: string;
  /**
   * Text that must appear in the HTTP response. Empty disables the check.
   * Catches block pages whose wording is not in the built-in marker list.
   */
  expect: string;
  /**
   * Which layers to run for this target. Chosen when the target is added and
   * editable afterwards; the global setting only supplies the default, so
   * there is one place to look when asking why a layer did not run.
   */
  layers: LayerSet;
}

/** When a status change should raise a desktop notification. */
export type NotifyMode = 'off' | 'bad' | 'both';

/** Certificate expiry below this many days is worth flagging. */
export const CERT_WARN_DAYS = 14;

export interface TargetState {
  target: Target;
  last: ProbeResult | null;
  /** Rolling window, oldest first, capped by HISTORY_SIZE. */
  history: { ts: number; verdict: Verdict; latency: number | null }[];
  /** Share of probes in history whose verdict is ok/ok-no-icmp, 0..1. */
  uptime: number;
  probing: boolean;
  /** When the running probe started, for the per-row elapsed timer. */
  probingSince: number | null;
  /** Waiting for a free worker — this is what a full queue looks like. */
  queued: boolean;
}

export interface Settings {
  /** Seconds between automatic sweeps. 0 disables auto mode. */
  intervalSec: number;
  /** Parallel probes in flight. */
  concurrency: number;
  /** Per-layer timeout, ms. */
  timeoutMs: number;
  /** DNS-over-HTTPS resolver used as the trusted reference. */
  dohUrl: string;
  /** Default layer selection applied to newly added targets. */
  layers: LayerSet;
  /** Configured proxies, in the order they appear in the switcher. */
  proxies: ProxyConfig[];
  /** Which proxy probes go through; null means a direct connection. */
  activeProxyId: string | null;
  /** Desktop notifications on status change. */
  notify: NotifyMode;
}

/** A target crossing between healthy and unhealthy, as reported after a sweep. */
export interface Transition {
  targetId: string;
  host: string;
  port: number;
  from: Verdict;
  to: Verdict;
  /** True when the target became unhealthy. */
  worse: boolean;
}

export type ServerMessage =
  | {
      type: 'snapshot';
      targets: TargetState[];
      settings: Settings;
      running: boolean;
      paused: boolean;
      cycleMs: number | null;
    }
  | { type: 'result'; state: TargetState }
  | {
      type: 'probing';
      targetId: string;
      probing: boolean;
      queued: boolean;
      since: number | null;
    }
  | {
      type: 'sweep';
      running: boolean;
      /** Probing is held off until the next explicit start. */
      paused: boolean;
      inFlight: number;
      queued: number;
      /** Time of the last complete pass over every target, ms. */
      cycleMs: number | null;
    }
  | { type: 'settings'; settings: Settings };

export const HISTORY_SIZE = 60;

/**
 * Positions of the polling-frequency slider, in seconds; 0 means manual only.
 * Deliberately not a linear range — the useful resolution is all at the short
 * end, where the difference between 10 s and 30 s matters, while nobody needs
 * to distinguish 11 h from 12 h.
 */
export const POLL_STEPS = [
  0, 0.1, 0.2, 0.5, 1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 450, 600,
] as const;

/** Shortest non-manual interval the slider offers, seconds. */
export const MIN_INTERVAL_SEC = 0.1;

/**
 * Human label for an interval in seconds. Handles values outside POLL_STEPS
 * too: settings saved by an earlier version may still hold hours or days.
 */
export function formatInterval(sec: number): string {
  if (sec <= 0) return 'вручную';
  if (sec < 1) return `${String(sec).replace('.', ',')} с`;
  if (sec < 60) return `${sec} с`;
  if (sec < 3600) {
    const min = Math.floor(sec / 60);
    const rest = Math.round(sec % 60);
    return rest ? `${min} мин ${rest} с` : `${min} мин`;
  }
  if (sec < 86400) return `${Math.round(sec / 3600)} ч`;
  return `${Math.round(sec / 86400)} сут`;
}

/** Index of the slider step nearest to `sec`, for arbitrary stored values. */
export function nearestPollStep(sec: number): number {
  let best = 0;
  for (let i = 1; i < POLL_STEPS.length; i++) {
    if (Math.abs(POLL_STEPS[i]! - sec) < Math.abs(POLL_STEPS[best]! - sec)) best = i;
  }
  return best;
}

export const VERDICT_META: Record<Verdict, { label: string; tone: 'good' | 'bad' | 'warn' | 'idle' }> = {
  ok: { label: 'Доступен', tone: 'good' },
  'ok-no-icmp': { label: 'Доступен (без ICMP)', tone: 'good' },
  'dns-nxdomain': { label: 'DNS: нет записи', tone: 'bad' },
  'dns-hijack': { label: 'DNS-подмена', tone: 'bad' },
  'ip-block': { label: 'Блок по IP/порту', tone: 'bad' },
  'tls-block': { label: 'DPI: обрыв TLS/SNI', tone: 'bad' },
  'tls-mitm': { label: 'Подмена сертификата', tone: 'bad' },
  'tls-expired': { label: 'Сертификат просрочен', tone: 'bad' },
  'tls-expiring': { label: 'Сертификат истекает', tone: 'warn' },
  'content-mismatch': { label: 'Нет ожидаемого текста', tone: 'bad' },
  'http-stub': { label: 'Страница-заглушка', tone: 'bad' },
  'http-error': { label: 'HTTP-ошибка', tone: 'warn' },
  // Amber, not red, and deliberately so: silence over UDP is indistinguishable
  // from a host that simply does not serve UDP on that port, which is normal.
  'udp-silent': { label: 'UDP не проходит', tone: 'warn' },
  timeout: { label: 'Таймаут', tone: 'bad' },
  error: { label: 'Ошибка пробы', tone: 'warn' },
  pending: { label: 'Не проверялся', tone: 'idle' },
};
