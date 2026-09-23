// @vitest-environment jsdom
import assert from 'node:assert/strict';

import JSZip from 'jszip';
import { test } from 'vitest';

import { readDocModel } from '../../server/src/officeDocs.js';
import { matchParagraphs } from '../src/docViewer.js';
import { drawnTexts } from '../src/wordDom.js';

// jsdom has no SVG layout; docx-preview measures drawings with it.
if (typeof SVGElement !== 'undefined' && !('getBBox' in SVGElement.prototype)) {
  Object.assign(SVGElement.prototype, { getBBox: () => ({ x: 0, y: 0, width: 0, height: 0 }) });
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';

async function docx(body: string): Promise<Blob> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="${REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`,
  );
  return new Blob([new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))]);
}

const p = (text: string, rPr = '') =>
  `<w:p><w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

test('docx-preview draws body paragraphs (incl. table cells) that line up with the ¶ numbering', async () => {
  const blob = await docx(
    p('Quarterly report', '<w:rPr><w:b/><w:sz w:val="40"/></w:rPr>') +
      '<w:p/>' +
      p('Churn rose.') +
      `<w:tbl><w:tr><w:tc>${p('Name')}</w:tc><w:tc>${p('Amount')}</w:tc></w:tr></w:tbl>` +
      p('Next quarter'),
  );
  const { renderAsync } = await import('docx-preview');
  const host = document.createElement('div');
  const styles = document.createElement('div');
  await renderAsync(blob, host, styles, {
    inWrapper: true,
    renderAltChunks: false,
    useBase64URL: true,
  });
  const drawn = [...host.querySelectorAll('article p')].map((el) => el.textContent ?? '');
  const model = ['Quarterly report', '', 'Churn rose.', 'Name', 'Amount', 'Next quarter'];
  assert.deepEqual(matchParagraphs(model, drawn), [1, 2, 3, 4, 5, 6]);
  // Formatting survives: the title run is bold.
  assert.ok(host.querySelector('article p span')?.getAttribute('style')?.includes('font-weight'));
});

test('matching skips drawn paragraphs the office does not number, without shifting the rest', () => {
  assert.deepEqual(matchParagraphs(['A', 'B', 'C'], ['A', 'in a text box', 'B', 'C']), [
    1,
    null,
    2,
    3,
  ]);
  assert.deepEqual(matchParagraphs(['A', 'missing', 'C'], ['A', 'C']), [1, 3]);
  assert.deepEqual(matchParagraphs(['a  b'], ['a\tb']), [1]);
});

test('on real Word files every numbered body paragraph finds its drawn paragraph', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { renderAsync } = await import('docx-preview');
  const dir = path.resolve(__dirname, '../../server/__tests__/fixtures/word');
  const report: string[] = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.docx'))) {
    const buf = fs.readFileSync(path.join(dir, name));
    const model = await readDocModel(buf, 'docx');
    if (model.kind !== 'docx') continue;
    const host = document.createElement('div');
    try {
      await renderAsync(new Blob([new Uint8Array(buf)]), host, document.createElement('div'), {
        inWrapper: true,
        renderAltChunks: false,
        useBase64URL: true,
      });
    } catch {
      report.push(`${name}: docx-preview could not draw it`);
      continue;
    }
    const drawn = [...host.querySelectorAll('article p')].map(drawnTexts);
    const matched = new Set(
      matchParagraphs(
        model.paragraphs.map((p) => p.text),
        drawn,
      ),
    );
    const missing = model.paragraphs.filter((p) => p.text.trim() && !matched.has(p.n));
    if (missing.length) report.push(`${name}: ¶${missing.map((p) => p.n).join(', ¶')} not found`);
  }
  assert.deepEqual(report, []);
});
