import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  columnLetter,
  fileBaseName,
  parseCellRef,
  parseCsv,
  spotLabel,
  toSheetView,
  viewerKind,
} from '../src/docViewer.js';

test('files open by type, judged by extension', () => {
  assert.equal(viewerKind('~/Docs/Plan.PDF'), 'pdf');
  assert.equal(viewerKind('notes.docx'), 'word');
  assert.equal(viewerKind('cases.xlsx'), 'sheet');
  assert.equal(viewerKind('rows.csv'), 'csv');
  assert.equal(viewerKind('README.md'), 'text');
  assert.equal(viewerKind('mock.jpeg'), 'image');
  assert.equal(viewerKind('old.doc'), 'unsupported');
  assert.equal(viewerKind('page.html'), 'unsupported');
  assert.equal(fileBaseName('/a/b/plan.pdf'), 'plan.pdf');
});

test('CSV keeps quoted commas, quotes and line breaks', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n"two\nlines",z'), [
    ['a', 'b'],
    ['x, y', 'say "hi"'],
    ['two\nlines', 'z'],
  ]);
  assert.deepEqual(parseCsv(''), []);
});

test('sheets become text cells and report what was cut', () => {
  const view = toSheetView('S', [[1, null, new Date('2026-09-21T00:00:00Z'), true]]);
  assert.deepEqual(view.rows, [['1', '', '2026-09-21', 'true']]);
  assert.equal(view.totalRows, 1);
});

test('column letters count like a spreadsheet', () => {
  assert.deepEqual([0, 25, 26, 27, 701, 702].map(columnLetter), [
    'A',
    'Z',
    'AA',
    'AB',
    'ZZ',
    'AAA',
  ]);
});

test('cell references name a sheet and a range', () => {
  assert.deepEqual(parseCellRef('B4'), { c0: 1, r0: 3, c1: 1, r1: 3 });
  assert.deepEqual(parseCellRef('Q3!B4:D6'), { sheet: 'Q3', c0: 1, r0: 3, c1: 3, r1: 5 });
  assert.deepEqual(parseCellRef("'My sheet'!$AA$10"), {
    sheet: 'My sheet',
    c0: 26,
    r0: 9,
    c1: 26,
    r1: 9,
  });
  assert.deepEqual(parseCellRef('D6:B4'), { c0: 1, r0: 3, c1: 3, r1: 5 });
  assert.equal(parseCellRef('not a cell'), null);
  assert.equal(parseCellRef('A0'), null);
});

test('a spot reads as lines, a page or a cell', () => {
  assert.equal(spotLabel({ lineStart: 40, lineEnd: 58 }), 'lines 40–58');
  assert.equal(spotLabel({ lineStart: 7, lineEnd: 7 }), 'line 7');
  assert.equal(spotLabel({ page: 3 }), 'page 3');
  assert.equal(spotLabel({ cell: 'Q3!B4' }), 'Q3!B4');
  assert.equal(spotLabel({}), '');
});
