/**
 * Checks the certificate-expiry verdicts and the per-target expected-text
 * assertion against local HTTPS servers presenting real certificates.
 *
 * Certificates are generated on the fly with openssl, including a genuinely
 * expired one (signed via `openssl ca`, the only way to backdate on
 * OpenSSL 3.2). Requires openssl on PATH; skips with a clear message otherwise.
 *
 *   npx tsx scripts/check-cert-and-expect.ts
 */
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ALL_LAYERS } from '../shared/types.ts';
import { probe } from '../server/probe.ts';
import type { Settings, Target } from '../shared/types.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const dir = mkdtempSync(path.join(tmpdir(), 'popingui-certs-'));
const at = (f: string) => path.join(dir, f);
const openssl = (args: string[]) =>
  execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });

try {
  openssl(['version']);
} catch {
  console.log('openssl не найден — проверка сертификатов пропущена');
  process.exit(0);
}

const SAN = 'subjectAltName=DNS:localhost,IP:127.0.0.1';

function selfSigned(name: string, days: number): void {
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', at(`${name}.key`), '-out', at(`${name}.pem`),
    '-subj', '/CN=localhost', '-addext', SAN, '-days', String(days),
  ]);
}

/** Backdated certificate: `openssl ca` is the only path that accepts dates. */
function expiredCert(): void {
  const caDir = at('ca');
  mkdirSync(path.join(caDir, 'newcerts'), { recursive: true });
  writeFileSync(path.join(caDir, 'index.txt'), '');
  writeFileSync(path.join(caDir, 'serial'), '1000\n');
  writeFileSync(
    path.join(caDir, 'openssl.cnf'),
    [
      '[ ca ]', 'default_ca = CA_default', '[ CA_default ]',
      `database = ${path.join(caDir, 'index.txt').replaceAll('\\', '/')}`,
      `new_certs_dir = ${path.join(caDir, 'newcerts').replaceAll('\\', '/')}`,
      `serial = ${path.join(caDir, 'serial').replaceAll('\\', '/')}`,
      `certificate = ${path.join(caDir, 'ca.pem').replaceAll('\\', '/')}`,
      `private_key = ${path.join(caDir, 'ca.key').replaceAll('\\', '/')}`,
      'default_md = sha256', 'policy = policy_any', 'email_in_dn = no',
      'rand_serial = no', 'unique_subject = no', 'copy_extensions = copy',
      '[ policy_any ]', 'commonName = supplied', '',
    ].join('\n'),
  );
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(caDir, 'ca.key'), '-out', path.join(caDir, 'ca.pem'),
    '-subj', '/CN=popingui Test CA', '-days', '3650',
  ]);
  openssl([
    'req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', at('expired.key'), '-out', at('expired.csr'),
    '-subj', '/CN=localhost', '-addext', SAN,
  ]);
  openssl([
    'ca', '-batch', '-config', path.join(caDir, 'openssl.cnf'),
    '-in', at('expired.csr'), '-out', at('expired.pem'),
    '-startdate', '240101000000Z', '-enddate', '240201000000Z', '-notext',
  ]);
}

selfSigned('good', 400);
selfSigned('soon', 5);
expiredCert();

const BODY = '<html><head><title>Витрина</title></head><body>Каталог товаров</body></html>';

const settings: Settings = {
  intervalSec: 0,
  concurrency: 4,
  timeoutMs: 4000,
  dohUrl: 'https://cloudflare-dns.com/dns-query',
  // HTTP stays off: these servers sit on random ports the HTTP layer would
  // skip anyway, and the certificate verdicts are what is under test.
  layers: { dns: true, ping: false, tcp: true, tls: true, http: false, udp: false },
  proxies: [],
  activeProxyId: null,
  notify: 'bad',
};

const target = (port: number, expect = ''): Target => ({
  id: randomUUID(),
  host: '127.0.0.1',
  port,
  note: '',
  enabled: true,
  layers: { ...ALL_LAYERS },
  group: '',
  expect,
});

/**
 * The TLS and HTTP layers only run on ports they recognise, so the test
 * servers bind those exact ports rather than an ephemeral one.
 */
async function serveOn(name: string, port: number): Promise<{ close: () => void } | null> {
  const server = https.createServer(
    { key: readFileSync(at(`${name}.key`)), cert: readFileSync(at(`${name}.pem`)) },
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(BODY);
    },
  );
  const ok = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => resolve(true));
  });
  return ok ? { close: () => server.close() } : null;
}

console.log('сертификаты:');
const cases: { name: string; port: number; expectVerdict: string }[] = [
  { name: 'good', port: 8443, expectVerdict: 'ok' },
  { name: 'soon', port: 9443, expectVerdict: 'tls-expiring' },
  { name: 'expired', port: 4443, expectVerdict: 'tls-expired' },
];

for (const c of cases) {
  const srv = await serveOn(c.name, c.port);
  if (!srv) {
    console.log(`  · порт ${c.port} занят, случай «${c.name}» пропущен`);
    continue;
  }
  const r = await probe(target(c.port), settings);
  const tls = r.layers.find((l) => l.layer === 'tls');
  check(`${c.name}: вердикт ${c.expectVerdict}`, r.verdict === c.expectVerdict, `${r.verdict} · ${tls?.detail ?? ''}`);
  if (c.name !== 'expired') {
    const days = tls?.extra?.['дней до истечения'];
    check(`${c.name}: срок посчитан`, typeof days === 'number' && days > 0, `дней: ${String(days)}`);
  }
  srv.close();
}

console.log('\nожидаемый текст:');
const httpSettings: Settings = { ...settings, layers: { ...settings.layers, http: true, tls: false } };
// 8443 is in the HTTP layer's port list, so reuse it for the content checks.
const httpSrv = await serveOn('good', 8443);
if (!httpSrv) {
  console.log('  · порт 8443 занят, проверки текста пропущены');
} else {
  const present = await probe(target(8443, 'Каталог товаров'), httpSettings);
  check('текст на месте — доступен', present.verdict === 'ok', `${present.verdict}`);
  check(
    'подтверждение в описании слоя',
    present.layers.find((l) => l.layer === 'http')?.detail.includes('ожидаемый текст на месте') ?? false,
    present.layers.find((l) => l.layer === 'http')?.detail ?? '',
  );

  const missing = await probe(target(8443, 'Личный кабинет'), httpSettings);
  check('текста нет — content-mismatch', missing.verdict === 'content-mismatch', missing.verdict);
  check('в summary назван искомый текст', missing.summary.includes('Личный кабинет'), missing.summary);

  const off = await probe(target(8443, ''), httpSettings);
  check('пустое поле не мешает', off.verdict === 'ok', off.verdict);
  httpSrv.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\nПРОВАЛОВ: ${failures}` : '\nвсе проверки пройдены');
process.exit(failures ? 1 : 0);
