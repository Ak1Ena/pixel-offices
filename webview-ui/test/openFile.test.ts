import assert from 'node:assert/strict';

import { test } from 'vitest';

import { OPEN_FILE_RECENT_MAX } from '../src/constants.js';
import { formatSize, isOpenable, parseRecent, withRecent } from '../src/openFile.js';

test('only files the viewer opens are openable', () => {
  assert.ok(isOpenable('~/Docs/Deck.PPTX'));
  assert.ok(isOpenable('/w/report.docx'));
  assert.ok(!isOpenable('/w/tool.exe'));
  assert.ok(!isOpenable('/w/folder'));
});

test('sizes read like a file manager', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(12_800), '13 KB');
  assert.equal(formatSize(3_565_158), '3.4 MB');
});

test('recent files: newest first, no duplicates, bounded', () => {
  let list: string[] = [];
  for (let i = 0; i < OPEN_FILE_RECENT_MAX + 3; i++) list = withRecent(list, `/f${i}.docx`);
  assert.equal(list.length, OPEN_FILE_RECENT_MAX);
  assert.equal(list[0], `/f${OPEN_FILE_RECENT_MAX + 2}.docx`);
  assert.deepEqual(withRecent(['/a', '/b'], '/b'), ['/b', '/a']);
});

test('bad stored recents read as none', () => {
  assert.deepEqual(parseRecent(null), []);
  assert.deepEqual(parseRecent('{"a":1}'), []);
  assert.deepEqual(parseRecent('not json'), []);
  assert.deepEqual(parseRecent('["/a", 3, "/b"]'), ['/a', '/b']);
});
