import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  cellEditText,
  cellRange,
  columnLetter,
  fileBaseName,
  isTextEditableName,
  lastEditKeyFor,
  mergeDocEdit,
  modelSheetGrid,
  modelSheetView,
  parseCellRef,
  parseCsv,
  refLabel,
  refText,
  samePath,
  spotLabel,
  toSheetView,
  viewerKind,
  withRefs,
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

test('references name the place, never the content', () => {
  const lines = { path: '/app/src/session.ts', lineStart: 41, lineEnd: 43 };
  assert.equal(refLabel(lines), 'session.ts:41–43');
  assert.equal(refText(lines), '[@/app/src/session.ts lines 41-43]');
  assert.equal(refText({ path: '/d/b.xlsx', cell: 'Q3!B4:D6' }), '[@/d/b.xlsx cells Q3!B4:D6]');
  assert.equal(refText({ path: '/d/r.pdf', page: 3 }), '[@/d/r.pdf page 3]');
  assert.equal(refLabel({ path: '/d/plan.docx' }), 'plan.docx');
  assert.equal(withRefs('Why?', [lines]), 'Why?\n\n[@/app/src/session.ts lines 41-43]');
  assert.equal(withRefs('', [lines]), '[@/app/src/session.ts lines 41-43]');
});

test('clicked cells become a range', () => {
  assert.equal(cellRange({ r: 5, c: 3 }, { r: 3, c: 1 }, 'Q3'), 'Q3!B4:D6');
  assert.equal(cellRange({ r: 0, c: 0 }, { r: 0, c: 0 }), 'A1');
});

// ── Word / PowerPoint places, model sheets, staged edits ──

test('paragraph and slide refs name the place, never the text', () => {
  assert.equal(
    refText({ path: '/w/report.docx', paraStart: 3, paraEnd: 4 }),
    '[@/w/report.docx paragraphs 3-4]',
  );
  assert.equal(refText({ path: '/w/report.docx', paraStart: 3 }), '[@/w/report.docx paragraph 3]');
  assert.equal(
    refText({ path: '/w/pitch.pptx', slide: 2, shape: 'Content "3"' }),
    `[@/w/pitch.pptx slide 2 "Content '3'"]`,
  );
  assert.equal(refLabel({ path: '/w/report.docx', paraStart: 3, paraEnd: 4 }), 'report.docx ¶3–4');
  assert.equal(refLabel({ path: '/w/pitch.pptx', slide: 2 }), 'pitch.pptx slide 2');
  assert.equal(viewerKind('deck.PPTX'), 'slides');
});

test('a model sheet becomes a grid placed by cell refs, with staged edits drawn in', () => {
  const sheet = {
    name: 'Q3',
    range: 'A1:C3',
    rows: [
      [
        { ref: 'A1', value: 'Team' },
        { ref: 'C1', value: 'Total' },
      ],
      [{ ref: 'B3', value: '12', formula: 'SUM(B1:B2)' }],
    ],
  };
  const grid = modelSheetGrid(sheet);
  assert.equal(grid.cols, 3);
  assert.equal(grid.rows[0][1], null);
  assert.equal(cellEditText(grid.rows[2][1]), '=SUM(B1:B2)');
  assert.equal(cellEditText(grid.rows[0][0]), 'Team');
  const view = modelSheetView(sheet, [
    { kind: 'cell', sheet: 'Q3', ref: 'B2', value: '7' },
    { kind: 'cell', sheet: 'Other', ref: 'A1', value: 'x' },
  ]);
  assert.deepEqual(view.rows, [
    ['Team', '', 'Total'],
    ['', '7', ''],
    ['', '12', ''],
  ]);
});

test('staged edits keep one change per place; new paragraphs all stay', () => {
  let edits = mergeDocEdit([], { kind: 'para', n: 3, text: 'a' });
  edits = mergeDocEdit(edits, { kind: 'para', n: 3, text: 'b' });
  edits = mergeDocEdit(edits, { kind: 'cell', ref: 'b2', value: '1' });
  edits = mergeDocEdit(edits, { kind: 'cell', ref: 'B2', value: '2' });
  edits = mergeDocEdit(edits, { kind: 'insertAfter', n: 3, text: '' });
  edits = mergeDocEdit(edits, { kind: 'insertAfter', n: 3, text: '' });
  assert.deepEqual(edits, [
    { kind: 'para', n: 3, text: 'b' },
    { kind: 'cell', ref: 'B2', value: '2' },
    { kind: 'insertAfter', n: 3, text: '' },
    { kind: 'insertAfter', n: 3, text: '' },
  ]);
});

test('only plain text formats are editable as text', () => {
  assert.ok(isTextEditableName('notes.md'));
  assert.ok(isTextEditableName('data.CSV'));
  assert.ok(!isTextEditableName('app.ts'));
});

test('a notice path matches a pin written with ~', () => {
  assert.ok(samePath('/Users/me/q3/report.docx', '~/q3/report.docx'));
  assert.ok(samePath('/w/a.docx', '/w/a.docx'));
  assert.ok(!samePath('/w/a.docx', '/w/b.docx'));
  assert.equal(
    lastEditKeyFor(
      [
        {
          editId: 'e1',
          path: '/w/a.docx',
          who: 'You',
          at: '',
          changes: [],
          canUndo: false,
          undone: false,
        },
        {
          editId: 'e2',
          path: '/w/a.docx',
          who: 'You',
          at: '',
          changes: [],
          canUndo: true,
          undone: true,
        },
      ],
      '/w/a.docx',
    ),
    'e2:true',
  );
});

test('a message with office refs says how to read them, once', () => {
  const text = withRefs('why?', [
    { path: '/w/a.docx', paraStart: 1 },
    { path: '/w/b.pptx', slide: 2 },
  ]);
  assert.equal(text.match(/pixel-office doc read/g)?.length, 1);
  assert.ok(!withRefs('x', [{ path: '/w/a.ts', lineStart: 3 }]).includes('pixel-office doc'));
});
