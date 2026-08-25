/**
 * Builds the tray menu from synthetic state, prints it as a tree and checks the
 * properties a right-click depends on. No Electron, no network.
 *
 *   npx tsx scripts/check-tray-menu.ts
 */
import type { MenuItemConstructorOptions } from 'electron';
import { buildTrayMenu, trayTooltip } from '../electron/tray-menu.ts';
import type { ProbeResult, TargetState, Verdict } from '../shared/types.ts';
import type { Summary } from '../server/app.ts';
import { ALL_LAYERS } from '../shared/types.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

function state(host: string, verdict: Verdict, latency: number | null, extras: Partial<ProbeResult> = {}): TargetState {
  const last: ProbeResult = {
    targetId: host,
    ts: Date.now() - 20_000,
    verdict,
    latency,
    latencyFrom: latency === null ? null : 'tls',
    address: '93.184.216.34',
    summary: 'Системный DNS не отдаёт адрес (через DoH он есть), а на найденном адресе ещё и рвут TLS по SNI — блокировка в два слоя.',
    route: 'Рабочий SOCKS',
    layers: [
      { layer: 'dns', status: 'fail', ms: 41, detail: 'системный DNS молчит, DoH отвечает' },
      { layer: 'ping', status: 'fail', ms: 4001, detail: 'нет ответа (ICMP часто режут — не приговор)' },
      { layer: 'tcp', status: 'ok', ms: 38, detail: 'порт 443 открыт' },
      { layer: 'tls', status: 'fail', ms: 120, detail: 'ECONNRESET' },
      { layer: 'http', status: 'fail', ms: 90, detail: 'fetch failed' },
    ],
    ...extras,
  };
  return {
    target: { id: host, host, port: 443, note: '', enabled: true, group: '', expect: '', layers: { ...ALL_LAYERS } },
    last,
    history: Array.from({ length: 12 }, (_, i) => ({ ts: Date.now() - i * 60_000, verdict, latency })),
    uptime: verdict === 'ok' || verdict === 'ok-no-icmp' ? 1 : 0,
    probing: false,
    probingSince: null,
    queued: false,
  };
}

const states: TargetState[] = [
  state('rutracker.org', 'dns-hijack', null),
  state('example.com', 'ok-no-icmp', 312),
  state('cloudflare.com', 'ok-no-icmp', 288),
  state('nnmclub.to', 'tls-block', 41),
  state('internal.corp', 'http-error', 900),
];

const summary: Summary = {
  good: 2,
  warn: 1,
  bad: 2,
  idle: 0,
  total: 5,
  tone: 'bad',
  running: false,
  lastSweepAt: Date.now() - 45_000,
};

const noop = () => {};
const menu = buildTrayMenu(states, summary, { autostart: false, intervalSec: 60, route: 'Рабочий SOCKS' }, {
  open: noop,
  recheck: noop,
  stopSweep: noop,
  copyReport: noop,
  toggleAutostart: noop,
  quit: noop,
});

function print(items: MenuItemConstructorOptions[], depth = 0): void {
  for (const item of items) {
    const pad = '  '.repeat(depth);
    if (item.type === 'separator') {
      console.log(`${pad}${'─'.repeat(40)}`);
      continue;
    }
    const check = item.type === 'checkbox' ? (item.checked ? '[x] ' : '[ ] ') : '';
    const arrow = item.submenu ? ' ▸' : '';
    const dim = item.enabled === false ? '' : ' ‹click›';
    console.log(`${pad}${check}${item.label}${arrow}${dim}`);
    if (Array.isArray(item.submenu)) print(item.submenu, depth + 1);
  }
}

console.log(`tooltip: ${trayTooltip(summary)}\n`);
print(menu);

const clickable = menu.filter((i) => i.type !== 'separator' && i.enabled !== false).length;
console.log(`\nвсего пунктов: ${menu.length}, кликабельных на верхнем уровне: ${clickable}`);

// --------------------------------------------------------------- проверки

const labels = menu.map((i) => String(i.label ?? (i.type === 'separator' ? '—' : '')));
const find = (re: RegExp) => menu.find((i) => re.test(String(i.label ?? '')));
const sub = (item: MenuItemConstructorOptions | undefined) =>
  Array.isArray(item?.submenu) ? item.submenu : [];

console.log('\nсостав меню:');
check('счётчики в первой строке', /2 норма.+1 странно.+2 блок/.test(labels[0]!), labels[0]);
check('маршрут назван, раз он не прямой', Boolean(find(/^Маршрут: Рабочий SOCKS$/)));
check('видно, когда обновлялось', Boolean(find(/^Обновлено .+ каждые 1 мин$/)), labels[1]);

// Смысл трея: проблемы видны сразу, без захода в подменю.
const problems = ['rutracker.org', 'nnmclub.to', 'internal.corp'];
for (const host of problems) {
  check(`${host} — на верхнем уровне`, Boolean(find(new RegExp(`\\s${host}\\b`))));
}
check(
  'здоровые цели наверх не вынесены',
  !find(/\sexample\.com\b/) && !find(/\scloudflare\.com\b/),
);
check('и при этом доступны в «Все ресурсы»', sub(find(/^Все ресурсы \(5\)$/)).length === 5);

console.log('\nподменю цели:');
const one = sub(find(/\srutracker\.org\b/));
const oneLabels = one.map((i) => String(i.label ?? ''));
check('перечислены все пять слоёв', one.filter((i) => /^[✔✖▲·] [A-Z]+:/.test(String(i.label ?? ''))).length === 5);
// Пояснение складывается из нескольких строк: в меню нет переноса, поэтому
// длинный текст режется по словам вручную — искать его надо в склейке.
check('есть объяснение вердикта', oneLabels.join(' ').includes('блокировка в два слоя'));
check('пояснение разбито по словам, а не по буквам', oneLabels.every((l) => l.length <= 60));
check('есть аптайм', oneLabels.some((l) => l.startsWith('аптайм:')));
check('«Показать в окне» кликабельно', sub(find(/\srutracker\.org\b/)).some((i) => i.label === 'Показать в окне' && typeof i.click === 'function'));
check('«Перепроверить» кликабельно', one.some((i) => i.label === 'Перепроверить' && typeof i.click === 'function'));
check('справочные строки не кликаются', one.filter((i) => i.enabled === false).length >= 8);

console.log('\nдействия:');
check('в покое предлагается запуск', Boolean(find(/^Проверить всё$/)) && !find(/^Остановить проверку$/));
const running = buildTrayMenu(states, { ...summary, running: true }, { autostart: true, intervalSec: 60 }, {
  open: noop, recheck: noop, stopSweep: noop, copyReport: noop, toggleAutostart: noop, quit: noop,
});
const runningLabels = running.map((i) => String(i.label ?? ''));
check(
  'во время проверки — остановка',
  runningLabels.includes('Остановить проверку') && !runningLabels.includes('Проверить всё'),
);
check('идёт проверка — так и написано', runningLabels.some((l) => l === 'Идёт проверка…'));
check('маршрут «Напрямую» строкой не занимает', !runningLabels.some((l) => l.startsWith('Маршрут:')));
check(
  'автозапуск — галочка, отражающая состояние',
  running.find((i) => i.type === 'checkbox')?.checked === true &&
    menu.find((i) => i.type === 'checkbox')?.checked === false,
);
check('выход есть', Boolean(find(/^Выход$/)));

console.log('\nпустой список:');
const empty = buildTrayMenu([], { good: 0, warn: 0, bad: 0, idle: 0, total: 0, tone: 'idle', running: false, lastSweepAt: null }, { autostart: false, intervalSec: 0 }, {
  open: noop, recheck: noop, stopSweep: noop, copyReport: noop, toggleAutostart: noop, quit: noop,
});
const emptyLabels = empty.map((i) => String(i.label ?? ''));
check('сказано, что список пуст', emptyLabels.includes('Список ресурсов пуст'));
check('раздела «Все ресурсы» нет', !emptyLabels.some((l) => l.startsWith('Все ресурсы')));
check('выйти всё равно можно', emptyLabels.includes('Выход'));

console.log('\nподсказка над иконкой:');
check('перечисляет состояния', trayTooltip(summary) === 'popingui — 2 норма · 1 странно · 2 блок', trayTooltip(summary));
check(
  'нули не показываются',
  trayTooltip({ ...summary, warn: 0, bad: 0 }) === 'popingui — 2 норма',
  trayTooltip({ ...summary, warn: 0, bad: 0 }),
);
check(
  'пустой список назван прямо',
  trayTooltip({ ...summary, total: 0 }) === 'popingui — список пуст',
);

console.log(failures ? `\nПРОВАЛОВ: ${failures}` : '\nвсе проверки пройдены');
process.exit(failures ? 1 : 0);
