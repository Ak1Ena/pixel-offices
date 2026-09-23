/**
 * Auto-update from GitHub Releases (electron-updater, feed = the `publish`
 * block in electron-builder.yml). Checks at startup and every
 * ELECTRON_UPDATE_CHECK_INTERVAL_MS, downloads in the background, installs on
 * quit — and offers a restart as soon as a download is ready.
 *
 * Only packaged builds update: a dev run has no installed app to replace.
 * macOS installs updates only for a signed app; an unsigned build logs the
 * failure and keeps running the current version.
 */
import { app, type BrowserWindow, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';

import { ELECTRON_UPDATE_CHECK_INTERVAL_MS } from './constants.js';

export function startAutoUpdates(
  getWindow: () => BrowserWindow | null,
  /** Stop the office server first, so the installer never kills it mid-write. */
  beforeInstall: () => Promise<void>,
): void {
  if (!app.isPackaged) {
    console.log('[Updater] dev run, update checks off');
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  let prompted = false;
  autoUpdater.on('update-available', (info) => {
    console.log(`[Updater] downloading ${info.version}`);
  });
  autoUpdater.on('update-downloaded', (info) => {
    // One prompt per run; "Later" still installs when the app quits.
    if (prompted) return;
    prompted = true;
    const options = {
      type: 'info' as const,
      title: 'Update ready',
      message: `Pixel Office ${info.version} is ready to install.`,
      detail: 'Restart now to use it, or it installs the next time you quit.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    };
    const win = getWindow();
    const answer = win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
    void answer.then(({ response }) => {
      if (response === 0) void beforeInstall().then(() => autoUpdater.quitAndInstall());
    });
  });
  autoUpdater.on('error', (err) => {
    console.error(`[Updater] ${err instanceof Error ? err.message : String(err)}`);
  });

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      console.error(`[Updater] check failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  check();
  setInterval(check, ELECTRON_UPDATE_CHECK_INTERVAL_MS).unref();
}
