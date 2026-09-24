/**
 * Electron shell entry point: `npm run electron`.
 *
 * Wraps the same standalone office composition `server/src/cli.ts` uses
 * (`attachOrStartOffice`, in-process, `standalone` namespace) in a
 * BrowserWindow + tray icon instead of a terminal + browser tab. R2a: macOS
 * local run only -- no packaging, CI, or auto-updater yet.
 */

import { execFileSync } from 'child_process';
import { app, BrowserWindow, dialog, Menu, Tray } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ELECTRON_HEALTH_POLL_MS } from '../../server/src/constants.js';
import { recordEndedSessions } from '../../server/src/endedSessions.js';
import type {
  OfficeStartResult,
  StandaloneOfficeOptions,
} from '../../server/src/standaloneOffice.js';
import { attachOrStartOffice } from '../../server/src/standaloneOffice.js';
import { resolveProjectFolder } from './projectFolder.js';
import { ensureUsablePath, readLoginShellPath } from './widenPath.js';

/** OfficeSessions, the launcher, gitRoot.ts and slash-command probing all
 *  shell out to these -- see widenPath.ts for why a packaged, GUI-launched
 *  app can lose sight of them entirely. */
const REQUIRED_BINARIES = ['claude', 'node', 'git'] as const;

/** Clicking this (unregistered, harmless) scheme is how the "server stopped"
 *  screen asks the main process to restart -- no preload/IPC channel needed. */
const RESTART_URL = 'pixel-office://restart';

let mainWindow: BrowserWindow | null = null;

/** The office this process currently owns or has attached to. Only 'own'
 *  mode carries a runtime/server/officeSessions to dispose -- 'attach' mode
 *  never built any of that (see attachOrStartOffice). */
let current: OfficeStartResult | null = null;
let currentUrl = '';
let healthTimer: ReturnType<typeof setInterval> | null = null;
let healthMisses = 0;

/** dist/electron/main.js sits one level below dist/cli.js, so the shared
 *  dist/assets + dist/webview roots are one level up from here. */
function distRoot(): string {
  return path.join(__dirname, '..');
}

function packageRoot(): string {
  return path.join(distRoot(), '..');
}

function iconPath(): string {
  return path.join(packageRoot(), 'icon.png');
}

function officeOptions(folder: string): StandaloneOfficeOptions {
  return {
    host: '127.0.0.1',
    distRoot: distRoot(),
    packageRoot: packageRoot(),
    staticDir: path.join(distRoot(), 'webview'),
    projectDir: folder,
  };
}

function urlFor(config: { port: number; token: string }): string {
  return `http://127.0.0.1:${config.port}/?token=${config.token}`;
}

// ── Saved folder (~/Library/Application Support/Pixel Office/folder.json) ──

function folderFilePath(): string {
  return path.join(app.getPath('userData'), 'folder.json');
}

function readSavedFolder(): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(folderFilePath(), 'utf-8')) as unknown;
    const folder = (raw as { folder?: unknown } | null)?.folder;
    return typeof folder === 'string' ? folder : undefined;
  } catch {
    return undefined; // no saved folder yet
  }
}

function saveFolder(folder: string): void {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(folderFilePath(), JSON.stringify({ folder }, null, 2));
  } catch (err) {
    console.error('[Pixel Office] Failed to save chosen folder:', err);
  }
}

/** First non-flag CLI argument, if any (`electron . /path/to/project`). */
function cliFolderArg(): string | undefined {
  const argv = app.isPackaged ? process.argv.slice(1) : process.argv.slice(2);
  return argv.find((a) => !a.startsWith('-'));
}

/** Resolves undefined on cancel -- caller must quit rather than guess a folder. */
async function pickFolder(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return undefined;
  return result.filePaths[0];
}

/** CLI argument, then the saved folder, then a usable cwd, else a picker
 *  (whose pick is saved for next time). Undefined -- the picker was
 *  cancelled -- means the caller must quit, never start on a guess. */
async function resolveFolder(): Promise<string | undefined> {
  const result = resolveProjectFolder({
    cliFolder: cliFolderArg(),
    savedFolder: readSavedFolder(),
    cwd: process.cwd(),
    homeDir: os.homedir(),
    exists: fs.existsSync,
  });
  if ('folder' in result) return result.folder;
  const picked = await pickFolder();
  if (!picked) return undefined;
  saveFolder(picked);
  return picked;
}

// ── Window / tray chrome ────────────────────────────────────────

function ensureWindow(): BrowserWindow {
  if (mainWindow) return mainWindow;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: iconPath(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow.on('close', (event) => {
    // macOS: hide instead of quitting so the office keeps running in the
    // background (Dock re-activate, or tray Show, brings it back).
    if (process.platform === 'darwin') {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === RESTART_URL) {
      event.preventDefault();
      void restartOffice();
    }
  });
  return mainWindow;
}

function showOfficeWindow(): void {
  const win = ensureWindow();
  void win.loadURL(currentUrl);
  win.show();
  win.focus();
}

function stoppedScreenDataUrl(): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Pixel Office</title></head>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#1e1e2e;color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
  <div style="text-align:center;">
    <p style="font-size:16px;">Pixel Office server stopped.</p>
    <a href="${RESTART_URL}" style="display:inline-block;padding:8px 20px;background:#4a4a6a;color:#fff;border:2px solid #2a2a3a;text-decoration:none;">Restart</a>
  </div>
</body></html>`;
  return `data:text/html,${encodeURIComponent(html)}`;
}

function showStoppedScreen(): void {
  const win = ensureWindow();
  void win.loadURL(stoppedScreenDataUrl());
  win.show();
  win.focus();
}

/** Tray "Show" / Dock activate: reveal what's already there, or open the
 *  office fresh if the window doesn't exist yet. Never reloads a page that's
 *  already showing (e.g. the stopped screen) -- that's restartOffice's job. */
function revealWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  showOfficeWindow();
}

// ── Health poll (attach mode only: we don't own that server's process) ──

async function pollHealthOnce(): Promise<void> {
  if (!current || current.mode !== 'attach') return;
  try {
    const res = await fetch(`http://127.0.0.1:${current.config.port}/api/health`, {
      signal: AbortSignal.timeout(ELECTRON_HEALTH_POLL_MS),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    healthMisses = 0;
  } catch {
    healthMisses += 1;
    if (healthMisses >= 2) {
      console.log(
        '[Pixel Office] Health check failed twice -- showing the "server stopped" screen',
      );
      stopHealthPoll();
      showStoppedScreen();
    }
  }
}

function startHealthPoll(): void {
  stopHealthPoll();
  healthTimer = setInterval(() => void pollHealthOnce(), ELECTRON_HEALTH_POLL_MS);
}

function stopHealthPoll(): void {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
  healthMisses = 0;
}

// ── Office lifecycle ────────────────────────────────────────────

/** Stops everything this process OWNS (office-run agent ptys, the runtime's
 *  timers/watchers, the HTTP/WS server). No-op in attach mode: none of that
 *  was ever built here. Mirrors cli.ts's shutdown(). */
function disposeOwned(): void {
  if (current?.mode === 'own') {
    recordEndedSessions(current.ownedTranscripts());
    current.disposeOfficeSessions();
    current.runtime.dispose();
    current.server.stop();
  }
}

/**
 * Tears down whatever this process currently owns/attached to and
 * (re)composes the office via `attachOrStartOffice` -- the single path used
 * by the initial launch, the stopped-screen Restart, and "Change folder…".
 *
 * `resolveOptions` is passed straight through to `attachOrStartOffice`,
 * which only calls it when no live server was found to attach to -- so a
 * caller whose `resolveOptions` shows a folder picker (`resolveOwnOptions`,
 * below) never prompts the user on a run that ends up attaching instead.
 * Returns `'cancelled'` when that happened AND no live server existed
 * either (nothing was started); callers that need SOMETHING running (the
 * initial launch, Restart) must quit on that. "Change folder…" never sees
 * it, because its own picker already ran (and was checked) before this is
 * ever called.
 */
async function relaunchOffice(
  resolveOptions: () =>
    StandaloneOfficeOptions | undefined | Promise<StandaloneOfficeOptions | undefined>,
): Promise<'started' | 'cancelled'> {
  stopHealthPoll();
  disposeOwned();
  current = null;

  const result = await attachOrStartOffice(resolveOptions);
  if (result.mode === 'cancelled') return 'cancelled';

  current = result;
  currentUrl = urlFor(result.config);
  if (result.mode === 'attach') startHealthPoll();
  showOfficeWindow();
  return 'started';
}

/** CLI argument, then saved folder, then a usable cwd, else a picker --
 *  invoked lazily by `attachOrStartOffice` (see `relaunchOffice`), so the
 *  picker only ever shows when own-start is actually needed. */
async function resolveOwnOptions(): Promise<StandaloneOfficeOptions | undefined> {
  const folder = await resolveFolder();
  return folder ? officeOptions(folder) : undefined;
}

async function restartOffice(): Promise<void> {
  console.log('[Pixel Office] Restart requested -- re-deciding attach vs. own...');
  const outcome = await relaunchOffice(resolveOwnOptions);
  if (outcome === 'cancelled') app.quit();
}

async function changeFolder(): Promise<void> {
  const picked = await pickFolder();
  if (!picked) return; // cancel: keep the current office running, untouched
  saveFolder(picked);
  await relaunchOffice(() => officeOptions(picked));
}

// ── Menu / tray ──────────────────────────────────────────────────

function buildAppMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Pixel Office',
        submenu: [
          { label: 'Change folder…', click: () => void changeFolder() },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
    ]),
  );
}

function createTray(): void {
  const tray = new Tray(iconPath());
  tray.setToolTip('Pixel Office');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show', click: () => revealWindow() },
      { label: 'Change folder…', click: () => void changeFolder() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

/** `which <bin>` under the (possibly just-widened) PATH -- logged once at
 *  startup so a Finder/Dock launch can be verified without a debugger
 *  attached: "resolved" means OfficeSessions/the launcher/gitRoot.ts will
 *  actually find it too. */
function logResolvedBinary(bin: string): void {
  try {
    const resolved = execFileSync('/usr/bin/which', [bin], {
      encoding: 'utf-8',
      timeout: 2_000,
    }).trim();
    console.log(`[Pixel Office] Resolved ${bin} -> ${resolved || '(not found)'}`);
  } catch {
    console.log(`[Pixel Office] Resolved ${bin} -> (not found)`);
  }
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => revealWindow());

  await app.whenReady();

  // A packaged, Dock/Finder-launched app inherits launchd's minimal PATH,
  // not a terminal's -- widen it (if needed) before anything shells out.
  if (app.isPackaged) {
    ensureUsablePath({
      required: REQUIRED_BINARIES,
      env: process.env,
      getLoginShellPath: readLoginShellPath,
      log: (message) => console.log(message),
    });
  }
  for (const bin of REQUIRED_BINARIES) logResolvedBinary(bin);

  // Probe/attach happens first, inside relaunchOffice -> attachOrStartOffice;
  // resolveOwnOptions (and the folder picker it may show) only runs if that
  // probe comes up empty, so launching while another standalone server is
  // already up never prompts for a folder this process will never use.
  const outcome = await relaunchOffice(resolveOwnOptions);
  if (outcome === 'cancelled') {
    app.quit();
    return;
  }

  buildAppMenu();
  createTray();

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => revealWindow());
  app.on('before-quit', () => {
    mainWindow?.removeAllListeners('close');
    stopHealthPoll();
    disposeOwned();
  });
}

main().catch((err) => {
  console.error('[Pixel Office] Failed to start:', err);
  app.quit();
});
