import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { FolderEntry, FolderFile, FolderListing } from '../../core/src/messages.js';
import { isViewableName } from './boardFiles.js';
import {
  FOLDER_DIALOG_TIMEOUT_MS,
  FOLDER_LIST_MAX_ENTRIES,
  FOLDER_LIST_SKIP_NAMES,
  FOLDER_PROJECT_MARKERS,
} from './constants.js';

/**
 * Lists the sub-folders of one directory for the + Agent folder picker, and
 * with `opts.files` the files the document viewer can open (Open file).
 * Absent/empty `requested` means the home folder; `~` expands to it. Only
 * absolute paths are accepted. Never throws — failures come back as `error`
 * with no entries.
 */
export async function listFolder(
  requested?: string,
  homeDir = os.homedir(),
  opts: { files?: boolean } = {},
): Promise<FolderListing> {
  const raw = (requested ?? '').trim();
  let target = raw === '' || raw === '~' ? homeDir : raw;
  if (target.startsWith('~/') || target.startsWith('~\\')) {
    target = path.join(homeDir, target.slice(2));
  }
  const base = { type: 'folderListing' as const, home: homeDir, entries: [] as FolderEntry[] };
  if (!path.isAbsolute(target)) {
    return { ...base, path: raw, error: 'Use an absolute path (or one starting with ~).' };
  }

  let resolved: string;
  try {
    resolved = await fs.promises.realpath(target);
    const stat = await fs.promises.stat(resolved);
    if (!stat.isDirectory()) {
      return { ...base, path: target, error: 'Not a folder.' };
    }
  } catch (err) {
    return { ...base, path: target, error: describeError(err, 'Folder not found.') };
  }

  const parentDir = path.dirname(resolved);
  const parent = parentDir !== resolved ? parentDir : undefined;

  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(resolved, { withFileTypes: true });
  } catch (err) {
    return { ...base, path: resolved, parent, error: describeError(err, 'Cannot read folder.') };
  }

  const candidates: string[] = [];
  const fileNames: string[] = [];
  for (const d of dirents) {
    if (d.name.startsWith('.') || FOLDER_LIST_SKIP_NAMES.includes(d.name)) continue;
    if (opts.files && !d.isDirectory() && isViewableName(d.name)) {
      fileNames.push(d.name); // a link is checked when it is stat'ed below
      continue;
    }
    if (d.isDirectory()) {
      candidates.push(d.name);
    } else if (d.isSymbolicLink()) {
      // Follow symlinks: a link to a folder is a folder to the user.
      try {
        if ((await fs.promises.stat(path.join(resolved, d.name))).isDirectory()) {
          candidates.push(d.name);
        }
      } catch {
        // Dangling link — not listed.
      }
    }
  }
  candidates.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const names = candidates.slice(0, FOLDER_LIST_MAX_ENTRIES);

  const entries = await Promise.all(
    names.map(async (name): Promise<FolderEntry> => {
      const full = path.join(resolved, name);
      const entry: FolderEntry = { name, path: full };
      if (await isProjectFolder(full)) entry.isProject = true;
      return entry;
    }),
  );
  if (!opts.files) return { ...base, path: resolved, parent, entries };
  fileNames.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const files: FolderFile[] = [];
  for (const name of fileNames.slice(0, FOLDER_LIST_MAX_ENTRIES)) {
    const full = path.join(resolved, name);
    try {
      const stat = await fs.promises.stat(full);
      if (!stat.isFile()) continue;
      files.push({ name, path: full, size: stat.size, modifiedAt: stat.mtime.toISOString() });
    } catch {
      // Dangling link — not listed.
    }
  }
  return { ...base, path: resolved, parent, entries, files };
}

async function isProjectFolder(dir: string): Promise<boolean> {
  for (const marker of FOLDER_PROJECT_MARKERS) {
    try {
      await fs.promises.access(path.join(dir, marker));
      return true;
    } catch {
      // try the next marker
    }
  }
  return false;
}

function describeError(err: unknown, fallback: string): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return 'Folder not found.';
  if (code === 'EACCES' || code === 'EPERM') return 'Permission denied.';
  if (code === 'ENOTDIR') return 'Not a folder.';
  return fallback;
}

// ── The machine's own folder dialog (pickFolder) ─────────────
//
// The office is a web page, and a web page cannot open a native folder dialog
// that yields an absolute path (`showDirectoryPicker` hands back a handle with
// no path). So the SERVER opens the platform dialog and replies with the path.
// That means the dialog appears where the office RUNS: right on a laptop or in
// the desktop app, useless from a phone across the room — hence
// `nativePickerAvailable()` and the `canPickFolder` capability, which the
// client also gates on screen size.

/** A cancelled dialog is neither a path nor an error: nothing changes. */
export interface FolderPick {
  path?: string;
  error?: string;
}

/** Probed once: spawning a dialog binary to ask whether it exists is absurd. */
let pickerAvailable: boolean | undefined;

function hasBinary(name: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Whether this machine can show a folder dialog at all. macOS always can
 * (osascript ships with the OS) and Windows always can (PowerShell does); a
 * Linux box may have neither zenity nor kdialog, and then the office silently
 * keeps its own folder browser.
 */
export function nativePickerAvailable(): boolean {
  if (pickerAvailable !== undefined) return pickerAvailable;
  if (process.platform === 'darwin' || process.platform === 'win32') {
    pickerAvailable = true;
  } else {
    pickerAvailable = hasBinary('zenity') || hasBinary('kdialog');
  }
  return pickerAvailable;
}

/** stdout, or undefined when the human cancelled. Never throws. */
function runDialog(
  file: string,
  args: string[],
): Promise<{ out?: string; error?: string; cancelled?: boolean }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: FOLDER_DIALOG_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        const out = (stdout ?? '').trim();
        if (!err) {
          // Every dialog prints nothing when it is dismissed.
          resolve(out === '' ? { cancelled: true } : { out });
          return;
        }
        // Cancel is an exit code on every platform: osascript 1 ("User
        // canceled"), zenity/kdialog 1, PowerShell prints nothing. Only a
        // missing binary or a crash is worth reporting.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') resolve({ error: 'No folder dialog available.' });
        else if (out !== '') resolve({ out });
        else if ((stderr ?? '').includes('User canceled')) resolve({ cancelled: true });
        else resolve({ cancelled: true });
      },
    );
  });
}

const WINDOWS_DIALOG = [
  'Add-Type -AssemblyName System.Windows.Forms;',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
  "if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
].join(' ');

/**
 * Opens this machine's own folder dialog and resolves the chosen folder.
 * Cancel resolves `{}` — the caller leaves the current value alone. Never
 * throws; a failure comes back as `error`. The path is checked the same way
 * `listFolder` checks one (realpath + is it really a directory).
 */
export async function pickFolderNative(homeDir = os.homedir()): Promise<FolderPick> {
  let result: { out?: string; error?: string; cancelled?: boolean };
  if (process.platform === 'darwin') {
    result = await runDialog('osascript', ['-e', 'POSIX path of (choose folder)']);
  } else if (process.platform === 'win32') {
    result = await runDialog('powershell', ['-NoProfile', '-STA', '-Command', WINDOWS_DIALOG]);
  } else if (hasBinary('zenity')) {
    result = await runDialog('zenity', ['--file-selection', '--directory']);
  } else if (hasBinary('kdialog')) {
    result = await runDialog('kdialog', ['--getexistingdirectory', homeDir]);
  } else {
    return { error: 'No folder dialog available.' };
  }

  if (result.error) return { error: result.error };
  if (result.cancelled || !result.out) return {};

  // osascript's POSIX path keeps a trailing separator; nobody else's does.
  const chosen = result.out.replace(/[\\/]+$/, '') || result.out;
  try {
    const resolved = await fs.promises.realpath(chosen);
    if (!(await fs.promises.stat(resolved)).isDirectory()) return { error: 'Not a folder.' };
    return { path: resolved };
  } catch (err) {
    return { error: describeError(err, 'Folder not found.') };
  }
}
