// Must come first: it sizes the libuv thread pool that DNS lookups run on.
import '../server/threadpool.ts';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, nativeImage, shell } from 'electron';
import { VERDICT_META, type Transition } from '../shared/types.ts';
import { Monitor, toCsv } from '../server/app.ts';
import { buildTrayMenu, trayTooltip, type TrayActions } from './tray-menu.ts';

const DEV = !app.isPackaged;
const SMOKE = process.env.POPINGUI_SMOKE === '1' || process.argv.includes('--smoke');
const SCREENSHOT_PATH = process.env.POPINGUI_SCREENSHOT;
const VITE_URL = 'http://127.0.0.1:5273';

// esbuild emits CommonJS to build/main.cjs, so __dirname is the build folder
// during development and inside the asar when packaged.
const ROOT = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
const ICONS = app.isPackaged ? path.join(ROOT, 'icons') : path.join(ROOT, 'build', 'icons');
const DIST = path.join(ROOT, 'dist');

/** Diagnostics go to userData: a packaged app has no writable build folder. */
const reportPath = () => path.join(app.getPath('userData'), 'smoke.json');

let monitor: Monitor;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let currentTone = '';

// A second launch should surface the running instance, not start a rival
// server on another port.
if (!app.requestSingleInstanceLock()) {
  // The self-check must never exit silently: "no report" would be
  // indistinguishable from a crash, and the usual reason for landing here is
  // simply that the user already has the app open.
  if (SMOKE) {
    try {
      writeFileSync(
        reportPath(),
        JSON.stringify({ ok: false, reason: 'уже запущен другой экземпляр', ran: false }, null, 2),
        'utf8',
      );
    } catch {
      /* best effort */
    }
  }
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  // A failure in here would otherwise leave a process with no window and no
  // tray icon — invisible and unkillable from the UI.
  main().catch((e: unknown) => {
    const message = e instanceof Error ? e.stack ?? e.message : String(e);
    try {
      writeFileSync(reportPath(), JSON.stringify({ ok: false, message }), 'utf8');
    } catch {
      /* best effort */
    }
    dialog.showErrorBox('popingui не смог запуститься', message);
    app.exit(1);
  });
}

async function main(): Promise<void> {
  await app.whenReady();
  // Windows ties toasts to this id and to a Start-menu shortcut carrying it;
  // it must match the installer's appId or notifications never appear.
  app.setAppUserModelId('dev.popingui.app');

  monitor = await startMonitor();
  createWindow(await uiUrl());
  createTray();

  monitor.on('update', scheduleTrayRefresh);
  monitor.on('transitions', notifyTransitions);

  app.on('window-all-closed', () => {
    // Deliberately empty: closing the window leaves the app in the tray.
  });
  app.on('before-quit', () => {
    quitting = true;
  });

  if (SMOKE) runSmokeTest();
  if (SCREENSHOT_PATH) runScreenshot(SCREENSHOT_PATH);
}

/** Captures the real packaged UI for release documentation. */
function runScreenshot(output: string): void {
  setTimeout(() => {
    void win?.webContents.capturePage().then((image) => {
      writeFileSync(output, image.toPNG());
      quitting = true;
      void monitor.stop().finally(() => app.exit(0));
    });
  }, 8000);
}

/**
 * Headless self-check for CI and for this machine, where a GUI process cannot
 * print to the parent console: everything lands in build/smoke.json instead.
 */
function runSmokeTest(): void {
  setTimeout(() => {
    const report = {
      ok: true,
      url: monitor.url,
      tray: tray !== null && !tray.isDestroyed(),
      window: win !== null,
      windowUrl: win?.webContents.getURL() ?? null,
      trayMenuItems: Menu.buildFromTemplate(buildMenu()).items.length,
      packaged: app.isPackaged,
      notifications: Notification.isSupported(),
      iconsDir: ICONS,
      summary: monitor.summary(),
    };
    writeFileSync(reportPath(), JSON.stringify(report, null, 2), 'utf8');
    quitting = true;
    void monitor.stop().finally(() => app.exit(0));
  }, 8000);
}

/** Ports can be taken; walk a small range before giving up. */
async function startMonitor(): Promise<Monitor> {
  let lastError: unknown;
  for (let port = 8787; port < 8797; port++) {
    const m = new Monitor({
      port,
      dataDir: path.join(app.getPath('userData'), 'data'),
      // Always serve the built UI: in development it is the fallback for when
      // the Vite dev server is not running.
      distDir: DIST,
      sweepOnStart: true,
    });
    try {
      await m.start();
      return m;
    } catch (e) {
      lastError = e;
      await m.stop().catch(() => {});
    }
  }
  throw new Error(`Не удалось занять порт для локального сервера: ${String(lastError)}`);
}

// ------------------------------------------------------------------ window

/**
 * Prefer the Vite dev server when it is actually up — `npm run app` starts it —
 * and otherwise fall back to the bundled UI so a bare `electron .` still works.
 */
async function uiUrl(): Promise<string> {
  if (!DEV) return monitor.url;
  try {
    await fetch(VITE_URL, { signal: AbortSignal.timeout(500) });
    return VITE_URL;
  } catch {
    return monitor.url;
  }
}

function createWindow(url: string = monitor.url): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 480,
    show: false,
    backgroundColor: '#0a0c10',
    icon: path.join(ICONS, 'app.ico'),
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  void win.loadURL(url);
  win.once('ready-to-show', () => {
    if (!SMOKE && !process.argv.includes('--hidden')) win?.show();
  });

  // Close means "get out of the way", not "stop monitoring".
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
  });
  win.on('closed', () => {
    win = null;
  });

  // External links belong in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow(targetId?: string): void {
  if (!win) createWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (targetId) {
    // The UI reads this on load and on hash change to open the detail drawer.
    // The nonce makes re-selecting the same target fire hashchange again.
    void win.webContents.executeJavaScript(
      `location.hash = ${JSON.stringify(`#target=${targetId}&t=${Date.now()}`)}; void 0;`,
    );
  }
}

// ----------------------------------------------------------- notifications

/**
 * One notification per sweep, never one per target: a filtered network flips
 * many resources at once and a burst of toasts would be unreadable.
 */
function notifyTransitions(all: Transition[]): void {
  const mode = monitor.settings().notify;
  if (mode === 'off' || !Notification.isSupported()) return;

  const shown = mode === 'bad' ? all.filter((t) => t.worse) : all;
  if (!shown.length) return;

  const broke = shown.filter((t) => t.worse);
  const healed = shown.filter((t) => !t.worse);
  const name = (t: Transition) => `${t.host}${t.port === 443 ? '' : `:${t.port}`}`;

  let title: string;
  let body: string;
  if (shown.length === 1) {
    const t = shown[0]!;
    title = t.worse ? `Недоступен: ${name(t)}` : `Снова доступен: ${name(t)}`;
    body = `${VERDICT_META[t.from].label} → ${VERDICT_META[t.to].label}`;
  } else {
    const parts: string[] = [];
    if (broke.length) parts.push(`${broke.length} недоступно`);
    if (healed.length) parts.push(`${healed.length} восстановлено`);
    title = `popingui: ${parts.join(', ')}`;
    body = shown.slice(0, 6).map((t) => `${t.worse ? '✖' : '✔'} ${name(t)}`).join('\n');
    if (shown.length > 6) body += `\n…и ещё ${shown.length - 6}`;
  }

  const note = new Notification({ title, body, icon: path.join(ICONS, 'app.png'), silent: false });
  note.on('click', () => showWindow(shown.length === 1 ? shown[0]!.targetId : undefined));
  note.show();
}

// -------------------------------------------------------------------- tray

function trayIcon(tone: string): Electron.NativeImage {
  const img = nativeImage.createFromPath(path.join(ICONS, `tray-${tone}.png`));
  const hidpi = nativeImage.createFromPath(path.join(ICONS, `tray-${tone}@2x.png`));
  if (!hidpi.isEmpty()) img.addRepresentation({ scaleFactor: 2, buffer: hidpi.toPNG() });
  return img;
}

function createTray(): void {
  tray = new Tray(trayIcon('idle'));
  tray.setToolTip('popingui');
  tray.on('click', () => (win?.isVisible() ? win.hide() : showWindow()));
  tray.on('double-click', () => showWindow());
  refreshTray();
}

const actions: TrayActions = {
  open: (targetId) => showWindow(targetId),
  recheck: (targetId) => void monitor.sweep(targetId ? [targetId] : undefined),
  stopSweep: () => monitor.stopSweep(),
  copyReport: () => clipboard.writeText(toCsv(monitor.states())),
  toggleAutostart: () => {
    const next = !app.getLoginItemSettings().openAtLogin;
    app.setLoginItemSettings({ openAtLogin: next, args: ['--hidden'] });
    refreshTray();
  },
  quit: () => {
    quitting = true;
    void monitor.stop().finally(() => app.quit());
  },
};

function buildMenu() {
  return buildTrayMenu(
    monitor.states(),
    monitor.summary(),
    {
      autostart: app.getLoginItemSettings().openAtLogin,
      intervalSec: monitor.settings().intervalSec,
      route: monitor.states().find((s) => s.last)?.last?.route,
    },
    actions,
  );
}

let refreshTimer: NodeJS.Timeout | null = null;
/**
 * A sweep fires one update per target; rebuilding the whole menu each time
 * would be wasteful and makes the menu flicker while it is open.
 */
function scheduleTrayRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshTray();
  }, 400);
}

function refreshTray(): void {
  if (!tray || tray.isDestroyed()) return;
  const summary = monitor.summary();
  if (summary.tone !== currentTone) {
    currentTone = summary.tone;
    tray.setImage(trayIcon(summary.tone));
  }
  tray.setToolTip(trayTooltip(summary));
  tray.setContextMenu(Menu.buildFromTemplate(buildMenu()));
}
