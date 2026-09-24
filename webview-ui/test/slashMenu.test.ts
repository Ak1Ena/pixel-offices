import assert from 'node:assert/strict';

import { test } from 'vitest';

import { matchCommands, slashQuery } from '../src/slashMenu.js';

test('slashQuery: only while the draft is a lone command name', () => {
  assert.equal(slashQuery('/'), '');
  assert.equal(slashQuery('/mo'), 'mo');
  assert.equal(slashQuery('/caveman:help'), 'caveman:help');
  assert.equal(slashQuery('/model sonnet'), null);
  assert.equal(slashQuery('hi /model'), null);
  assert.equal(slashQuery(''), null);
});

test('matchCommands: prefix first, then a namespaced name, then anywhere', () => {
  const all = ['model', 'compact', 'caveman:caveman-help', 'mcp', 'clear', 'context', 'my-model'];
  assert.deepEqual(matchCommands(all, 'mo', 10), ['model', 'my-model']);
  assert.deepEqual(matchCommands(all, 'cav', 10), ['caveman:caveman-help']);
  assert.deepEqual(matchCommands(all, 'c', 3), ['clear', 'compact', 'context']);
  assert.equal(matchCommands(all, '', 100).length, all.length);
});
