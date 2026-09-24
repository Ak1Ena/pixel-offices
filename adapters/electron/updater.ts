/**
 * Update checking, wired thin around the decision logic:
 * - Windows/Linux: `electron-updater` against the GitHub release feed
 *   declared in `electron-builder.yml`'s `publish` block. Downloads happen
 *   in the background; installing never happens without the user saying so
 *   (the office may be mid-turn with live agents).
 * - macOS: no `electron-updater` at all -- Squirrel.Mac needs a signed app
 *   and ours is ad-hoc only. Instead `updateCheck.ts` asks GitHub directly
 *   and this renders a small banner window with the release link and one
 *   Install button. The button runs the SAME published installer the README
 *   documents (`scripts/install-macos.sh`, https + SHA-256 verified inside
 *   the script) with `PIXEL_OFFICE_KEEP_RUNNING=1`, so the office is never
 *   quit from under live agents: the download and the swap happen while the
 *   user keeps working, and a dialog then offers to reopen. The child is
 *   detached so quitting mid-install cannot leave a half-installed app.
 *
 * Both paths tolerate every failure silently: a broken or offline update
 * check must never block startup or put an error dialog in front of the
 * user.
 */

import { spawn } from 'node:child_process';

import { app, BrowserWindow, dialog, shell } from 'electron';

import { evaluateLatestRelease, fetchLatestRelease, type UpdateAvailable } from './updateCheck.js';

/** Checked once at startup, then on this interval. */
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

const INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/Ak1Ena/pixel-offices/main/scripts/install-macos.sh | bash';
const RELEASES_PAGE_URL = 'https://github.com/Ak1Ena/pixel-offices/releases';
/** The banner has no preload and no IPC channel (it is a `data:` URL). Its
 *  button calls `window.open` on this URL, which always reaches the window's
 *  open handler; progress goes back the other way through
 *  `executeJavaScript`. */
export const INSTALL_TRIGGER_URL = 'pixel-install://start';

// ── Windows / Linux: electron-updater ───────────────────────────

/** Deferred import: electron-updater is marked external in esbuild.js and
 *  only ever runs on Windows/Linux, so a macOS build never even loads it. */
async function setupNativeUpdater(getMainWindow: () => BrowserWindow | null): Promise<void> {
  const { autoUpdater } = await import('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false; // never restart on its own

  autoUpdater.on('error', (err) => {
    console.error('[Pixel Office] Update check failed:', err instanceof Error ? err.message : err);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Pixel Office] Update ${info.version} downloaded -- prompting to restart`);
    const win = getMainWindow();
    const opts = {
      type: 'info' as const,
      buttons: ['Restart now', 'Later'],
      defaultId: 1,
      cancelId: 1,
      title: 'Update ready',
      message: `Pixel Office ${info.version} has been downloaded.`,
      detail: 'Restart now to install it, or keep working and install it later.',
    };
    const shown = win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
    void shown.then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      console.error(
        '[Pixel Office] Update check failed:',
        err instanceof Error ? err.message : err,
      );
    });
  };
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

// ── macOS: banner only ──────────────────────────────────────────

let macBannerWindow: BrowserWindow | null = null;
let macBannerShownForVersion: string | undefined;

/** One update step to show: a `==> ` line from the installer, a download
 *  percentage, or a failure. */
export type InstallProgress = { step?: string; percent?: number; error?: string };

/**
 * The installer's output as things worth showing. `==> ` lines are its own
 * step log; the percentage comes from `curl --progress-bar` on stderr, which
 * separates its updates with carriage returns; `error:` is how the script
 * dies. Everything else (mount chatter, blank lines) is dropped.
 */
export function parseInstallOutput(chunk: string): InstallProgress[] {
  const out: InstallProgress[] = [];
  for (const raw of chunk.split(/[\r\n]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const step = /^==>\s+(.+)$/.exec(line);
    if (step) {
      out.push({ step: step[1] });
      continue;
    }
    if (line.startsWith('error:')) {
      out.push({ error: line.slice('error:'.length).trim() });
      continue;
    }
    const percent = /(\d{1,3}(?:\.\d+)?)%/.exec(line);
    if (percent) out.push({ percent: Math.max(0, Math.min(100, Number(percent[1]))) });
  }
  return out;
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The banner: the release link and ONE button. No command to copy -- the
 *  button does the install itself and this window is where its progress shows. */
export function macBannerHtml(update: UpdateAvailable): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Update available</title></head>
<body style="margin:0;padding:20px;background:#1e1e2e;color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
  <p style="margin:0 0 8px;font-size:15px;">Pixel Office ${escapeHtml(update.version)} is available.</p>
  <p style="margin:0 0 14px;">
    <a href="${escapeHtml(update.url)}" style="color:#8ab4ff;">See what's new</a>
  </p>
  <button id="install" style="padding:8px 16px;font-size:13px;">Install update</button>
  <div id="bar" style="display:none;margin-top:14px;height:10px;background:#2a2a3a;border:1px solid #3a3a4a;">
    <div id="fill" style="height:100%;width:0%;background:#8ab4ff;transition:width 0.2s;"></div>
  </div>
  <p id="status" style="margin:10px 0 0;font-size:12px;opacity:0.85;min-height:16px;"></p>
  <script>
    var button = document.getElementById('install');
    var bar = document.getElementById('bar');
    var fill = document.getElementById('fill');
    var status = document.getElementById('status');
    button.addEventListener('click', function () {
      button.disabled = true;
      bar.style.display = 'block';
      status.textContent = 'Starting the installer...';
      window.open(${JSON.stringify(INSTALL_TRIGGER_URL)});
    });
    // Called from the main process with each step (no preload, no IPC channel).
    window.pixelProgress = function (update) {
      if (typeof update.percent === 'number') {
        bar.style.display = 'block';
        fill.style.width = update.percent + '%';
      }
      if (update.step) status.textContent = update.step;
      if (update.error) {
        status.textContent = 'Update failed: ' + update.error;
        fill.style.background = '#ff8a8a';
        button.disabled = false;
      }
    };
  </script>
</body></html>`;
}

let installing = false;

function showProgress(win: BrowserWindow, update: InstallProgress): void {
  if (win.isDestroyed()) return;
  void win.webContents
    .executeJavaScript(`window.pixelProgress && window.pixelProgress(${JSON.stringify(update)})`)
    .catch(() => {});
}

/** Offer the restart once the new version is on disk. The app is still running
 *  from the bundle that was just replaced, so only a reopen makes it the new
 *  version -- but nothing was quit under the user's agents to get here. */
function offerReopen(win: BrowserWindow, version: string): void {
  const opts = {
    type: 'info' as const,
    buttons: ['Reopen now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update installed',
    message: `Pixel Office ${version} is installed.`,
    detail: 'Reopen to start using it. Your agents keep running until you do.',
  };
  const shown = win.isDestroyed() ? dialog.showMessageBox(opts) : dialog.showMessageBox(win, opts);
  void shown.then(({ response }) => {
    if (response !== 0) return;
    app.relaunch();
    app.quit();
  });
}

/**
 * Run the published installer. Detached and `unref`ed on purpose: the user may
 * quit the office while it runs, and a child that died with us could leave
 * /Applications mid-swap. `PIXEL_OFFICE_KEEP_RUNNING` tells the script not to
 * quit or relaunch us; `PIXEL_OFFICE_PROGRESS` makes its download report a
 * percentage.
 */
export function startMacInstall(win: BrowserWindow, version: string): void {
  if (installing) return;
  installing = true;
  let child;
  try {
    child = spawn('/bin/bash', ['-c', INSTALL_COMMAND], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PIXEL_OFFICE_KEEP_RUNNING: '1', PIXEL_OFFICE_PROGRESS: '1' },
    });
  } catch (err) {
    installing = false;
    showProgress(win, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  child.unref();
  let lastError = '';
  const onChunk = (buf: Buffer): void => {
    for (const update of parseInstallOutput(buf.toString())) {
      if (update.error) lastError = update.error;
      showProgress(win, update);
    }
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);
  child.on('error', (err) => {
    installing = false;
    showProgress(win, { error: err.message });
  });
  child.on('exit', (code) => {
    installing = false;
    if (code === 0) {
      showProgress(win, { percent: 100, step: 'Installed.' });
      offerReopen(win, version);
    } else {
      showProgress(win, { error: lastError || `the installer exited with code ${code}.` });
    }
  });
}

function showMacBanner(update: UpdateAvailable, parent: BrowserWindow | null): void {
  macBannerWindow?.close();
  const win = new BrowserWindow({
    width: 460,
    height: 250,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Update available',
    parent: parent ?? undefined,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  macBannerWindow = win;
  win.setMenuBarVisibility(false);
  win.on('closed', () => {
    macBannerWindow = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // The Install button's only way to reach us; checked before anything is
    // handed to the browser.
    if (url === INSTALL_TRIGGER_URL) startMacInstall(win, update.version);
    else void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url === INSTALL_TRIGGER_URL) {
      event.preventDefault();
      startMacInstall(win, update.version);
      return;
    }
    if (url.startsWith('http')) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  void win.loadURL(`data:text/html,${encodeURIComponent(macBannerHtml(update))}`);
}

async function checkMacUpdateBanner(getMainWindow: () => BrowserWindow | null): Promise<void> {
  const release = await fetchLatestRelease();
  const update = evaluateLatestRelease(release, app.getVersion());
  if (!update) return;
  if (macBannerShownForVersion === update.version && macBannerWindow) return; // already showing
  macBannerShownForVersion = update.version;
  console.log(`[Pixel Office] Update ${update.version} available -- see ${RELEASES_PAGE_URL}`);
  showMacBanner(update, getMainWindow());
}

// ── Entry point ──────────────────────────────────────────────────

/** Starts the platform-appropriate update check (once now, then on
 *  `UPDATE_CHECK_INTERVAL_MS`). Never throws, never blocks the caller. */
export function startUpdateChecks(getMainWindow: () => BrowserWindow | null): void {
  if (process.platform === 'darwin') {
    const check = (): void => {
      checkMacUpdateBanner(getMainWindow).catch((err: unknown) => {
        console.error(
          '[Pixel Office] Update check failed:',
          err instanceof Error ? err.message : err,
        );
      });
    };
    check();
    setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  } else {
    setupNativeUpdater(getMainWindow).catch((err: unknown) => {
      console.error(
        '[Pixel Office] Updater setup failed:',
        err instanceof Error ? err.message : err,
      );
    });
  }
}
