import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { BoardPin, ChatEntry } from '../../core/src/messages.js';
import {
  chatPreview,
  composeMessage,
  mergeChatEntries,
  newPinId,
  pinsForAgent,
} from '../src/officeChat.js';

const pin = (overrides: Partial<BoardPin>): BoardPin => ({
  id: 'p1',
  kind: 'link',
  title: 'Spec',
  value: 'https://x.dev',
  scope: [],
  createdAt: '2026-09-21T00:00:00Z',
  ...overrides,
});

test('attached pins ride ahead of the message in the form the agent can use', () => {
  const message = composeMessage('use these', [
    pin({ kind: 'file', value: 'docs/auth.md' }),
    pin({ kind: 'link' }),
    pin({ kind: 'snippet', title: 'Cookie', value: 'httpOnly: true' }),
  ]);
  assert.equal(
    message,
    '@docs/auth.md\n\nSpec: https://x.dev\n\nCookie:\n```\nhttpOnly: true\n```\n\nuse these',
  );
  assert.equal(composeMessage('   ', []), '');
});

test('chat entries upsert by id and keep their first position', () => {
  const a: ChatEntry = { entryId: 't1', role: 'tool', text: 'Bash', toolDone: false };
  const b: ChatEntry = { entryId: 'a1', role: 'assistant', text: 'hi' };
  const merged = mergeChatEntries([a, b], [{ ...a, toolDone: true }]);
  assert.deepEqual(
    merged.map((e) => [e.entryId, e.toolDone]),
    [
      ['t1', true],
      ['a1', undefined],
    ],
  );
});

test('the preview is the newest reply on one line', () => {
  assert.equal(
    chatPreview([
      { entryId: 'a1', role: 'assistant', text: 'old' },
      { entryId: 'a2', role: 'assistant', text: 'new\nline' },
      { entryId: 'u1', role: 'user', text: 'mine' },
    ]),
    'new line',
  );
  assert.equal(chatPreview([{ entryId: 'u1', role: 'user', text: 'x' }]), null);
});

test('scoped pins show only for their sessions', () => {
  const pins = [pin({ id: 'all' }), pin({ id: 'two', scope: [2] })];
  assert.deepEqual(
    pinsForAgent(pins, 1).map((p) => p.id),
    ['all'],
  );
  assert.deepEqual(
    pinsForAgent(pins, 2).map((p) => p.id),
    ['all', 'two'],
  );
});

test('pin ids satisfy the server rule', () => {
  assert.match(newPinId(), /^[A-Za-z0-9_-]{1,64}$/);
});
