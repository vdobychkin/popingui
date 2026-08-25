/**
 * Прогоняет все проверки подряд и печатает сводку.
 *
 *   npm run check
 *
 * Последовательно, а не параллельно: половина скриптов занимает конкретные
 * порты (8000, 8080, 8443, 8899) и мешала бы сама себе.
 *
 * Вывод каждого скрипта показывается только при провале — при зелёном прогоне
 * это сотни строк, в которых нечего искать. Полный вывод одного скрипта всегда
 * доступен запуском его самого.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Порядок по возрастанию времени: быстрые падают первыми. */
const SCRIPTS = [
  ['check-interval', 'шаги ползунка частоты'],
  ['check-tray-menu', 'меню в трее'],
  ['check-system-proxy', 'чтение прокси из системы'],
  ['check-transitions', 'смены статуса для уведомлений'],
  ['check-proxy', 'протоколы прокси'],
  ['check-udp', 'UDP-пробы и релей SOCKS5'],
  ['check-probe-proxy', 'сквозная проба через прокси'],
  ['check-tcp-ping', 'пинг через прокси'],
  ['check-latency', 'что меряет задержка'],
  ['check-cert-and-expect', 'сертификаты и ожидаемый текст'],
  ['check-threadpool', 'пул потоков libuv'],
  ['check-scheduler', 'планировщик и параллельность'],
];

function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'scripts', `${name}.ts`)],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('error', (e) => resolve({ code: 1, out: String(e), ms: Date.now() - started }));
    child.on('exit', (code) => resolve({ code: code ?? 1, out, ms: Date.now() - started }));
  });
}

let failed = 0;
const total = Date.now();
console.log(`проверок: ${SCRIPTS.length}\n`);

for (const [name, what] of SCRIPTS) {
  process.stdout.write(`  ${name.padEnd(24)} ${what.padEnd(34)}`);
  const { code, out, ms } = await run(name);
  const secs = `${(ms / 1000).toFixed(1)} с`;
  if (code === 0) {
    console.log(`✔  ${secs}`);
  } else {
    failed++;
    console.log(`✖  ${secs}`);
    // Провалившийся скрипт печатается целиком: ради этого всё и запускалось.
    console.log(out.split('\n').map((l) => `      ${l}`).join('\n'));
  }
}

console.log(
  failed
    ? `\nПРОВАЛИЛОСЬ: ${failed} из ${SCRIPTS.length} (${((Date.now() - total) / 1000).toFixed(0)} с)`
    : `\nвсе ${SCRIPTS.length} проверок пройдены за ${((Date.now() - total) / 1000).toFixed(0)} с`,
);
process.exit(failed ? 1 : 0);
