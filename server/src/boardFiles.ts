import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { BoardPin } from '../../core/src/messages.js';
import {
  BOARD_FILE_MAX_BYTES,
  BOARD_UPLOAD_DIR,
  CHAT_FILE_ID_PREFIX,
  CHAT_FILE_NAME_PATTERN,
  LAYOUT_FILE_DIR,
  UPLOAD_NAME_MAX_CHARS,
} from './constants.js';

/**
 * Serving whiteboard file pins to the office's document viewer.
 *
 * The client names a PIN, never a path: the path comes from board.json, so a
 * request can only reach files someone pinned. Only document types the viewer
 * renders are served, and never anything a browser would execute in the
 * office's origin: no html or svg, and source code only ever as text/plain.
 * The route itself requires the server token — a token holder can already
 * type into Claude sessions, so reading a pinned file adds no new power,
 * while an untokened LAN viewer gets nothing.
 */

/** Extension → content type the viewer is sent. Text formats go out as text/plain. */
const SERVABLE: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8',
  // Source code, shown as text so agents can point at lines of it. Sent as
  // text/plain with nosniff, so even a .js file is never run by the browser.
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.mjs': 'text/plain; charset=utf-8',
  '.cjs': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.rb': 'text/plain; charset=utf-8',
  '.go': 'text/plain; charset=utf-8',
  '.rs': 'text/plain; charset=utf-8',
  '.java': 'text/plain; charset=utf-8',
  '.kt': 'text/plain; charset=utf-8',
  '.swift': 'text/plain; charset=utf-8',
  '.c': 'text/plain; charset=utf-8',
  '.h': 'text/plain; charset=utf-8',
  '.cpp': 'text/plain; charset=utf-8',
  '.hpp': 'text/plain; charset=utf-8',
  '.cs': 'text/plain; charset=utf-8',
  '.php': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.zsh': 'text/plain; charset=utf-8',
  '.bash': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.css': 'text/plain; charset=utf-8',
  '.scss': 'text/plain; charset=utf-8',
  '.graphql': 'text/plain; charset=utf-8',
  '.vue': 'text/plain; charset=utf-8',
  '.svelte': 'text/plain; charset=utf-8',
  '.lua': 'text/plain; charset=utf-8',
  '.dart': 'text/plain; charset=utf-8',
  '.scala': 'text/plain; charset=utf-8',
  '.r': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export type PinFileResult =
  | { ok: true; filePath: string; contentType: string; size: number }
  | { ok: false; status: 400 | 404 | 413 | 415; error: string };

/** Resolve a file pin to something safe to stream, or say why not. */
export function resolvePinFile(pins: BoardPin[], pinId: string): PinFileResult {
  const pin = pins.find((p) => p.id === pinId);
  if (!pin || pin.kind !== 'file') return { ok: false, status: 404, error: 'No such file pin.' };

  let target = pin.value.trim();
  if (target === '~' || target.startsWith('~/')) target = path.join(os.homedir(), target.slice(1));
  if (!path.isAbsolute(target)) {
    return {
      ok: false,
      status: 400,
      error: 'Use a full path for this pin (for example ~/Documents/plan.pdf).',
    };
  }
  const contentType = SERVABLE[path.extname(target).toLowerCase()];
  if (!contentType) {
    return {
      ok: false,
      status: 415,
      error:
        'The viewer opens PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), CSV, text and image files.',
    };
  }
  let stat: fs.Stats;
  try {
    // realpath: the type check above must hold for what is actually read.
    target = fs.realpathSync(target);
    if (!SERVABLE[path.extname(target).toLowerCase()]) throw new Error('type changed');
    stat = fs.statSync(target);
  } catch {
    return { ok: false, status: 404, error: 'File not found on this computer.' };
  }
  if (!stat.isFile()) return { ok: false, status: 404, error: 'File not found on this computer.' };
  if (stat.size > BOARD_FILE_MAX_BYTES) {
    return { ok: false, status: 413, error: 'File is too large to open here (limit 25 MB).' };
  }
  return { ok: true, filePath: target, contentType, size: stat.size };
}

/** Whether the viewer can open a file with this name. */
export function isViewableName(name: string): boolean {
  return path.extname(name).toLowerCase() in SERVABLE;
}

/** Reduce a client-supplied file name to a safe basename ('' when nothing is left). */
function safeUploadName(rawName: string): string {
  return path
    .basename(rawName.replace(/\\/g, '/'))
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .slice(-UPLOAD_NAME_MAX_CHARS);
}

/** Where uploads live: ~/.pixel-agents/files. */
export function uploadDir(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, BOARD_UPLOAD_DIR);
}

/** Stored board uploads are named `pin_<id>-<name>`. */
const STORED_PIN_FILE_RE = /^pin_[A-Za-z0-9]+-/;

/**
 * A copy of `data` named `name` the office already stores (uploaded before),
 * so uploading the same file again reuses it instead of piling up duplicates.
 */
function findStoredCopy(name: string, data: Buffer): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(uploadDir());
  } catch {
    return null;
  }
  const want = crypto.createHash('sha256').update(data).digest('hex');
  for (const entry of entries) {
    if (!STORED_PIN_FILE_RE.test(entry) || entry.replace(STORED_PIN_FILE_RE, '') !== name) continue;
    const full = path.join(uploadDir(), entry);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size !== data.length) continue;
      if (crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') === want)
        return full;
    } catch {
      /* gone meanwhile */
    }
  }
  return null;
}

/**
 * Whether `filePath` is a board upload the office stored itself — the only
 * files the office ever deletes. The real path must sit directly in
 * ~/.pixel-agents/files with the `pin_` prefix, so a pin pointing anywhere
 * else (the user's own documents) can never be deleted from here.
 */
export function isStoredUpload(filePath: string): boolean {
  let target = filePath.trim();
  if (target === '~' || target.startsWith('~/')) target = path.join(os.homedir(), target.slice(1));
  try {
    const real = fs.realpathSync(target);
    return (
      path.dirname(real) === fs.realpathSync(uploadDir()) &&
      STORED_PIN_FILE_RE.test(path.basename(real)) &&
      fs.statSync(real).isFile()
    );
  } catch {
    return false;
  }
}

/** Delete a stored upload (see isStoredUpload). Returns whether a file was deleted. */
export function deleteStoredUpload(filePath: string): boolean {
  if (!isStoredUpload(filePath)) return false;
  let target = filePath.trim();
  if (target.startsWith('~/')) target = path.join(os.homedir(), target.slice(1));
  try {
    fs.unlinkSync(fs.realpathSync(target));
    return true;
  } catch {
    return false;
  }
}

/** Write an upload under ~/.pixel-agents/files as `<id>-<name>` (0600, never overwriting). */
function writeUpload(name: string, data: Buffer, id: string): string {
  const dir = uploadDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, `${id}-${name}`);
  fs.writeFileSync(filePath, data, { mode: 0o600, flag: 'wx' });
  return filePath;
}

/**
 * Store a file uploaded from a browser under ~/.pixel-agents/files and return
 * its path. The client's name is reduced to a safe basename; the stored name
 * is prefixed so uploads never overwrite each other. The same file (name and
 * content) uploaded again returns the copy already stored.
 */
export function saveUploadedFile(rawName: string, data: Buffer, id: string): string | null {
  const base = safeUploadName(rawName);
  if (!base || !isViewableName(base) || data.length === 0 || data.length > BOARD_FILE_MAX_BYTES) {
    return null;
  }
  return findStoredCopy(base, data) ?? writeUpload(base, data, id);
}

/**
 * Store a file sent to an agent from the office chat and return its absolute
 * path, which the message then names as `@<path>` so Claude reads it. Any type
 * is accepted: the file is stored; only images are served back (resolveChatImage). Spaces
 * become `_` so the `@path` mention stays one token. Not pinned to the board.
 */
export function saveChatFile(rawName: string, data: Buffer): string | null {
  const base = safeUploadName(rawName).replace(/ /g, '_');
  if (!base || data.length === 0 || data.length > BOARD_FILE_MAX_BYTES) return null;
  const id = `${CHAT_FILE_ID_PREFIX}${crypto.randomUUID().replace(/-/g, '')}`;
  return writeUpload(base, data, id);
}

/** Uploaded files the chat shows inline: images only, never anything a browser would run. */
const CHAT_VIEWABLE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Resolve an uploaded file's stored NAME (never a path) to an image the chat
 * may show. Only files directly inside ~/.pixel-agents/files qualify, only
 * image types, and the realpath must still be inside that folder with an
 * image extension — a link planted there can't reach anything else.
 */
export function resolveChatImage(name: string): PinFileResult {
  if (!new RegExp(CHAT_FILE_NAME_PATTERN).test(name) || name.startsWith('.')) {
    return { ok: false, status: 404, error: 'No such file.' };
  }
  const contentType = CHAT_VIEWABLE[path.extname(name).toLowerCase()];
  if (!contentType) return { ok: false, status: 415, error: 'Only images are shown here.' };
  let target: string;
  let stat: fs.Stats;
  try {
    const dir = fs.realpathSync(path.join(os.homedir(), LAYOUT_FILE_DIR, BOARD_UPLOAD_DIR));
    target = fs.realpathSync(path.join(dir, name));
    if (path.dirname(target) !== dir) throw new Error('outside');
    if (!CHAT_VIEWABLE[path.extname(target).toLowerCase()]) throw new Error('type changed');
    stat = fs.statSync(target);
  } catch {
    return { ok: false, status: 404, error: 'No such file.' };
  }
  if (!stat.isFile()) return { ok: false, status: 404, error: 'No such file.' };
  if (stat.size > BOARD_FILE_MAX_BYTES) {
    return { ok: false, status: 413, error: 'File is too large to show (limit 25 MB).' };
  }
  return { ok: true, filePath: target, contentType, size: stat.size };
}

/**
 * Remove a pin and, when asked (and allowed), the office's own stored copy of
 * its file — once no other pin points at it. Both surfaces call this.
 */
export function removePinAndCopy(
  board: { getPins(): BoardPin[]; removePin(pinId: unknown): boolean },
  pinId: unknown,
  deleteFile: boolean,
): { removed: boolean; deleted: boolean } {
  const pin = board.getPins().find((p) => p.id === pinId);
  const removed = board.removePin(pinId);
  if (!removed || !deleteFile || pin?.kind !== 'file') return { removed, deleted: false };
  const stillUsed = board.getPins().some((p) => p.kind === 'file' && p.value === pin.value);
  return { removed, deleted: !stillUsed && deleteStoredUpload(pin.value) };
}
