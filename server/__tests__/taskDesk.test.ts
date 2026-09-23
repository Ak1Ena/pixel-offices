import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DeskTask } from '../../core/src/messages.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { TASK_MAX_LOOK_ATTEMPTS } from '../src/constants.js';
import { createHttpServer } from '../src/httpServer.js';
import type { ServerConfig } from '../src/serverConfig.js';
import { runTaskCommand } from '../src/taskCli.js';
import { TaskDesk } from '../src/taskDesk.js';
import { TaskStore } from '../src/taskStore.js';
import type { AgentState } from '../src/types.js';

let dir: string;
const REPO = '/work/repo';
const OTHER = '/work/other';

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-desk-')));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

interface AgentInit {
  cwd?: string;
  pickup?: boolean;
  isWaiting?: boolean;
  permissionSent?: boolean;
  leadAgentId?: number;
  displayName?: string;
}

function setup(opts: { owner?: string; ownerAlive?: boolean } = {}) {
  const store = new AgentStateStore();
  const sent: Array<[number, string]> = [];
  const unreachable = new Set<number>();
  const busy = new Set<number>();
  const desk = new TaskDesk({
    store,
    chatSender: {
      canSend: (id) => !unreachable.has(id),
      isIdle: (id) => !busy.has(id),
      send: (id, text) => void sent.push([id, String(text)]),
    },
    taskStore: new TaskStore(() => {}, path.join(dir, 'tasks.json')),
    // "/work/repo/server" belongs to "/work/repo": the match is on the project root.
    resolveRoot: async (folder) => {
      if (folder.startsWith('/missing')) return null;
      const root = folder.startsWith(REPO) ? REPO : folder;
      return { root, name: path.basename(root), isGit: true, branch: 'main' };
    },
    owner: opts.owner ?? '111',
    isOwnerAlive: () => opts.ownerAlive ?? true,
  });
  const addAgent = (id: number, init: AgentInit = {}) =>
    store.set(id, {
      id,
      cwd: REPO,
      pickup: true,
      isWaiting: true,
      permissionSent: false,
      ...init,
    } as unknown as AgentState);
  const addCard = async (folder = REPO, priority = 'p2', title = 'Fix the thing') => {
    const reply = await desk.saveTask({ kind: 'issue', title, body: 'details', priority, folder });
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
  };
  const card = (task: DeskTask) => desk.show(task.id) as { ok: true; value: DeskTask };
  const status = (id: number, s: 'active' | 'waiting') =>
    store.broadcast({ type: 'agentStatus', id, status: s });
  return { store, desk, sent, unreachable, busy, addAgent, addCard, card, status };
}

const BRIEF = {
  understanding: 'You want X.',
  subtasks: ['find it', 'fix it'],
  files: ['a.ts'],
  questions: ['Which version?'],
  risk: 'low',
  size: '30 min',
};

describe('who gets a card', () => {
  it('refuses a card only read-only sessions may take — it would never be picked up', async () => {
    const t = setup();
    t.addAgent(1, { displayName: 'Terminal Tom' });
    t.addAgent(2);
    t.unreachable.add(1);
    const task = await t.addCard();
    const refused = t.desk.setAllow(task.id, [1]);
    expect(refused.ok).toBe(false);
    expect((refused as { error: string }).error).toMatch(/Terminal Tom is a read-only session/);
    expect(t.card(task).value.allow).toEqual([]);
    // One reachable agent among them is enough; junk ids are dropped.
    expect(t.desk.setAllow(task.id, [1, 2, 'x']).ok).toBe(true);
    expect(t.card(task).value.allow).toEqual([1, 2]);
    await t.desk.tick();
    expect(t.card(task).value).toMatchObject({ state: 'looking', claimedBy: 2 });
    t.desk.dispose();
  });

  it('hands an inbox card to a free agent in the same project, by its root', async () => {
    const t = setup();
    t.addAgent(1, { cwd: `${REPO}/server` });
    const task = await t.addCard();
    await t.desk.tick();
    expect(t.card(task).value).toMatchObject({ state: 'looking', claimedBy: 1, owner: '111' });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0][1]).toContain(`task show ${task.num}`);
    expect(t.sent[0][1]).toContain('Do not change any file');
    t.desk.dispose();
  });

  it('never hands a card to an agent in another folder, or one whose folder is unknown', async () => {
    const t = setup();
    t.addAgent(1, { cwd: OTHER });
    t.addAgent(2, { cwd: undefined });
    const task = await t.addCard();
    await t.desk.tick();
    expect(t.card(task).value.state).toBe('inbox');
    expect(t.sent).toEqual([]);
    t.desk.dispose();
  });

  it.each([
    ['its pick-up switch is off', { pickup: false }],
    ['it is mid-turn', { isWaiting: false }],
    ['it is showing a permission prompt', { permissionSent: true }],
    ['it is a teammate', { leadAgentId: 9 }],
  ])('skips an agent when %s', async (_why, init) => {
    const t = setup();
    t.addAgent(1, init);
    const task = await t.addCard();
    await t.desk.tick();
    expect(t.card(task).value.state).toBe('inbox');
    t.desk.dispose();
  });

  it('skips an agent the office cannot type into, or that has messages queued', async () => {
    const t = setup();
    t.addAgent(1);
    t.addAgent(2);
    t.unreachable.add(1);
    t.busy.add(2);
    const task = await t.addCard();
    await t.desk.tick();
    expect(t.card(task).value.state).toBe('inbox');
    t.desk.dispose();
  });

  it('pick-up defaults to off for agents nobody switched on', async () => {
    const t = setup();
    t.addAgent(1, { pickup: undefined });
    const task = await t.addCard();
    await t.desk.tick();
    expect(t.card(task).value.state).toBe('inbox');
    t.desk.setPickup(1, true);
    await t.desk.tick();
    expect(t.card(task).value.state).toBe('looking');
    t.desk.dispose();
  });

  it('honours "who may look", and gives one agent one card at a time, P1 first', async () => {
    const t = setup();
    const normal = await t.addCard(REPO, 'p2', 'normal');
    const urgent = await t.addCard(REPO, 'p1', 'urgent');
    t.desk.setAllow(urgent.id, [2]);
    t.desk.setAllow(normal.id, [2]);
    t.addAgent(1);
    t.addAgent(2);
    await t.desk.tick();
    expect(t.card(urgent).value).toMatchObject({ state: 'looking', claimedBy: 2 });
    expect(t.card(normal).value.state).toBe('inbox'); // agent 1 is not allowed, agent 2 is taken
    t.desk.dispose();
  });

  it('a draft stays off the desk until it is sent, and can be edited meanwhile', async () => {
    const t = setup();
    t.addAgent(1);
    const made = await t.desk.saveTask({
      kind: 'task',
      title: 'idea',
      body: '',
      priority: 'p2',
      folder: OTHER,
      draft: true,
    });
    if (!made.ok) throw new Error(made.error);
    await t.desk.tick();
    expect(t.card(made.value).value.state).toBe('draft');
    expect(t.sent).toEqual([]);

    // Still a draft after an edit — and the folder can still change.
    const edited = await t.desk.saveTask({
      taskId: made.value.id,
      kind: 'issue',
      title: 'better idea',
      body: 'b',
      priority: 'p1',
      folder: REPO,
    });
    expect(edited.ok && edited.value).toMatchObject({
      state: 'draft',
      title: 'better idea',
      kind: 'issue',
      folder: { root: REPO },
    });
    expect(t.desk.humanCall(made.value.id, { action: 'do' }).ok).toBe(false);

    expect(t.desk.humanCall(made.value.id, { action: 'publish' }).ok).toBe(true);
    await t.desk.tick();
    expect(t.card(made.value).value).toMatchObject({ state: 'looking', claimedBy: 1 });
    expect(t.desk.humanCall(made.value.id, { action: 'publish' }).ok).toBe(false);
    t.desk.dispose();
  });

  it('refuses a card for a folder that does not exist', async () => {
    const t = setup();
    const reply = await t.desk.saveTask({
      kind: 'task',
      title: 'x',
      body: '',
      priority: 'p2',
      folder: '/missing/dir',
    });
    expect(reply).toEqual({ ok: false, error: 'That folder does not exist on this computer.' });
    t.desk.dispose();
  });
});

describe('the loop from brief to done', () => {
  it('brief → verified → do → steps → done → accept', async () => {
    const t = setup();
    t.addAgent(1, { displayName: 'Mina' });
    const task = await t.addCard();
    await t.desk.tick();

    expect(t.desk.submitBrief(task.num, BRIEF).ok).toBe(true);
    let now = t.card(task).value;
    expect(now.state).toBe('brief');
    expect(now.briefs[0]).toMatchObject({
      by: 'Mina',
      subtasks: [{ title: 'find it', by: 'agent' }, { title: 'fix it' }],
    });

    // The human answers the question, drops a subtask and adds one.
    t.desk.humanCall(task.id, {
      action: 'verified',
      note: 'keep it small',
      answers: ['1.2.0'],
      subtasks: [
        { title: 'find it', skip: true, done: false, by: 'agent' },
        { title: 'fix it', skip: false, done: false, by: 'agent' },
        { title: 'add a test', skip: false, done: false, by: 'you' },
      ],
    });
    now = t.card(task).value;
    expect(now.state).toBe('ready');
    expect(now.briefs[0].questions[0].a).toBe('1.2.0');
    await t.desk.tick();
    expect(t.card(task).value.state).toBe('ready'); // verified parks it: nothing starts

    t.desk.humanCall(task.id, { action: 'do' });
    await t.desk.tick();
    now = t.card(task).value;
    expect(now).toMatchObject({ state: 'working', claimedBy: 1 });
    expect(t.sent[1][1]).toContain('Do the task');
    expect(t.sent[1][1]).toContain('its 2 steps');

    expect(t.desk.markSubtask(task.num, 2).ok).toBe(true);
    expect(t.card(task).value.briefs[0].subtasks[1].done).toBe(true);

    expect(
      t.desk.submitResult(task.num, { summary: 'fixed', branch: 'fix/x', tests: 'all passed' }).ok,
    ).toBe(true);
    now = t.card(task).value;
    expect(now).toMatchObject({
      state: 'result',
      result: { by: 'Mina', summary: 'fixed', branch: 'fix/x' },
    });
    expect(now.claimedBy).toBeUndefined();

    expect(t.desk.humanCall(task.id, { action: 'accept' }).ok).toBe(true);
    expect(t.card(task).value.state).toBe('done');
    t.desk.dispose();
  });

  it('rejected needs a reason, then the card goes round again with the old brief kept', async () => {
    const t = setup();
    t.addAgent(1);
    const task = await t.addCard();
    await t.desk.tick();
    t.desk.submitBrief(task.num, BRIEF);

    expect(t.desk.humanCall(task.id, { action: 'rejected' }).ok).toBe(false);
    expect(t.desk.humanCall(task.id, { action: 'rejected', note: 'wrong repo area' }).ok).toBe(
      true,
    );
    await t.desk.tick();
    const now = t.card(task).value;
    expect(now).toMatchObject({ state: 'looking', round: 2 });
    expect(now.briefs).toHaveLength(1);
    expect(t.sent[1][1]).toContain('round 2');
    t.desk.dispose();
  });

  it('a look that ends with no brief goes back to the inbox, then to the human', async () => {
    const t = setup();
    t.addAgent(1);
    const task = await t.addCard();
    for (let attempt = 1; attempt <= TASK_MAX_LOOK_ATTEMPTS; attempt++) {
      await t.desk.tick();
      expect(t.card(task).value.state).toBe('looking');
      t.status(1, 'waiting'); // still idle before its turn starts: NOT a turn end
      expect(t.card(task).value.state).toBe('looking');
      t.status(1, 'active');
      t.status(1, 'waiting');
      // the turn-end handler re-ticks asynchronously; settle it
      await t.desk.tick();
      await new Promise((r) => setTimeout(r, 0));
    }
    const now = t.card(task).value;
    expect(now.state).toBe('brief');
    expect(now.log.at(-1)?.text).toContain('too vague');
    t.desk.dispose();
  });

  it('a build whose turn ends without a report still lands in front of the human', async () => {
    const t = setup();
    t.addAgent(1);
    const task = await t.addCard();
    await t.desk.tick();
    t.desk.submitBrief(task.num, BRIEF);
    t.desk.humanCall(task.id, { action: 'do' });
    await t.desk.tick();
    t.status(1, 'active');
    t.status(1, 'waiting');
    expect(t.card(task).value).toMatchObject({ state: 'result' });
    expect(t.card(task).value.result?.summary).toContain('without a report');
    t.desk.dispose();
  });

  it('send back needs a reason and queues the same brief again', async () => {
    const t = setup();
    t.addAgent(1);
    const task = await t.addCard();
    await t.desk.tick();
    t.desk.submitBrief(task.num, BRIEF);
    t.desk.humanCall(task.id, { action: 'do' });
    await t.desk.tick();
    t.desk.submitResult(task.num, { summary: 'done' });
    expect(t.desk.humanCall(task.id, { action: 'sendBack' }).ok).toBe(false);
    expect(t.desk.humanCall(task.id, { action: 'sendBack', note: 'tests fail' }).ok).toBe(true);
    await t.desk.tick();
    expect(t.card(task).value.state).toBe('working');
    t.desk.dispose();
  });

  it('an agent that leaves mid-look releases its card', async () => {
    const t = setup();
    t.addAgent(1);
    const task = await t.addCard();
    await t.desk.tick();
    t.store.delete(1);
    await t.desk.tick();
    expect(t.card(task).value).toMatchObject({ state: 'inbox', attempts: 1 });
    t.desk.dispose();
  });

  it("leaves another office's claim alone while that office lives, releases it once it is gone", async () => {
    const file = path.join(dir, 'tasks.json');
    const theirs = setup({ owner: '222' });
    theirs.addAgent(1);
    const task = await theirs.addCard();
    await theirs.desk.tick();
    theirs.desk.dispose();

    for (const [alive, state] of [
      [true, 'looking'],
      [false, 'inbox'],
    ] as const) {
      const ours = setup({ owner: '111', ownerAlive: alive });
      await ours.desk.tick();
      expect(JSON.parse(fs.readFileSync(file, 'utf-8')).tasks[0].state).toBe(state);
      expect(ours.desk.submitBrief(task.num, BRIEF).ok).toBe(false);
      ours.desk.dispose();
    }
  });
});

describe('pixel-office task (agent CLI over HTTP)', () => {
  async function office() {
    const t = setup();
    const { app, port } = await createHttpServer({
      embedded: true,
      token: 'secret',
      store: t.store,
      taskDesk: () => t.desk,
    });
    const server = {
      port,
      pid: process.pid,
      token: 'secret',
      startedAt: Date.now(),
      servesSpa: false,
      protocol: 1,
    } as ServerConfig;
    return { ...t, server, port, close: () => app.close() };
  }
  const run = async (
    servers: ServerConfig[],
    argv: string[],
    files: Record<string, string> = {},
  ) => {
    const lines: string[] = [];
    const errors: string[] = [];
    const code = await runTaskCommand(argv, {
      servers,
      readFile: (f) => files[f],
      out: (l) => lines.push(l),
      err: (l) => errors.push(l),
    });
    return { code, out: lines.join('\n'), err: errors.join('\n') };
  };

  it('show, brief, step, done', async () => {
    const o = await office();
    o.addAgent(1);
    const task = await o.addCard();
    await o.desk.tick();
    const n = String(task.num);

    const shown = await run([o.server], ['show', n]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('Fix the thing');

    const briefed = await run([o.server], ['brief', n, '--file', 'b.json'], {
      'b.json': JSON.stringify(BRIEF),
    });
    expect(briefed).toMatchObject({ code: 0 });
    expect(o.card(task).value.state).toBe('brief');

    o.desk.humanCall(task.id, { action: 'do' });
    await o.desk.tick();
    expect((await run([o.server], ['step', n, '1'])).code).toBe(0);
    expect(
      (await run([o.server], ['done', n, '--summary', 'fixed it', '--tests', 'green'])).code,
    ).toBe(0);
    expect(o.card(task).value).toMatchObject({
      state: 'result',
      result: { summary: 'fixed it', tests: 'green' },
    });
    o.desk.dispose();
    await o.close();
  });

  it('gate waits for the human; step reports a mid-build plan change', async () => {
    const o = await office();
    o.addAgent(1);
    const task = await o.addCard();
    await o.desk.tick();
    const n = String(task.num);
    await run([o.server], ['brief', n, '--file', 'b.json'], {
      'b.json': JSON.stringify({
        ...BRIEF,
        subtasks: ['find it', '[gate] check with me', 'fix it'],
      }),
    });
    const steps = o.card(task).value.briefs[0].subtasks;
    expect(steps.map((s) => [s.title, s.kind])).toEqual([
      ['find it', undefined],
      ['check with me', 'gate'],
      ['fix it', undefined],
    ]);
    expect(steps.every((s) => /^s[a-f0-9]{6}$/.test(s.id ?? ''))).toBe(true);

    o.desk.humanCall(task.id, { action: 'do' });
    await o.desk.tick();
    expect(o.sent.at(-1)?.[1]).toContain(`gate ${n} <step number>`);

    const waiting = run([o.server], ['gate', n, '2', '--ask', 'Ready to fix?']);
    await new Promise((r) => setTimeout(r, 50));
    expect(o.card(task).value.briefs[0].subtasks[1]).toMatchObject({
      waiting: true,
      ask: 'Ready to fix?',
    });
    expect(o.desk.answerGate(task.id, 2, 'continue', 'go').ok).toBe(true);
    const gate = await waiting;
    expect(gate.out).toContain('go ahead');
    expect(gate.out).toContain('They said: go');
    expect(o.card(task).value.briefs[0].subtasks.map((s) => [s.done, s.skip])).toEqual([
      [false, true],
      [true, false],
      [false, false],
    ]);

    // The human adds a step after the current one; the next report says so, once.
    const current = o.card(task).value.briefs[0].subtasks;
    expect(
      o.desk.editSteps(task.id, [
        ...current,
        { title: 'write a test', skip: false, done: false, by: 'you' },
      ]).ok,
    ).toBe(true);
    const stepped = await run([o.server], ['step', n, '3']);
    expect(stepped.out).toContain('The human changed the steps');
    expect(stepped.out).toContain('write a test (added by the human)');
    expect((await run([o.server], ['step', n, '4'])).out).not.toContain('changed the steps');
    o.desk.dispose();
    await o.close();
  });

  it('an answer given between polls is kept; a card that stops being built ends the wait', async () => {
    const o = await office();
    o.addAgent(1);
    const task = await o.addCard();
    await o.desk.tick();
    o.desk.submitBrief(task.num, { ...BRIEF, subtasks: ['[gate] ok?', 'go'] });
    o.desk.humanCall(task.id, { action: 'do' });
    await o.desk.tick();
    expect(o.desk.openGate(task.num, 1, '').ok).toBe(true);
    o.desk.answerGate(task.id, 1, 'stop', 'not yet');
    expect(await o.desk.waitGate(task.num, 1, 10)).toEqual({ decision: 'stop', note: 'not yet' });

    expect(o.desk.openGate(task.num, 2, '').ok).toBe(true);
    const wait = o.desk.waitGate(task.num, 2, 5_000);
    o.desk.submitResult(task.num, { summary: 'stopped' });
    expect(await wait).toEqual({ decision: 'gone' });
    o.desk.dispose();
    await o.close();
  });

  it('explains a bad brief, an unknown card and a missing office', async () => {
    const o = await office();
    o.addAgent(1);
    const task = await o.addCard();
    await o.desk.tick();
    const bad = await run([o.server], ['brief', String(task.num), '--file', 'b.json'], {
      'b.json': '{"understanding":"x"}',
    });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('subtasks');
    expect((await run([o.server], ['show', '999'])).err).toBe('No such card.');
    expect((await run([], ['show', '1'])).err).toContain('No Pixel Office is running');
    expect((await run([o.server], ['done', '1'])).err).toContain('--summary');
    o.desk.dispose();
    await o.close();
  });

  it('refuses browsers and requests without the token', async () => {
    const o = await office();
    const url = `http://127.0.0.1:${o.port}/api/tasks/1`;
    expect((await fetch(url)).status).toBe(401);
    const withOrigin = await fetch(url, {
      headers: { Authorization: 'Bearer secret', Origin: 'http://evil.test' },
    });
    expect(withOrigin.status).toBe(403);
    o.desk.dispose();
    await o.close();
  });
});
