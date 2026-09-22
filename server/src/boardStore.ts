import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { BoardPin, BoardPinKind } from '../../core/src/messages.js';
import {
  BOARD_CLI_COMMAND,
  BOARD_FILE_NAME,
  BOARD_INDEX_FILE_NAME,
  BOARD_MAX_PINS,
  BOARD_PIN_DETAIL_MAX_CHARS,
  BOARD_PIN_TITLE_MAX_CHARS,
  BOARD_PIN_VALUE_MAX_CHARS,
  LAYOUT_FILE_DIR,
  LAYOUT_FILE_POLL_INTERVAL_MS,
  SHOW_CLI_COMMAND,
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
  if (p.detail !== undefined && typeof p.detail !== 'string') return null;
  const detail = typeof p.detail === 'string' ? p.detail.trim() : '';
  if (detail.length > BOARD_PIN_DETAIL_MAX_CHARS) return null;
  const scope = Array.isArray(p.scope)
    ? [...new Set(p.scope.filter((id): id is number => Number.isInteger(id)))].slice(0, SCOPE_MAX)
    : [];
  const createdAt =
    typeof p.createdAt === 'string' && p.createdAt.length <= 40
      ? p.createdAt
      : new Date().toISOString();
  return {
    id: p.id,
    kind: p.kind as BoardPinKind,
    title,
    value: p.value,
    ...(detail ? { detail } : {}),
    scope,
    createdAt,
  };
}

export type PinInputResult = { ok: true; pin: BoardPin } | { ok: false; error: string };

const AUTHOR_MAX_CHARS = 40;
const DEFAULT_TITLE_CHARS = 60;

function defaultTitle(kind: string, value: string): string {
  if (kind === 'file') return path.basename(value) || value;
  if (kind === 'link') return value;
  const firstLine = value.trim().split('\n')[0] ?? '';
  if (firstLine) return firstLine.slice(0, DEFAULT_TITLE_CHARS);
  return kind === 'snippet' ? 'Snippet' : 'Note';
}

/**
 * A NEW pin from an agent's request (`POST /api/board/pins`, `pixel-office
 * board add`): `{ kind, value, title?, detail?, scope?, author? }`. The id and
 * createdAt are always minted here. `scope` may name agents (resolved through
 * `resolveAgent`) as well as give ids; `author` becomes a title prefix, since
 * BoardPin has no author field.
 */
export function pinFromInput(
  raw: unknown,
  resolveAgent: (name: string) => number | undefined = () => undefined,
): PinInputResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Expected a JSON object.' };
  const input = raw as Record<string, unknown>;
  if (typeof input.kind !== 'string' || !PIN_KINDS.has(input.kind as BoardPinKind)) {
    return { ok: false, error: 'kind must be one of: link, file, snippet, note.' };
  }
  if (typeof input.value !== 'string') return { ok: false, error: 'value must be a string.' };
  if (input.title !== undefined && typeof input.title !== 'string') {
    return { ok: false, error: 'title must be a string.' };
  }
  if (input.detail !== undefined && typeof input.detail !== 'string') {
    return { ok: false, error: 'detail must be a string.' };
  }
  let title = (input.title as string | undefined)?.trim() || defaultTitle(input.kind, input.value);
  if (typeof input.author === 'string' && input.author.trim()) {
    const author = input.author
      .replace(/[\x00-\x1f\x7f]/g, '')
      .trim()
      .slice(0, AUTHOR_MAX_CHARS);
    if (author) title = `${author}: ${title}`;
  }
  title = title.slice(0, BOARD_PIN_TITLE_MAX_CHARS);
  const scope: number[] = [];
  if (input.scope !== undefined) {
    if (!Array.isArray(input.scope)) return { ok: false, error: 'scope must be an array.' };
    for (const entry of input.scope) {
      if (Number.isInteger(entry)) {
        scope.push(entry as number);
      } else if (typeof entry === 'string' && entry.trim()) {
        const id = resolveAgent(entry.trim());
        if (id === undefined) return { ok: false, error: `No agent named "${entry.trim()}".` };
        scope.push(id);
      } else {
        return { ok: false, error: 'scope entries must be agent ids or names.' };
      }
    }
  }
  const pin = sanitizePin({
    id: `pin_${crypto.randomUUID().replace(/-/g, '')}`,
    kind: input.kind,
    title,
    value: input.value,
    detail: input.detail,
    scope,
    createdAt: new Date().toISOString(),
  });
  if (!pin) {
    return {
      ok: false,
      error: `Pin rejected (title must be non-empty, value at most ${BOARD_PIN_VALUE_MAX_CHARS} characters, detail at most ${BOARD_PIN_DETAIL_MAX_CHARS}).`,
    };
  }
  return { ok: true, pin };
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
    /** Names an agent id in the index file's "for:" line. */
    private readonly describeAgent: (agentId: number) => string = (id) => `agent #${id}`,
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
    // Refresh the index so its how-to header is there even before the first change.
    this.writeIndex();
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

  /**
   * board.md beside board.json: the whiteboard as plain text, so agents (which
   * can read files) can look things up whenever they want. Best effort.
   */
  private writeIndex(): void {
    const lines = [
      '# Pixel Office whiteboard',
      '',
      'Shared documents, links, snippets and notes for every agent in this office.',
      'Kept up to date by the office. "for:" says who an item is meant for.',
      'Read this file any time. Do not edit it: it is rewritten on every change.',
      '',
      'To add to the whiteboard yourself (any agent, any tool):',
      `- note:    ${BOARD_CLI_COMMAND} add --note "text" [--title T] [--detail D] [--for NAME]`,
      `- link:    ${BOARD_CLI_COMMAND} add --link URL [--title T]`,
      `- file:    ${BOARD_CLI_COMMAND} add --file PATH [--title T]`,
      `- snippet: ${BOARD_CLI_COMMAND} add --snippet "code" (or pipe it on stdin)`,
      `- detail (notes on any pin): ${BOARD_CLI_COMMAND} detail <id> "text"`,
      `- list / remove: ${BOARD_CLI_COMMAND} list, ${BOARD_CLI_COMMAND} rm <id>`,
      '',
      'To make the user look at part of a file (the office opens it at that spot;',
      'only the path is sent):',
      `- ${SHOW_CLI_COMMAND} PATH [--lines 40-58 | --page 3 | --cell "Q3!B4" | --find "text"] --why "why" [--wait]`,
      '',
    ];
    for (const pin of this.pins) {
      const who =
        pin.scope.length === 0 ? 'everyone' : pin.scope.map(this.describeAgent).join(', ');
      lines.push(`## ${pin.title}`, `- id: ${pin.id}`, `- type: ${pin.kind}`, `- for: ${who}`);
      if (pin.kind === 'file') lines.push(`- path: ${pin.value}`);
      else if (pin.kind === 'link') lines.push(`- url: ${pin.value}`);
      else if (pin.value.trim()) lines.push('', '```', pin.value, '```');
      if (pin.detail) lines.push('', pin.detail);
      lines.push('');
    }
    try {
      const indexPath = path.join(path.dirname(this.filePath), BOARD_INDEX_FILE_NAME);
      fs.writeFileSync(indexPath, lines.join('\n'));
    } catch {
      /* the index is a convenience; board.json is the record */
    }
  }

  private commit(): void {
    const json = JSON.stringify({ version: 1, pins: this.pins } satisfies BoardFile, null, 2);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmpPath = this.filePath + '.tmp';
      fs.writeFileSync(tmpPath, json, 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
      this.lastSeen = json;
      this.writeIndex();
    } catch (err) {
      console.error('[Pixel Agents] Failed to write board file:', err);
    }
    this.onChange(this.getPins());
  }
}
