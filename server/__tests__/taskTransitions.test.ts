import { describe, expect, it } from 'vitest';

import type { DeskSubtask, DeskTask } from '../../core/src/messages.js';
import {
  applyHumanCall,
  briefIn,
  claimForLook,
  editSteps,
  gateAnswered,
  gateOpened,
  lockedSteps,
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

describe('card steps', () => {
  const step = (id: string, extra: Partial<DeskSubtask> = {}): DeskSubtask => ({
    id,
    title: id,
    skip: false,
    done: false,
    by: 'agent',
    ...extra,
  });
  const card = (state: DeskTask['state'], subtasks: DeskSubtask[]): DeskTask => ({
    ...base,
    state,
    claimedBy: state === 'working' ? 1 : undefined,
    briefs: [{ ...brief, subtasks }],
  });
  const ids = (t: DeskTask) => t.briefs[0].subtasks.map((s) => s.id);

  it('locks nothing before the build, and done steps plus the current one during it', () => {
    expect(lockedSteps(card('brief', [step('a'), step('b')]))).toBe(0);
    expect(lockedSteps(card('working', [step('a'), step('b')]))).toBe(1);
    expect(
      lockedSteps(
        card('working', [step('a', { done: true }), step('b', { skip: true }), step('c')]),
      ),
    ).toBe(3);
    expect(lockedSteps(card('working', [step('a', { done: true })]))).toBe(1);
  });

  it('lets the human reorder, retype and add steps while the brief waits', () => {
    const r = editSteps(
      card('brief', [step('a'), step('b')]),
      [step('b', { kind: 'gate' }), step('a'), step('c')],
      AT,
    );
    if (!r.ok) throw new Error(r.error);
    expect(ids(r.task)).toEqual(['b', 'a', 'c']);
    expect(r.task.briefs[0].subtasks[0].kind).toBe('gate');
    expect(r.task.briefs[0].subtasks[2].by).toBe('you');
    expect(r.task.log.at(-1)?.text).toBe('Changed the steps.');
  });

  it('mid-build, keeps the locked steps first and unchanged, and frees the rest', () => {
    const working = card('working', [step('a', { done: true }), step('b'), step('c'), step('d')]);
    const moved = editSteps(working, [step('a'), step('b'), step('d'), step('c')], AT);
    if (!moved.ok) throw new Error(moved.error);
    expect(ids(moved.task)).toEqual(['a', 'b', 'd', 'c']);
    expect(moved.task.briefs[0].subtasks[0].done).toBe(true); // the old locked step, not the sent copy
    expect(editSteps(working, [step('b'), step('a'), step('c')], AT).ok).toBe(false);
    expect(editSteps(working, [step('a'), step('c')], AT).ok).toBe(false);
  });

  it('refuses edits where there is nothing to change', () => {
    expect(editSteps(card('done', [step('a')]), [], AT).ok).toBe(false);
    expect(editSteps({ ...base, state: 'brief' }, [], AT).ok).toBe(false);
  });

  it('a report past pending steps marks them skipped', () => {
    const r = subtaskDone(card('working', [step('a'), step('b'), step('c')]), 3);
    if (!r.ok) throw new Error(r.error);
    expect(r.task.briefs[0].subtasks.map((s) => [s.done, s.skip])).toEqual([
      [false, true],
      [false, true],
      [true, false],
    ]);
  });

  it('a gate waits for the human; continue marks it done, stop does not', () => {
    const opened = gateOpened(card('working', [step('a', { kind: 'gate' })]), 1, 'OK?', 'Mina', AT);
    if (!opened.ok) throw new Error(opened.error);
    expect(opened.task.briefs[0].subtasks[0]).toMatchObject({ waiting: true, ask: 'OK?' });
    expect(opened.task.log.at(-1)?.text).toMatch(/step 1 .*OK\?/);

    const go = gateAnswered(opened.task, 1, 'continue', 'looks good', AT);
    if (!go.ok) throw new Error(go.error);
    expect(go.task.briefs[0].subtasks[0]).toMatchObject({ done: true });
    expect(go.task.briefs[0].subtasks[0].waiting).toBeUndefined();

    const stop = gateAnswered(opened.task, 1, 'stop', '', AT);
    if (!stop.ok) throw new Error(stop.error);
    expect(stop.task.briefs[0].subtasks[0].done).toBe(false);
    expect(stop.task.log.at(-1)?.kind).toBe('rejected');

    expect(gateAnswered(go.task, 1, 'continue', '', AT).ok).toBe(false);
  });
});
