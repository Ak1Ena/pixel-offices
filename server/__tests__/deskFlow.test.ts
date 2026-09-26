import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DeskColumnDef, DeskTask } from '../../core/src/messages.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import type { Decider, DecisionAnswer } from '../src/decisions.js';
import { DeskFlowStore, placeCard, sanitizeColumns } from '../src/deskFlow.js';
import { TaskDesk } from '../src/taskDesk.js';
import { TaskStore } from '../src/taskStore.js';
import type { AgentState } from '../src/types.js';

const REPO = '/work/repo';
let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-flow-')));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const settle = () => new Promise((resolve) => setImmediate(resolve));

const COLUMNS = [
  { name: 'Coding', description: 'writing code', phase: 'working', laya: true },
  { name: 'Testing', description: 'running or fixing tests', phase: 'working', laya: true },
  { name: 'Blocked', description: 'waiting on something outside', phase: 'working', laya: false },
];

describe('board columns', () => {
  it('keeps valid columns only, with unique ids', () => {
    const cols = sanitizeColumns([
      ...COLUMNS,
      { name: 'Coding', phase: 'working' },
      { name: '', phase: 'working' },
      { name: 'x', phase: 'nope' },
      7,
    ]);
    expect(cols.map((c) => c.id)).toEqual(['coding', 'testing', 'blocked', 'coding-2']);
    expect(cols[3]).toMatchObject({ description: '', laya: false });
  });

  it("places a card in its state's first column unless it sits in one of them", () => {
    const cols = sanitizeColumns(COLUMNS);
    const card = { state: 'working' } as DeskTask;
    expect(placeCard(card, cols)).toBe('coding');
    expect(placeCard({ ...card, column: 'testing' }, cols)).toBe('testing');
    expect(placeCard({ ...card, state: 'inbox', column: 'testing' }, cols)).toBeUndefined();
  });

  it('saves to its file and re-reads it', () => {
    const file = path.join(dir, 'flow.json');
    const seen: DeskColumnDef[][] = [];
    const store = new DeskFlowStore((c) => seen.push(c), file);
    store.save(COLUMNS);
    const again = new DeskFlowStore(() => {}, file);
    expect(again.list().map((c) => c.name)).toEqual(['Coding', 'Testing', 'Blocked']);
    expect(seen).toHaveLength(1);
    store.dispose();
    again.dispose();
  });
});

function setup(answer?: (key: string) => DecisionAnswer | undefined) {
  const store = new AgentStateStore();
  const flow = new DeskFlowStore(() => {}, path.join(dir, 'flow.json'));
  flow.save(COLUMNS);
  const decider: Decider | null = answer
    ? {
        ask: async (_s, questions) =>
          Object.fromEntries(
            Object.keys(questions).flatMap((k) => {
              const a = answer(k);
              return a ? [[k, { ...a, model: 'english' }]] : [];
            }),
          ),
      }
    : null;
  const desk = new TaskDesk({
    store,
    chatSender: { canSend: () => true, isIdle: () => true, send: () => {} },
    taskStore: new TaskStore(() => {}, path.join(dir, 'tasks.json')),
    resolveRoot: async (folder) => ({ root: folder, name: 'repo', isGit: true }),
    owner: '1',
    isOwnerAlive: () => true,
    decider: () => decider,
    flow,
  });
  store.set(1, {
    id: 1,
    cwd: REPO,
    pickup: true,
    isWaiting: true,
    permissionSent: false,
  } as unknown as AgentState);
  const card = (t: DeskTask) => (desk.show(t.id) as { ok: true; value: DeskTask }).value;
  /** A card being built by agent 1, with the given steps. */
  const building = async (steps = ['write it', 'test it']) => {
    const r = await desk.saveTask({
      kind: 'task',
      title: 'X',
      body: '',
      priority: 'p2',
      folder: REPO,
    });
    if (!r.ok) throw new Error(r.error);
    await desk.tick();
    desk.submitBrief(r.value.num, {
      understanding: 'u',
      subtasks: steps,
      files: [],
      questions: [],
      risk: 'low',
      size: 's',
    });
    desk.humanCall(r.value.id, { action: 'do' });
    await desk.tick();
    return r.value;
  };
  /** Agent 1 finishes a turn saying `text`. */
  const turn = async (text: string) => {
    store.set(1, {
      ...store.get(1)!,
      chatLog: [{ role: 'assistant', text }],
    } as unknown as AgentState);
    store.broadcast({ type: 'agentStatus', id: 1, status: 'active' });
    store.broadcast({ type: 'agentStatus', id: 1, status: 'waiting' });
    await settle();
    await settle();
  };
  return { store, desk, flow, card, building, turn };
}

describe('columns on the desk', () => {
  it('a card changing state lands in the first column; the human moves it within its state', async () => {
    const t = setup();
    const task = await t.building();
    expect(t.card(task)).toMatchObject({ state: 'working', column: 'coding' });
    expect(t.desk.setColumn(task.id, 'blocked').ok).toBe(true);
    expect(t.card(task).column).toBe('blocked');
    expect(t.desk.setColumn(task.id, 'nope').ok).toBe(false);
    t.desk.dispose();
  });

  it('Laya moves a card to the column its reply fits, only into columns open to her', async () => {
    const t = setup((k) => (k === 'column' ? { choice: 'testing', confidence: 0.9 } : undefined));
    const task = await t.building();
    // A reply mid-turn (the card is still being built).
    t.store.broadcast({
      type: 'agentChatEntry',
      id: 1,
      entry: { entryId: 'e1', role: 'assistant', text: 'Code written; running the tests now.' },
    });
    await settle();
    expect(t.card(task)).toMatchObject({ state: 'working', column: 'testing' });
    expect(t.card(task).log.some((l) => l.who === 'Laya' && /Testing/.test(l.text))).toBe(true);
    t.desk.dispose();
  });

  it('Laya ticks steps the reply says are done, and nothing else', async () => {
    const t = setup((k) =>
      k === 's0' ? { noul: 0.95 } : k.startsWith('s') ? { noul: 0.1 } : undefined,
    );
    const task = await t.building(['write it', 'test it', 'ship it']);
    await t.turn('I wrote it. Tests next.');
    const steps = t.card(task).briefs.at(-1)!.subtasks;
    expect(steps.map((s) => s.done)).toEqual([true, false, false]);
    expect(steps.some((s) => s.skip)).toBe(false);
    t.desk.dispose();
  });
});
