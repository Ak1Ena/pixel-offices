import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BoardPin } from '../../core/src/messages.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { FocusRequests, guessAgent } from '../src/focusRequests.js';
import { findLine, parseShowArgs } from '../src/showCli.js';
import type { AgentState } from '../src/types.js';

function agent(overrides: Partial<AgentState>): AgentState {
  return {
    id: 0,
    sessionId: 's',
    isExternal: false,
    projectDir: '/p',
    jsonlFile: '/p/s.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

function memoryBoard() {
  const pins: BoardPin[] = [];
  return {
    pins,
    getPins: () => pins.map((p) => ({ ...p })),
    savePin: (pin: unknown) => {
      pins.push(pin as BoardPin);
      return true;
    },
  };
}

describe('focus requests', () => {
  let dir: string;
  let file: string;
  let store: AgentStateStore;
  let board: ReturnType<typeof memoryBoard>;
  let focus: FocusRequests;
  let broadcasts: Array<{ type: string }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-'));
    file = path.join(dir, 'session.ts.txt');
    fs.writeFileSync(file, 'a\nb\nc\n');
    store = new AgentStateStore();
    broadcasts = [];
    store.on('broadcast', (m) => broadcasts.push(m as { type: string }));
    board = memoryBoard();
    focus = new FocusRequests(store, () => board);
  });
  afterEach(() => {
    focus.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('opens a request on a file pin and broadcasts it', () => {
    const result = focus.open({ path: file, lineStart: 2, lineEnd: 3, why: 'look here' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(board.pins).toHaveLength(1);
    expect(board.pins[0]).toMatchObject({ kind: 'file', value: file });
    expect(result.request).toMatchObject({
      pinId: board.pins[0].id,
      lineStart: 2,
      lineEnd: 3,
      why: 'look here',
      state: 'waiting',
    });
    expect(broadcasts.at(-1)?.type).toBe('focusRequests');
  });

  it('reuses the pin of a file already on the board', () => {
    focus.open({ path: file });
    focus.open({ path: file, page: 2 });
    expect(board.pins).toHaveLength(1);
  });

  it('refuses relative paths, missing files and types the viewer cannot open', () => {
    expect(focus.open({ path: 'rel.txt' }).ok).toBe(false);
    expect(focus.open({ path: path.join(dir, 'nope.txt') }).ok).toBe(false);
    const exe = path.join(dir, 'x.html');
    fs.writeFileSync(exe, '<script>');
    expect(focus.open({ path: exe }).ok).toBe(false);
  });

  it('hands a waiting poller the reply', async () => {
    const result = focus.open({ path: file });
    if (!result.ok) throw new Error(result.error);
    const poll = focus.wait(result.request.requestId, 5_000);
    expect(focus.answer(result.request.requestId, 'yes, add the lock')).toBe(true);
    await expect(poll).resolves.toEqual({ state: 'seen', reply: 'yes, add the lock' });
    expect(focus.answer(result.request.requestId)).toBe(false);
  });

  it('sends a reply nobody waits for to the agent as a message', () => {
    const sent: Array<[number, string]> = [];
    const f = new FocusRequests(
      store,
      () => board,
      (id, text) => sent.push([id, text]),
    );
    store.set(1, agent({ id: 1, cwd: dir }));
    const result = f.open({ path: file, cwd: dir, lineStart: 2 });
    if (!result.ok) throw new Error(result.error);
    f.answer(result.request.requestId, 'fine');
    expect(sent).toEqual([[1, `About @${file} line 2: fine`]]);
    f.dispose();
  });

  it('keeps one open request per agent', async () => {
    store.set(1, agent({ id: 1, cwd: dir }));
    const first = focus.open({ path: file, cwd: dir });
    if (!first.ok) throw new Error(first.error);
    const poll = focus.wait(first.request.requestId, 5_000);
    focus.open({ path: file, cwd: dir, lineStart: 3 });
    await expect(poll).resolves.toEqual({ state: 'gone' });
    expect(focus.snapshot().requests).toHaveLength(1);
  });

  it('drops an agent’s requests when the agent goes', () => {
    store.set(1, agent({ id: 1, cwd: dir }));
    focus.open({ path: file, cwd: dir });
    store.delete(1);
    expect(focus.snapshot().requests).toHaveLength(0);
  });
});

describe('which agent asked', () => {
  it('prefers the named agent, then the busy one in the folder', () => {
    const agents = [
      agent({ id: 1, cwd: '/repo', displayName: 'auth-fix' }),
      agent({ id: 2, cwd: '/repo', activeToolIds: new Set(['t']) }),
      agent({ id: 3, cwd: '/other' }),
    ];
    expect(guessAgent(agents, { agent: 'AUTH-FIX' })).toBe(1);
    expect(guessAgent(agents, { cwd: '/repo/src' })).toBe(2);
    expect(guessAgent(agents, { cwd: '/other' })).toBe(3);
    expect(guessAgent(agents, { cwd: '/elsewhere' })).toBeUndefined();
  });
});

describe('pixel-office show arguments', () => {
  it('parses a range, a page, a cell and --wait', () => {
    expect(parseShowArgs(['a.ts', '--lines', '58-40', '--why', 'hi', '--wait'])).toMatchObject({
      path: 'a.ts',
      lineStart: 40,
      lineEnd: 58,
      why: 'hi',
      wait: true,
    });
    expect(parseShowArgs(['r.pdf', '--page', '3'])).toMatchObject({ page: 3 });
    expect(parseShowArgs(['b.xlsx', '--cell', 'Q3!B4'])).toMatchObject({ cell: 'Q3!B4' });
  });

  it('rejects bad input', () => {
    expect(() => parseShowArgs([])).toThrow();
    expect(() => parseShowArgs(['a', '--lines', 'x'])).toThrow();
    expect(() => parseShowArgs(['a', 'b'])).toThrow();
  });

  it('turns --find into a line', () => {
    expect(findLine('one\nTwo words\nthree', 'two')).toBe(2);
    expect(findLine('one', 'zzz')).toBeUndefined();
  });
});
