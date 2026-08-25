/**
 * Checks how the machine's own proxy settings are read and offered as a route.
 *
 * The parsing is exercised through the environment, which is the half that can
 * be set up from here; the registry half is only reported, since this machine's
 * real settings are whatever they are.
 *
 *   npx tsx scripts/check-system-proxy.ts
 */
import { detectSystemProxies } from '../server/system-proxy.ts';
import { isSystemProxy } from '../shared/types.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const ENV_KEYS = ['ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'all_proxy', 'https_proxy', 'http_proxy'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const clearEnv = () => ENV_KEYS.forEach((k) => delete process.env[k]);

console.log('настройки этой машины:');
for (const p of await detectSystemProxies()) {
  console.log(`  ${p.label}  (${p.origin})`);
}
console.log('');

console.log('разбор переменных окружения:');
clearEnv();
process.env.ALL_PROXY = 'socks5://127.0.0.1:1080';
let found = await detectSystemProxies();
let socks = found.find((p) => p.port === 1080);
check('SOCKS5 из ALL_PROXY найден', socks !== undefined);
check('вид определён по схеме', socks?.kind === 'socks5', String(socks?.kind));
check('помечен как системный', socks !== undefined && isSystemProxy(socks), String(socks?.source));
check('источник назван', socks?.origin === 'ALL_PROXY', String(socks?.origin));
check(
  'идентификатор устойчив между запусками',
  socks?.id === 'system:socks5://127.0.0.1:1080',
  String(socks?.id),
);

clearEnv();
process.env.http_proxy = 'http://user:secret@10.0.0.9:3128';
found = await detectSystemProxies();
const http = found.find((p) => p.port === 3128);
check('строчное имя переменной тоже читается', http !== undefined, String(http?.label));
check('вид — HTTP', http?.kind === 'http', String(http?.kind));

clearEnv();
process.env.HTTPS_PROXY = 'не-адрес';
found = await detectSystemProxies();
check(
  'мусор в переменной не даёт записи',
  !found.some((p) => p.origin === 'HTTPS_PROXY'),
  `записей: ${found.length}`,
);

clearEnv();
process.env.ALL_PROXY = 'socks5://127.0.0.1:1080';
process.env.HTTPS_PROXY = 'socks5://127.0.0.1:1080';
found = await detectSystemProxies();
const dupes = found.filter((p) => p.port === 1080);
check('один адрес в двух переменных — одна запись', dupes.length === 1, `записей: ${dupes.length}`);
check(
  'названы оба источника',
  (dupes[0]?.origin ?? '').includes('ALL_PROXY') && (dupes[0]?.origin ?? '').includes('HTTPS_PROXY'),
  String(dupes[0]?.origin),
);

clearEnv();
found = await detectSystemProxies();
check(
  'без переменных остаются только системные настройки',
  found.every((p) => p.origin !== 'ALL_PROXY'),
  `записей: ${found.length}`,
);

for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
console.log(failures ? `\nПРОВАЛОВ: ${failures}` : '\nвсе проверки пройдены');
process.exit(failures ? 1 : 0);
