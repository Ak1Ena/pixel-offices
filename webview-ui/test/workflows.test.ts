import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { WorkflowRun } from '../../core/src/messages.js';
import { activeRun, moveStep, openGates, previewMarkdown, runProgress } from '../src/workflows.js';

const run = (over: Partial<WorkflowRun>): WorkflowRun => ({
  runId: 'w000001',
  workflowId: 'w',
  title: 'W',
  agentId: 1,
  state: 'running',
  startedAt: '',
  steps: [
    { kind: 'do', text: 'a', state: 'done' },
    { kind: 'gate', text: 'b', state: 'waiting' },
    { kind: 'do', text: 'c', state: 'pending' },
  ],
  ...over,
});

test('the active run is the newest running one for the agent', () => {
  const runs = [
    run({ runId: 'w1' }),
    run({ runId: 'w2', state: 'done' }),
    run({ runId: 'w3', agentId: 2 }),
  ];
  assert.equal(activeRun(runs, 1)?.runId, 'w1');
  assert.equal(activeRun(runs, 3), undefined);
});

test('progress counts done and skipped, and names the waiting gate', () => {
  assert.deepEqual(runProgress(run({})), { done: 1, total: 3, waiting: 2 });
});

test('open gates skip finished runs', () => {
  assert.deepEqual(
    openGates([run({}), run({ runId: 'w9', state: 'stopped' })]).map((g) => [g.run.runId, g.step]),
    [['w000001', 2]],
  );
});

test('steps move within the list only', () => {
  const steps = [
    { kind: 'do' as const, text: 'a' },
    { kind: 'do' as const, text: 'b' },
  ];
  assert.deepEqual(
    moveStep(steps, 1, -1).map((s) => s.text),
    ['b', 'a'],
  );
  assert.equal(moveStep(steps, 0, -1), steps);
});

test('the preview is the file the office writes', () => {
  assert.equal(
    previewMarkdown('T', [
      { kind: 'show', text: 'look', refs: ['a.md'], show: 'b.md --lines 1-2' },
    ]),
    '---\ntitle: T\n---\n\n1. [show] look\n   ref: a.md\n   show: b.md --lines 1-2',
  );
});
