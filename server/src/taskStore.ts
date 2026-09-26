import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type {
  DeskAttachment,
  DeskBrief,
  DeskFolder,
  DeskLogEntry,
  DeskQuestion,
  DeskResult,
  DeskSubtask,
  DeskTask,
  DeskTaskKind,
  DeskTaskPriority,
  DeskTaskState,
  DeskWaitingOn,
} from '../../core/src/messages.js';
import {
  LAYOUT_FILE_DIR,
  LAYOUT_FILE_POLL_INTERVAL_MS,
  MODEL_LABEL_MAX_CHARS,
  TASK_BODY_MAX_CHARS,
  TASK_BRIEF_SHORT_MAX_CHARS,
  TASK_BRIEF_TEXT_MAX_CHARS,
  TASK_CLI_COMMAND,
  TASK_DESK_FILE_NAME,
  TASK_DESK_INDEX_FILE_NAME,
  TASK_DESK_MAX_TASKS,
  TASK_MAX_ATTACHMENTS,
  TASK_MAX_BRIEFS,
  TASK_MAX_FILES,
  TASK_MAX_LOG,
  TASK_MAX_QUESTIONS,
  TASK_MAX_SUBTASKS,
  TASK_NOTE_MAX_CHARS,
  TASK_TITLE_MAX_CHARS,
} from './constants.js';

/**
 * The task desk's cards. Persisted at ~/.pixel-agents/tasks.json and shared
 * across windows and both surfaces exactly the way the whiteboard is: atomic
 * tmp+rename writes, and a poll that picks up another process's write.
 *
 * Cards come from clients and briefs from agents, so everything is validated
 * and bounded here; what fails validation is dropped, never partially stored.
 * The RULES of how a card moves live in taskTransitions.ts — this file only
 * keeps cards.
 */

const KINDS: ReadonlySet<string> = new Set<DeskTaskKind>(['task', 'issue', 'feature']);
const PRIORITIES: ReadonlySet<string> = new Set<DeskTaskPriority>(['p1', 'p2']);
const STATES: ReadonlySet<string> = new Set<DeskTaskState>([
  'draft',
  'inbox',
  'looking',
  'brief',
  'ready',
  'working',
  'result',
  'done',
]);
const LOG_KINDS: ReadonlySet<string> = new Set(['agent', 'verified', 'rejected', 'system']);
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Team preset and workflow ids (teamFile / workflowFile slugs). */
const PRESET_ID_RE = /^[a-z0-9-]{1,64}$/;
const CREW_ID_RE = /^c[a-f0-9]{6}$/;
const ALLOW_MAX = 64;
const PATH_MAX_CHARS = 4096;
const WHO_MAX_CHARS = 60;
const STAMP_MAX_CHARS = 40;
// Control characters other than tab and newline.
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

interface TaskFile {
  version: 1;
  nextNum: number;
  tasks: DeskTask[];
}

function taskFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, TASK_DESK_FILE_NAME);
}

/** A trimmed, control-free string no longer than `max`, or null when `raw` isn't a string. */
export function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  return raw.replace(CONTROL_CHARS_RE, '').trim().slice(0, max);
}

const stamp = (raw: unknown): string =>
  typeof raw === 'string' && raw.length <= STAMP_MAX_CHARS ? raw : new Date().toISOString();

function sanitizeFolder(raw: unknown): DeskFolder | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  const root = cleanText(f.root, PATH_MAX_CHARS);
  if (!root || !path.isAbsolute(root)) return null;
  const branch = cleanText(f.branch, TASK_BRIEF_SHORT_MAX_CHARS);
  const subPath = cleanText(f.subPath, PATH_MAX_CHARS);
  return {
    root,
    name: cleanText(f.name, TASK_BRIEF_SHORT_MAX_CHARS) || path.basename(root) || root,
    isGit: f.isGit === true,
    ...(branch ? { branch } : {}),
    ...(subPath ? { subPath } : {}),
  };
}

/** One attached file: an absolute path; the name defaults to its basename. */
export function sanitizeAttachment(raw: unknown): DeskAttachment | null {
  const a = (typeof raw === 'string' ? { path: raw } : raw) as Record<string, unknown> | null;
  if (!a || typeof a !== 'object') return null;
  const filePath = cleanText(a.path, PATH_MAX_CHARS);
  if (!filePath || !path.isAbsolute(filePath)) return null;
  const name = cleanText(a.name, TASK_BRIEF_SHORT_MAX_CHARS) || path.basename(filePath) || filePath;
  return { path: filePath, name };
}

/** Attachments without duplicates (by path), bounded. */
export function sanitizeAttachments(raw: unknown): DeskAttachment[] {
  const seen = new Set<string>();
  return list(
    raw,
    (item) => {
      const clean = sanitizeAttachment(item);
      if (!clean || seen.has(clean.path)) return null;
      seen.add(clean.path);
      return clean;
    },
    TASK_MAX_ATTACHMENTS,
  );
}

const STEP_KINDS: ReadonlySet<string> = new Set(['do', 'gate', 'show']);
const STEP_ID_RE = /^s[a-f0-9]{6}$/;
/** "[gate] Check the export" — how an agent writes a step's kind in a plain string. */
const KIND_PREFIX_RE = /^\[(do|gate|show)\]\s*/i;

/** A fresh step id. */
export function newStepId(): string {
  return `s${crypto.randomBytes(3).toString('hex')}`;
}

/** One card step. Agents hand steps in as strings ("[gate] …") or objects; stored cards hold objects. */
export function sanitizeSubtask(raw: unknown): DeskSubtask | null {
  const s = (typeof raw === 'string' ? { title: raw } : raw) as Record<string, unknown> | null;
  if (!s || typeof s !== 'object') return null;
  let title = cleanText(s.title, TASK_BRIEF_SHORT_MAX_CHARS);
  if (!title) return null;
  let kind = typeof s.kind === 'string' && STEP_KINDS.has(s.kind) ? s.kind : undefined;
  const prefix = KIND_PREFIX_RE.exec(title);
  if (prefix) {
    kind ??= prefix[1].toLowerCase();
    title = title.slice(prefix[0].length).trim();
    if (!title) return null;
  }
  const ref = cleanText(s.ref, PATH_MAX_CHARS);
  const ask = cleanText(s.ask, TASK_NOTE_MAX_CHARS);
  return {
    ...(typeof s.id === 'string' && STEP_ID_RE.test(s.id) ? { id: s.id } : {}),
    ...(kind && kind !== 'do' ? { kind: kind as DeskSubtask['kind'] } : {}),
    title,
    ...(ref ? { ref } : {}),
    skip: s.skip === true,
    done: s.done === true,
    ...(s.waiting === true ? { waiting: true } : {}),
    ...(ask ? { ask } : {}),
    by: s.by === 'you' ? 'you' : 'agent',
  };
}

/** Steps with an id each (new ones get one). */
export function withStepIds(steps: DeskSubtask[]): DeskSubtask[] {
  const seen = new Set<string>();
  return steps.map((step) => {
    const id = step.id && !seen.has(step.id) ? step.id : newStepId();
    seen.add(id);
    return { ...step, id };
  });
}

function sanitizeQuestion(raw: unknown): DeskQuestion | null {
  const q = (typeof raw === 'string' ? { q: raw } : raw) as Record<string, unknown> | null;
  if (!q || typeof q !== 'object') return null;
  const text = cleanText(q.q, TASK_BRIEF_SHORT_MAX_CHARS * 2);
  if (!text) return null;
  return { q: text, a: cleanText(q.a, TASK_NOTE_MAX_CHARS) ?? '' };
}

function list<T>(raw: unknown, each: (item: unknown) => T | null, max: number): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const item of raw) {
    const clean = each(item);
    if (clean !== null) out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

/** A bounded brief. `by` and `createdAt` win over whatever `raw` claims when given. */
export function sanitizeBrief(raw: unknown, by?: string, createdAt?: string): DeskBrief | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  return {
    by: (by ?? cleanText(b.by, WHO_MAX_CHARS)) || 'An agent',
    understanding: cleanText(b.understanding, TASK_BRIEF_TEXT_MAX_CHARS) ?? '',
    subtasks: list(b.subtasks, sanitizeSubtask, TASK_MAX_SUBTASKS),
    files: list(b.files, (f) => cleanText(f, PATH_MAX_CHARS) || null, TASK_MAX_FILES),
    questions: list(b.questions, sanitizeQuestion, TASK_MAX_QUESTIONS),
    risk: cleanText(b.risk, TASK_BRIEF_SHORT_MAX_CHARS) ?? '',
    size: cleanText(b.size, TASK_BRIEF_SHORT_MAX_CHARS) ?? '',
    createdAt: createdAt ?? stamp(b.createdAt),
  };
}

/** A brief an AGENT handed in: it must at least say what it understood. */
export function briefFromInput(
  raw: unknown,
  by: string,
): { ok: true; brief: DeskBrief } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Expected a JSON object.' };
  const brief = sanitizeBrief(raw, by, new Date().toISOString());
  if (!brief || !brief.understanding) {
    return { ok: false, error: '"understanding" must say what you think the card wants.' };
  }
  if (brief.subtasks.length === 0) {
    return { ok: false, error: '"subtasks" must list at least one step (an array of strings).' };
  }
  return {
    ok: true,
    brief: {
      ...brief,
      subtasks: withStepIds(
        brief.subtasks.map((s) => {
          const step: DeskSubtask = { ...s, by: 'agent', done: false, skip: false };
          delete step.waiting;
          delete step.ask;
          return step;
        }),
      ),
    },
  };
}

export function sanitizeResult(raw: unknown, by?: string): DeskResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const summary = cleanText(r.summary, TASK_BRIEF_TEXT_MAX_CHARS);
  if (!summary) return null;
  const branch = cleanText(r.branch, TASK_BRIEF_SHORT_MAX_CHARS);
  const diffStat = cleanText(r.diffStat, TASK_BRIEF_SHORT_MAX_CHARS);
  const tests = cleanText(r.tests, TASK_BRIEF_SHORT_MAX_CHARS);
  return {
    by: (by ?? cleanText(r.by, WHO_MAX_CHARS)) || 'An agent',
    summary,
    ...(branch ? { branch } : {}),
    ...(diffStat ? { diffStat } : {}),
    ...(tests ? { tests } : {}),
  };
}

function sanitizeLog(raw: unknown): DeskLogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as Record<string, unknown>;
  const text = cleanText(l.text, TASK_NOTE_MAX_CHARS + 40);
  if (!text || typeof l.kind !== 'string' || !LOG_KINDS.has(l.kind)) return null;
  return {
    at: stamp(l.at),
    who: cleanText(l.who, WHO_MAX_CHARS) || '?',
    kind: l.kind as DeskLogEntry['kind'],
    text,
  };
}

function sanitizeWaitingOn(raw: unknown): DeskWaitingOn | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  if (w.kind !== 'question' && w.kind !== 'blocked') return null;
  const text = cleanText(w.text, TASK_NOTE_MAX_CHARS);
  return text ? { kind: w.kind, text, at: stamp(w.at) } : null;
}

/** A well-formed, bounded copy of `raw`, or null when it isn't a card. */
export function sanitizeTask(raw: unknown): DeskTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== 'string' || !TASK_ID_RE.test(t.id)) return null;
  if (!Number.isInteger(t.num) || (t.num as number) < 1) return null;
  if (typeof t.kind !== 'string' || !KINDS.has(t.kind)) return null;
  if (typeof t.priority !== 'string' || !PRIORITIES.has(t.priority)) return null;
  if (typeof t.state !== 'string' || !STATES.has(t.state)) return null;
  const title = cleanText(t.title, TASK_TITLE_MAX_CHARS);
  const folder = sanitizeFolder(t.folder);
  if (!title || !folder) return null;
  const result = sanitizeResult(t.result);
  const attachments = sanitizeAttachments(t.attachments);
  // Only a card still being built can be waiting on the human's answer.
  const waitingOn = t.state === 'working' ? sanitizeWaitingOn(t.waitingOn) : null;
  const allow = Array.isArray(t.allow)
    ? [...new Set(t.allow.filter((id): id is number => Number.isInteger(id)))].slice(0, ALLOW_MAX)
    : [];
  return {
    id: t.id,
    num: t.num as number,
    kind: t.kind as DeskTaskKind,
    title,
    body: cleanText(t.body, TASK_BODY_MAX_CHARS) ?? '',
    priority: t.priority as DeskTaskPriority,
    folder,
    allow,
    state: t.state as DeskTaskState,
    round: Number.isInteger(t.round) && (t.round as number) >= 1 ? (t.round as number) : 1,
    ...(Number.isInteger(t.claimedBy) ? { claimedBy: t.claimedBy as number } : {}),
    ...(typeof t.owner === 'string' && /^[0-9]{1,12}$/.test(t.owner) ? { owner: t.owner } : {}),
    ...(t.queued === true ? { queued: true } : {}),
    ...(Number.isInteger(t.attempts) && (t.attempts as number) > 0
      ? { attempts: t.attempts as number }
      : {}),
    briefs: list(t.briefs, (b) => sanitizeBrief(b), TASK_MAX_BRIEFS),
    ...(result ? { result } : {}),
    log: list(t.log, sanitizeLog, TASK_MAX_LOG),
    createdAt: stamp(t.createdAt),
    ...(typeof t.teamId === 'string' && PRESET_ID_RE.test(t.teamId) ? { teamId: t.teamId } : {}),
    ...(typeof t.crewId === 'string' && CREW_ID_RE.test(t.crewId) ? { crewId: t.crewId } : {}),
    ...(typeof t.workflowId === 'string' && PRESET_ID_RE.test(t.workflowId)
      ? { workflowId: t.workflowId }
      : {}),
    ...(t.autoRouted === true ? { autoRouted: true } : {}),
    ...(typeof t.column === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(t.column)
      ? { column: t.column }
      : {}),
    ...(typeof t.model === 'string' && t.model.trim()
      ? { model: t.model.trim().slice(0, MODEL_LABEL_MAX_CHARS) }
      : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(waitingOn ? { waitingOn } : {}),
  };
}

export interface NewTaskInput {
  kind: unknown;
  title: unknown;
  body: unknown;
  priority: unknown;
  folder: DeskFolder;
  /** Keep it off the desk: no agent looks at a draft until the human sends it. */
  draft?: boolean;
  teamId?: unknown;
  workflowId?: unknown;
  model?: unknown;
  attachments?: unknown;
}

function parseFile(raw: string): { tasks: DeskTask[]; nextNum: number } {
  const data = JSON.parse(raw) as Partial<TaskFile>;
  const tasks: DeskTask[] = [];
  for (const candidate of Array.isArray(data.tasks) ? data.tasks : []) {
    const task = sanitizeTask(candidate);
    if (task && !tasks.some((t) => t.id === task.id || t.num === task.num)) tasks.push(task);
    if (tasks.length >= TASK_DESK_MAX_TASKS) break;
  }
  const highest = tasks.reduce((max, t) => Math.max(max, t.num), 0);
  const nextNum = Number.isInteger(data.nextNum)
    ? Math.max(data.nextNum as number, highest + 1)
    : highest + 1;
  return { tasks, nextNum };
}

export class TaskStore {
  private tasks: DeskTask[] = [];
  private nextNum = 1;
  private loaded = false;
  /** The exact text we last wrote or read, so our own write never reads as a change. */
  private lastSeen = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** @param onChange called after any change, local or from another window. */
  constructor(
    private readonly onChange: () => void,
    private readonly filePath: string = taskFilePath(),
  ) {}

  getTasks(): DeskTask[] {
    this.ensureLoaded();
    return structuredClone(this.tasks);
  }

  /** By id, or by the short number agents use (`12` or `#12`). */
  find(ref: unknown): DeskTask | undefined {
    this.ensureLoaded();
    const text = typeof ref === 'number' ? String(ref) : typeof ref === 'string' ? ref.trim() : '';
    if (!text) return undefined;
    const num = /^#?\d{1,9}$/.test(text) ? Number(text.replace('#', '')) : undefined;
    const found = this.tasks.find((t) => t.id === text || (num !== undefined && t.num === num));
    return found ? structuredClone(found) : undefined;
  }

  /** A new inbox card. Null when the input is rejected or the desk is full. */
  create(input: NewTaskInput): DeskTask | null {
    this.ensureLoaded();
    if (this.tasks.length >= TASK_DESK_MAX_TASKS) return null;
    const task = sanitizeTask({
      id: `t_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      num: this.nextNum,
      kind: input.kind,
      title: input.title,
      body: input.body,
      priority: input.priority,
      folder: input.folder,
      allow: [],
      state: input.draft === true ? 'draft' : 'inbox',
      round: 1,
      briefs: [],
      log: [],
      createdAt: new Date().toISOString(),
      teamId: input.teamId,
      workflowId: input.workflowId,
      model: input.model,
      attachments: input.attachments,
    });
    if (!task) return null;
    this.nextNum++;
    this.tasks.push(task);
    this.commit();
    return structuredClone(task);
  }

  /** Replace the card with the same id. False when it is unknown or malformed. */
  replace(raw: DeskTask): boolean {
    this.ensureLoaded();
    const task = sanitizeTask(raw);
    if (!task) return false;
    const index = this.tasks.findIndex((t) => t.id === task.id);
    if (index === -1) return false;
    this.tasks[index] = { ...task, num: this.tasks[index].num };
    this.commit();
    return true;
  }

  remove(taskId: unknown): boolean {
    this.ensureLoaded();
    if (typeof taskId !== 'string') return false;
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== taskId);
    if (this.tasks.length === before) return false;
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
      if (this.readFromDisk()) this.onChange();
    }, LAYOUT_FILE_POLL_INTERVAL_MS);
    // Never keep a process alive just to watch the desk.
    this.pollTimer.unref?.();
  }

  /** Re-read the file. Returns true when its content changed since we last saw it. */
  private readFromDisk(): boolean {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      return false; // no desk yet
    }
    if (raw === this.lastSeen) return false;
    this.lastSeen = raw;
    try {
      ({ tasks: this.tasks, nextNum: this.nextNum } = parseFile(raw));
    } catch (err) {
      console.error('[Pixel Agents] Failed to parse task desk file:', err);
      return false;
    }
    return true;
  }

  /** tasks.md beside tasks.json: the open cards as plain text agents can read. Best effort. */
  private writeIndex(): void {
    const lines = [
      '# Pixel Office task desk',
      '',
      'Cards people put on the desk. Kept up to date by the office; do not edit.',
      `Read one card in full: ${TASK_CLI_COMMAND} show <number>`,
      'Only work on a card the office handed to you.',
      '',
    ];
    for (const task of this.tasks) {
      if (task.state === 'done' || task.state === 'draft') continue; // drafts are the human's own notes
      lines.push(
        `## #${task.num} ${task.title}`,
        `- kind: ${task.kind}, priority: ${task.priority}, state: ${task.state}`,
        `- folder: ${task.folder.root}${task.folder.branch ? ` (${task.folder.branch})` : ''}`,
        ...(task.attachments?.length
          ? [`- attached: ${task.attachments.map((a) => a.path).join(', ')}`]
          : []),
        '',
      );
    }
    try {
      fs.writeFileSync(
        path.join(path.dirname(this.filePath), TASK_DESK_INDEX_FILE_NAME),
        lines.join('\n'),
      );
    } catch {
      /* the index is a convenience; tasks.json is the record */
    }
  }

  private commit(): void {
    const file: TaskFile = { version: 1, nextNum: this.nextNum, tasks: this.tasks };
    const json = JSON.stringify(file, null, 2);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmpPath = this.filePath + '.tmp';
      fs.writeFileSync(tmpPath, json, 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
      this.lastSeen = json;
      this.writeIndex();
    } catch (err) {
      console.error('[Pixel Agents] Failed to write task desk file:', err);
    }
    this.onChange();
  }
}
