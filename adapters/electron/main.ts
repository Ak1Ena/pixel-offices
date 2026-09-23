/**
 * Electron shell for the standalone office.
 *
 * The office is already a web app served by `dist/cli.js`, so this shell does
 * not import the server: it runs the CLI as a child process, waits for the
 * tokened office URL it prints, and shows that URL in a window. The child
 * keeps its own signal handling (shutdown records the sessions it ran, kills
 * its ptys) and node-pty never has to be rebuilt for Electron's ABI.
 */
import { type ChildProcess, spawn } from 'child_process';
import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions, shell } from 'electron';
import * as os from 'os';
import * as path from 'path';

import {
  ELECTRON_CHILD_STOP_TIMEOUT_MS,
  ELECTRON_SERVER_START_TIMEOUT_MS,
  ELECTRON_WINDOW_HEIGHT,
  ELECTRON_WINDOW_WIDTH,
  OFFICE_URL_PATTERN,
} from './constants.js';
import { createUpdates, type Updates } from './updater.js';

const CLI_PATH = path.join(__dirname, 'cli.js');

let server: ChildProcess | null = null;
let officeUrl: string | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

/**
 * Start `dist/cli.js`. Prefers the user's `node` (node-pty is built for it);
 * `PIXEL_OFFICE_NODE` overrides. Without one, Electron's own Node runs it —
 * the office still works, but node-pty may fail to load (read-only sessions).
 */
function startServer(useElectronNode: boolean): ChildProcess {
  const nodeBin = useElectronNode ? process.execPath : (process.env['PIXEL_OFFICE_NODE'] ?? 'node');
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (useElectronNode) env['ELECTRON_RUN_AS_NODE'] = '1';
  return spawn(nodeBin, [CLI_PATH, '--no-open'], {
    // An app started from the Dock / Start menu has cwd `/`; home is the sane project root.
    cwd: process.env['PIXEL_OFFICE_CWD'] ?? (app.isPackaged ? os.homedir() : process.cwd()),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Resolve with the office URL once the CLI prints it; reject if it dies or stalls. */
function waitForOfficeUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(
      () => reject(new Error('The office server did not start in time.')),
      ELECTRON_SERVER_START_TIMEOUT_MS,
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      buffered += text;
      const match = OFFICE_URL_PATTERN.exec(buffered);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`The office server exited (code ${code ?? 'null'}) before it was ready.`));
    });
  });
}

async function launchServer(): Promise<string> {
  const child = startServer(false);
  try {
    server = child;
    return await waitForOfficeUrl(child);
  } catch (err) {
    // No `node` on PATH (common for apps started from the Dock): fall back to Electron's.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    console.log('[Electron] node not found on PATH, running the server with Electron');
    const fallback = startServer(true);
    server = fallback;
    return await waitForOfficeUrl(fallback);
  }
}

function watchServerExit(child: ChildProcess): void {
  child.once('exit', (code) => {
    server = null;
    if (quitting) return;
    dialog.showErrorBox('Pixel Office', `The office server stopped (code ${code ?? 'null'}).`);
    app.quit();
  });
}

/** Stop the server the way a closed terminal would, then give up waiting after a timeout. */
function stopServer(): Promise<void> {
  const child = server;
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, ELECTRON_CHILD_STOP_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function isOfficeUrl(url: string): boolean {
  if (!officeUrl) return false;
  try {
    return new URL(url).origin === new URL(officeUrl).origin;
  } catch {
    return false;
  }
}

function openOutside(url: string): void {
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) void shell.openExternal(url);
}

function createWindow(url: string): void {
  const win = new BrowserWindow({
    width: ELECTRON_WINDOW_WIDTH,
    height: ELECTRON_WINDOW_HEIGHT,
    title: 'Pixel Office',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;
  win.once('ready-to-show', () => win.show());
  // Office pages (doc viewer tabs, served files) stay in the app; the rest opens in the browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isOfficeUrl(target)) return { action: 'allow' };
    openOutside(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (isOfficeUrl(target)) return;
    event.preventDefault();
    openOutside(target);
  });
  win.webContents.on('did-finish-load', () => console.log('[Electron] office loaded'));
  win.webContents.on('did-fail-load', (_event, code, description) =>
    console.error(`[Electron] office failed to load: ${description} (${code})`),
  );
  win.on('closed', () => {
    mainWindow = null;
  });
  void win.loadURL(url);
}

/** The standard menus, plus Check for Updates… (app menu on macOS, Help elsewhere). */
function installMenu(updates: Updates): void {
  const checkItem: MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    click: () => updates.check(true),
  };
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            role: 'appMenu' as const,
            submenu: [
              { role: 'about' as const },
              checkItem,
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : [{ role: 'fileMenu' as const }]),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    ...(isMac ? [] : [{ role: 'help' as const, submenu: [checkItem] }]),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function start(): Promise<void> {
  try {
    officeUrl = await launchServer();
  } catch (err) {
    dialog.showErrorBox(
      'Pixel Office',
      `Could not start the office server.\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    quitting = true;
    await stopServer();
    app.quit();
    return;
  }
  if (server) watchServerExit(server);
  createWindow(officeUrl);
  const updates = createUpdates(
    () => mainWindow,
    async () => {
      quitting = true;
      await stopServer();
    },
  );
  installMenu(updates);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(start, (err: unknown) => {
    console.error('[Electron] startup failed:', err);
    app.quit();
  });

  app.on('activate', () => {
    // macOS: clicking the Dock icon with no window open reopens the office.
    if (!mainWindow && officeUrl) createWindow(officeUrl);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    if (!server) return;
    event.preventDefault();
    void stopServer().then(() => app.quit());
  });
}
