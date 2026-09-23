import * as jszipModule from 'jszip';

/** Small but real OOXML packages (Word, PowerPoint, Excel) built in-test. */

export const JSZip =
  (jszipModule as unknown as { default?: typeof jszipModule }).default ?? jszipModule;

// ── Fixture builders (small but real OOXML packages) ────────────────────────

export const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
export const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
export const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 250, 251, 252]);

export function rels(items: Array<[string, string, string]>): string {
  return (
    `${DECL}<Relationships xmlns="${REL}">` +
    items
      .map(
        ([id, type, target]) =>
          `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`,
      )
      .join('') +
    '</Relationships>'
  );
}

export async function zipOf(files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export const DOCX_BODY = [
  // 1 Title
  `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Quarterly report</w:t></w:r></w:p>`,
  // 2 heading with a localized style id
  `<w:p><w:pPr><w:pStyle w:val="berschrift1"/></w:pPr><w:r><w:t>Intro</w:t></w:r></w:p>`,
  // 3 multi-run formatted paragraph with a bookmark
  `<w:p w14:paraId="1A2B" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:pPr><w:jc w:val="center"/></w:pPr><w:bookmarkStart w:id="0" w:name="churn"/>` +
    `<w:r><w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr><w:t xml:space="preserve">Churn in the </w:t></w:r>` +
    `<w:r><w:rPr><w:i/></w:rPr><w:t>third quarter</w:t></w:r><w:r><w:tab/><w:t>fell.</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>`,
  // 4 empty
  `<w:p/>`,
  // 5 list item
  `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First point</w:t></w:r></w:p>`,
  // 6-9 table
  `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid>` +
    `<w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Amount</w:t></w:r></w:p></w:tc></w:tr>` +
    `<w:tr><w:tc><w:p><w:r><w:t>Acme</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>131,500</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
  // 10 inside a content control
  `<w:sdt><w:sdtPr/><w:sdtContent><w:p><w:r><w:t>In a control</w:t></w:r></w:p></w:sdtContent></w:sdt>`,
  // 11 tracked changes + line break
  `<w:p><w:r><w:t>Keep</w:t></w:r><w:del w:id="1" w:author="x"><w:r><w:delText>Gone</w:delText></w:r></w:del><w:ins w:id="2" w:author="x"><w:r><w:t>New</w:t><w:br/><w:t>line</w:t></w:r></w:ins></w:p>`,
  `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>`,
].join('');

export async function makeDocx(): Promise<Buffer> {
  return zipOf({
    '[Content_Types].xml': `${DECL}<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    '_rels/.rels': rels([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/_rels/document.xml.rels': rels([
      ['rId1', 'styles', 'styles.xml'],
      ['rId2', 'image', 'media/image1.png'],
    ]),
    'word/document.xml': `${DECL}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${DOCX_BODY}</w:body></w:document>`,
    'word/styles.xml': `${DECL}<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style></w:styles>`,
    'word/media/image1.png': PNG_BYTES,
  });
}

export function sp(id: number, name: string, body: string, ph?: string): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:spPr/>` +
    (body ? `<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${body}</p:txBody>` : '') +
    '</p:sp>'
  );
}

export function slideXml(shapes: string): string {
  return `${DECL}<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld><p:timing><p:tnLst/></p:timing></p:sld>`;
}

export async function makePptx(): Promise<Buffer> {
  // Presentation order is slide2.xml first, then slide1.xml.
  const first = slideXml(
    sp(2, 'Title 1', '<a:p><a:r><a:rPr lang="en-US"/><a:t>Why now</a:t></a:r></a:p>', 'title') +
      sp(
        3,
        'Content 2',
        '<a:p><a:pPr lvl="1"/><a:r><a:rPr lang="en-US" sz="2400" b="1"/><a:t>Churn is </a:t></a:r><a:r><a:rPr lang="en-US"/><a:t>up</a:t></a:r><a:endParaRPr lang="en-US"/></a:p>' +
          '<a:p><a:r><a:rPr lang="en-US"/><a:t>Costs</a:t></a:r><a:br/><a:r><a:t>fell</a:t></a:r></a:p>',
      ) +
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="Group 3"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp(5, 'TextBox 5', '<a:p><a:r><a:t>In a group</a:t></a:r></a:p>')}</p:grpSp>` +
      sp(6, 'TextBox 5', '<a:p><a:r><a:t>Same name</a:t></a:r></a:p>') +
      sp(7, 'Picture 6', ''),
  );
  const second = slideXml(sp(2, 'Title 1', '<a:p><a:r><a:t>Deck</a:t></a:r></a:p>', 'ctrTitle'));
  return zipOf({
    '[Content_Types].xml': `${DECL}<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': `${DECL}<p:presentation xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([
      ['rId2', 'slide', 'slides/slide1.xml'],
      ['rId3', 'slide', 'slides/slide2.xml'],
    ]),
    'ppt/slides/slide1.xml': second,
    'ppt/slides/slide2.xml': first,
    'ppt/slides/_rels/slide2.xml.rels': rels([['rId1', 'image', '../media/image1.png']]),
    'ppt/media/image1.png': PNG_BYTES,
  });
}

export const SHEET1 =
  `${DECL}<worksheet xmlns="${S}" xmlns:r="${R}"><dimension ref="A1:C4"/><sheetData>` +
  '<row r="1" spans="1:2"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
  '<row r="2" spans="1:3"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>131500</v></c><c r="C2" t="b"><v>1</v></c></row>' +
  '<row r="3"><c r="B3" s="1"><v>97200</v></c></row>' +
  '<row r="4"><c r="A4" t="str"><f>"Total"</f><v>Total</v></c><c r="B4" s="1"><f>SUM(B2:B3)</f><v>228700</v></c></row>' +
  '</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';

export const SHEET2 =
  `${DECL}<worksheet xmlns="${S}"><sheetData>` +
  '<row r="1"><c r="A1" t="inlineStr"><is><t>hello</t></is></c></row>' +
  '<row r="2"><c r="A2" t="str"><f t="shared" ref="A2:A3" si="0">A1&amp;"x"</f><v>hellox</v></c></row>' +
  '<row r="3"><c r="A3" t="str"><f t="shared" si="0"/><v>x</v></c></row>' +
  '<row r="5"><c r="B5"><f t="array" ref="B5:B6">ROW(A1:A2)</f><v>1</v></c></row>' +
  '<row r="6"><c r="B6"><v>2</v></c></row>' +
  '</sheetData></worksheet>';

export async function makeXlsx(opts: { formulas?: boolean } = {}): Promise<Buffer> {
  const withF = opts.formulas !== false;
  const sheet1 = withF
    ? SHEET1
    : SHEET1.replace('<f>"Total"</f>', '').replace('<f>SUM(B2:B3)</f>', '');
  return zipOf({
    '[Content_Types].xml': `${DECL}<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>`,
    '_rels/.rels': rels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': `${DECL}<workbook xmlns="${S}" xmlns:r="${R}"><bookViews><workbookView/></bookViews><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/><sheet name="My Sheet" sheetId="2" r:id="rId2"/></sheets><extLst/></workbook>`,
    'xl/_rels/workbook.xml.rels': rels([
      ['rId1', 'worksheet', 'worksheets/sheet1.xml'],
      ['rId2', 'worksheet', 'worksheets/sheet2.xml'],
      ['rId3', 'sharedStrings', 'sharedStrings.xml'],
      ['rId4', 'styles', 'styles.xml'],
      ['rId5', 'calcChain', 'calcChain.xml'],
    ]),
    'xl/sharedStrings.xml': `${DECL}<sst xmlns="${S}" count="3" uniqueCount="3"><si><t>Name</t></si><si><r><rPr><b/></rPr><t>Amo</t></r><r><t>unt</t></r><rPh sb="0" eb="1"><t>ph</t></rPh></si><si><t>Acme</t></si></sst>`,
    'xl/styles.xml': `${DECL}<styleSheet xmlns="${S}"><cellXfs count="2"><xf/><xf numFmtId="3"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': sheet1,
    'xl/worksheets/sheet2.xml': SHEET2,
    'xl/calcChain.xml': `${DECL}<calcChain xmlns="${S}"><c r="B4" i="1"/></calcChain>`,
  });
}
