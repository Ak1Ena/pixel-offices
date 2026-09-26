import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DeskTask } from '../../core/src/messages.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { type AutopilotSettings, parseAutopilot } from '../src/configPersistence.js';
import { AUTOPILOT_FIRST_MESSAGE } from '../src/constants.js';
import type { Decider, DecisionAnswer } from '../src/decisions.js';
import { type AutopilotStarter, DeskAutopilot } from '../src/deskAutopilot.js';
import { TaskDesk } from '../src/taskDesk.js';
import { TaskStore } from '../src/taskStore.js';
import type { AgentState } from '../src/types.js';

const REPO = '/work/repo';
let dir: string;
let desks = 0;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-autopilot-')));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Answers every question with `answer(key)`, tagged as the English checkpoint. */
function decider(answer: (key: string) => DecisionAnswer | undefined): Decider {
  return {
    ask: async (_state, questions) =>
      Object.fromEntries(
        Object.keys(questions).flatMap((k) => {
          const a = answer(k);
          return a ? [[k, { ...a, model: 'english' }]] : [];
        }),
      ),
  };
}

function setup(
  opts: { settings?: Partial<AutopilotSettings>; decider?: Decider; models?: string[] } = {},
) {
  const store = new AgentStateStore();
  const sent: Array<[number, string]> = [];
  let clock = 1_000_000;
  let settings = parseAutopilot({ enabled: true, maxAgents: 2, idleMinutes: 10, ...opts.settings });
  const started: Array<Record<string, unknown>> = [];
  const stopped: string[] = [];
  const adopted = new Map<string, number>();
  const starter: AutopilotStarter = {
    start: (req) => {
      started.push(req);
      return { ok: true, sessionId: `s${started.length}` };
    },
    agentIdFor: (sessionId) => adopted.get(sessionId),
    stopSession: (sessionId) => void stopped.push(sessionId) || true,
  };
  const autopilot = new DeskAutopilot({
    store,
    decider: () => opts.decider ?? null,
    starter: () => starter,
    routing: () => ({
      teams: [],
      workflows: [],
      models: (opts.models ?? []).map((label, i) => ({ number: i + 1, label, detail: label })),
    }),
    readSettings: () => settings,
    writeSettings: (change) => (settings = parseAutopilot(change, settings)),
    nowMs: () => clock,
  });
  const desk = new TaskDesk({
    store,
    chatSender: {
      canSend: () => true,
      isIdle: () => true,
      send: (id, text) => void sent.push([id, String(text)]),
    },
    taskStore: new TaskStore(() => {}, path.join(dir, `tasks-${++desks}.json`)),
    resolveRoot: async (folder) => ({
      root: folder,
      name: path.basename(folder),
      isGit: true,
      branch: 'main',
    }),
    owner: '111',
    isOwnerAlive: () => true,
    decider: () => opts.decider ?? null,
    autopilot,
  });
  const addAgent = (id: number) =>
    store.set(id, {
      id,
      cwd: REPO,
      pickup: true,
      isWaiting: true,
      permissionSent: false,
    } as unknown as AgentState);
  const addCard = async (title = 'Fix the thing') => {
    const reply = await desk.saveTask({
      kind: 'issue',
      title,
      body: 'details',
      priority: 'p2',
      folder: REPO,
    });
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
  };
  const card = (task: DeskTask) => (desk.show(task.id) as { ok: true; value: DeskTask }).value;
  const advance = (ms: number) => (clock += ms);
  return {
    store,
    desk,
    sent,
    started,
    stopped,
    adopted,
    autopilot,
    addAgent,
    addCard,
    card,
    advance,
  };
}

describe('desk autopilot', () => {
  it('does nothing while off', async () => {
    const t = setup({ settings: { enabled: false } });
    const task = await t.addCard();
    await t.desk.tick();
    expect(t.card(task).autoRouted).toBeUndefined();
    expect(t.started).toEqual([]);
    t.desk.dispose();
  });

  it('routes a new card and starts an agent in its folder when nobody can take it', async () => {
    const t = setup();
    const task = await t.addCard();
    await t.desk.tick();
    expect(t.card(task).autoRouted).toBe(true);
    expect(t.card(task).log.at(-1)?.text).toMatch(/One agent/);
    expect(t.started).toEqual([
      { cwd: REPO, command: 'claude', firstMessage: AUTOPILOT_FIRST_MESSAGE },
    ]);
    // The agent on its way counts: no second start for the same card.
    await t.desk.tick();
    expect(t.started).toHaveLength(1);
    t.desk.dispose();
  });

  it('never starts more than its limit', async () => {
    const t = setup({ settings: { maxAgents: 1 } });
    await t.addCard('one');
    await t.addCard('two');
    await t.desk.tick();
    expect(t.started).toHaveLength(1);
    t.desk.dispose();
  });

  it('gives a card to a free agent instead of starting one', async () => {
    const t = setup();
    t.addAgent(1);
    const task = await t.addCard();
    await t.desk.tick();
    expect(t.card(task)).toMatchObject({ state: 'looking', claimedBy: 1 });
    expect(t.started).toEqual([]);
    t.desk.dispose();
  });

  it('takes a confident model pick from the decision model, and starts the agent with it', async () => {
    const t = setup({
      decider: decider((k) => (k === 'model' ? { choice: 'opus', confidence: 0.9 } : undefined)),
      models: ['Opus', 'Haiku'],
    });
    const task = await t.addCard('Rewrite the auth system');
    await t.desk.tick();
    await settle();
    await t.desk.tick();
    expect(t.card(task).model).toBe('Opus');
    expect(t.card(task).log.some((l) => /Laya chose model Opus/.test(l.text))).toBe(true);
    expect(t.started[0]).toMatchObject({ model: 'Opus' });
    t.desk.dispose();
  });

  it('builds a brief nobody has to answer, and leaves questions and risky plans to the human', async () => {
    const brief = (questions: string[], risk = 'low') => ({
      understanding: 'You want X.',
      subtasks: ['do it'],
      files: [],
      questions,
      risk,
      size: 'small',
    });
    const t = setup();
    t.addAgent(1);
    const plain = await t.addCard('plain');
    await t.desk.tick();
    t.desk.submitBrief(plain.num, brief([]));
    await t.desk.tick();
    expect(t.card(plain)).toMatchObject({ state: 'working' });
    expect(t.card(plain).log.some((l) => l.who === 'Autopilot')).toBe(true);

    const t2 = setup();
    t2.addAgent(1);
    const asks = await t2.addCard('asks');
    await t2.desk.tick();
    t2.desk.submitBrief(asks.num, brief(['Which version?']));
    await t2.desk.tick();
    expect(t2.card(asks).state).toBe('brief');

    const t3 = setup();
    t3.addAgent(1);
    const risky = await t3.addCard('risky');
    await t3.desk.tick();
    t3.desk.submitBrief(risky.num, brief([], 'high'));
    await t3.desk.tick();
    expect(t3.card(risky).state).toBe('brief');
    for (const x of [t, t2, t3]) x.desk.dispose();
  });

  it('leaves a plan the decision model confidently sends to the human', async () => {
    const t = setup({
      decider: decider((k) => (k === 'plan' ? { choice: 'ask', confidence: 0.9 } : undefined)),
    });
    t.addAgent(1);
    const task = await t.addCard();
    await t.desk.tick();
    await settle();
    await t.desk.tick();
    t.desk.submitBrief(task.num, {
      understanding: 'Drop the users table.',
      subtasks: ['drop it'],
      files: [],
      questions: [],
      risk: 'medium',
      size: 'small',
    });
    await t.desk.tick();
    await settle();
    await t.desk.tick();
    expect(t.card(task).state).toBe('brief');
    t.desk.dispose();
  });

  it('closes only its own agents, and only after they sat idle with no card', async () => {
    const t = setup();
    const task = await t.addCard();
    await t.desk.tick();
    expect(t.started).toHaveLength(1);
    // Its agent shows up and takes the card; somebody else's agent 8 is idle all along.
    t.adopted.set('s1', 7);
    t.addAgent(7);
    await t.desk.tick();
    expect(t.card(task).claimedBy).toBe(7);
    t.addAgent(8);
    // Holding a card is not idle, however long it takes.
    t.advance(11 * 60_000);
    await t.desk.tick();
    expect(t.stopped).toEqual([]);
    // The look ends with a question for the human: agent 7 is free from now on.
    t.desk.submitBrief(task.num, {
      understanding: 'x',
      subtasks: ['y'],
      files: [],
      questions: ['Which one?'],
      risk: 'low',
      size: 's',
    });
    await t.desk.tick();
    t.advance(9 * 60_000);
    await t.desk.tick();
    expect(t.stopped).toEqual([]);
    t.advance(2 * 60_000);
    await t.desk.tick();
    expect(t.stopped).toEqual(['s1']);
    expect(t.autopilot.snapshot()).toMatchObject({ running: 0 });
    t.desk.dispose();
  });
});
