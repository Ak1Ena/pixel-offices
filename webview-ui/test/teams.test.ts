import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { TeamPreset, Workflow } from '../../core/src/messages.js';
import { encodeShareCode, exportBundle, fileSlug, readBundle } from '../src/teams.js';

const team: TeamPreset = {
  id: 'feature-squad',
  title: 'Feature squad',
  members: [
    {
      name: 'lead',
      role: 'Lead',
      lead: true,
      instructions: 'Plan',
      command: 'c-caff --model x',
      workflowId: 'flow',
    },
    { name: 'dev', role: 'Dev', instructions: 'Build ü', command: 'claude' },
  ],
};
const workflows: Workflow[] = [
  {
    id: 'flow',
    title: 'Flow',
    path: '/home/me/.pixel-agents/workflows/flow.md',
    steps: [{ kind: 'do', text: 'a' }],
  },
  { id: 'other', title: 'Other', steps: [{ kind: 'do', text: 'b' }] },
];

test('an export leaves out commands and paths unless asked, and brings only used workflows', () => {
  const b = exportBundle(team, workflows, { includeCommands: false, includeWorkflows: true });
  assert.equal(b.team.id, '');
  assert.deepEqual(
    b.team.members.map((m) => m.command),
    ['', ''],
  );
  assert.deepEqual(
    b.workflows.map((w) => w.id),
    ['flow'],
  );
  assert.equal('path' in b.workflows[0], false);
  const withCmds = exportBundle(team, workflows, {
    includeCommands: true,
    includeWorkflows: false,
  });
  assert.equal(withCmds.team.members[0].command, 'c-caff --model x');
  assert.equal(withCmds.team.members[0].workflowId, undefined);
  assert.deepEqual(withCmds.workflows, []);
});

test('a share code round-trips, including non-ASCII text', () => {
  const b = exportBundle(team, workflows, { includeCommands: false, includeWorkflows: true });
  const code = encodeShareCode(b);
  assert.ok(code.startsWith('PXT1-'));
  assert.deepEqual(readBundle(code), b);
  assert.deepEqual(readBundle(JSON.stringify(b)), b);
});

test('things that are not a bundle are refused', () => {
  assert.equal(readBundle('PXT1-!!!'), null);
  assert.equal(readBundle('{"format":"other"}'), null);
  assert.equal(readBundle('hello'), null);
});

test('export file names', () => {
  assert.equal(fileSlug('Feature squad!'), 'feature-squad');
  assert.equal(fileSlug('***'), 'team');
});
