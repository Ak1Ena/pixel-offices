import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { DeskColumnDef, DeskTask, DeskTaskState } from '../../core/src/messages.js';
import {
  DESK_COLUMN_DESCRIPTION_MAX_CHARS,
  DESK_COLUMN_NAME_MAX_CHARS,
  DESK_FLOW_FILE_NAME,
  DESK_FLOW_MAX_COLUMNS,
  LAYOUT_FILE_DIR,
  LAYOUT_FILE_POLL_INTERVAL_MS,
} from './constants.js';

/**
 * Board columns the human defines (~/.pixel-agents/desk-flow.json). A column
 * lives inside one card state (its `phase`) and only SPLITS it: "Working" can
 * become "Coding", "Testing", "Blocked on API". The desk's own state machine
 * (taskTransitions.ts) still decides every move between states, so a column
 * can never make an illegal jump — a card changing state lands in the new
 * state's first column.
 *
 * Inside a state, the card moves between its columns by drag (the human) or
 * by the decision model after an agent turn, into columns marked `laya`,
 * judged by each column's description.
 *
 * Shared across windows like board.json: atomic writes, a poll for others'.
 */

const STATES: ReadonlySet<DeskTaskState> = new Set([
  'draft',
  'inbox',
  'looking',
  'brief',
  'ready',
  'working',
  'result',
  'done',
]);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function flowPath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, DESK_FLOW_FILE_NAME);
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'column'
  );
}

/** Valid, bounded, unique columns from anything (a file, a client). */
export function sanitizeColumns(raw: unknown): DeskColumnDef[] {
  if (!Array.isArray(raw)) return [];
  const out: DeskColumnDef[] = [];
  const ids = new Set<string>();
  for (const item of raw.slice(0, DESK_FLOW_MAX_COLUMNS)) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const name =
      typeof c.name === 'string'
        ? c.name
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .trim()
            .slice(0, DESK_COLUMN_NAME_MAX_CHARS)
        : '';
    if (!name || typeof c.phase !== 'string' || !STATES.has(c.phase as DeskTaskState)) continue;
    let id = typeof c.id === 'string' && ID_RE.test(c.id) ? c.id : slug(name);
    for (let n = 2; ids.has(id); n++) id = `${slug(name).slice(0, 36)}-${n}`;
    ids.add(id);
    const description =
      typeof c.description === 'string'
        ? c.description.trim().slice(0, DESK_COLUMN_DESCRIPTION_MAX_CHARS)
        : '';
    out.push({ id, name, description, phase: c.phase as DeskTaskState, laya: c.laya === true });
  }
  return out;
}

/** The columns of one state, in board order. */
export function columnsOf(columns: DeskColumnDef[], phase: DeskTaskState): DeskColumnDef[] {
  return columns.filter((c) => c.phase === phase);
}

/**
 * Where a card belongs after a change: its column if that still is one of its
 * state's columns, else the state's first column (undefined when the state
 * has none of its own).
 */
export function placeCard(task: DeskTask, columns: DeskColumnDef[]): string | undefined {
  const own = columnsOf(columns, task.state);
  if (own.length === 0) return undefined;
  return own.some((c) => c.id === task.column) ? task.column : own[0].id;
}

export class DeskFlowStore {
  private columns: DeskColumnDef[] = [];
  private mtime = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly onChange: (columns: DeskColumnDef[]) => void,
    private readonly filePath: string = flowPath(),
  ) {
    this.load();
    this.timer = setInterval(() => {
      if (this.load()) this.onChange(this.list());
    }, LAYOUT_FILE_POLL_INTERVAL_MS);
  }

  list(): DeskColumnDef[] {
    return this.columns.map((c) => ({ ...c }));
  }

  save(raw: unknown): DeskColumnDef[] {
    this.columns = sanitizeColumns(raw);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, columns: this.columns }, null, 2));
      fs.renameSync(tmp, this.filePath);
      this.mtime = fs.statSync(this.filePath).mtimeMs;
    } catch (err) {
      console.error('[Pixel Agents] Failed to save board columns:', err);
    }
    this.onChange(this.list());
    return this.list();
  }

  /** Re-read when another window wrote it. True when the columns changed. */
  private load(): boolean {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.mtimeMs === this.mtime) return false;
      this.mtime = stat.mtimeMs;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as { columns?: unknown };
      const next = sanitizeColumns(raw.columns);
      const changed = JSON.stringify(next) !== JSON.stringify(this.columns);
      this.columns = next;
      return changed;
    } catch {
      return false;
    }
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
