import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { FolderEntry, FolderListing } from '../../core/src/messages.js';
import {
  FOLDER_LIST_MAX_ENTRIES,
  FOLDER_LIST_SKIP_NAMES,
  FOLDER_PROJECT_MARKERS,
} from './constants.js';

/**
 * Lists the sub-folders of one directory for the + Agent folder picker.
 * Absent/empty `requested` means the home folder; `~` expands to it. Only
 * absolute paths are accepted. Never throws — failures come back as `error`
 * with no entries.
 */
export async function listFolder(
  requested?: string,
  homeDir = os.homedir(),
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
  for (const d of dirents) {
    if (d.name.startsWith('.') || FOLDER_LIST_SKIP_NAMES.includes(d.name)) continue;
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
  return { ...base, path: resolved, parent, entries };
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
