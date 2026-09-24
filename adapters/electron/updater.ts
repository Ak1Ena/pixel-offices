/**
 * Update checking, wired thin around the decision logic:
 * - Windows/Linux: `electron-updater` against the GitHub release feed
 *   declared in `electron-builder.yml`'s `publish` block. Downloads happen
 *   in the background; installing never happens without the user saying so
 *   (the office may be mid-turn with live agents).
 * - macOS: no `electron-updater` at all -- Squirrel.Mac needs a signed app
 *   and ours is ad-hoc only. Instead `updateCheck.ts` asks GitHub directly
 *   and this just renders a small banner window with the release link and
 *   the manual install command (`scripts/install-macos.sh`); nothing is
 *   downloaded or replaced from inside the app.
 *
 * Both paths tolerate every failure silently: a broken or offline update
 * check must never block startup or put an error dialog in front of the
 * user.
 */

import { app, BrowserWindow, dialog, shell } from 'electron';

import { evaluateLatestRelease, fetchLatestRelease, type UpdateAvailable } from './updateCheck.js';

/** Checked once at startup, then on this interval. */
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

const INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/Ak1Ena/pixel-offices/main/scripts/install-macos.sh | bash';
const RELEASES_PAGE_URL = 'https://github.com/Ak1Ena/pixel-offices/releases';

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

function macBannerHtml(update: UpdateAvailable): string {
  const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Update available</title></head>
<body style="margin:0;padding:20px;background:#1e1e2e;color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
  <p style="margin:0 0 8px;font-size:15px;">Pixel Office ${escape(update.version)} is available.</p>
  <p style="margin:0 0 12px;">
    <a href="${escape(update.url)}" style="color:#8ab4ff;">See what's new</a>
  </p>
  <p style="margin:0 0 6px;font-size:12px;opacity:0.8;">Install it from the terminal:</p>
  <code id="cmd" style="display:block;padding:8px;background:#2a2a3a;border:1px solid #3a3a4a;word-break:break-all;font-size:12px;">${escape(INSTALL_COMMAND)}</code>
  <button id="copy" style="margin-top:10px;padding:6px 14px;">Copy command</button>
  <script>
    document.getElementById('copy').addEventListener('click', () => {
      navigator.clipboard.writeText(${JSON.stringify(INSTALL_COMMAND)}).catch(() => {});
    });
  </script>
</body></html>`;
}

function showMacBanner(update: UpdateAvailable, parent: BrowserWindow | null): void {
  macBannerWindow?.close();
  const win = new BrowserWindow({
    width: 440,
    height: 200,
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
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
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
