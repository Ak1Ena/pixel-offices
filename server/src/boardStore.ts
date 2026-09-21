import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { BoardPin, BoardPinKind } from '../../core/src/messages.js';
import {
  BOARD_FILE_NAME,
  BOARD_MAX_PINS,
  BOARD_PIN_TITLE_MAX_CHARS,
  BOARD_PIN_VALUE_MAX_CHARS,
  LAYOUT_FILE_DIR,
  LAYOUT_FILE_POLL_INTERVAL_MS,
} from './constants.js';

/**
 * The whiteboard — pins (links, files, snippets, notes) shared by every
 * session. Persisted at ~/.pixel-agents/board.json, shared across windows and
 * both surfaces the same way layout.json is: atomic tmp+rename writes, and a
 * poll that picks up another process's write.
 *
 * Pins arrive from clients, so every one is validated and bounded here; a pin
 * that fails validation is dropped, never partially stored.
 */

const PIN_KINDS: ReadonlySet<BoardPinKind> = new Set(['link', 'file', 'snippet', 'note']);
const PIN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SCOPE_MAX = 64;

interface BoardFile {
  version: 1;
  pins: BoardPin[];
}

function boardFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, BOARD_FILE_NAME);
}

/** A well-formed, bounded copy of `raw`, or null when it isn't a pin. */
export function sanitizePin(raw: unknown): BoardPin | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== 'string' || !PIN_ID_RE.test(p.id)) return null;
  if (typeof p.kind !== 'string' || !PIN_KINDS.has(p.kind as BoardPinKind)) return null;
  if (typeof p.title !== 'string' || typeof p.value !== 'string') return null;
  const title = p.title.trim();
  if (!title || title.length > BOARD_PIN_TITLE_MAX_CHARS) return null;
  if (p.value.length > BOARD_PIN_VALUE_MAX_CHARS) return null;
  const scope = Array.isArray(p.scope)
    ? [...new Set(p.scope.filter((id): id is number => Number.isInteger(id)))].slice(0, SCOPE_MAX)
    : [];
  const createdAt =
    typeof p.createdAt === 'string' && p.createdAt.length <= 40
      ? p.createdAt
      : new Date().toISOString();
  return { id: p.id, kind: p.kind as BoardPinKind, title, value: p.value, scope, createdAt };
}

function parseBoard(raw: string): BoardPin[] {
  const data = JSON.parse(raw) as Partial<BoardFile>;
  if (!Array.isArray(data.pins)) return [];
  const pins: BoardPin[] = [];
  for (const candidate of data.pins) {
    const pin = sanitizePin(candidate);
    if (pin && !pins.some((existing) => existing.id === pin.id)) pins.push(pin);
    if (pins.length >= BOARD_MAX_PINS) break;
  }
  return pins;
}

export class BoardStore {
  private pins: BoardPin[] = [];
  private loaded = false;
  /** The exact text we last wrote or read, so our own write never reads as a change. */
  private lastSeen = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** @param onChange called with the full pin list after any change, local or external. */
  constructor(
    private readonly onChange: (pins: BoardPin[]) => void,
    private readonly filePath: string = boardFilePath(),
  ) {}

  /** Current pins. Loads from disk and starts watching on first use. */
  getPins(): BoardPin[] {
    this.ensureLoaded();
    return this.pins.map((pin) => ({ ...pin, scope: [...pin.scope] }));
  }

  /** Add a pin, or replace the pin with the same id. Returns false when rejected. */
  savePin(raw: unknown): boolean {
    this.ensureLoaded();
    const pin = sanitizePin(raw);
    if (!pin) return false;
    const index = this.pins.findIndex((existing) => existing.id === pin.id);
    if (index !== -1) {
      this.pins[index] = pin;
    } else {
      if (this.pins.length >= BOARD_MAX_PINS) return false;
      this.pins.push(pin);
    }
    this.commit();
    return true;
  }

  removePin(pinId: unknown): boolean {
    this.ensureLoaded();
    if (typeof pinId !== 'string') return false;
    const before = this.pins.length;
    this.pins = this.pins.filter((pin) => pin.id !== pinId);
    if (this.pins.length === before) return false;
    this.commit();
    return true;
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.readFromDisk();
    this.pollTimer = setInterval(() => {
      if (this.readFromDisk()) this.onChange(this.getPins());
    }, LAYOUT_FILE_POLL_INTERVAL_MS);
    // Never keep a process alive just to watch the board.
    this.pollTimer.unref?.();
  }

  /** Re-read the file. Returns true when its content changed since we last saw it. */
  private readFromDisk(): boolean {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      return false; // no board yet
    }
    if (raw === this.lastSeen) return false;
    this.lastSeen = raw;
    try {
      this.pins = parseBoard(raw);
    } catch (err) {
      console.error('[Pixel Agents] Failed to parse board file:', err);
      return false;
    }
    return true;
  }

  private commit(): void {
    const json = JSON.stringify({ version: 1, pins: this.pins } satisfies BoardFile, null, 2);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmpPath = this.filePath + '.tmp';
      fs.writeFileSync(tmpPath, json, 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
      this.lastSeen = json;
    } catch (err) {
      console.error('[Pixel Agents] Failed to write board file:', err);
    }
    this.onChange(this.getPins());
  }
}
