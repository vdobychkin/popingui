import type { MenuItemConstructorOptions } from 'electron';
import { DIRECT_ROUTE, VERDICT_META, formatInterval, type TargetState } from '../shared/types.ts';
import type { Summary } from '../server/app.ts';

const DOT: Record<string, string> = { good: '●', warn: '▲', bad: '✖', idle: '○' };

/** Menu labels have no wrapping, so long summaries are folded by hand. */
function wrap(text: string, width = 58): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

function ago(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec} с назад`;
  if (sec < 3600) return `${Math.round(sec / 60)} мин назад`;
  return new Date(ts).toLocaleTimeString();
}

export interface TrayActions {
  open: (targetId?: string) => void;
  recheck: (targetId?: string) => void;
  stopSweep: () => void;
  copyReport: () => void;
  toggleAutostart: () => void;
  quit: () => void;
}

/** Per-target submenu: the verdict, why, and every layer that produced it. */
function targetSubmenu(state: TargetState, actions: TrayActions): MenuItemConstructorOptions[] {
  const last = state.last;
  const items: MenuItemConstructorOptions[] = [];

  if (!last) {
    items.push({ label: 'Ещё не проверялся', enabled: false });
  } else {
    for (const line of wrap(last.summary)) items.push({ label: line, enabled: false });
    items.push({ type: 'separator' });
    for (const l of last.layers) {
      const mark = l.status === 'ok' ? '✔' : l.status === 'fail' ? '✖' : l.status === 'warn' ? '▲' : '·';
      const ms = l.ms != null ? `  ${l.ms} мс` : '';
      items.push({ label: `${mark} ${l.layer.toUpperCase()}: ${l.detail}${ms}`, enabled: false });
    }
    items.push({ type: 'separator' });
    if (last.address) items.push({ label: `адрес: ${last.address}`, enabled: false });
    items.push({ label: `задержка: ${last.latency != null ? `${last.latency} мс` : '—'}`, enabled: false });
    items.push({
      label: `аптайм: ${state.history.length ? `${Math.round(state.uptime * 100)}% за ${state.history.length} проб` : '—'}`,
      enabled: false,
    });
    items.push({ label: `проверено: ${ago(last.ts)}`, enabled: false });
  }

  items.push({ type: 'separator' });
  items.push({ label: 'Показать в окне', click: () => actions.open(state.target.id) });
  items.push({ label: 'Перепроверить', click: () => actions.recheck(state.target.id) });
  return items;
}

function targetLabel(state: TargetState): string {
  const meta = VERDICT_META[state.last?.verdict ?? 'pending'];
  const port = state.target.port === 443 ? '' : `:${state.target.port}`;
  const ms = state.last?.latency != null ? `  ${state.last.latency} мс` : '';
  return `${DOT[meta.tone]}  ${state.target.host}${port} — ${meta.label}${ms}`;
}

export function buildTrayMenu(
  states: TargetState[],
  summary: Summary,
  opts: { autostart: boolean; intervalSec: number; route?: string },
  actions: TrayActions,
): MenuItemConstructorOptions[] {
  const problems = states
    .filter((s) => {
      const tone = VERDICT_META[s.last?.verdict ?? 'pending'].tone;
      return tone === 'bad' || tone === 'warn';
    })
    .sort((a, b) => a.target.host.localeCompare(b.target.host));

  const byHost = [...states].sort((a, b) => a.target.host.localeCompare(b.target.host));

  const menu: MenuItemConstructorOptions[] = [
    {
      // Each count carries its own marker: a single worst-case glyph next to
      // "2 норма" would read as if everything were down.
      label: summary.total
        ? `${DOT.good} ${summary.good} норма   ${DOT.warn} ${summary.warn} странно   ${DOT.bad} ${summary.bad} блок`
        : 'Список ресурсов пуст',
      enabled: false,
    },
    {
      label: summary.running
        ? 'Идёт проверка…'
        : summary.lastSweepAt
          ? `Обновлено ${ago(summary.lastSweepAt)}${opts.intervalSec ? ` · каждые ${formatInterval(opts.intervalSec)}` : ' · вручную'}`
          : 'Ещё не проверялось',
      enabled: false,
    },
  ];

  // Only worth a line when it is not the default: readings taken through a
  // proxy say nothing about what this network can reach on its own.
  if (opts.route && opts.route !== DIRECT_ROUTE) {
    menu.push({ label: `Маршрут: ${opts.route}`, enabled: false });
  }
  menu.push({ type: 'separator' });

  if (problems.length) {
    // Problems sit at the top level: a right-click should surface what is
    // broken without any further navigation.
    for (const s of problems.slice(0, 12)) {
      menu.push({ label: targetLabel(s), submenu: targetSubmenu(s, actions) });
    }
    if (problems.length > 12) {
      menu.push({ label: `…и ещё ${problems.length - 12}`, click: () => actions.open() });
    }
  } else if (summary.total) {
    menu.push({ label: '✔  Проблем нет', enabled: false });
  }

  if (byHost.length) {
    menu.push({ type: 'separator' });
    menu.push({
      label: `Все ресурсы (${byHost.length})`,
      submenu: byHost.map((s) => ({ label: targetLabel(s), submenu: targetSubmenu(s, actions) })),
    });
  }

  menu.push(
    { type: 'separator' },
    summary.running
      ? { label: 'Остановить проверку', click: () => actions.stopSweep() }
      : { label: 'Проверить всё', click: () => actions.recheck() },
    { label: 'Открыть окно', click: () => actions.open() },
    { label: 'Скопировать отчёт (CSV)', click: () => actions.copyReport() },
    { type: 'separator' },
    { label: 'Запускать при входе в систему', type: 'checkbox', checked: opts.autostart, click: () => actions.toggleAutostart() },
    { label: 'Выход', click: () => actions.quit() },
  );

  return menu;
}

export function trayTooltip(summary: Summary): string {
  if (!summary.total) return 'popingui — список пуст';
  const parts = [`${summary.good} норма`];
  if (summary.warn) parts.push(`${summary.warn} странно`);
  if (summary.bad) parts.push(`${summary.bad} блок`);
  return `popingui — ${parts.join(' · ')}`;
}
