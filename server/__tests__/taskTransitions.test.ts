import { describe, expect, it } from 'vitest';

import type { DeskTask } from '../../core/src/messages.js';
import {
  applyHumanCall,
  briefIn,
  claimForLook,
  startWork,
  subtaskDone,
} from '../src/taskTransitions.js';

const AT = '2026-09-22T00:00:00.000Z';
const base: DeskTask = {
  id: 't_1',
  num: 1,
  kind: 'task',
  title: 't',
  body: '',
  priority: 'p2',
  folder: { root: '/r', name: 'r', isGit: true },
  allow: [],
  state: 'inbox',
  round: 1,
  briefs: [],
  log: [],
  createdAt: AT,
};
const brief = {
  by: 'Mina',
  understanding: 'u',
  subtasks: [{ title: 'a', skip: false, done: true, by: 'agent' as const }],
  files: [],
  questions: [{ q: 'q?', a: '' }],
  risk: '',
  size: '',
  createdAt: AT,
};
const at = (state: DeskTask['state'], extra: Partial<DeskTask> = {}): DeskTask => ({
  ...base,
  state,
  briefs: [brief],
  ...extra,
});

describe('card transitions', () => {
  it.each([
    ['verified', 'inbox'],
    ['verified', 'ready'],
    ['verified', 'working'],
    ['do', 'inbox'],
    ['do', 'looking'],
    ['do', 'result'],
    ['rejected', 'working'],
    ['rejected', 'done'],
    ['accept', 'brief'],
    ['accept', 'working'],
    ['sendBack', 'ready'],
  ] as const)('%s is refused on a %s card', (action, state) => {
    expect(applyHumanCall(at(state), { action, note: 'n' }, AT).ok).toBe(false);
  });

  it('never mutates its input', () => {
    const task = at('brief');
    const frozen = JSON.stringify(task);
    applyHumanCall(task, { action: 'rejected', note: 'n', answers: ['x'] }, AT);
    applyHumanCall(task, { action: 'do', subtasks: [] }, AT);
    expect(JSON.stringify(task)).toBe(frozen);
  });

  it('do can start a verified card later, and refuses a card with no brief', () => {
    const r = applyHumanCall(at('ready'), { action: 'do' }, AT);
    expect(r.ok && r.task).toMatchObject({ state: 'ready', queued: true });
    expect(applyHumanCall({ ...base, state: 'brief' }, { action: 'do' }, AT).ok).toBe(false);
  });

  it('system moves check the state they start from', () => {
    expect(claimForLook(at('brief'), 1).ok).toBe(false);
    expect(briefIn(at('inbox'), brief, AT).ok).toBe(false);
    expect(startWork(at('ready'), 1).ok).toBe(false); // verified but not queued
    expect(subtaskDone(at('working'), 9).ok).toBe(false);
    const started = startWork(at('ready', { queued: true }), 1);
    expect(started.ok && started.task.briefs[0].subtasks[0].done).toBe(false); // a rebuild starts clean
  });
});
