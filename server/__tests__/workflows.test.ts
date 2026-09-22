import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Workflow } from '../../core/src/messages.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { parseWorkflowArgs } from '../src/workflowCli.js';
import {
  parseWorkflow,
  sanitizeWorkflow,
  serializeWorkflow,
  slugify,
} from '../src/workflowFile.js';
import { attachMessage, WorkflowRuns } from '../src/workflowRuns.js';
import { WorkflowStore } from '../src/workflowStore.js';

const FILE = `---
title: Release check
---

1. [do] Run the full test suite
   fix anything red
2. [do] Bump version
   ref: ~/code/app/CHANGELOG.md
3. [show] Show me the changelog
   show: ~/code/app/CHANGELOG.md --lines 1-40
4. [gate] Wait for my go-ahead
5. Publish
`;

describe('workflow files', () => {
  it('parses kinds, refs, show lines and continuation text', () => {
    const w = parseWorkflow('release-check', FILE);
    expect(w.title).toBe('Release check');
    expect(w.steps.map((s) => s.kind)).toEqual(['do', 'do', 'show', 'gate', 'do']);
    expect(w.steps[0].text).toBe('Run the full test suite fix anything red');
    expect(w.steps[1].refs).toEqual(['~/code/app/CHANGELOG.md']);
    expect(w.steps[2].show).toBe('~/code/app/CHANGELOG.md --lines 1-40');
  });

  it('round-trips through serialize', () => {
    const w = parseWorkflow('x', FILE);
    expect(parseWorkflow('x', serializeWorkflow(w)).steps).toEqual(w.steps);
  });

  it('takes a heading as the title when there is no front matter', () => {
    expect(parseWorkflow('x', '# Hotfix\n1. Branch\n').title).toBe('Hotfix');
  });

  it('slugs titles and cleans client input', () => {
    expect(slugify('Release check!')).toBe('release-check');
    expect(slugify('***')).toBe('workflow');
    expect(sanitizeWorkflow({ title: 'T', steps: [] })).toBeNull();
    expect(
      sanitizeWorkflow({ title: 'T', steps: [{ kind: 'bogus', text: 'a\nb' }] })?.steps,
    ).toEqual([{ kind: 'do', text: 'a b' }]);
  });
});

describe('workflow store', () => {
  let dir: string;
  let store: WorkflowStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
    store = new WorkflowStore(() => {}, dir);
  });
  afterEach(() => {
    store.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('saves a file named after the title and reads edits made outside', () => {
    const saved = store.save({
      id: '',
      title: 'Release check',
      steps: [{ kind: 'do', text: 'a' }],
    });
    expect(saved.ok && saved.workflow.id).toBe('release-check');
    const again = store.save({
      id: '',
      title: 'Release check',
      steps: [{ kind: 'do', text: 'b' }],
    });
    expect(again.ok && again.workflow.id).toBe('release-check-2');
    fs.writeFileSync(path.join(dir, 'hand-made.md'), '# Hand made\n1. [gate] ok?\n');
    expect(store.list().some((w) => w.id === 'hand-made')).toBe(false); // until the next poll
    expect(store.remove('release-check')).toBe(true);
    expect(
      store
        .list()
        .map((w) => w.id)
        .sort(),
    ).toEqual(['hand-made', 'release-check-2']);
  });
});

describe('workflow runs', () => {
  const workflow: Workflow = {
    id: 'w',
    title: 'W',
    path: '/tmp/w.md',
    steps: [
      { kind: 'do', text: 'one' },
      { kind: 'gate', text: 'ok?' },
      { kind: 'do', text: 'three' },
    ],
  };
  let store: AgentStateStore;
  let runs: WorkflowRuns;
  beforeEach(() => {
    store = new AgentStateStore();
    runs = new WorkflowRuns(store);
  });
  afterEach(() => runs.dispose());

  it('marks steps, skips gaps and finishes', () => {
    const run = runs.start(1, workflow);
    expect(runs.markStep(run.runId, 3).ok).toBe(true);
    const after = runs.describe(run.runId);
    expect(after.ok && after.run.steps.map((s) => s.state)).toEqual(['skipped', 'skipped', 'done']);
    expect(after.ok && after.run.state).toBe('done');
    expect(runs.markStep('wffffff', 1)).toMatchObject({ ok: false, status: 404 });
  });

  it('holds a gate until the user answers', async () => {
    const run = runs.start(1, workflow);
    runs.markStep(run.runId, 1);
    runs.openGate(run.runId, 2);
    const poll = runs.waitGate(run.runId, 2, 5_000);
    expect(runs.answerGate(run.runId, 2, 'continue')).toBe(true);
    await expect(poll).resolves.toBe('continue');
    expect(runs.answerGate(run.runId, 2, 'continue')).toBe(false);
  });

  it('a stop at the gate stops the run', async () => {
    const run = runs.start(1, workflow);
    runs.openGate(run.runId, 2);
    const poll = runs.waitGate(run.runId, 2, 5_000);
    runs.answerGate(run.runId, 2, 'stop');
    await expect(poll).resolves.toBe('stop');
    expect(runs.snapshot().runs[0].state).toBe('stopped');
  });

  it('a new run for the same agent stops the old one', () => {
    const first = runs.start(1, workflow);
    runs.start(1, workflow);
    expect(runs.snapshot().runs.find((r) => r.runId === first.runId)?.state).toBe('stopped');
  });

  it('the attach message names the file, not the steps', () => {
    const run = runs.start(1, workflow);
    const text = attachMessage(run, '/tmp/w.md');
    expect(text).toContain('@/tmp/w.md');
    expect(text).toContain(run.runId);
    expect(text).not.toContain('three');
  });
});

describe('pixel-office workflow arguments', () => {
  it('parses step and gate', () => {
    expect(parseWorkflowArgs(['step', 'w1a2b3c', '2'])).toEqual({
      cmd: 'step',
      runId: 'w1a2b3c',
      step: 2,
    });
    expect(parseWorkflowArgs(['gate', 'w1a2b3c', '4'])).toMatchObject({ cmd: 'gate', step: 4 });
    expect(() => parseWorkflowArgs(['step', 'nope', '1'])).toThrow();
    expect(() => parseWorkflowArgs(['step', 'w1a2b3c'])).toThrow();
    expect(parseWorkflowArgs([])).toEqual({ cmd: 'help' });
  });
});
