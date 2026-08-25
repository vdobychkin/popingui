import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayerSet, ServerMessage, Settings, Target, TargetState } from '../../shared/types.ts';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

export interface Monitor {
  targets: TargetState[];
  settings: Settings | null;
  running: boolean;
  connected: boolean;
  /** Probing is held off until the next explicit start. */
  paused: boolean;
  /** How long one probe of every target last took, ms. */
  cycleMs: number | null;
  /** Live counts of probes running and waiting for a worker. */
  progress: Progress;
  addTargets: (text: string, layers?: LayerSet) => Promise<void>;
  removeTargets: (ids: string[]) => Promise<void>;
  patchTarget: (id: string, patch: Partial<Target>) => Promise<void>;
  patchSettings: (patch: Partial<Settings>) => Promise<void>;
  addProxies: (text: string) => Promise<number>;
  removeProxy: (id: string) => Promise<void>;
  /** Re-reads the proxy the OS is configured to use. */
  refreshProxies: () => Promise<void>;
  testProxy: (id: string) => Promise<ProxyTest>;
  sweep: (ids?: string[], restart?: boolean) => Promise<void>;
  stop: () => Promise<void>;
}

export interface Progress {
  inFlight: number;
  queued: number;
}

export interface ProxyTest {
  ok: boolean;
  ms: number;
  error?: string;
}

export function useMonitor(): Monitor {
  const [targets, setTargets] = useState<TargetState[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [cycleMs, setCycleMs] = useState<number | null>(null);
  const [progress, setProgress] = useState<Progress>({ inFlight: 0, queued: 0 });
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry.current = setTimeout(connect, 1500);
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as ServerMessage;
        switch (msg.type) {
          case 'snapshot':
            setTargets(msg.targets);
            setSettings(msg.settings);
            setRunning(msg.running);
            setPaused(msg.paused);
            setCycleMs(msg.cycleMs);
            break;
          case 'result':
            setTargets((prev) => {
              const i = prev.findIndex((t) => t.target.id === msg.state.target.id);
              if (i === -1) return [...prev, msg.state];
              const next = prev.slice();
              next[i] = msg.state;
              return next;
            });
            break;
          case 'probing':
            setTargets((prev) =>
              prev.map((t) =>
                t.target.id === msg.targetId
                  ? { ...t, probing: msg.probing, queued: msg.queued, probingSince: msg.since }
                  : t,
              ),
            );
            break;
          case 'sweep':
            setRunning(msg.running);
            setPaused(msg.paused);
            setProgress({ inFlight: msg.inFlight, queued: msg.queued });
            if (msg.cycleMs != null) setCycleMs(msg.cycleMs);
            break;
          case 'settings':
            setSettings(msg.settings);
            break;
        }
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry.current) clearTimeout(retry.current);
      ws?.close();
    };
  }, []);

  const addTargets = useCallback(async (text: string, layers?: LayerSet) => {
    const { targets: all } = await api<{ targets: TargetState[] }>('/api/targets', {
      method: 'POST',
      body: JSON.stringify({ text, layers }),
    });
    setTargets(all);
  }, []);

  const removeTargets = useCallback(async (ids: string[]) => {
    await api('/api/targets', { method: 'DELETE', body: JSON.stringify({ ids }) });
    setTargets((prev) => prev.filter((t) => !ids.includes(t.target.id)));
  }, []);

  const patchTarget = useCallback(async (id: string, patch: Partial<Target>) => {
    await api(`/api/targets/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  }, []);

  const patchSettings = useCallback(async (patch: Partial<Settings>) => {
    const s = await api<Settings>('/api/settings', { method: 'POST', body: JSON.stringify(patch) });
    setSettings(s);
  }, []);

  const addProxies = useCallback(async (text: string) => {
    const r = await api<{ added: number; settings: Settings }>('/api/proxies', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    setSettings(r.settings);
    return r.added;
  }, []);

  const removeProxy = useCallback(async (id: string) => {
    setSettings(await api<Settings>(`/api/proxies/${id}`, { method: 'DELETE' }));
  }, []);

  const refreshProxies = useCallback(async () => {
    setSettings(await api<Settings>('/api/proxies/refresh', { method: 'POST' }));
  }, []);

  const testProxy = useCallback(
    (id: string) => api<ProxyTest>(`/api/proxies/${id}/test`, { method: 'POST' }),
    [],
  );

  const sweep = useCallback(async (ids?: string[], restart = false) => {
    await api('/api/sweep', { method: 'POST', body: JSON.stringify({ ids, restart }) });
  }, []);

  const stop = useCallback(async () => {
    await api('/api/sweep/stop', { method: 'POST' });
  }, []);

  return {
    targets,
    settings,
    running,
    connected,
    paused,
    cycleMs,
    progress,
    addTargets,
    removeTargets,
    patchTarget,
    patchSettings,
    addProxies,
    removeProxy,
    refreshProxies,
    testProxy,
    sweep,
    stop,
  };
}
