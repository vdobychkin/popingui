/**
 * Checks the polling-frequency slider's data model: step ordering, labels, and
 * the mapping of an arbitrary stored value onto the nearest step.
 *
 *   npx tsx scripts/check-interval.ts
 */
import { MIN_INTERVAL_SEC, POLL_STEPS, formatInterval, nearestPollStep } from '../shared/types.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('шаги ползунка:');
console.log(
  '  ' + POLL_STEPS.map((s, i) => `${i}:${formatInterval(s)}`).join('  '),
);

console.log('\nпроверки:');
check('первый шаг — ручной режим', POLL_STEPS[0] === 0, formatInterval(POLL_STEPS[0]!));
check(
  'шаги строго возрастают',
  POLL_STEPS.every((s, i) => i === 0 || s > POLL_STEPS[i - 1]!),
);
check(
  'нижняя граница — 0,1 с',
  POLL_STEPS[1] === MIN_INTERVAL_SEC,
  formatInterval(POLL_STEPS[1]!),
);
check('верхняя граница — 10 минут', POLL_STEPS.at(-1) === 600, formatInterval(POLL_STEPS.at(-1)!));
check(
  'есть субсекундные шаги',
  POLL_STEPS.filter((s) => s > 0 && s < 1).length >= 3,
  `${POLL_STEPS.filter((s) => s > 0 && s < 1).length} шт.`,
);
check(
  'мелкий шаг там, где он нужен',
  POLL_STEPS.filter((s) => s > 0 && s <= 60).length >= 10,
  `${POLL_STEPS.filter((s) => s > 0 && s <= 60).length} шагов до минуты`,
);

const labels: [number, string][] = [
  [0, 'вручную'],
  [0.1, '0,1 с'],
  [0.5, '0,5 с'],
  [10, '10 с'],
  [60, '1 мин'],
  [90, '1 мин 30 с'],
  [600, '10 мин'],
  // Values only reachable from settings written by an older build.
  [3600, '1 ч'],
  [86400, '1 сут'],
];
for (const [sec, want] of labels) {
  check(`подпись ${sec} с`, formatInterval(sec) === want, `«${formatInterval(sec)}», ожидалось «${want}»`);
}

// Values saved by older versions, or typed by hand into the API, are not
// required to sit exactly on a step — the slider still has to show something.
const snapped: [number, number][] = [
  [0, 0],
  [0.12, 0.1],
  [12, 10],
  [61, 60],
  // Legacy settings from before the range was narrowed must still land on a
  // real step rather than leaving the slider blank.
  [3600, 600],
  [100000, 600],
];
for (const [stored, want] of snapped) {
  const got = POLL_STEPS[nearestPollStep(stored)]!;
  check(`${stored} с ложится на ${formatInterval(want)}`, got === want, `получилось ${formatInterval(got)}`);
}

check(
  'каждый шаг отображается сам в себя',
  POLL_STEPS.every((s, i) => nearestPollStep(s) === i),
);

console.log(failures ? `\nПРОВАЛОВ: ${failures}` : '\nвсе проверки пройдены');
process.exit(failures ? 1 : 0);
