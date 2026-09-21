import assert from 'node:assert/strict';

import { test } from 'vitest';

import { buildChannels, groupNote, mergeTimeline } from '../src/officeChat.js';

test('channels: everyone, plus one per team named after its room', () => {
  const channels = buildChannels([
    { id: 1, label: 'Bob', leadId: 1, room: 'Team Room A' },
    { id: 2, label: 'Pat', leadId: 1, room: 'Team Room A' },
    { id: 3, label: 'Ivy' },
    { id: 4, label: 'Lonely Lead', leadId: 4 },
  ]);
  assert.deepEqual(
    channels.map((c) => [c.name, c.members]),
    [
      ['everyone', [1, 2, 3, 4]],
      ['Team Room A', [1, 2]],
    ],
  );
});

test('a message sent to several agents shows once; relayed copies are hidden', () => {
  const t = (s: number) => new Date(Date.UTC(2026, 8, 21, 14, 0, s)).toISOString();
  const note = groupNote(['Pat'], true);
  const items = mergeTimeline(
    {
      1: [
        { entryId: 'u1', role: 'user', text: `split the work${note}`, timestamp: t(0) },
        { entryId: 'a1', role: 'assistant', text: '@Pat amounts are in cents', timestamp: t(20) },
        { entryId: 't1', role: 'tool', text: 'Edit x.ts', timestamp: t(21) },
      ],
      2: [
        { entryId: 'u1b', role: 'user', text: 'split the work', timestamp: t(2) },
        {
          entryId: 'u2',
          role: 'user',
          text: 'Message from Bob (teammate, via the office): @Pat amounts are in cents',
          timestamp: t(22),
        },
        { entryId: 'a2', role: 'assistant', text: 'Got it', timestamp: t(30) },
      ],
    },
    [1, 2],
  );
  assert.deepEqual(
    items.map((i) => [i.agentId, i.text, i.recipients]),
    [
      [null, 'split the work', [1, 2]],
      [1, '@Pat amounts are in cents', []],
      [2, 'Got it', []],
    ],
  );
});
