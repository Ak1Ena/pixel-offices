import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { DeskAgent, DeskTask } from '../../core/src/messages.js';
import {
  agentsInFolder,
  branchMismatch,
  deskSections,
  stuckReason,
  subtaskProgress,
} from '../src/taskDesk.js';

const task = (overrides: Partial<DeskTask>): DeskTask => ({
  id: 't1',
  num: 1,
  kind: 'task',
  title: 'T',
  body: '',
  priority: 'p2',
  folder: { root: '/work/repo', name: 'repo', isGit: true, branch: 'main' },
  allow: [],
  state: 'inbox',
  round: 1,
  briefs: [],
  log: [],
  createdAt: '2026-09-22T00:00:00Z',
  ...overrides,
});
const agent = (overrides: Partial<DeskAgent>): DeskAgent => ({
  id: 1,
  root: '/work/repo',
  pickup: true,
  canReach: true,
  ...overrides,
});

test('what waits on you comes first, P1 ahead; agents’ cards by how far along they are', () => {
  const sections = deskSections([
    task({ id: 'a', num: 1, state: 'inbox' }),
    task({ id: 'b', num: 2, state: 'working' }),
    task({ id: 'c', num: 3, state: 'brief' }),
    task({ id: 'd', num: 4, state: 'result', priority: 'p1' }),
    task({ id: 'e', num: 5, state: 'done' }),
    task({ id: 'f', num: 6, state: 'done' }),
  ]);
  assert.deepEqual(
    sections.needsYou.map((t) => t.id),
    ['d', 'c'],
  );
  assert.deepEqual(
    sections.inFlight.map((t) => t.id),
    ['b', 'a'],
  );
  assert.deepEqual(
    sections.done.map((t) => t.id),
    ['f', 'e'],
  );
});

test('a waiting card says why nobody is taking it', () => {
  const card = task({});
  assert.equal(stuckReason(card, []), 'No agent is working in repo.');
  assert.equal(stuckReason(card, [agent({ root: '/work/other' })]), 'No agent is working in repo.');
  assert.equal(stuckReason(card, [agent({ root: undefined })]), 'No agent is working in repo.');
  assert.equal(stuckReason(card, [agent({})]), null);
  assert.equal(
    stuckReason(card, [agent({ pickup: false })]),
    'Agents in this folder have pick-up switched off.',
  );
  assert.equal(
    stuckReason(card, [agent({ canReach: false })]),
    'The office cannot type into the agents in this folder.',
  );
  assert.equal(stuckReason(task({ allow: [7] }), [agent({})]), 'Nobody is allowed to take it.');
  // Only cards waiting for an agent can be stuck.
  assert.equal(stuckReason(task({ state: 'brief' }), []), null);
  assert.equal(stuckReason(task({ state: 'ready' }), []), null);
  assert.equal(
    stuckReason(task({ state: 'ready', queued: true }), []),
    'No agent is working in repo.',
  );
});

test('folders match the way the server matches them', () => {
  const card = task({});
  assert.equal(agentsInFolder(card, [agent({ root: '/work/repo/' })]).length, 1);
  assert.equal(agentsInFolder(card, [agent({ root: '/Work/Repo' })]).length, 1);
  assert.equal(agentsInFolder(card, [agent({ root: '/work/repo2' })]).length, 0);
  assert.equal(branchMismatch(card, agent({ branch: 'feat/x' })), true);
  assert.equal(branchMismatch(card, agent({ branch: 'main' })), false);
  assert.equal(branchMismatch(card, agent({})), false);
});

test('subtask progress leaves skipped subtasks out', () => {
  const sub = (done: boolean, skip = false) => ({ title: 's', done, skip, by: 'agent' as const });
  const brief = {
    by: 'A',
    understanding: 'u',
    files: [],
    questions: [],
    risk: '',
    size: '',
    createdAt: '',
    subtasks: [sub(true), sub(false), sub(false, true)],
  };
  assert.equal(subtaskProgress(task({ briefs: [brief] })), '1/2');
  assert.equal(subtaskProgress(task({})), null);
});
