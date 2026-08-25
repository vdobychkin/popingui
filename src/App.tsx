import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ALL_LAYERS,
  DIRECT_ROUTE,
  LAYER_ORDER,
  POLL_STEPS,
  type LayerSet,
  type NotifyMode,
  VERDICT_META,
  formatInterval,
  nearestPollStep,
  type TargetState,
  type Verdict,
} from '../shared/types.ts';
import { useMonitor, type Progress } from './lib/useMonitor.ts';
import { LayerDots } from './components/LayerDots.tsx';
import { Sparkline } from './components/Sparkline.tsx';
import { DetailDrawer } from './components/DetailDrawer.tsx';
import { RouteSwitcher } from './components/RouteSwitcher.tsx';
import { ProxyPanel } from './components/ProxyPanel.tsx';
import { LayerPicker } from './components/LayerPicker.tsx';
import {
  IconBell,
  IconBellOff,
  IconGear,
  IconPlay,
  IconPlus,
  IconStop,
  TONE_ICON,
  VERDICT_ICON,
} from './components/icons.tsx';

type Tone = 'good' | 'warn' | 'bad' | 'idle';
type FilterKey = 'all' | Tone;
type SortCol = 'host' | 'verdict' | 'latency' | 'uptime';
/** Column plus direction; clicking the active column flips it. */
interface SortKey {
  col: SortCol;
  desc: boolean;
}

const TONE_DOT: Record<Tone, string> = {
  good: 'bg-good',
  warn: 'bg-warn',
  bad: 'bg-bad',
  idle: 'bg-ink-600',
};
const TONE_TEXT: Record<Tone, string> = {
  good: 'text-good',
  warn: 'text-warn',
  bad: 'text-bad',
  idle: 'text-muted',
};

export default function App() {
  const m = useMonitor();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [sort, setSort] = useState<SortKey>({ col: 'verdict', desc: false });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showProxies, setShowProxies] = useState(false);

  // The tray's "Показать в окне" navigates to #target=<id>; honour it on load
  // and on every subsequent click while the window stays open.
  useEffect(() => {
    const apply = () => {
      const id = /#target=([^&]+)/.exec(location.hash)?.[1];
      if (id) setOpenId(decodeURIComponent(id));
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  const counts = useMemo(() => {
    const c: Record<Tone, number> = { good: 0, warn: 0, bad: 0, idle: 0 };
    for (const t of m.targets) c[VERDICT_META[t.last?.verdict ?? 'pending'].tone]++;
    return c;
  }, [m.targets]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = m.targets.filter((t) => {
      const tone = VERDICT_META[t.last?.verdict ?? 'pending'].tone;
      if (filter !== 'all' && tone !== filter) return false;
      if (!q) return true;
      return (
        t.target.host.includes(q) ||
        t.target.note.toLowerCase().includes(q) ||
        (t.last?.address ?? '').includes(q)
      );
    });
    const rank: Record<Tone, number> = { bad: 0, warn: 1, idle: 2, good: 3 };
    const cmp = (a: TargetState, b: TargetState): number => {
      switch (sort.col) {
        case 'host':
          return a.target.host.localeCompare(b.target.host);
        // Unmeasured rows sort as the worst latency either way, so flipping the
        // direction never floats a row that has no number at all to the top.
        case 'latency':
          return (a.last?.latency ?? Infinity) - (b.last?.latency ?? Infinity);
        case 'uptime':
          return a.uptime - b.uptime;
        default: {
          const d =
            rank[VERDICT_META[a.last?.verdict ?? 'pending'].tone] -
            rank[VERDICT_META[b.last?.verdict ?? 'pending'].tone];
          return d !== 0 ? d : a.target.host.localeCompare(b.target.host);
        }
      }
    };
    return filtered.sort((a, b) => {
      const d = cmp(a, b);
      if (d === 0) return a.target.host.localeCompare(b.target.host);
      const flipped = sort.desc ? -d : d;
      const aMissing = sort.col === 'latency' && a.last?.latency == null;
      const bMissing = sort.col === 'latency' && b.last?.latency == null;
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      return flipped;
    });
  }, [m.targets, query, filter, sort]);

  const open = m.targets.find((t) => t.target.id === openId) ?? null;
  const allShownSelected = rows.length > 0 && rows.every((r) => selected.has(r.target.id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  /**
   * Saves a target's layer selection and re-probes it, because the results
   * shown under the checkboxes would otherwise describe a different set of
   * layers until the next scheduled probe.
   *
   * The save is immediate, the re-probe is debounced: switching three layers
   * off is one decision, and each probe can take as long as the timeout.
   */
  const reprobeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changeLayers = async (id: string, layers: LayerSet) => {
    await m.patchTarget(id, { layers });
    if (reprobeTimer.current) clearTimeout(reprobeTimer.current);
    reprobeTimer.current = setTimeout(() => void m.sweep([id]), 500);
  };
  useEffect(() => () => void (reprobeTimer.current && clearTimeout(reprobeTimer.current)), []);

  /**
   * The bell switches notifications off and back on. Which mode it comes back
   * to is remembered, so someone who chose "problems and recovery" in settings
   * does not silently get demoted to "problems only" by muting for a minute.
   */
  const [notifyBack, setNotifyBack] = useState<NotifyMode>('bad');
  const toggleNotify = () => {
    const current = m.settings?.notify ?? 'bad';
    if (current === 'off') {
      void m.patchSettings({ notify: notifyBack });
    } else {
      setNotifyBack(current);
      void m.patchSettings({ notify: 'off' });
    }
  };

  // Switching route invalidates every reading on screen, so re-probe at once
  // instead of leaving stale results under a new label.
  const selectRoute = async (id: string | null) => {
    await m.patchSettings({ activeProxyId: id });
    await m.sweep(undefined, true);
  };

  return (
    <div className="flex h-full flex-col">
      <Header
        counts={counts}
        total={m.targets.length}
        connected={m.connected}
        running={m.running}
        paused={m.paused}
        progress={m.progress}
        settings={m.settings}
        cycleMs={m.cycleMs}
        onIntervalChange={(intervalSec) => void m.patchSettings({ intervalSec })}
        onSelectRoute={(id) => void selectRoute(id)}
        onManageProxies={() => setShowProxies(true)}
        onRefreshProxies={() => void m.refreshProxies()}
        onSweep={() => void m.sweep()}
        onStop={() => void m.stop()}
        onToggleNotify={toggleNotify}
        onAdd={() => setShowAdd((v) => !v)}
        onSettings={() => setShowSettings((v) => !v)}
      />

      {showAdd && (
        <AddPanel
          defaultLayers={m.settings?.layers ?? ALL_LAYERS}
          onSubmit={async (text, layers) => {
            await m.addTargets(text, layers);
            setShowAdd(false);
          }}
          onClose={() => setShowAdd(false)}
        />
      )}
      {showProxies && m.settings && (
        <ProxyPanel
          settings={m.settings}
          onAdd={m.addProxies}
          onRemove={m.removeProxy}
          onTest={m.testProxy}
          onSelect={(id) => void selectRoute(id)}
          onClose={() => setShowProxies(false)}
        />
      )}
      {showSettings && m.settings && (
        <SettingsPanel settings={m.settings} onChange={(p) => void m.patchSettings(p)} />
      )}

      <Toolbar
        query={query}
        setQuery={setQuery}
        filter={filter}
        setFilter={setFilter}
        counts={counts}
        sort={sort}
        setSort={setSort}
        selectedCount={selected.size}
        onRecheckSelected={() => void m.sweep([...selected])}
        onDeleteSelected={async () => {
          await m.removeTargets([...selected]);
          setSelected(new Set());
        }}
      />

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto">
          {/* min-width keeps columns readable and scrolls instead of wrapping
              once the detail drawer takes its share of a narrow window */}
          {/* table-fixed with declared widths: without it the column widths are
              derived from content, so a status going from a spinner to
              "Сертификат просрочен" shifts every column beside it on each
              probe. Only the resource column flexes; the rest never move. */}
          <table className="w-full min-w-[940px] table-fixed border-collapse text-sm">
            {/* Every width but the resource column is fixed, and each is wide
                enough for its longest content: the status column has to hold
                "0.5 с" beside a spinner, the latency one "1234 мс · ping". Too
                narrow and the text wraps to a second line, which changes the
                row height on every probe. */}
            <colgroup>
              <col className="w-9" />
              <col />
              <col className="w-[92px]" />
              <col className="w-[254px]" />
              <col className="w-[126px]" />
              <col className="w-[148px]" />
              <col className="w-[72px]" />
            </colgroup>
            <thead className="bg-ink-900/95 sticky top-0 z-10 backdrop-blur">
              <tr className="border-ink-800 text-muted border-b text-left text-[11px] uppercase tracking-wide">
                <th className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allShownSelected}
                    onChange={() =>
                      setSelected(allShownSelected ? new Set() : new Set(rows.map((r) => r.target.id)))
                    }
                    className="accent-good"
                  />
                </th>
                <SortHeader label="Ресурс" col="host" sort={sort} onSort={setSort} />
                <SortHeader label="Статус" col="verdict" sort={sort} onSort={setSort} />
                <th className="px-2 py-2 font-medium">Слои</th>
                <SortHeader label="Задержка" col="latency" sort={sort} onSort={setSort} align="right" />
                <th className="px-2 py-2 font-medium">История</th>
                <SortHeader label="Аптайм" col="uptime" sort={sort} onSort={setSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <Row
                  key={t.target.id}
                  state={t}
                  selected={selected.has(t.target.id)}
                  active={t.target.id === openId}
                  onToggle={() => toggle(t.target.id)}
                  onOpen={() => setOpenId(t.target.id)}
                />
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={7} className="text-muted px-4 py-16 text-center text-sm">
                    {m.targets.length ? 'Ничего не подходит под фильтр.' : 'Список пуст — добавьте ресурсы.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {open && (
          <DetailDrawer
            state={open}
            onClose={() => setOpenId(null)}
            onRecheck={() => void m.sweep([open.target.id])}
            onExpectChange={async (expect) => {
              await m.patchTarget(open.target.id, { expect });
              await m.sweep([open.target.id]);
            }}
            onLayersChange={(layers) => void changeLayers(open.target.id, layers)}
          />
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ header

function Header(props: {
  counts: Record<Tone, number>;
  total: number;
  connected: boolean;
  running: boolean;
  paused: boolean;
  progress: Progress;
  settings: import('../shared/types.ts').Settings | null;
  cycleMs: number | null;
  onIntervalChange: (sec: number) => void;
  onSelectRoute: (id: string | null) => void;
  onManageProxies: () => void;
  onRefreshProxies: () => void;
  onSweep: () => void;
  onStop: () => void;
  onToggleNotify: () => void;
  onAdd: () => void;
  onSettings: () => void;
}) {
  const notify = props.settings?.notify ?? 'bad';
  const muted = notify === 'off';
  return (
    <header className="border-ink-800 bg-ink-900 flex items-center gap-4 border-b px-4 py-2.5">
      <span className="font-mono text-[15px] font-semibold tracking-tight text-slate-100">popingui</span>

      {/* shrink-0 + nowrap: in a flex row this block is otherwise allowed to
          narrow until "из 6" breaks across two lines and the header grows. */}
      <div className="flex shrink-0 items-center gap-3 whitespace-nowrap text-xs">
        <Chip tone="good" n={props.counts.good} label="норма" />
        <Chip tone="warn" n={props.counts.warn} label="странно" />
        <Chip tone="bad" n={props.counts.bad} label="блок" />
        <span className="text-muted">из {props.total}</span>
      </div>

      {props.settings && (
        <IntervalSlider
          intervalSec={props.settings.intervalSec}
          cycleMs={props.cycleMs}
          onChange={props.onIntervalChange}
        />
      )}

      {/* Start/stop sits with the slider: both answer "how often is this being
          polled", and the pair reads as one control instead of the action being
          at the far end of the header from the setting it acts on. */}
      {props.running ? (
        <IconButton
          onClick={props.onStop}
          label="Остановить опрос"
          className="border-bad/40 bg-bad/10 text-bad hover:bg-bad/20"
        >
          <IconStop size={13} />
        </IconButton>
      ) : (
        <IconButton
          onClick={props.onSweep}
          label="Проверить всё"
          className="border-good/40 bg-good/10 text-good hover:bg-good/20"
        >
          <IconPlay size={13} />
        </IconButton>
      )}

      <ActivityIndicator running={props.running} paused={props.paused} progress={props.progress} />

      <div className="ml-auto flex items-center gap-2">
        <span
          className={`flex items-center gap-1.5 text-[11px] ${props.connected ? 'text-muted' : 'text-bad'}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${props.connected ? 'bg-good' : 'bg-bad'}`} />
          {props.connected ? 'подключено' : 'нет связи с сервером'}
        </span>
        {props.settings && (
          <RouteSwitcher
            settings={props.settings}
            onSelect={props.onSelectRoute}
            onManage={props.onManageProxies}
            onRefresh={props.onRefreshProxies}
          />
        )}
        <a
          href="/api/export?format=csv"
          className="border-ink-700 hover:bg-ink-800 rounded border px-2.5 py-1.5 text-xs text-slate-300"
        >
          CSV
        </a>
        <IconButton
          onClick={props.onToggleNotify}
          label={
            muted
              ? 'Уведомления выключены — включить'
              : `Уведомления включены (${notify === 'both' ? 'о проблемах и восстановлении' : 'только о проблемах'}) — выключить`
          }
          className={
            muted
              ? 'border-ink-700 text-muted hover:bg-ink-800'
              : 'border-good/40 bg-good/10 text-good hover:bg-good/20'
          }
        >
          {muted ? <IconBellOff size={14} /> : <IconBell size={14} />}
        </IconButton>
        <IconButton onClick={props.onAdd} label="Добавить ресурсы">
          <IconPlus size={14} />
        </IconButton>
        <IconButton onClick={props.onSettings} label="Настройки">
          <IconGear size={14} />
        </IconButton>
      </div>
    </header>
  );
}

/**
 * Square icon button. The size is fixed rather than derived from the glyph so
 * that swapping play for stop — or any icon for any other — never moves the
 * controls beside it by a pixel. The name lives in `title` and in a screen
 * reader label, because an icon alone is not a name.
 */
function IconButton({
  onClick,
  label,
  className = 'border-ink-700 hover:bg-ink-800 text-slate-300',
  children,
}: {
  onClick: () => void;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded border ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * Shows that probing is happening at all, and how much of it. With targets on
 * independent schedules there is no single "sweep 40%" figure to report, so it
 * reports the two numbers that do exist: probes running and probes waiting.
 */
function ActivityIndicator({
  running,
  paused,
  progress,
}: {
  running: boolean;
  paused: boolean;
  progress: Progress;
}) {
  if (paused) {
    return (
      <span className="text-warn flex shrink-0 items-center gap-1.5 text-[11px]" title="Опрос остановлен — запустите его кнопкой у ползунка.">
        <span className="bg-warn h-1.5 w-1.5 rounded-full" />
        пауза
      </span>
    );
  }
  if (!running) {
    return <span className="text-muted shrink-0 text-[11px]">ожидание</span>;
  }
  return (
    <span
      className="text-good flex shrink-0 items-center gap-1.5 text-[11px]"
      title={`${progress.inFlight} проб выполняется, ${progress.queued} в очереди`}
    >
      <span className="border-good/30 border-t-good h-3 w-3 animate-spin rounded-full border-2" />
      <span className="font-mono">{progress.inFlight}</span>
      {progress.queued > 0 && <span className="text-muted font-mono">+{progress.queued}</span>}
    </span>
  );
}

/**
 * Per-row activity: a spinner with the elapsed seconds while the probe runs,
 * a clock while it waits for a worker. The elapsed time is the point — it is
 * what identifies the target that is holding the queue up.
 */
function RowActivity({ state }: { state: TargetState }) {
  const [, tick] = useState(0);
  const since = state.probingSince;
  useEffect(() => {
    if (since == null) return;
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [since]);

  if (state.probing) {
    const elapsed = since == null ? 0 : (Date.now() - since) / 1000;
    // Amber past three seconds: that is roughly where a probe stops being
    // "in progress" and starts being "the one everything is waiting on".
    const slow = elapsed >= 3;
    return (
      <span
        className={`inline-flex items-center gap-1.5 whitespace-nowrap ${slow ? 'text-warn' : 'text-good'}`}
        title={`Проверяется ${elapsed.toFixed(1)} с`}
      >
        {/* Same ring as the header indicator — a faint circle with one bright
            arc — rather than a three-quarter horseshoe, so the two spinners on
            screen at once read as the same thing happening. */}
        <span
          className={`h-3 w-3 animate-spin rounded-full border-2 ${
            slow ? 'border-warn/30 border-t-warn' : 'border-good/30 border-t-good'
          }`}
        />
        <span className="font-mono text-[11px]">{elapsed.toFixed(1)} с</span>
      </span>
    );
  }
  if (state.queued) {
    return (
      <span
        className="text-muted inline-flex items-center gap-1.5 whitespace-nowrap"
        title="Ждёт свободного работника"
      >
        <span className="border-ink-600 h-3 w-3 rounded-full border-2 border-dashed" />
        <span className="text-[11px]">в очереди</span>
      </span>
    );
  }
  return null;
}

/**
 * A counter for one tone. The glyph carries the meaning, the word moved to the
 * tooltip: three coloured dots side by side told colour-blind readers nothing,
 * and the words made the header wide enough to push the slider off-screen.
 */
function Chip({ tone, n, label }: { tone: Tone; n: number; label: string }) {
  const Icon = TONE_ICON[tone];
  return (
    <span className={`flex items-center gap-1 ${TONE_TEXT[tone]}`} title={`${n} — ${label}`}>
      <Icon size={13} />
      <span className="font-mono text-slate-200">{n}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

// ----------------------------------------------------------------- toolbar

function Toolbar(props: {
  query: string;
  setQuery: (v: string) => void;
  filter: FilterKey;
  setFilter: (v: FilterKey) => void;
  counts: Record<Tone, number>;
  sort: SortKey;
  setSort: (v: SortKey) => void;
  selectedCount: number;
  onRecheckSelected: () => void;
  onDeleteSelected: () => void;
}) {
  const tabs: { key: FilterKey; label: string }[] = [
    { key: 'all', label: 'Все' },
    { key: 'bad', label: `Блок (${props.counts.bad})` },
    { key: 'warn', label: `Странно (${props.counts.warn})` },
    { key: 'good', label: `Норма (${props.counts.good})` },
  ];
  return (
    <div className="border-ink-800 bg-ink-950 flex items-center gap-2 border-b px-4 py-2">
      <input
        value={props.query}
        onChange={(e) => props.setQuery(e.target.value)}
        placeholder="Фильтр по хосту, IP или заметке…"
        className="border-ink-700 bg-ink-900 placeholder:text-muted focus:border-ink-600 w-72 rounded border px-2.5 py-1.5 text-xs text-slate-200 outline-none"
      />
      <div className="border-ink-700 flex overflow-hidden rounded border">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => props.setFilter(t.key)}
            className={`px-2.5 py-1.5 text-xs ${
              props.filter === t.key ? 'bg-ink-700 text-slate-100' : 'text-muted hover:text-slate-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* Sorting moved onto the column headers, where the arrow shows both the
          key and the direction without a second control repeating it. */}
      {props.selectedCount > 0 && (
        <div className="ml-auto flex items-center gap-2">
          <span className="text-muted text-xs">выбрано {props.selectedCount}</span>
          <button
            onClick={props.onRecheckSelected}
            className="border-ink-700 hover:bg-ink-800 rounded border px-2.5 py-1.5 text-xs text-slate-300"
          >
            Перепроверить
          </button>
          <button
            onClick={props.onDeleteSelected}
            className="border-bad/40 text-bad hover:bg-bad/10 rounded border px-2.5 py-1.5 text-xs"
          >
            Удалить
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Clickable column header. First click sorts by that column, clicking the
 * active one flips the direction — the arrow always shows which is in effect.
 */
function SortHeader({
  label,
  col,
  sort,
  onSort,
  align = 'left',
}: {
  label: string;
  col: SortCol;
  sort: SortKey;
  onSort: (s: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = sort.col === col;
  return (
    <th
      className={`whitespace-nowrap px-2 py-2 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      <button
        onClick={() => onSort({ col, desc: active ? !sort.desc : false })}
        className={`inline-flex items-center gap-1 uppercase tracking-wide ${
          active ? 'text-slate-200' : 'hover:text-slate-300'
        }`}
        title={`Сортировать по «${label}»`}
      >
        {label}
        <span className={active ? 'text-good' : 'text-ink-600'}>{active && sort.desc ? '▼' : '▲'}</span>
      </button>
    </th>
  );
}

// --------------------------------------------------------------------- row

function Row({
  state,
  selected,
  active,
  onToggle,
  onOpen,
}: {
  state: TargetState;
  selected: boolean;
  active: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const verdict: Verdict = state.last?.verdict ?? 'pending';
  const meta = VERDICT_META[verdict];
  const VerdictIcon = VERDICT_ICON[verdict];
  return (
    <tr
      onClick={onOpen}
      // The row no longer pulses: a per-row spinner with elapsed time says the
      // same thing and also says for how long, without the whole grid flashing.
      className={`border-ink-800/70 hover:bg-ink-900/70 cursor-pointer border-b ${
        active ? 'bg-ink-900' : ''
      } ${state.queued ? 'bg-ink-900/40' : ''}`}
    >
      <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={onToggle} className="accent-good" />
      </td>
      <td className="px-2 py-1.5">
        {/* min-w-0 lets the note truncate instead of widening the cell */}
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_DOT[meta.tone]}`} />
          <span className="shrink-0 font-mono text-[13px] text-slate-200">{state.target.host}</span>
          {state.target.port !== 443 && (
            <span className="text-muted shrink-0 font-mono text-[11px]">:{state.target.port}</span>
          )}
          {state.target.note && (
            <span className="text-muted min-w-0 truncate text-[11px]">{state.target.note}</span>
          )}
          {state.last && state.last.route !== DIRECT_ROUTE && (
            <span
              title={`Проверено через ${state.last.route}`}
              className="border-warn/30 bg-warn/10 text-warn shrink-0 rounded border px-1 py-px text-[9px] leading-none"
            >
              через прокси
            </span>
          )}
        </div>
      </td>
      <td className="px-2 py-1.5 text-xs">
        {state.probing || state.queued ? (
          <RowActivity state={state} />
        ) : (
          // Icon only, with the wording on hover and in the drawer: a fixed
          // glyph keeps the column from resizing, and the layer strip beside
          // it already spells out which stage failed.
          <span className={`inline-flex ${TONE_TEXT[meta.tone]}`} title={meta.label}>
            <VerdictIcon size={15} />
            <span className="sr-only">{meta.label}</span>
          </span>
        )}
      </td>
      <td className="px-2 py-1.5">
        <LayerDots layers={state.last?.layers ?? []} />
      </td>
      <td
        className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-xs text-slate-300"
        title={state.last?.latencyFrom ? `Измерено слоем ${state.last.latencyFrom.toUpperCase()}` : undefined}
      >
        {state.last?.latency != null ? `${state.last.latency}` : '—'}
        {state.last?.latency != null && (
          <span className="text-muted"> мс{state.last.latencyFrom ? ` · ${state.last.latencyFrom}` : ''}</span>
        )}
      </td>
      <td className="px-2 py-1.5">
        <Sparkline history={state.history} />
      </td>
      <td className="px-2 py-1.5 text-right font-mono text-xs text-slate-400">
        {state.history.length ? `${Math.round(state.uptime * 100)}%` : '—'}
      </td>
    </tr>
  );
}

// -------------------------------------------------------------- add panel

function AddPanel({
  defaultLayers,
  onSubmit,
  onClose,
}: {
  defaultLayers: LayerSet;
  onSubmit: (text: string, layers: LayerSet) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [layers, setLayers] = useState<LayerSet>(defaultLayers);
  const fileRef = useRef<HTMLInputElement>(null);
  const none = LAYER_ORDER.every((l) => !layers[l]);

  return (
    <div className="border-ink-800 bg-ink-900 border-b px-4 py-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        spellCheck={false}
        placeholder={'example.com\nhttps://rutracker.org\n1.1.1.1:53  DNS Cloudflare\nmy-host.local:8080 # внутренний сервис'}
        className="border-ink-700 bg-ink-950 placeholder:text-muted focus:border-ink-600 w-full rounded border px-3 py-2 font-mono text-xs text-slate-200 outline-none"
      />
      <div className="border-ink-800 mt-2 flex flex-wrap items-center gap-3 border-t pt-2">
        <span className="text-muted text-[10px] uppercase tracking-wide">Что проверять</span>
        <LayerPicker value={layers} onChange={setLayers} />
        <button
          onClick={() => setLayers({ ...ALL_LAYERS })}
          className="text-muted text-[11px] underline-offset-2 hover:text-slate-300 hover:underline"
        >
          все
        </button>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => void onSubmit(text, layers)}
          disabled={!text.trim() || none}
          title={none ? 'Выберите хотя бы один слой проверки' : undefined}
          className="border-good/40 bg-good/10 text-good hover:bg-good/20 rounded border px-3 py-1.5 text-xs font-medium disabled:opacity-40"
        >
          Добавить
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          className="border-ink-700 hover:bg-ink-800 rounded border px-3 py-1.5 text-xs text-slate-300"
        >
          Импорт из файла
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.csv,.list,text/plain"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) {
              const content = await f.text();
              setText((prev) => (prev ? `${prev}\n` : '') + content);
            }
            e.target.value = '';
          }}
        />
        <span className="text-muted text-[11px]">
          Одна строка — один ресурс. Поддерживаются URL, host:port, комментарии после #
        </span>
        <button onClick={onClose} className="text-muted ml-auto text-xs hover:text-slate-300">
          Свернуть
        </button>
      </div>
    </div>
  );
}

// --------------------------------------------------------- settings panel

/**
 * Frequency picker. The slider walks a preset list rather than a linear range:
 * the whole useful resolution sits between 10 s and a few minutes, and a linear
 * 0…86400 track would bury it in the first pixel.
 */
function IntervalSlider({
  intervalSec,
  cycleMs,
  onChange,
}: {
  intervalSec: number;
  cycleMs: number | null;
  onChange: (sec: number) => void;
}) {
  const index = nearestPollStep(intervalSec);
  // Targets run on independent schedules, so no cycle is skipped any more — but
  // a target whose own probe outlasts the interval cannot be polled that often.
  const tooTight = intervalSec > 0 && cycleMs != null && cycleMs > intervalSec * 1000;

  // Comma decimal separator, to match formatInterval's "0,1 с" in the same row.
  const cycleText = cycleMs == null ? null : `${(cycleMs / 1000).toFixed(1).replace('.', ',')} с`;
  const title = [
    'Частота автоматического опроса. Крайнее левое положение — только вручную.',
    cycleText && `Полный круг по всем целям занял ${cycleText}.`,
    tooTight && 'Круг длиннее интервала: медленные цели опрашиваются реже заданного.',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <label className="flex shrink-0 items-center gap-2" title={title}>
      <span className="text-muted text-[11px]">Опрос</span>
      <input
        type="range"
        min={0}
        max={POLL_STEPS.length - 1}
        step={1}
        value={index}
        onChange={(e) => onChange(POLL_STEPS[Number(e.target.value)]!)}
        list="poll-steps"
        className={`w-40 ${tooTight ? 'accent-warn' : 'accent-good'}`}
        aria-label="Частота опроса"
      />
      <datalist id="poll-steps">
        {POLL_STEPS.map((_, i) => (
          <option key={i} value={i} />
        ))}
      </datalist>
      {/* Fixed width so the controls to the right do not shuffle as the label
          changes between "0,1 с" and "1 мин 30 с". */}
      <span
        className={`w-20 shrink-0 font-mono text-xs ${tooTight ? 'text-warn' : 'text-slate-200'}`}
      >
        {formatInterval(intervalSec)}
      </span>
      {tooTight && (
        // Amber alone would only say "unusual"; name the actual consequence.
        <span className="text-warn max-w-56 truncate text-[11px]">круг {cycleText} — медленные реже</span>
      )}
    </label>
  );
}

function SettingsPanel({
  settings,
  onChange,
}: {
  settings: import('../shared/types.ts').Settings;
  onChange: (p: Partial<import('../shared/types.ts').Settings>) => void;
}) {
  return (
    <div className="border-ink-800 bg-ink-900 flex flex-wrap items-end gap-5 border-b px-4 py-3 text-xs">
      {/* Frequency lives in the header: it is adjusted far more often than
          anything here, and it needs to be visible while watching results. */}
      <Field label="Параллельно">
        <input
          type="number"
          min={1}
          max={128}
          value={settings.concurrency}
          onChange={(e) => onChange({ concurrency: Number(e.target.value) })}
          className="border-ink-700 bg-ink-950 w-20 rounded border px-2 py-1 font-mono text-slate-200 outline-none"
        />
      </Field>
      <Field label="Таймаут, мс">
        <input
          type="number"
          min={500}
          step={500}
          value={settings.timeoutMs}
          onChange={(e) => onChange({ timeoutMs: Number(e.target.value) })}
          className="border-ink-700 bg-ink-950 w-24 rounded border px-2 py-1 font-mono text-slate-200 outline-none"
        />
      </Field>
      <Field label="Эталонный DoH-резолвер">
        <input
          value={settings.dohUrl}
          onChange={(e) => onChange({ dohUrl: e.target.value })}
          className="border-ink-700 bg-ink-950 w-72 rounded border px-2 py-1 font-mono text-slate-200 outline-none"
        />
      </Field>
      <Field label="Уведомления о смене статуса">
        <select
          value={settings.notify}
          onChange={(e) => onChange({ notify: e.target.value as import('../shared/types.ts').NotifyMode })}
          className="border-ink-700 bg-ink-950 rounded border px-2 py-1 text-slate-200 outline-none"
        >
          <option value="bad">только о проблемах</option>
          <option value="both">о проблемах и восстановлении</option>
          <option value="off">выключены</option>
        </select>
      </Field>
      {/* Only a default: each target carries its own selection, so changing
          this does not silently alter what already-added targets measure. */}
      <Field label="Слои для новых ресурсов">
        <LayerPicker value={settings.layers} onChange={(l) => onChange({ layers: l })} />
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted text-[10px] uppercase tracking-wide">{label}</span>
      {children}
    </label>
  );
}
