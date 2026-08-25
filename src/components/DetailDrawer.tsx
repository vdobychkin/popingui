import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ALL_LAYERS,
  DIRECT_ROUTE,
  LAYER_ORDER,
  VERDICT_META,
  type LayerName,
  type LayerResult,
  type LayerSet,
  type TargetState,
} from '../../shared/types.ts';
import { LayerPicker } from './LayerPicker.tsx';
import { Sparkline } from './Sparkline.tsx';

const TONE_TEXT: Record<string, string> = {
  good: 'text-good',
  warn: 'text-warn',
  bad: 'text-bad',
  idle: 'text-muted',
};
const STATUS_TEXT: Record<LayerResult['status'], string> = {
  ok: 'text-good',
  warn: 'text-warn',
  fail: 'text-bad',
  skip: 'text-muted',
};

function Extra({ extra }: { extra: LayerResult['extra'] }) {
  if (!extra) return null;
  const rows = Object.entries(extra).filter(([, v]) => v !== '' && v != null);
  if (!rows.length) return null;
  return (
    <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="break-all text-slate-300">{Array.isArray(v) ? v.join(', ') : String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Free-text expectation. Saves itself shortly after typing stops, rather than
 * only on blur: an inline field with no Save button loses whatever was typed
 * if the panel is closed while it still has focus.
 *
 * The draft is held locally so a probe result arriving mid-edit — they stream
 * in constantly — cannot overwrite what is being typed.
 */
function ExpectField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(false);
  const editing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ value, onSave });
  latest.current = { value, onSave };

  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);

  const flush = useCallback((next: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    editing.current = false;
    if (next === latest.current.value) return;
    latest.current.onSave(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }, []);

  const draftRef = useRef(draft);
  draftRef.current = draft;

  // A pending save must not be dropped when the panel closes or the user
  // selects another target.
  useEffect(
    () => () => {
      if (!timer.current) return;
      clearTimeout(timer.current);
      if (editing.current && draftRef.current !== latest.current.value) {
        latest.current.onSave(draftRef.current);
      }
    },
    [],
  );

  const change = (next: string) => {
    editing.current = true;
    setDraft(next);
    draftRef.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => flush(next), 700);
  };

  return (
    <label className="mt-4 block">
      <span className="text-muted mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide">
        Ожидаемый текст в ответе
        {saved && <span className="text-good normal-case">сохранено</span>}
      </span>
      <input
        value={draft}
        onChange={(e) => change(e.target.value)}
        onBlur={() => flush(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') flush(e.currentTarget.value);
        }}
        placeholder="например, название сайта в заголовке"
        className="border-ink-700 bg-ink-950 placeholder:text-muted focus:border-ink-600 w-full rounded border px-2.5 py-1.5 text-xs text-slate-200 outline-none"
      />
      <span className="text-muted mt-1 block text-[10px]">
        Если текста в ответе нет — вердикт «нет ожидаемого текста». Пусто — проверка выключена.
      </span>
    </label>
  );
}

export function DetailDrawer({
  state,
  onClose,
  onRecheck,
  onExpectChange,
  onLayersChange,
}: {
  state: TargetState;
  onClose: () => void;
  onRecheck: () => void;
  onExpectChange: (expect: string) => void;
  onLayersChange: (layers: LayerSet) => void;
}) {
  const last = state.last;
  const meta = VERDICT_META[last?.verdict ?? 'pending'];
  const layers = state.target.layers;
  const off = LAYER_ORDER.filter((l) => !layers[l]);

  return (
    <aside className="border-ink-800 bg-ink-900 flex w-[420px] shrink-0 flex-col border-l">
      <header className="border-ink-800 flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-sm text-slate-100">
            {state.target.host}
            <span className="text-muted">:{state.target.port}</span>
          </div>
          <div className={`mt-0.5 text-xs font-medium ${TONE_TEXT[meta.tone]}`}>{meta.label}</div>
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={onRecheck}
            className="border-ink-700 hover:bg-ink-800 rounded border px-2 py-1 text-xs text-slate-300"
          >
            Проверить
          </button>
          <button
            onClick={onClose}
            className="border-ink-700 hover:bg-ink-800 rounded border px-2 py-1 text-xs text-slate-400"
          >
            ✕
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {last?.summary && (
          <p className="border-ink-700 bg-ink-800/60 mb-4 rounded border px-3 py-2 text-[13px] leading-relaxed text-slate-300">
            {last.summary}
          </p>
        )}

        <div className="mb-4 grid grid-cols-3 gap-2 text-center">
          <Stat
            label={last?.latencyFrom ? `Задержка · ${last.latencyFrom.toUpperCase()}` : 'Задержка'}
            value={last?.latency != null ? `${last.latency} мс` : '—'}
            hint={latencyHint(last?.latencyFrom ?? null, last?.route ?? DIRECT_ROUTE)}
          />
          <Stat label="Аптайм" value={state.history.length ? `${Math.round(state.uptime * 100)}%` : '—'} />
          <Stat label="Проб" value={String(state.history.length)} />
        </div>

        <div className="mb-4">
          <div className="text-muted mb-1 text-[11px] uppercase tracking-wide">История</div>
          <Sparkline history={state.history} width={388} height={34} />
        </div>

        {/* The choice sits directly above its own results: switch a layer on
            and the entry it produces appears in the list below it. */}
        <div className="text-muted mb-1.5 flex items-center gap-2 text-[11px] uppercase tracking-wide">
          Слои
          {off.length > 0 && (
            <button
              onClick={() => onLayersChange({ ...ALL_LAYERS })}
              className="text-muted normal-case underline-offset-2 hover:text-slate-300 hover:underline"
            >
              включить все
            </button>
          )}
        </div>
        <div className="border-ink-800 bg-ink-950/60 mb-2 rounded border px-3 py-2">
          <LayerPicker value={layers} onChange={onLayersChange} requireOne />
          <div className="text-muted mt-1.5 text-[10px]">
            Меняется только для этого ресурса; после изменения он проверяется заново.
          </div>
        </div>
        <ul className="space-y-2">
          {(last?.layers ?? []).map((l) => (
            <li key={l.layer} className="border-ink-800 bg-ink-950/60 rounded border px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className={`font-mono text-xs uppercase ${STATUS_TEXT[l.status]}`}>{l.layer}</span>
                <span className="text-muted font-mono text-[11px]">{l.ms != null ? `${l.ms} мс` : '—'}</span>
              </div>
              <div className="mt-0.5 text-[12px] text-slate-400">{l.detail}</div>
              <Extra extra={l.extra} />
            </li>
          ))}
          {!last && <li className="text-muted text-xs">Ещё не проверялся.</li>}
        </ul>

        <ExpectField value={state.target.expect} onSave={onExpectChange} />

        {last && (
          <div className="text-muted mt-4 font-mono text-[11px]">
            маршрут: <span className={last.route === DIRECT_ROUTE ? 'text-slate-400' : 'text-warn'}>{last.route}</span>
          </div>
        )}
        {last?.address && (
          <div className="text-muted mt-1 font-mono text-[11px]">
            адрес проверки: <span className="text-slate-400">{last.address}</span>
          </div>
        )}
        {last && (
          <div className="text-muted mt-1 font-mono text-[11px]">
            последняя проверка: <span className="text-slate-400">{new Date(last.ts).toLocaleString()}</span>
          </div>
        )}
      </div>
    </aside>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border-ink-800 bg-ink-950/60 rounded border px-2 py-2" title={hint}>
      <div className="font-mono text-sm text-slate-200">{value}</div>
      <div className="text-muted mt-0.5 text-[10px] uppercase tracking-wide">{label}</div>
    </div>
  );
}

/** Explains what the number covers — it is not the same distance every time. */
function latencyHint(from: LayerName | null, route: string): string | undefined {
  if (!from) return undefined;
  const viaProxy = route !== DIRECT_ROUTE;
  switch (from) {
    case 'tls':
      return 'Время TLS-рукопожатия — оно проходит весь путь до цели.';
    case 'http':
      return 'Время HTTP-запроса целиком, включая ответ сервера, — больше, чем чистый RTT.';
    case 'tcp':
      return viaProxy
        ? 'Время до ответа прокси на CONNECT. Если прокси отвечает до того, как сам подключится к цели, это задержка только до прокси.'
        : 'Время установки TCP-соединения с целью.';
    case 'ping':
      return viaProxy
        ? 'Лучший из трёх TCP-пингов через прокси: ICMP по SOCKS не проходит.'
        : 'Время ответа на ICMP-эхо.';
    default:
      return undefined;
  }
}
