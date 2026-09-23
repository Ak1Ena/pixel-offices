import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { OfficeFile } from '../../core/src/messages.js';
import { ago, filesTab } from '../src/filesView.js';

const file = (id: string, source: OfficeFile['source']): OfficeFile => ({
  fileId: id,
  path: `/w/${id}.docx`,
  name: `${id}.docx`,
  source,
  openedAt: '2026-09-23T10:00:00.000Z',
  pinned: false,
});

test('each tab lists its files', () => {
  const files = [file('a', 'disk'), file('b', 'upload')];
  assert.deepEqual(
    filesTab(files, 'recent').map((f) => f.fileId),
    ['a', 'b'],
  );
  assert.deepEqual(
    filesTab(files, 'uploads').map((f) => f.fileId),
    ['b'],
  );
  assert.deepEqual(filesTab(files, 'review'), []);
});

test('times read like a person would say them', () => {
  const now = Date.parse('2026-09-23T12:00:00.000Z');
  assert.equal(ago('2026-09-23T11:59:30.000Z', now), 'just now');
  assert.equal(ago('2026-09-23T11:55:00.000Z', now), '5 min ago');
  assert.equal(ago('2026-09-23T09:00:00.000Z', now), '3 h ago');
  assert.equal(ago('2026-09-22T10:00:00.000Z', now), 'yesterday');
  assert.equal(ago('2026-09-20T12:00:00.000Z', now), '3 days ago');
  assert.equal(ago('nonsense', now), 'just now');
});
