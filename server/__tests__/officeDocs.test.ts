import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import type { DocEdit, DocModel } from '../../core/src/docModel.js';
import { DOC_USAGE, formatOutline, parseDocEditArgs, runDocCommand } from '../src/docCli.js';
import {
  applyDocEdits,
  docKindOf,
  parseDocPlace,
  readDocModel,
  readDocPlace,
} from '../src/officeDocs.js';
import {
  CT,
  DECL,
  JSZip,
  makeDocx,
  makePptx,
  makeXlsx,
  S,
  W,
  zipOf,
} from './helpers/officeFixtures.js';

async function entries(buf: Buffer): Promise<Map<string, Buffer>> {
  const zip = await JSZip.loadAsync(buf);
  const out = new Map<string, Buffer>();
  for (const name of Object.keys(zip.files)) {
    const f = zip.file(name);
    if (f) out.set(name, await f.async('nodebuffer'));
  }
  return out;
}

async function part(buf: Buffer, name: string): Promise<string> {
  const f = (await JSZip.loadAsync(buf)).file(name);
  if (!f) throw new Error(`no ${name}`);
  return f.async('string');
}

/** Every entry except `changed` is byte-identical, and nothing else appeared or vanished. */
async function expectUntouched(
  before: Buffer,
  after: Buffer,
  changed: string[],
  removed: string[] = [],
): Promise<void> {
  const a = await entries(before);
  const b = await entries(after);
  expect([...b.keys()].sort()).toEqual([...a.keys()].filter((k) => !removed.includes(k)).sort());
  for (const [name, bytes] of a) {
    if (changed.includes(name) || removed.includes(name)) continue;
    expect(b.get(name)?.equals(bytes), name).toBe(true);
  }
}

function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`edit failed: ${(r as unknown as { error: string }).error}`);
  return r as Extract<T, { ok: true }>;
}

// ── Kinds ───────────────────────────────────────────────────────────────────

describe('docKindOf', () => {
  it('knows the three formats by extension, case-insensitively', () => {
    expect(docKindOf('/a/b/Report.DOCX')).toBe('docx');
    expect(docKindOf('deck.pptx')).toBe('pptx');
    expect(docKindOf('x.Xlsx')).toBe('xlsx');
  });
  it('refuses macro-enabled and other files', () => {
    for (const f of ['a.docm', 'a.xlsm', 'a.pptm', 'a.doc', 'a.pdf', 'docx'])
      expect(docKindOf(f)).toBeNull();
  });
});

// ── Word ────────────────────────────────────────────────────────────────────

describe('Word model', () => {
  it('numbers body paragraphs in order, tables flattened, empties counted', async () => {
    const model = await readDocModel(await makeDocx(), 'docx');
    if (model.kind !== 'docx') throw new Error('kind');
    expect(model.paragraphs.map((p) => p.text)).toEqual([
      'Quarterly report',
      'Intro',
      'Churn in the third quarter\tfell.',
      '',
      'First point',
      'Name',
      'Amount',
      'Acme',
      '131,500',
      'In a control',
      'KeepNew\nline',
    ]);
    expect(model.paragraphs.map((p) => p.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(model.paragraphs[0].heading).toBe(1);
    expect(model.paragraphs[1].heading).toBe(1); // localized id, name "heading 1"
    expect(model.paragraphs[2].heading).toBeUndefined();
    expect(model.paragraphs[4].list).toBe(true);
    expect(model.paragraphs.filter((p) => p.table).map((p) => p.n)).toEqual([6, 7, 8, 9]);
    expect(model.paragraphs[9].table).toBeUndefined();
  });
});

describe('Word edits', () => {
  it('replaces a paragraph keeping pPr, the first run formatting and bookmarks', async () => {
    const buf = await makeDocx();
    const r = must(
      await applyDocEdits(buf, 'docx', [{ kind: 'para', n: 3, text: 'Churn fell\tagain\nby 2%' }]),
    );
    expect(r.previews).toEqual([
      {
        edit: { kind: 'para', n: 3, text: 'Churn fell\tagain\nby 2%' },
        where: '¶3',
        before: 'Churn in the third quarter\tfell.',
        after: 'Churn fell\tagain\nby 2%',
      },
    ]);
    const xml = await part(r.buffer, 'word/document.xml');
    expect(xml).toContain(
      '<w:pPr><w:jc w:val="center"/></w:pPr><w:bookmarkStart w:id="0" w:name="churn"/><w:r><w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr><w:t xml:space="preserve">Churn fell</w:t><w:tab/><w:t xml:space="preserve">again</w:t><w:br/><w:t xml:space="preserve">by 2%</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>',
    );
    expect(xml).not.toContain('third quarter');
    expect(xml).toContain('w14:paraId="1A2B"');
    await expectUntouched(buf, r.buffer, ['word/document.xml']);
    const model = (await readDocModel(r.buffer, 'docx')) as Extract<DocModel, { kind: 'docx' }>;
    expect(model.paragraphs[2].text).toBe('Churn fell\tagain\nby 2%');
    expect(model.paragraphs).toHaveLength(11);
  });

  it('edits a table cell paragraph and a paragraph with tracked changes', async () => {
    const r = must(
      await applyDocEdits(await makeDocx(), 'docx', [
        { kind: 'para', n: 9, text: '140,000' },
        { kind: 'para', n: 11, text: 'Plain' },
        { kind: 'para', n: 4, text: 'Was empty' },
      ]),
    );
    const model = (await readDocModel(r.buffer, 'docx')) as Extract<DocModel, { kind: 'docx' }>;
    expect(model.paragraphs[8]).toEqual({ n: 9, text: '140,000', table: true });
    expect(model.paragraphs[10].text).toBe('Plain');
    expect(model.paragraphs[3].text).toBe('Was empty');
    expect(await part(r.buffer, 'word/document.xml')).not.toContain('Gone');
  });

  it('inserts paragraphs styled like their anchor; numbers refer to the original document', async () => {
    const edits: DocEdit[] = [
      { kind: 'insertAfter', n: 5, text: 'Second point' },
      { kind: 'insertAfter', n: 5, text: 'Third point' },
      { kind: 'para', n: 6, text: 'Who' }, // still the table's "Name"
      { kind: 'insertAfter', n: 0, text: 'Draft' },
    ];
    const r = must(await applyDocEdits(await makeDocx(), 'docx', edits));
    expect(r.previews.map((p) => p.where)).toEqual(['after ¶5', 'after ¶5', '¶6', 'before ¶1']);
    const model = (await readDocModel(r.buffer, 'docx')) as Extract<DocModel, { kind: 'docx' }>;
    expect(model.paragraphs.map((p) => p.text).slice(0, 9)).toEqual([
      'Draft',
      'Quarterly report',
      'Intro',
      'Churn in the third quarter\tfell.',
      '',
      'First point',
      'Second point',
      'Third point',
      'Who',
    ]);
    expect(model.paragraphs[6].list).toBe(true);
    expect(model.paragraphs[7].list).toBe(true);
    expect(model.paragraphs[0].heading).toBeUndefined();
  });

  it('never clones a section break into an inserted paragraph', async () => {
    const buf = await zipOf({
      '[Content_Types].xml': `${DECL}<Types xmlns="${CT}"/>`,
      'word/document.xml': `${DECL}<w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:sectPr/></w:pPr><w:r><w:t>End of section</w:t></w:r></w:p></w:body></w:document>`,
    });
    const r = must(await applyDocEdits(buf, 'docx', [{ kind: 'insertAfter', n: 1, text: 'x' }]));
    expect((await part(r.buffer, 'word/document.xml')).match(/sectPr/g)).toHaveLength(1);
  });

  it('is all-or-nothing and names the bad edit', async () => {
    const buf = await makeDocx();
    const r = await applyDocEdits(buf, 'docx', [
      { kind: 'para', n: 1, text: 'fine' },
      { kind: 'para', n: 2, text: 'fine' },
      { kind: 'para', n: 40, text: 'nope' },
    ]);
    expect(r).toEqual({
      ok: false,
      error: 'Edit 3: there is no paragraph 40 (the document has 11).',
    });
    const wrongKind = await applyDocEdits(buf, 'docx', [{ kind: 'cell', ref: 'A1', value: '1' }]);
    expect(wrongKind).toEqual({
      ok: false,
      error: "Edit 1: a cell edit can't be applied to a Word document.",
    });
    const bad = await applyDocEdits(buf, 'docx', [{ kind: 'para', n: 0, text: 'x' }]);
    expect(bad.ok).toBe(false);
    const junk = await applyDocEdits(buf, 'docx', [{ kind: 'para', n: 1 } as unknown as DocEdit]);
    expect(junk).toEqual({ ok: false, error: 'Edit 1: "text" must be a string.' });
    expect((await applyDocEdits(buf, 'docx', [])).ok).toBe(false);
    expect(
      (await applyDocEdits(Buffer.from('not a zip'), 'docx', [{ kind: 'para', n: 1, text: 'x' }]))
        .ok,
    ).toBe(false);
  });

  it('strips control characters XML cannot carry', async () => {
    const r = must(
      await applyDocEdits(await makeDocx(), 'docx', [
        { kind: 'para', n: 1, text: 'a\u0001b\r\nc' },
      ]),
    );
    expect(r.previews[0].after).toBe('ab\nc');
  });
});

// ── PowerPoint ──────────────────────────────────────────────────────────────

describe('PowerPoint model', () => {
  it('reads slides in presentation order, groups, duplicate names and titles', async () => {
    const model = await readDocModel(await makePptx(), 'pptx');
    expect(model).toEqual({
      kind: 'pptx',
      slides: [
        {
          n: 1,
          shapes: [
            { name: 'Title 1', text: 'Why now', title: true },
            { name: 'Content 2', text: 'Churn is up\nCosts\nfell' },
            { name: 'TextBox 5', text: 'In a group' },
            { name: 'TextBox 5 (2)', text: 'Same name' },
          ],
        },
        { n: 2, shapes: [{ name: 'Title 1', text: 'Deck', title: true }] },
      ],
    });
  });
});

describe('PowerPoint edits', () => {
  it('replaces a shape text, one paragraph per line, formatting kept', async () => {
    const buf = await makePptx();
    const r = must(
      await applyDocEdits(buf, 'pptx', [
        { kind: 'shape', slide: 1, shape: 'Content 2', text: 'Churn is down\n\nCosts rose' },
      ]),
    );
    expect(r.previews[0]).toMatchObject({
      where: 'slide 1 “Content 2”',
      before: 'Churn is up\nCosts\nfell',
      after: 'Churn is down\n\nCosts rose',
    });
    const xml = await part(r.buffer, 'ppt/slides/slide2.xml');
    expect(xml).toContain(
      '<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:pPr lvl="1"/><a:r><a:rPr lang="en-US" sz="2400" b="1"/><a:t>Churn is down</a:t></a:r><a:endParaRPr lang="en-US"/></a:p><a:p><a:pPr lvl="1"/><a:endParaRPr lang="en-US"/></a:p><a:p><a:pPr lvl="1"/><a:r><a:rPr lang="en-US" sz="2400" b="1"/><a:t>Costs rose</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody>',
    );
    expect(xml).toContain('<p:timing><p:tnLst/></p:timing>');
    await expectUntouched(buf, r.buffer, ['ppt/slides/slide2.xml']);
  });

  it('targets a duplicate-named shape by its disambiguated name, in a group too', async () => {
    const r = must(
      await applyDocEdits(await makePptx(), 'pptx', [
        { kind: 'shape', slide: 1, shape: 'TextBox 5 (2)', text: 'B' },
        { kind: 'shape', slide: 1, shape: 'textbox 5', text: 'A' },
        { kind: 'shape', slide: 2, shape: 'Title 1', text: 'New deck' },
      ]),
    );
    const model = (await readDocModel(r.buffer, 'pptx')) as Extract<DocModel, { kind: 'pptx' }>;
    expect(model.slides[0].shapes.map((s) => s.text)).toEqual([
      'Why now',
      'Churn is up\nCosts\nfell',
      'A',
      'B',
    ]);
    expect(model.slides[1].shapes[0].text).toBe('New deck');
  });

  it('refuses missing slides and shapes', async () => {
    const buf = await makePptx();
    expect(
      await applyDocEdits(buf, 'pptx', [{ kind: 'shape', slide: 3, shape: 'Title 1', text: 'x' }]),
    ).toEqual({
      ok: false,
      error: 'Edit 1: there is no slide 3 (the presentation has 2).',
    });
    const r = await applyDocEdits(buf, 'pptx', [
      { kind: 'shape', slide: 1, shape: 'Title 1', text: 'x' },
      { kind: 'shape', slide: 1, shape: 'Picture 6', text: 'x' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^Edit 2: slide 1 has no text shape “Picture 6”/);
  });
});

// ── Excel ───────────────────────────────────────────────────────────────────

describe('Excel model', () => {
  it('resolves shared, rich, inline and boolean values, formulas and ranges', async () => {
    const model = await readDocModel(await makeXlsx(), 'xlsx');
    if (model.kind !== 'xlsx') throw new Error('kind');
    expect(model.sheets.map((s) => [s.name, s.range])).toEqual([
      ['Sheet1', 'A1:C4'],
      ['My Sheet', 'A1:B6'],
    ]);
    expect(model.sheets[0].rows).toEqual([
      [
        { ref: 'A1', value: 'Name' },
        { ref: 'B1', value: 'Amount' },
      ],
      [
        { ref: 'A2', value: 'Acme' },
        { ref: 'B2', value: '131500' },
        { ref: 'C2', value: 'TRUE' },
      ],
      [{ ref: 'B3', value: '97200' }],
      [
        { ref: 'A4', value: 'Total', formula: '"Total"' },
        { ref: 'B4', value: '228700', formula: 'SUM(B2:B3)' },
      ],
    ]);
    const s2 = model.sheets[1].rows;
    expect(s2[1][0]).toEqual({ ref: 'A2', value: 'hellox', formula: 'A1&"x"' });
    expect(s2[2][0]).toEqual({ ref: 'A3', value: 'x' }); // shared-formula dependent: cached value only
  });

  it('bounds rows with maxRows', async () => {
    const model = (await readDocModel(await makeXlsx(), 'xlsx', { maxRows: 2 })) as Extract<
      DocModel,
      { kind: 'xlsx' }
    >;
    expect(model.sheets[0].rows).toHaveLength(2);
    expect(model.sheets[0].truncated).toBe(true);
    expect(model.sheets[0].range).toBe('A1:C4');
  });
});

describe('Excel edits', () => {
  it('writes strings, numbers and formulas; drops calcChain and asks for a recalc', async () => {
    const buf = await makeXlsx();
    const r = must(
      await applyDocEdits(buf, 'xlsx', [
        { kind: 'cell', ref: 'A2', value: 'Globex & Co' },
        { kind: 'cell', ref: 'B3', value: '100000' },
        { kind: 'cell', ref: 'Sheet1!B4', value: '=SUM(B2:B3)*2' },
      ]),
    );
    expect(r.previews.map((p) => [p.where, p.before, p.after])).toEqual([
      ['Sheet1!A2', 'Acme', 'Globex & Co'],
      ['Sheet1!B3', '97200', '100000'],
      ['Sheet1!B4', '=SUM(B2:B3)', '=SUM(B2:B3)*2'],
    ]);
    const sheet = await part(r.buffer, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain(
      '<c r="A2" t="inlineStr"><is><t xml:space="preserve">Globex &amp; Co</t></is></c>',
    );
    expect(sheet).toContain('<c r="B3" s="1"><v>100000</v></c>');
    expect(sheet).toContain('<c r="B4" s="1"><f>SUM(B2:B3)*2</f></c>');
    expect(sheet).toContain('<pageMargins');
    const wb = await part(r.buffer, 'xl/workbook.xml');
    expect(wb).toContain('<calcPr fullCalcOnLoad="1"/><extLst/>');
    expect(await part(r.buffer, '[Content_Types].xml')).not.toContain('calcChain');
    expect(await part(r.buffer, 'xl/_rels/workbook.xml.rels')).not.toContain('calcChain');
    await expectUntouched(
      buf,
      r.buffer,
      [
        'xl/worksheets/sheet1.xml',
        'xl/workbook.xml',
        '[Content_Types].xml',
        'xl/_rels/workbook.xml.rels',
      ],
      ['xl/calcChain.xml'],
    );
  });

  it('creates rows and cells in sorted order and grows the dimension', async () => {
    const buf = await makeXlsx();
    const r = must(
      await applyDocEdits(buf, 'xlsx', [
        { kind: 'cell', ref: 'D2', value: 'x' },
        { kind: 'cell', ref: 'A3', value: '-1.5e3' },
        { kind: 'cell', ref: 'B10', value: 'late' },
        { kind: 'cell', ref: 'A7', value: 'mid' },
      ]),
    );
    const sheet = await part(r.buffer, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<dimension ref="A1:D10"/>');
    expect(sheet).toContain(
      '<row r="2" spans="1:4"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>131500</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" t="inlineStr">',
    );
    expect(sheet).toContain('<row r="3"><c r="A3"><v>-1.5e3</v></c><c r="B3" s="1">');
    expect(sheet.indexOf('<row r="7">')).toBeGreaterThan(sheet.indexOf('<row r="4">'));
    expect(sheet.indexOf('<row r="10">')).toBeGreaterThan(sheet.indexOf('<row r="7">'));
    // No formula touched: calcChain stays, but formulas exist so Excel recalculates.
    expect(await part(r.buffer, 'xl/calcChain.xml')).toContain('B4');
    expect(await part(r.buffer, 'xl/workbook.xml')).toContain('fullCalcOnLoad="1"');
  });

  it('clears cells: plain ones go, styled ones stay empty', async () => {
    const r = must(
      await applyDocEdits(await makeXlsx(), 'xlsx', [
        { kind: 'cell', ref: 'A2', value: '' },
        { kind: 'cell', ref: 'B3', value: '' },
        { kind: 'cell', ref: 'Z99', value: '' },
      ]),
    );
    const sheet = await part(r.buffer, 'xl/worksheets/sheet1.xml');
    expect(sheet).not.toContain('r="A2"');
    expect(sheet).toContain('<row r="3"><c r="B3" s="1"/></row>');
    expect(r.previews[2]).toMatchObject({ where: 'Sheet1!Z99', before: '', after: '' });
  });

  it('leaves workbook.xml alone when there are no formulas anywhere', async () => {
    // Sheet1 without its formulas, and an empty sheet 2.
    const zip = await JSZip.loadAsync(await makeXlsx({ formulas: false }));
    zip.file('xl/worksheets/sheet2.xml', `${DECL}<worksheet xmlns="${S}"><sheetData/></worksheet>`);
    const plain = await zip.generateAsync({ type: 'nodebuffer' });
    const r = must(
      await applyDocEdits(plain, 'xlsx', [{ kind: 'cell', ref: "'My Sheet'!B2", value: '5' }]),
    );
    await expectUntouched(plain, r.buffer, ['xl/worksheets/sheet2.xml']);
    expect(await part(r.buffer, 'xl/worksheets/sheet2.xml')).toContain(
      '<row r="2"><c r="B2"><v>5</v></c></row>',
    );
  });

  it('refuses shared-formula masters, array members, bad refs and unknown sheets', async () => {
    const buf = await makeXlsx();
    const err = async (edit: DocEdit): Promise<string> => {
      const r = await applyDocEdits(buf, 'xlsx', [edit]);
      return r.ok ? 'ok' : r.error;
    };
    expect(await err({ kind: 'cell', sheet: 'My Sheet', ref: 'A2', value: '1' })).toMatch(
      /shared formula/,
    );
    expect(await err({ kind: 'cell', sheet: 'my sheet', ref: 'A3', value: '1' })).toBe('ok');
    expect(await err({ kind: 'cell', sheet: 'My Sheet', ref: 'B6', value: '1' })).toMatch(
      /array formula entered at B5/,
    );
    expect(await err({ kind: 'cell', ref: 'C', value: '1' })).toBe(
      'Edit 1: “C” is not a cell like C5.',
    );
    expect(await err({ kind: 'cell', ref: 'Nope!C1', value: '1' })).toMatch(
      /there is no sheet “Nope”/,
    );
    expect(await err({ kind: 'cell', sheet: 'Sheet1', ref: "'My Sheet'!C1", value: '1' })).toMatch(
      /names sheet “My Sheet” but the edit says “Sheet1”/,
    );
    expect(await err({ kind: 'cell', ref: 'A1', value: '=' })).toBe(
      'Edit 1: the formula is empty.',
    );
  });
});

// ── Places ──────────────────────────────────────────────────────────────────

describe('parseDocPlace / readDocPlace', () => {
  it('parses CLI flags', () => {
    expect(parseDocPlace({ para: '3' })).toEqual({ para: [3, 3] });
    expect(parseDocPlace({ para: '4-3' })).toEqual({ para: [3, 4] });
    expect(parseDocPlace({ slide: '2', shape: 'Title 1' })).toEqual({ slide: 2, shape: 'Title 1' });
    expect(parseDocPlace({ cell: ' Sheet1!C2:C4 ' })).toEqual({ cells: 'Sheet1!C2:C4' });
    expect(() => parseDocPlace({})).toThrow(/Say which place/);
    expect(() => parseDocPlace({ para: '1', cell: 'A1' })).toThrow(/only one/);
    expect(() => parseDocPlace({ shape: 'x' })).toThrow(/--shape needs --slide/);
    expect(() => parseDocPlace({ para: 'x' })).toThrow(/--para takes/);
    expect(() => parseDocPlace({ slide: '0' })).toThrow(/--slide/);
  });

  it('prints paragraphs, slides and cells with their labels', async () => {
    const docx = await readDocModel(await makeDocx(), 'docx');
    expect(readDocPlace(docx, { para: [2, 3] })).toBe(
      '¶2 Intro\n¶3 Churn in the third quarter\tfell.',
    );
    expect(() => readDocPlace(docx, { para: [11, 12] })).toThrow(
      'There is no paragraph 12 (the document has 11).',
    );
    expect(() => readDocPlace(docx, { slide: 1 })).toThrow(/Slides are for PowerPoint/);

    const pptx = await readDocModel(await makePptx(), 'pptx');
    expect(readDocPlace(pptx, { slide: 2 })).toBe('Slide 2\n[Title 1] Deck');
    expect(readDocPlace(pptx, { slide: 1, shape: 'Content 2' })).toBe(
      '[Content 2] Churn is up\nCosts\nfell',
    );
    expect(() => readDocPlace(pptx, { slide: 1, shape: 'Nope' })).toThrow(
      /has no text shape “Nope”/,
    );

    const xlsx = await readDocModel(await makeXlsx(), 'xlsx');
    expect(readDocPlace(xlsx, { cells: 'B2:B4' })).toBe(
      'B2 131500\nB3 97200\nB4 =SUM(B2:B3) → 228700',
    );
    expect(readDocPlace(xlsx, { cells: "'My Sheet'!A1" })).toBe('A1 hello');
    expect(readDocPlace(xlsx, { cells: 'Z1:Z3' })).toBe('Sheet1!Z1:Z3 is empty.');
    expect(() => readDocPlace(xlsx, { cells: 'Q!A1' })).toThrow(/There is no sheet “Q”/);
    expect(() => readDocPlace(xlsx, { cells: 'A' })).toThrow(/not a cell or range/);
  });
});

// ── CLI ─────────────────────────────────────────────────────────────────────

describe('parseDocEditArgs', () => {
  const cwd = '/work';
  it('turns flags into one edit', () => {
    expect(
      parseDocEditArgs(
        ['edit', 'r.docx', '--para', '3', '--text', 'a\\nb', '--why', 'fix', '--wait'],
        { cwd },
      ),
    ).toEqual({
      file: path.resolve('/work/r.docx'),
      edits: [{ kind: 'para', n: 3, text: 'a\nb' }],
      why: 'fix',
      wait: true,
    });
    expect(
      parseDocEditArgs(['r.docx', '--insert-after', '0', '--text', 'x'], { cwd }).edits,
    ).toEqual([{ kind: 'insertAfter', n: 0, text: 'x' }]);
    expect(
      parseDocEditArgs(['d.pptx', '--slide', '2', '--shape', 'Title 1', '--text', 'T'], { cwd })
        .edits,
    ).toEqual([{ kind: 'shape', slide: 2, shape: 'Title 1', text: 'T' }]);
    expect(parseDocEditArgs(['b.xlsx', '--cell', 'Sheet1!C5', '--value', '=A1'], { cwd })).toEqual({
      file: path.resolve('/work/b.xlsx'),
      edits: [{ kind: 'cell', ref: 'Sheet1!C5', value: '=A1' }],
      wait: false,
    });
  });

  it('reads --from JSON and validates it', () => {
    const readText = (): string =>
      JSON.stringify([
        { kind: 'cell', ref: 'A1', value: '1' },
        { kind: 'cell', sheet: 'S', ref: 'B2', value: '' },
      ]);
    expect(parseDocEditArgs(['b.xlsx', '--from', 'e.json'], { cwd, readText }).edits).toHaveLength(
      2,
    );
    expect(() =>
      parseDocEditArgs(['b.xlsx', '--from', 'e.json'], {
        cwd,
        readText: () => '[{"kind":"cell","ref":"A1"}]',
      }),
    ).toThrow('--from: edit 1: "value" must be a string.');
    expect(() =>
      parseDocEditArgs(['b.xlsx', '--from', 'e.json'], { cwd, readText: () => '{}' }),
    ).toThrow(/JSON array/);
    expect(() =>
      parseDocEditArgs(['b.xlsx', '--from', 'e.json'], { cwd, readText: () => 'nope' }),
    ).toThrow(/not JSON/);
    expect(() =>
      parseDocEditArgs(['b.xlsx', '--from', 'e.json'], {
        cwd,
        readText: () => '[{"kind":"cell","ref":"A1","value":"1"},{"kind":"para","n":1,"text":"x"}]',
      }),
    ).toThrow(/Edit 2: a para edit doesn't fit an Excel file/);
  });

  it('gives clear errors', () => {
    expect(() => parseDocEditArgs(['edit'], { cwd })).toThrow(/needs a FILE/);
    expect(() => parseDocEditArgs(['a.txt', '--para', '1', '--text', 'x'], { cwd })).toThrow(
      /not a Word/,
    );
    expect(() => parseDocEditArgs(['a.docx'], { cwd })).toThrow(/Say what to change/);
    expect(() => parseDocEditArgs(['a.docx', '--para', '1'], { cwd })).toThrow(
      '--para needs --text.',
    );
    expect(() => parseDocEditArgs(['a.docx', '--para', 'x', '--text', 'y'], { cwd })).toThrow(
      /--para takes a whole number/,
    );
    expect(() =>
      parseDocEditArgs(['a.docx', '--para', '1', '--cell', 'A1', '--text', 'y'], { cwd }),
    ).toThrow(/only one/);
    expect(() => parseDocEditArgs(['a.docx', '--para', '1', '--value', 'y'], { cwd })).toThrow(
      /--value can't be used with --para/,
    );
    expect(() => parseDocEditArgs(['a.docx', '--cell', 'A1', '--value', 'y'], { cwd })).toThrow(
      /cell edit doesn't fit a Word/,
    );
    expect(() => parseDocEditArgs(['a.xlsx', '--cell', 'A1:B2', '--value', 'y'], { cwd })).toThrow(
      /one cell/,
    );
    expect(() => parseDocEditArgs(['a.docx', '--bogus'], { cwd })).toThrow(
      /Unknown option --bogus/,
    );
    expect(() => parseDocEditArgs(['a.docx', '--para'], { cwd })).toThrow(/--para needs a value/);
  });
});

describe('runDocCommand', () => {
  async function run(
    argv: string[],
    files: Record<string, Buffer>,
  ): Promise<{ code: number; out: string; err: string }> {
    let out = '';
    let err = '';
    const code = await runDocCommand(argv, {
      cwd: '/docs',
      out: (t) => (out += `${t}\n`),
      err: (t) => (err += `${t}\n`),
      readFile: (p) => {
        const f = files[p];
        if (!f) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
        return f;
      },
    });
    return { code, out: out.trimEnd(), err: err.trimEnd() };
  }

  it('reads places from a local file', async () => {
    const files = {
      [path.resolve('/docs/r.docx')]: await makeDocx(),
      [path.resolve('/docs/b.xlsx')]: await makeXlsx(),
    };
    expect(await run(['read', 'r.docx', '--para', '5'], files)).toEqual({
      code: 0,
      out: '¶5 First point',
      err: '',
    });
    expect((await run(['read', 'b.xlsx', '--cell', 'B4'], files)).out).toBe(
      'B4 =SUM(B2:B3) → 228700',
    );
    const missing = await run(['read', 'r.docx', '--para', '50'], files);
    expect(missing.code).toBe(1);
    expect(missing.err).toBe('There is no paragraph 50 (the document has 11).');
    expect((await run(['read', 'gone.docx', '--para', '1'], files)).err).toMatch(/^No such file: /);
    expect((await run(['read', 'r.docx'], files)).err).toMatch(/Say which place/);
  });

  it('prints outlines for all three kinds', async () => {
    const files = {
      [path.resolve('/docs/r.docx')]: await makeDocx(),
      [path.resolve('/docs/d.pptx')]: await makePptx(),
      [path.resolve('/docs/b.xlsx')]: await makeXlsx(),
    };
    const docx = await run(['outline', 'r.docx'], files);
    expect(docx.code).toBe(0);
    expect(docx.out.split('\n').slice(0, 6)).toEqual([
      'Word document, 11 paragraphs (empty ones not listed)',
      '¶1 [H1] Quarterly report',
      '¶2 [H1] Intro',
      '¶3 Churn in the third quarter fell.',
      '¶5 • First point',
      '¶6 [table] Name',
    ]);
    expect((await run(['outline', 'd.pptx'], files)).out).toBe(
      [
        'PowerPoint presentation, 2 slides',
        'Slide 1',
        '  [Title 1] (title) Why now',
        '  [Content 2] Churn is up',
        '  [TextBox 5] In a group',
        '  [TextBox 5 (2)] Same name',
        'Slide 2',
        '  [Title 1] (title) Deck',
      ].join('\n'),
    );
    const xlsx = (await run(['outline', 'b.xlsx'], files)).out.split('\n');
    expect(xlsx.slice(0, 3)).toEqual([
      'Excel workbook, 2 sheets',
      'Sheet1  A1:C4',
      '  A1 Name | B1 Amount',
    ]);
    expect(xlsx).toContain('  A4 ="Total" | B4 =SUM(B2:B3)');
  });

  it('shows usage and refuses unknown subcommands', async () => {
    expect((await run(['help'], {})).out).toBe(DOC_USAGE);
    const r = await run(['frobnicate'], {});
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Unknown doc command "frobnicate"/);
    expect((await run(['read', 'a.txt', '--para', '1'], {})).err).toMatch(
      /not a Word, PowerPoint or Excel/,
    );
  });
});

// ── Files made elsewhere (mammoth's Word fixtures) ──────────────────────────

const MAMMOTH = path.resolve(__dirname, '../../node_modules/mammoth/test/test-data');
const mammothFiles = fs.existsSync(MAMMOTH)
  ? fs.readdirSync(MAMMOTH).filter((f) => f.endsWith('.docx'))
  : [];

describe.skipIf(mammothFiles.length === 0)('real Word files round-trip', () => {
  it.each(mammothFiles)('%s', async (name) => {
    const buf = fs.readFileSync(path.join(MAMMOTH, name));
    let model: DocModel;
    try {
      model = await readDocModel(buf, 'docx');
    } catch {
      return; // not every fixture is a complete document (e.g. empty.docx)
    }
    if (model.kind !== 'docx' || model.paragraphs.length === 0) return;
    const last = model.paragraphs.length;
    const r = must(
      await applyDocEdits(buf, 'docx', [
        { kind: 'para', n: 1, text: 'Edited by the office' },
        { kind: 'insertAfter', n: last, text: 'Appended' },
      ]),
    );
    const again = (await readDocModel(r.buffer, 'docx')) as Extract<DocModel, { kind: 'docx' }>;
    expect(again.paragraphs).toHaveLength(last + 1);
    expect(again.paragraphs[0].text).toBe('Edited by the office');
    expect(again.paragraphs[last].text).toBe('Appended');
    for (const p of model.paragraphs.slice(1)) expect(again.paragraphs[p.n - 1].text).toBe(p.text);
  });
});

it('formatOutline handles an empty workbook sheet', () => {
  expect(formatOutline({ kind: 'xlsx', sheets: [{ name: 'S', range: '', rows: [] }] })).toBe(
    'Excel workbook, 1 sheets\nS  (empty)',
  );
});
