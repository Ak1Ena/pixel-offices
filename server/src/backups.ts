import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { BackupGroup } from '../../core/src/messages.js';
import {
  BACKUPS_KEEP_PER_FILE,
  BACKUPS_MAX_AGE_MS,
  LAYOUT_FILE_DIR,
  PROPOSAL_BACKUP_DIR,
} from './constants.js';

/**
 * ~/.pixel-agents/backups: the version of a file just before the office wrote
 * to it (a viewer save, an applied suggestion, an auto-accepted agent edit),
 * so Undo can put it back.
 *
 * Named `<ms>-<id>-<pathhash>-<basename>`; the hash keeps two files with the
 * same name in different folders apart. Older backups (`<ms>-<id>-<basename>`)
 * are grouped by name. Pruned after every write: the newest
 * BACKUPS_KEEP_PER_FILE per file, none older than BACKUPS_MAX_AGE_MS.
 */

export function backupDir(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, PROPOSAL_BACKUP_DIR);
}

const pathHash = (filePath: string): string =>
  crypto.createHash('sha256').update(path.resolve(filePath)).digest('hex').slice(0, 8);

/** The name a new backup of `filePath` gets. */
export function backupName(filePath: string, id: string, now = Date.now()): string {
  return `${now}-${id}-${pathHash(filePath)}-${path.basename(filePath)}`;
}

interface Parsed {
  name: string;
  at: number;
  /** Which file it is a version of. */
  key: string;
  /** The file's name, for display. */
  display: string;
}

const NAME_RE = /^(\d{10,})-([A-Za-z0-9]+)-(.+)$/;
const HASHED_RE = /^([a-f0-9]{8})-(.+)$/;

function parse(name: string): Parsed | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const rest = m[3];
  const hashed = HASHED_RE.exec(rest);
  return { name, at: Number(m[1]), key: rest, display: hashed ? hashed[2] : rest };
}

function entries(dir: string): Array<Parsed & { bytes: number }> {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<Parsed & { bytes: number }> = [];
  for (const name of names) {
    const parsed = parse(name);
    if (!parsed) continue;
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (stat.isFile()) out.push({ ...parsed, bytes: stat.size });
    } catch {
      /* gone meanwhile */
    }
  }
  return out;
}

/** Backups grouped by the file they are versions of, newest group first. */
export function listBackups(dir = backupDir()): BackupGroup[] {
  const groups = new Map<string, BackupGroup>();
  for (const e of entries(dir)) {
    const g = groups.get(e.key) ?? {
      key: e.key,
      name: e.display,
      versions: 0,
      bytes: 0,
      newestAt: new Date(0).toISOString(),
    };
    g.versions++;
    g.bytes += e.bytes;
    if (e.at > Date.parse(g.newestAt)) g.newestAt = new Date(e.at).toISOString();
    groups.set(e.key, g);
  }
  return [...groups.values()].sort((a, b) => Date.parse(b.newestAt) - Date.parse(a.newestAt));
}

/**
 * Drop what retention no longer keeps: beyond the newest `keep` per file, and
 * anything older than `maxAgeMs`. Undo only ever uses a file's newest backup,
 * which stays while it is younger than that. Returns the names deleted.
 */
export function pruneBackups(
  dir = backupDir(),
  now = Date.now(),
  keep = BACKUPS_KEEP_PER_FILE,
  maxAgeMs = BACKUPS_MAX_AGE_MS,
): string[] {
  const byKey = new Map<string, Parsed[]>();
  for (const e of entries(dir)) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
  const deleted: string[] = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => b.at - a.at);
    list.forEach((e, i) => {
      if (i < keep && now - e.at <= maxAgeMs) return;
      try {
        fs.unlinkSync(path.join(dir, e.name));
        deleted.push(e.name);
      } catch {
        /* already gone */
      }
    });
  }
  return deleted;
}

/** Delete the backups of one file (by group key), or all of them. Returns how many. */
export function clearBackups(key?: string, dir = backupDir()): number {
  let count = 0;
  for (const e of entries(dir)) {
    if (key !== undefined && e.key !== key) continue;
    try {
      fs.unlinkSync(path.join(dir, e.name));
      count++;
    } catch {
      /* already gone */
    }
  }
  return count;
}
