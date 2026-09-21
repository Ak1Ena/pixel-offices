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
 * office's origin (no html, svg, js). The route itself requires the server
 * token — a token holder can already type into Claude sessions, so reading a
 * pinned file adds no new power, while an untokened LAN viewer gets nothing.
 */

/** Extension → content type the viewer is sent. Text formats go out as text/plain. */
const SERVABLE: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8',
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
      error: 'The viewer opens PDF, Word (.docx), Excel (.xlsx), CSV, text and image files.',
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

/** Write an upload under ~/.pixel-agents/files as `<id>-<name>` (0600, never overwriting). */
function writeUpload(name: string, data: Buffer, id: string): string {
  const dir = path.join(os.homedir(), LAYOUT_FILE_DIR, BOARD_UPLOAD_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, `${id}-${name}`);
  fs.writeFileSync(filePath, data, { mode: 0o600, flag: 'wx' });
  return filePath;
}

/**
 * Store a file uploaded from a browser under ~/.pixel-agents/files and return
 * its path. The client's name is reduced to a safe basename; the stored name
 * is prefixed so uploads never overwrite each other.
 */
export function saveUploadedFile(rawName: string, data: Buffer, id: string): string | null {
  const base = safeUploadName(rawName);
  if (!base || !isViewableName(base) || data.length === 0 || data.length > BOARD_FILE_MAX_BYTES) {
    return null;
  }
  return writeUpload(base, data, id);
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
