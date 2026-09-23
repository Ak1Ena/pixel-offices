import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { BoardPin, FocusRequest } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { isViewableName } from './boardFiles.js';
import {
  FOCUS_ANSWERED_KEEP_MS,
  FOCUS_CELL_MAX_CHARS,
  FOCUS_MAX_REQUESTS,
  FOCUS_REPLY_MAX_CHARS,
  FOCUS_REQUEST_MAX_AGE_MS,
  FOCUS_WHY_MAX_CHARS,
} from './constants.js';
import type { AgentState } from './types.js';

/**
 * "Show me": an agent points the user at part of a file (`pixel-office show`).
 *
 * Only the PATH travels. The request rides on a board file pin, so the office's
 * document viewer loads it through the existing pin route with all of that
 * route's checks (allowlisted types, realpath, size cap, token). Requests live
 * in memory: they are about the running session and mean nothing after a
 * restart, while the pin stays on the board.
 */

export interface FocusInput {
  /** Absolute path (the CLI resolves `~` and relative paths). */
  path: string;
  lineStart?: number;
  lineEnd?: number;
  page?: number;
  cell?: string;
  why?: string;
  /** Agent name (display or team name) given with `--agent`. */
  agent?: string;
  /** Where the command ran — used to tell which agent asked. */
  cwd?: string;
}

export type FocusOpenResult = { ok: true; request: FocusRequest } | { ok: false; error: string };

/** What a `--wait` poll gets: the answer, or "keep waiting", or "gone". */
export type FocusPoll =
  { state: 'seen'; reply?: string } | { state: 'pending' } | { state: 'gone' };

export interface FocusBoard {
  getPins(): BoardPin[];
  savePin(pin: unknown): boolean;
}

const CELL_RE = /^[A-Za-z0-9 _.'!:$-]+$/;

function positiveInt(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trim()
    .slice(0, max);
  return text || undefined;
}

/**
 * Which agent ran the command: the named one, else the agent working in that
 * folder — preferring one mid-tool, since `show` runs inside a Bash tool call.
 */
export function guessAgent(
  agents: Iterable<AgentState>,
  input: Pick<FocusInput, 'agent' | 'cwd'>,
): number | undefined {
  const list = [...agents].filter((a) => !a.leadAgentId || a.agentName);
  if (input.agent) {
    const wanted = input.agent.toLowerCase();
    return list.find(
      (a) => a.displayName?.toLowerCase() === wanted || a.agentName?.toLowerCase() === wanted,
    )?.id;
  }
  if (!input.cwd) return undefined;
  const cwd = path.resolve(input.cwd);
  const inFolder = list.filter(
    (a) => a.cwd && (cwd === path.resolve(a.cwd) || cwd.startsWith(path.resolve(a.cwd) + path.sep)),
  );
  const busy = inFolder.filter((a) => a.activeToolIds.size > 0);
  if (busy.length === 1) return busy[0].id;
  return inFolder.length === 1 ? inFolder[0].id : undefined;
}

/** "session.ts lines 40-58", for messages about a request. */
export function describeSpot(r: FocusRequest): string {
  const where = r.lineStart
    ? r.lineEnd && r.lineEnd !== r.lineStart
      ? ` lines ${r.lineStart}-${r.lineEnd}`
      : ` line ${r.lineStart}`
    : r.page
      ? ` page ${r.page}`
      : r.cell
        ? ` cell ${r.cell}`
        : '';
  return `@${r.path}${where}`;
}

export class FocusRequests {
  private requests: FocusRequest[] = [];
  private readonly waiters = new Map<string, Set<(poll: FocusPoll) => void>>();

  constructor(
    private readonly store: AgentStateStore,
    private readonly board: () => FocusBoard,
    /** Types a reply into the agent's terminal when no `--wait` is there to take it. */
    private readonly deliver: (agentId: number, text: string) => void = () => {},
  ) {
    store.on('agentRemoved', this.onAgentRemoved);
  }

  /** Every request, for the handshake and broadcasts. */
  snapshot(): { type: 'focusRequests'; requests: FocusRequest[] } {
    this.prune();
    return { type: 'focusRequests', requests: this.requests.map((r) => ({ ...r })) };
  }

  open(raw: unknown): FocusOpenResult {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'Expected a JSON object.' };
    const input = raw as Record<string, unknown>;
    if (typeof input.path !== 'string' || !path.isAbsolute(input.path)) {
      return { ok: false, error: 'path must be an absolute path.' };
    }
    const filePath = path.normalize(input.path);
    if (!isViewableName(filePath)) {
      return {
        ok: false,
        error:
          'The office viewer opens PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), CSV, text, markdown, JSON, logs and images.',
      };
    }
    try {
      if (!fs.statSync(filePath).isFile()) return { ok: false, error: `Not a file: ${filePath}` };
    } catch {
      return { ok: false, error: `No such file: ${filePath}` };
    }

    const lineStart = positiveInt(input.lineStart);
    const lineEnd = positiveInt(input.lineEnd);
    const page = positiveInt(input.page);
    const cellText = cleanText(input.cell, FOCUS_CELL_MAX_CHARS);
    const cell = cellText && CELL_RE.test(cellText) ? cellText : undefined;
    const why = cleanText(input.why, FOCUS_WHY_MAX_CHARS);

    const pinId = this.pinFor(filePath);
    if (!pinId) return { ok: false, error: 'The whiteboard is full.' };

    const agentId = guessAgent(this.store.values(), {
      agent: typeof input.agent === 'string' ? input.agent : undefined,
      cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
    });
    // One open request per agent: a newer one replaces it.
    if (agentId !== undefined) {
      for (const old of this.requests.filter(
        (r) => r.agentId === agentId && r.state === 'waiting',
      )) {
        this.drop(old.requestId);
      }
    }

    const request: FocusRequest = {
      requestId: `focus_${crypto.randomUUID().replace(/-/g, '')}`,
      pinId,
      path: filePath,
      ...(agentId !== undefined ? { agentId } : {}),
      ...(why ? { why } : {}),
      ...(lineStart ? { lineStart, lineEnd: Math.max(lineStart, lineEnd ?? lineStart) } : {}),
      ...(page ? { page } : {}),
      ...(cell ? { cell } : {}),
      state: 'waiting',
      createdAt: new Date().toISOString(),
    };
    this.requests.push(request);
    this.prune();
    this.broadcast();
    return { ok: true, request: { ...request } };
  }

  /** "Got it" (no reply) or a reply for an agent waiting on `--wait`. */
  answer(requestId: unknown, reply?: unknown): boolean {
    const request = this.requests.find((r) => r.requestId === requestId);
    if (!request || request.state !== 'waiting') return false;
    request.state = 'seen';
    const text = cleanText(reply, FOCUS_REPLY_MAX_CHARS);
    if (text) request.reply = text;
    const waited = this.waiters.has(request.requestId);
    this.settle(request.requestId, { state: 'seen', ...(text ? { reply: text } : {}) });
    // Nobody is blocked on `--wait` for it: the reply goes to the agent as a message.
    if (text && !waited && request.agentId !== undefined) {
      this.deliver(request.agentId, `About ${describeSpot(request)}: ${text}`);
    }
    this.broadcast();
    return true;
  }

  /** Long-poll for the answer; resolves `pending` after `ms` with none. */
  wait(requestId: string, ms: number): Promise<FocusPoll> {
    const request = this.requests.find((r) => r.requestId === requestId);
    if (!request) return Promise.resolve({ state: 'gone' });
    if (request.state === 'seen') {
      return Promise.resolve({ state: 'seen', ...(request.reply ? { reply: request.reply } : {}) });
    }
    return new Promise((resolve) => {
      const waiters = this.waiters.get(requestId) ?? new Set();
      this.waiters.set(requestId, waiters);
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        resolve({ state: 'pending' });
      }, ms);
      timer.unref?.();
      const waiter = (poll: FocusPoll) => {
        clearTimeout(timer);
        resolve(poll);
      };
      waiters.add(waiter);
    });
  }

  dispose(): void {
    this.store.off('agentRemoved', this.onAgentRemoved);
    for (const id of [...this.waiters.keys()]) this.settle(id, { state: 'gone' });
  }

  private readonly onAgentRemoved = (agentId: number): void => {
    const gone = this.requests.filter((r) => r.agentId === agentId);
    if (gone.length === 0) return;
    for (const request of gone) this.drop(request.requestId);
    this.broadcast();
  };

  /** The file pin for `filePath`: an existing one, or a new one. */
  private pinFor(filePath: string): string | null {
    const board = this.board();
    const existing = board.getPins().find((p) => p.kind === 'file' && p.value === filePath);
    if (existing) return existing.id;
    const pin = {
      id: `pin_${crypto.randomUUID().replace(/-/g, '')}`,
      kind: 'file',
      title: path.basename(filePath),
      value: filePath,
      scope: [],
      createdAt: new Date().toISOString(),
    };
    return board.savePin(pin) ? pin.id : null;
  }

  private drop(requestId: string): void {
    this.requests = this.requests.filter((r) => r.requestId !== requestId);
    this.settle(requestId, { state: 'gone' });
  }

  private settle(requestId: string, poll: FocusPoll): void {
    const waiters = this.waiters.get(requestId);
    if (!waiters) return;
    this.waiters.delete(requestId);
    for (const waiter of waiters) waiter(poll);
  }

  /** Old waiting requests expire; answered ones linger briefly for late polls. */
  private prune(): void {
    const now = Date.now();
    for (const r of [...this.requests]) {
      const age = now - Date.parse(r.createdAt);
      if (age > FOCUS_REQUEST_MAX_AGE_MS || (r.state === 'seen' && age > FOCUS_ANSWERED_KEEP_MS)) {
        this.drop(r.requestId);
      }
    }
    while (this.requests.length > FOCUS_MAX_REQUESTS) this.drop(this.requests[0].requestId);
  }

  private broadcast(): void {
    this.store.broadcast(this.snapshot());
  }
}
