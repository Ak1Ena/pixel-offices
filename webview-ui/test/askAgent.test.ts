import assert from 'node:assert/strict';

import { test } from 'vitest';

import { askMessage, fileFolder, isInFolder, rankAgents } from '../src/askAgent.js';

test('the folder a file is in', () => {
  assert.equal(fileFolder('/w/q3/report.docx'), '/w/q3');
  assert.equal(fileFolder('~/Docs/a.pptx'), '~/Docs');
  assert.equal(fileFolder('report.docx'), '');
});

test('an agent works in a folder above the file, never a sibling with the same prefix', () => {
  assert.ok(isInFolder('/w/repo/docs/a.docx', '/w/repo'));
  assert.ok(isInFolder('/w/repo/a.docx', '/w/repo/'));
  assert.ok(!isInFolder('/w/repo-old/a.docx', '/w/repo'));
  assert.ok(!isInFolder('/w/repo/a.docx', undefined));
});

test('agents in the file’s folder come first, then idle ones, then by name', () => {
  const ranked = rankAgents([
    { id: 1, label: 'Zed', busy: false, inFolder: false },
    { id: 2, label: 'Bea', busy: true, inFolder: true },
    { id: 3, label: 'Al', busy: false, inFolder: true },
    { id: 4, label: 'Cy', busy: true, inFolder: false },
  ]);
  assert.deepEqual(
    ranked.map((a) => a.id),
    [3, 2, 1, 4],
  );
});

test('the question carries references, the whole file when nothing was picked', () => {
  assert.match(askMessage('  why?  ', [], '/w/r.docx'), /^why\?\n\n\[@\/w\/r\.docx\]$/);
  const picked = askMessage('fix totals', [{ path: '/w/b.xlsx', cell: 'C2:C4' }], '/w/b.xlsx');
  assert.ok(picked.includes('[@/w/b.xlsx cells C2:C4]'));
  assert.ok(picked.includes('pixel-office doc read'));
  assert.ok(askMessage('', [], '/w/a.md').startsWith('Can you help me with this?'));
});
