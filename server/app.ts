import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import type { LayerSet, ServerMessage, TargetState, Transition, Verdict } from '../shared/types.ts';
import { DIRECT_ROUTE, VERDICT_META } from '../shared/types.ts';

/** Tones that count as "something is wrong" for notification purposes. */
const BAD_TONES = new Set(['bad', 'warn']);
import { probe } from './probe.ts';
import { dial } from './proxy.ts';
import {
  addProxies,
  addTargets,
  removeProxy,
  getSettings,
  getState,
  listStates,
  load,
  recordResult,
  refreshSystemProxies,
  removeTargets,
  setDataDir,
  setSettings,
  updateTarget,
} from './store.ts';

export interface MonitorOptions {
  port?: number;
  /** Directory holding targets.json / settings.json. */
  dataDir?: string;
  /** Built frontend to serve. Omit during Vite development. */
  distDir?: string | null;
  /** Kick off a sweep as soon as the server is up. */
  sweepOnStart?: boolean;
}

export interface Summary {
  good: number;
  warn: number;
  bad: number;
  idle: number;
  total: number;
  /** Worst tone currently present — drives the tray icon colour. */
  tone: 'good' | 'warn' | 'bad' | 'idle';
  running: boolean;
  lastSweepAt: number | null;
}

/**
 * The whole monitor as one object: HTTP+WS server, probe scheduler and the
 * event stream the tray subscribes to. Constructing it starts nothing; call
 * `start()`.
 */
export class Monitor extends EventEmitter {
  readonly port: number;
  private readonly opts: Required<Omit<MonitorOptions, 'distDir'>> & { distDir: string | null };
  private readonly app = express();
  private readonly server: http.Server;
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  private timer: NodeJS.Timeout | null = null;
  private paused = false;
  private lastSweepAt: number | null = null;
  /** How long one probe of every target last took — the full cycle. */
  private cycleMs: number | null = null;

  constructor(options: MonitorOptions = {}) {
    super();
    this.port = options.port ?? 8787;
    this.opts = {
      port: this.port,
      dataDir: options.dataDir ?? path.resolve(process.cwd(), 'data'),
      distDir: options.distDir ?? null,
      sweepOnStart: options.sweepOnStart ?? true,
    };
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
    this.buildRoutes();
    this.buildSockets();
  }

  // ------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    setDataDir(this.opts.dataDir);
    await load();
    // Before the first probe: if the machine has a proxy configured, the route
    // switcher should offer it from the very first frame the UI draws.
    await refreshSystemProxies();
    this.rescheduleAuto();
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', resolve);
    });
    this.emit('update');
    if (this.opts.sweepOnStart) void this.sweep();
  }

  async stop(): Promise<void> {
    this.paused = true;
    this.queued.clear();
    if (this.timer) clearTimeout(this.timer);
    if (this.transitionTimer) clearTimeout(this.transitionTimer);
    if (this.publishTimer) clearTimeout(this.publishTimer);
    for (const ws of this.clients) ws.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  // ------------------------------------------------------------ public API

  states(): TargetState[] {
    return listStates();
  }

  settings() {
    return getSettings();
  }

  summary(): Summary {
    const s: Summary = {
      good: 0,
      warn: 0,
      bad: 0,
      idle: 0,
      total: 0,
      tone: 'idle',
      running: this.running,
      lastSweepAt: this.lastSweepAt,
    };
    for (const t of listStates()) {
      s[VERDICT_META[t.last?.verdict ?? 'pending'].tone]++;
      s.total++;
    }
    s.tone = s.bad > 0 ? 'bad' : s.warn > 0 ? 'warn' : s.good > 0 ? 'good' : 'idle';
    return s;
  }

  /**
   * Probes the given targets (all enabled ones by default) as soon as a worker
   * frees up, and resolves once each has produced a result.
   *
   * `restart` drops whatever is still queued before re-queueing, so a settings
   * change — a new route above all — is not applied to half the grid only.
   * Probes already in flight cannot be cancelled and finish under the old
   * settings; their targets are simply measured again straight after.
   */
  async sweep(ids?: string[], restart = false): Promise<void> {
    const batch = (ids ? ids.map(getState) : listStates().filter((s) => s.target.enabled))
      .filter((s): s is TargetState => Boolean(s))
      .map((s) => s.target.id);
    if (!batch.length) return;

    if (restart) this.clearQueue();
    this.paused = false;
    this.startPass();
    for (const id of batch) {
      this.dueAt.delete(id); // due immediately
      this.markQueued(id);
    }

    const done = new Promise<void>((resolve) => {
      this.waiters.push({ pending: new Set(batch), resolve });
    });
    this.drain();
    await done;
  }

  /** Clears the queue and holds off new probes until the next explicit start. */
  stopSweep(): void {
    this.paused = true;
    this.clearQueue();
    this.settleWaiters(null);
    this.publish();
  }

  /** Empties the queue and clears the per-row "waiting" flags with it. */
  private clearQueue(): void {
    for (const id of this.queued) {
      const state = getState(id);
      if (!state?.queued) continue;
      state.queued = false;
      this.broadcast({ type: 'probing', targetId: id, probing: false, queued: false, since: null });
    }
    this.queued.clear();
  }

  // ------------------------------------------------------------- scheduling

  private readonly inFlight = new Set<string>();
  private readonly queued = new Set<string>();
  /** Earliest time each target may be probed again. */
  private readonly dueAt = new Map<string, number>();
  private waiters: { pending: Set<string>; resolve: () => void }[] = [];
  private transitions: Transition[] = [];
  private transitionTimer: NodeJS.Timeout | null = null;
  private publishTimer: NodeJS.Timeout | null = null;

  /** Targets still unprobed in the current full pass, for the cycle timing. */
  private passPending = new Set<string>();
  private passStartedAt: number | null = null;

  get running(): boolean {
    return this.inFlight.size > 0 || this.queued.size > 0;
  }

  /** Live scheduler counters, for the UI indicator and for tests. */
  progress(): { inFlight: number; queued: number; paused: boolean; cycleMs: number | null } {
    return {
      inFlight: this.inFlight.size,
      queued: this.queued.size,
      paused: this.paused,
      cycleMs: this.cycleMs,
    };
  }

  /**
   * Marks every target due and starts probing them independently. Each target
   * carries its own schedule, so a slow one no longer holds up the rest and no
   * cycle is skipped: fast targets keep their cadence while it finishes.
   */
  private pump(): void {
    if (!this.paused) {
      const intervalMs = getSettings().intervalSec * 1000;
      if (intervalMs > 0) {
        const now = Date.now();
        for (const s of listStates()) {
          const id = s.target.id;
          if (!s.target.enabled || this.inFlight.has(id) || this.queued.has(id)) continue;
          if (now >= (this.dueAt.get(id) ?? 0)) this.markQueued(id);
        }
      }
    }
    this.drain();
  }

  /**
   * Queues a target and tells the UI, so a row can show that it is waiting for
   * a worker rather than looking idle — that is what a backed-up queue looks
   * like from the outside.
   */
  private markQueued(id: string): void {
    this.queued.add(id);
    const state = getState(id);
    if (!state || state.queued) return;
    state.queued = true;
    this.broadcast({ type: 'probing', targetId: id, probing: false, queued: true, since: null });
  }

  /** Fills the worker pool up to the configured concurrency. */
  private drain(): void {
    const { concurrency } = getSettings();
    /** Targets that came up while already being probed; re-queued below. */
    const waiting: string[] = [];
    while (!this.paused && this.inFlight.size < concurrency && this.queued.size > 0) {
      const id = this.queued.values().next().value as string;
      this.queued.delete(id);
      // Never two probes of one target at once. `pump` already avoids it, but
      // an explicit re-check does not go through `pump` — and two overlapping
      // probes race to write `state.last`, so the slower one, started with the
      // older settings, can land last and overwrite the newer result. Editing a
      // target's layers is exactly that case: the grid would then show a layer
      // that has just been switched off.
      if (this.inFlight.has(id)) {
        waiting.push(id);
        continue;
      }
      const state = getState(id);
      if (!state) continue;

      this.inFlight.add(id);
      void this.probeOne(state).finally(() => {
        this.inFlight.delete(id);
        this.dueAt.set(id, Date.now() + getSettings().intervalSec * 1000);
        this.notePass(id);
        this.settleWaiters(id);
        // Refill straight away rather than waiting for the next tick: at short
        // intervals the tick period would otherwise cap the throughput.
        this.drain();
      });
    }
    // Put the deferred ones back only now: re-adding them inside the loop would
    // spin on the same id. The probe that is running will call `drain` again
    // when it finishes, and they go first because the queue keeps its order.
    for (const id of waiting) this.queued.add(id);
    this.publish();
  }

  private startPass(): void {
    this.passPending = new Set(listStates().filter((s) => s.target.enabled).map((s) => s.target.id));
    this.passStartedAt = Date.now();
  }

  /** A pass is one probe of every enabled target; its length is the cycle. */
  private notePass(id: string): void {
    this.lastSweepAt = Date.now();
    if (!this.passPending.delete(id)) return;
    if (this.passPending.size === 0 && this.passStartedAt !== null) {
      this.cycleMs = Date.now() - this.passStartedAt;
      this.startPass();
    }
  }

  private settleWaiters(id: string | null): void {
    this.waiters = this.waiters.filter((w) => {
      if (id === null) w.pending.clear();
      else w.pending.delete(id);
      if (w.pending.size > 0) return true;
      w.resolve();
      return false;
    });
  }

  /** Coalesced progress broadcast — completions can arrive in bursts. */
  private publish(): void {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.broadcast({
        type: 'sweep',
        running: this.running,
        paused: this.paused,
        inFlight: this.inFlight.size,
        queued: this.queued.size,
        cycleMs: this.cycleMs,
      });
      this.emit('update');
    }, 120);
  }

  // --------------------------------------------------------------- interns

  private broadcast(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  private async probeOne(state: TargetState): Promise<void> {
    const before = state.last?.verdict ?? null;
    state.probing = true;
    state.probingSince = Date.now();
    state.queued = false;
    this.broadcast({
      type: 'probing',
      targetId: state.target.id,
      probing: true,
      queued: false,
      since: state.probingSince,
    });
    try {
      state.last = await probe(state.target, getSettings());
    } catch (e) {
      state.last = {
        targetId: state.target.id,
        ts: Date.now(),
        verdict: 'error' as Verdict,
        latency: null,
        latencyFrom: null,
        address: null,
        layers: [],
        route: getSettings().proxies.find((p) => p.id === getSettings().activeProxyId)?.label ?? DIRECT_ROUTE,
        summary: (e as Error).message,
      };
    }
    recordResult(state);
    state.probing = false;
    state.probingSince = null;
    this.noteTransition(state, before);
    this.broadcast({ type: 'result', state });
    this.emit('update');
  }

  /**
   * Records healthy <-> unhealthy crossings. The very first result for a target
   * is not a change — without this guard the first sweep would announce every
   * blocked resource as if it had just broken.
   */
  private noteTransition(state: TargetState, before: Verdict | null): void {
    const after = state.last?.verdict;
    if (!after || !before || before === after) return;
    const wasBad = BAD_TONES.has(VERDICT_META[before].tone);
    const isBad = BAD_TONES.has(VERDICT_META[after].tone);
    if (wasBad === isBad) return;
    this.transitions.push({
      targetId: state.target.id,
      host: state.target.host,
      port: state.target.port,
      from: before,
      to: after,
      worse: isBad,
    });

    // With targets on independent schedules there is no sweep boundary to
    // batch on, so collect for a short window instead: a filtered network
    // flips a dozen resources at once, and that is one event, one notification.
    if (this.transitionTimer) return;
    this.transitionTimer = setTimeout(() => {
      this.transitionTimer = null;
      if (!this.transitions.length) return;
      this.emit('transitions', this.transitions);
      this.transitions = [];
    }, 3000);
    this.transitionTimer.unref?.();
  }

  /**
   * One scheduler tick drives everything; targets decide for themselves when
   * they are due.
   *
   * Self-rescheduling rather than setInterval: the period is recomputed from
   * the current interval on every tick, so changing the frequency takes effect
   * at once no matter which code path changed it — a fixed timer would keep
   * ticking once a second while the user asked for ten times that.
   */
  private rescheduleAuto(): void {
    if (this.timer) clearTimeout(this.timer);
    const loop = () => {
      this.pump();
      const intervalMs = getSettings().intervalSec * 1000;
      const period = intervalMs > 0 ? Math.min(1000, Math.max(20, intervalMs / 4)) : 1000;
      this.timer = setTimeout(loop, period);
      this.timer.unref?.();
    };
    loop();
  }

  private buildSockets(): void {
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.send(
        JSON.stringify({
          type: 'snapshot',
          targets: listStates(),
          settings: getSettings(),
          running: this.running,
          paused: this.paused,
          cycleMs: this.cycleMs,
        } satisfies ServerMessage),
      );
      ws.on('close', () => this.clients.delete(ws));
    });
  }

  private buildRoutes(): void {
    const app = this.app;
    app.use(express.json({ limit: '2mb' }));

    app.get('/api/state', (_req, res) => {
      res.json({ targets: listStates(), settings: getSettings(), running: this.running });
    });

    app.post('/api/targets', (req, res) => {
      const body = req.body as { lines?: string[]; text?: string; layers?: LayerSet };
      const added = addTargets(body.lines ?? (body.text ?? '').split(/\r?\n/), body.layers);
      res.json({ added: added.length, targets: listStates() });
      for (const s of added) this.broadcast({ type: 'result', state: s });
      this.emit('update');
    });

    app.patch('/api/targets/:id', (req, res) => {
      const state = updateTarget(req.params.id, req.body as Record<string, never>);
      if (!state) return void res.status(404).json({ error: 'not found' });
      this.broadcast({ type: 'result', state });
      this.emit('update');
      res.json(state);
    });

    app.delete('/api/targets', (req, res) => {
      const { ids } = req.body as { ids: string[] };
      removeTargets(ids ?? []);
      // Drop the scheduler's bookkeeping too, or the maps keep growing with
      // ids that will never be probed again.
      for (const id of ids ?? []) {
        this.queued.delete(id);
        this.dueAt.delete(id);
        this.passPending.delete(id);
      }
      res.json({ ok: true });
      this.broadcast({
        type: 'snapshot',
        targets: listStates(),
        settings: getSettings(),
        running: this.running,
        paused: this.paused,
        cycleMs: this.cycleMs,
      });
      this.emit('update');
    });

    app.post('/api/settings', (req, res) => {
      const s = setSettings(req.body as Record<string, never>);
      this.rescheduleAuto();
      res.json(s);
      this.broadcast({ type: 'settings', settings: s });
    });

    app.post('/api/proxies', (req, res) => {
      const body = req.body as { lines?: string[]; text?: string };
      const added = addProxies(body.lines ?? (body.text ?? '').split(/\r?\n/));
      const s = getSettings();
      res.json({ added: added.length, settings: s });
      this.broadcast({ type: 'settings', settings: s });
      this.emit('update');
    });

    // Re-reads the OS proxy settings. Called when the route list is opened, so
    // a proxy switched on in Windows shows up without restarting the app.
    app.post('/api/proxies/refresh', async (_req, res) => {
      const s = await refreshSystemProxies();
      res.json(s);
      this.broadcast({ type: 'settings', settings: s });
      this.emit('update');
    });

    app.delete('/api/proxies/:id', (req, res) => {
      const s = removeProxy(req.params.id);
      res.json(s);
      this.broadcast({ type: 'settings', settings: s });
      this.emit('update');
    });

    // Confirms the proxy itself is usable before the user blames every target.
    app.post('/api/proxies/:id/test', async (req, res) => {
      const s = getSettings();
      const proxy = s.proxies.find((p) => p.id === req.params.id);
      if (!proxy) return void res.status(404).json({ error: 'not found' });
      const started = Date.now();
      try {
        const sock = await dial({ host: 'example.com', port: 443, timeoutMs: s.timeoutMs, proxy });
        sock.destroy();
        res.json({ ok: true, ms: Date.now() - started });
      } catch (e) {
        res.json({ ok: false, ms: Date.now() - started, error: (e as Error).message });
      }
    });

    app.post('/api/sweep', (req, res) => {
      const { ids, restart } = (req.body ?? {}) as { ids?: string[]; restart?: boolean };
      void this.sweep(ids, restart === true);
      res.json({ ok: true });
    });

    app.post('/api/sweep/stop', (_req, res) => {
      this.stopSweep();
      res.json({ ok: true });
    });

    app.get('/api/export', (req, res) => {
      const states = listStates();
      if (req.query.format === 'csv') {
        res.setHeader('content-type', 'text/csv; charset=utf-8');
        res.setHeader('content-disposition', 'attachment; filename="popingui-report.csv"');
        return void res.send('﻿' + toCsv(states));
      }
      res.setHeader('content-disposition', 'attachment; filename="popingui-report.json"');
      res.json({ generatedAt: new Date().toISOString(), targets: states });
    });

    if (this.opts.distDir) {
      const dist = this.opts.distDir;
      app.use(express.static(dist));
      app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
    }
  }
}

export function toCsv(states: TargetState[]): string {
  const head = 'host,port,note,verdict,route,latency_ms,address,uptime,checked_at,summary';
  const rows = states.map((s) => {
    const l = s.last;
    return [
      s.target.host,
      s.target.port,
      s.target.note,
      l?.verdict ?? 'pending',
      l?.route ?? '',
      l?.latency ?? '',
      l?.address ?? '',
      `${(s.uptime * 100).toFixed(0)}%`,
      l ? new Date(l.ts).toISOString() : '',
      l?.summary ?? '',
    ]
      .map((c) => `"${String(c).replaceAll('"', '""')}"`)
      .join(',');
  });
  return [head, ...rows].join('\r\n');
}

