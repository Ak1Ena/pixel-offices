import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { BoardPin, OfficeFile, OfficeFileSource } from '../../core/src/messages.js';
import { listBackups } from './backups.js';
import { isStoredUpload, isViewableName, uploadDir } from './boardFiles.js';
import {
  LAYOUT_FILE_DIR,
  LAYOUT_FILE_POLL_INTERVAL_MS,
  OFFICE_FILES_FILE_NAME,
  OFFICE_FILES_MAX,
} from './constants.js';

/**
 * Files: the documents the office opened, kept in ~/.pixel-agents/files.json
 * — separate from the whiteboard, so opening a file never shows it to agents.
 * Only paths are stored, never content. The viewer fetches a file by its id
 * (OFFICE_FILE_API_PREFIX); the id is how the browser names a file, never a
 * path. Same file pattern as the board: sanitized on read, atomic writes, a
 * poll so two office windows agree.
 */

interface Entry {
  fileId: string;
  path: string;
  source: OfficeFileSource;
  openedAt: string;
  editedAt?: string;
}

const FILE_ID_RE = /^f[a-f0-9]{12}$/;

function registryPath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, OFFICE_FILES_FILE_NAME);
}

/** `~/x` → absolute; anything not absolute → null. */
export function expandPath(raw: string): string | null {
  let target = raw.trim();
  if (target === '~' || target.startsWith('~/')) target = path.join(os.homedir(), target.slice(1));
  return path.isAbsolute(target) ? path.normalize(target) : null;
}

function sanitize(raw: unknown): Entry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.fileId !== 'string' || !FILE_ID_RE.test(e.fileId)) return null;
  if (typeof e.path !== 'string' || !path.isAbsolute(e.path)) return null;
  const stamp = (v: unknown) =>
    typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : undefined;
  const openedAt = stamp(e.openedAt);
  if (!openedAt) return null;
  const editedAt = stamp(e.editedAt);
  return {
    fileId: e.fileId,
    path: e.path,
    source: e.source === 'upload' ? 'upload' : 'disk',
    openedAt,
    ...(editedAt ? { editedAt } : {}),
  };
}

function dirBytes(dir: string): number {
  let total = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        const stat = fs.statSync(path.join(dir, name));
        if (stat.isFile()) total += stat.size;
      } catch {
        /* gone meanwhile */
      }
    }
  } catch {
    /* no folder yet */
  }
  return total;
}

export class OfficeFiles {
  private entries: Entry[] = [];
  private loaded = false;
  private lastSeen = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    /** Broadcast the whole list (filesLoaded) after any change. */
    private readonly onChange: () => void,
    /** Whiteboard pins, for the `pinned` flag. */
    private readonly pins: () => BoardPin[],
    private readonly filePath: string = registryPath(),
  ) {}

  /** Add (or bring to the top) a file the user opened. Returns its entry, or an error. */
  open(
    rawPath: unknown,
    source: OfficeFileSource = 'disk',
  ): { ok: true; fileId: string; path: string } | { ok: false; error: string } {
    this.ensureLoaded();
    if (typeof rawPath !== 'string') return { ok: false, error: 'No path.' };
    const target = expandPath(rawPath);
    if (!target)
      return { ok: false, error: 'Use a full path (for example ~/Documents/plan.docx).' };
    if (!isViewableName(target))
      return {
        ok: false,
        error: 'The viewer opens PDF, Word, PowerPoint, Excel, CSV, text and images.',
      };
    try {
      if (!fs.statSync(target).isFile()) return { ok: false, error: 'Not a file.' };
    } catch {
      return { ok: false, error: 'File not found on this computer.' };
    }
    const existing = this.entries.find((e) => e.path === target);
    const entry: Entry = existing
      ? { ...existing, openedAt: new Date().toISOString() }
      : {
          fileId: `f${crypto.randomBytes(6).toString('hex')}`,
          path: target,
          source: source === 'upload' || isStoredUpload(target) ? 'upload' : 'disk',
          openedAt: new Date().toISOString(),
        };
    this.entries = [entry, ...this.entries.filter((e) => e.fileId !== entry.fileId)].slice(
      0,
      OFFICE_FILES_MAX,
    );
    this.commit();
    return { ok: true, fileId: entry.fileId, path: entry.path };
  }

  /** The path behind an id (the only way a browser names a file). */
  pathOf(fileId: unknown): string | undefined {
    this.ensureLoaded();
    return this.entries.find((e) => e.fileId === fileId)?.path;
  }

  forget(fileId: unknown): boolean {
    this.ensureLoaded();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.fileId !== fileId);
    if (this.entries.length === before) return false;
    this.commit();
    return true;
  }

  /** A write landed on this path (viewer save, applied suggestion, agent edit). */
  markEdited(filePath: string): void {
    this.ensureLoaded();
    const resolved = path.normalize(filePath);
    const entry = this.entries.find(
      (e) => e.path === resolved || safeRealpath(e.path) === safeRealpath(resolved),
    );
    if (!entry) return;
    entry.editedAt = new Date().toISOString();
    this.commit();
  }

  /** The list clients see: live size / missing, `pinned` from the whiteboard. */
  list(): OfficeFile[] {
    this.ensureLoaded();
    const pinned = new Set(
      this.pins()
        .filter((p) => p.kind === 'file')
        .map((p) => expandPath(p.value))
        .filter((p): p is string => p !== null),
    );
    return this.entries.map((e) => {
      let size: number | undefined;
      let missing = false;
      try {
        size = fs.statSync(e.path).size;
      } catch {
        missing = true;
      }
      return {
        fileId: e.fileId,
        path: e.path,
        name: path.basename(e.path).replace(/^pin_[A-Za-z0-9]+-/, ''),
        source: e.source,
        openedAt: e.openedAt,
        ...(e.editedAt ? { editedAt: e.editedAt } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(missing ? { missing: true } : {}),
        pinned: pinned.has(e.path),
      };
    });
  }

  snapshot(): {
    type: 'filesLoaded';
    files: OfficeFile[];
    uploadsBytes: number;
    backups: ReturnType<typeof listBackups>;
    backupsBytes: number;
  } {
    const backups = listBackups();
    return {
      type: 'filesLoaded',
      files: this.list(),
      uploadsBytes: dirBytes(uploadDir()),
      backups,
      backupsBytes: backups.reduce((sum, g) => sum + g.bytes, 0),
    };
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.readFromDisk();
    this.pollTimer = setInterval(() => {
      if (this.readFromDisk()) this.onChange();
    }, LAYOUT_FILE_POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  private readFromDisk(): boolean {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      return false;
    }
    if (raw === this.lastSeen) return false;
    this.lastSeen = raw;
    try {
      const parsed = JSON.parse(raw) as { files?: unknown };
      const list = Array.isArray(parsed.files) ? parsed.files : [];
      this.entries = list
        .map(sanitize)
        .filter((e): e is Entry => e !== null)
        .slice(0, OFFICE_FILES_MAX);
    } catch (err) {
      console.error('[Pixel Agents] Failed to parse files.json:', err);
      return false;
    }
    return true;
  }

  private commit(): void {
    const json = JSON.stringify({ version: 1, files: this.entries }, null, 2);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, json, { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
      this.lastSeen = json;
    } catch (err) {
      console.error('[Pixel Agents] Failed to write files.json:', err);
    }
    this.onChange();
  }
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
