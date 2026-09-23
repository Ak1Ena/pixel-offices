/**
 * Update checks against GitHub Releases (electron-updater, feed = the
 * `publish` block in electron-builder.yml). Nothing happens without the
 * user's say: a check that finds a new version ASKS (Download and install /
 * Later / Skip this version), the download runs only after "Download", and the
 * install only after "Restart and install" — or on quit, if the user picked
 * "Install when I quit".
 *
 * One check runs each time the app opens; the menu (Check for Updates…) runs
 * another on demand. The launch check stays quiet about a skipped version and
 * when there is nothing new; a menu check always answers.
 *
 * Only packaged builds update: a dev run has no installed app to replace.
 * macOS installs updates only for a signed app.
 */
import { app, type BrowserWindow, dialog, type MessageBoxOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as fs from 'fs';
import * as path from 'path';

import { ELECTRON_UPDATE_PREFS_FILE } from './constants.js';

export interface Updates {
  /** Check now; `manual` = the user asked (menu), so always answer. */
  check(manual: boolean): void;
}

type Phase = 'idle' | 'checking' | 'downloading' | 'ready';

function prefsPath(): string {
  return path.join(app.getPath('userData'), ELECTRON_UPDATE_PREFS_FILE);
}

function readSkippedVersion(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(prefsPath(), 'utf8')) as { skippedVersion?: unknown };
    return typeof parsed.skippedVersion === 'string' ? parsed.skippedVersion : null;
  } catch {
    return null;
  }
}

function writeSkippedVersion(version: string): void {
  try {
    fs.writeFileSync(prefsPath(), JSON.stringify({ skippedVersion: version }));
  } catch (err) {
    console.error(`[Updater] could not save skipped version: ${String(err)}`);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createUpdates(
  getWindow: () => BrowserWindow | null,
  /** Stop the office server first, so the installer never kills it mid-write. */
  beforeInstall: () => Promise<void>,
): Updates {
  const ask = async (options: MessageBoxOptions): Promise<number> => {
    const win = getWindow();
    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    return response;
  };

  if (!app.isPackaged) {
    console.log('[Updater] dev run, update checks off');
    return {
      check(manual) {
        if (manual) {
          void ask({
            type: 'info',
            message: 'Updates work only in the installed app.',
            buttons: ['OK'],
          });
        }
      },
    };
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  let phase: Phase = 'idle';
  let readyVersion: string | null = null;

  const offerRestart = async (version: string): Promise<void> => {
    const choice = await ask({
      type: 'info',
      title: 'Update downloaded',
      message: `Pixel Office ${version} is ready to install.`,
      detail: 'The office restarts to install it. Agents it runs will stop.',
      buttons: ['Restart and install', 'Install when I quit', 'Not now'],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice === 0) {
      await beforeInstall();
      autoUpdater.quitAndInstall();
    } else if (choice === 1) {
      autoUpdater.autoInstallOnAppQuit = true;
    }
  };

  const download = async (version: string): Promise<void> => {
    phase = 'downloading';
    try {
      await autoUpdater.downloadUpdate();
      phase = 'ready';
      readyVersion = version;
      await offerRestart(version);
    } catch (err) {
      phase = 'idle';
      await ask({
        type: 'error',
        message: 'The update could not be downloaded.',
        detail: errorText(err),
        buttons: ['OK'],
      });
    }
  };

  const check = async (manual: boolean): Promise<void> => {
    if (phase === 'ready' && readyVersion) {
      if (manual) await offerRestart(readyVersion);
      return;
    }
    if (phase !== 'idle') {
      if (manual) {
        await ask({
          type: 'info',
          message:
            phase === 'downloading' ? 'An update is downloading.' : 'Already checking for updates.',
          buttons: ['OK'],
        });
      }
      return;
    }
    phase = 'checking';
    let version: string | null = null;
    try {
      const result = await autoUpdater.checkForUpdates();
      if (result?.isUpdateAvailable) version = result.updateInfo.version;
    } catch (err) {
      phase = 'idle';
      console.error(`[Updater] check failed: ${errorText(err)}`);
      if (manual) {
        await ask({
          type: 'error',
          message: 'Could not check for updates.',
          detail: errorText(err),
          buttons: ['OK'],
        });
      }
      return;
    }

    if (!version) {
      phase = 'idle';
      if (manual) {
        await ask({
          type: 'info',
          message: `You're up to date (Pixel Office ${app.getVersion()}).`,
          buttons: ['OK'],
        });
      }
      return;
    }
    if (!manual && readSkippedVersion() === version) {
      phase = 'idle';
      return;
    }

    const choice = await ask({
      type: 'info',
      title: 'Update available',
      message: `Pixel Office ${version} is available.`,
      detail: `You have ${app.getVersion()}. Download and install it?`,
      buttons: ['Download and install', 'Later', 'Skip this version'],
      defaultId: 0,
      cancelId: 1,
    });
    // Stays 'checking' while the question is open, so a menu check can't stack a second one.
    phase = 'idle';
    if (choice === 0) await download(version);
    else if (choice === 2) writeSkippedVersion(version);
  };

  const run = (manual: boolean): void => {
    void check(manual).catch((err: unknown) => console.error(`[Updater] ${errorText(err)}`));
  };
  run(false);
  return { check: run };
}
