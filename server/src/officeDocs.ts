import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import * as jszipModule from 'jszip';
import * as path from 'path';

import type {
  DocCell,
  DocEdit,
  DocEditPreview,
  DocKind,
  DocModel,
  DocParagraph,
  DocShape,
  DocSheet,
  DocSlide,
} from '../../core/src/docModel.js';
import {
  DOC_CELL_MAX_CHARS,
  DOC_EDIT_TEXT_MAX_CHARS,
  DOC_MAX_EDITS,
  DOC_MAX_ROWS,
} from './constants.js';

/**
 * The document engine for Word (.docx), PowerPoint (.pptx) and Excel (.xlsx).
 *
 * Reading turns a file into numbered places (core/src/docModel.ts). Editing
 * patches the XML parts it has to touch IN PLACE — it never rebuilds a file
 * from the model — so styles, images, comments, charts, animations and every
 * other part survive; zip entries we don't edit keep their exact bytes.
 *
 * Numbering (both read and edit use the same walkers, so they always agree):
 * - Word: every `w:p` of the body in document order, empty ones included.
 *   Tables are flattened row by row, cell by cell (nested tables in place);
 *   content controls (`w:sdt`) and `w:customXml` are looked through. Text
 *   boxes, headers, footers, footnotes and comments are not numbered.
 * - PowerPoint: slides in presentation order; on each slide every `p:sp` with
 *   a text body, group shapes looked through. Graphic frames (tables, charts)
 *   are skipped. Duplicate names on a slide become "Name (2)", "Name (3)".
 * - Excel: sheets in workbook order; cells as written. Numbers are the text
 *   stored in the file (dates are serial numbers — no number formats are
 *   applied). Shared formulas: only the master cell reports `formula`; the
 *   cells that reuse it report their cached value and no formula.
 *
 * Known losses when editing:
 * - A Word paragraph edit keeps the paragraph properties and the FIRST run's
 *   formatting; the other runs go, and with them fields, hyperlinks, images,
 *   footnote/endnote references and tracked-change wrappers inside that
 *   paragraph. Bookmark and comment range markers and comment reference runs
 *   are kept (so comments stay anchored).
 * - A shape edit keeps the first paragraph's properties and first run's
 *   formatting for every new line; per-paragraph bullets/levels beyond the
 *   first are lost.
 * - An Excel cell is written as a number, a formula (no cached value — the
 *   workbook is flagged to recalculate on open and calcChain.xml is dropped)
 *   or an inline string. Clearing a styled cell keeps it (empty) so its
 *   format stays. The master of a shared formula that other cells use, and
 *   the non-master cells of an array formula, are refused.
 * - Edited XML parts are re-serialized: their bytes change (whitespace between
 *   the declaration and the root, entity spelling) but not their content.
 */

// jszip is `export =` CommonJS: a namespace import types cleanly under both
// tsconfigs (no esModuleInterop); at run time the class is `.default` when an
// ESM loader wraps it, the namespace itself otherwise.
type JSZipStatic = typeof jszipModule;
type JSZip = Awaited<ReturnType<JSZipStatic['loadAsync']>>;
const JSZipLib: JSZipStatic =
  (jszipModule as unknown as { default?: JSZipStatic }).default ?? jszipModule;

// ── Namespaces ──────────────────────────────────────────────────────────────

const W_NS = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const A_NS = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
]);
const P_NS = new Set([
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main',
]);
const S_NS = new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main',
]);
const R_NS = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);

// ── Small XML helpers ───────────────────────────────────────────────────────

class DocError extends Error {}

function parseXml(xml: string, part: string): Document {
  const fail = (msg: string): never => {
    throw new DocError(`${part} is not valid XML (${msg.split('\n')[0]}).`);
  };
  const doc = new DOMParser({
    errorHandler: { warning: () => undefined, error: fail, fatalError: fail },
  }).parseFromString(xml, 'application/xml');
  if (!doc.documentElement) fail('no root element');
  return doc;
}

function serializeXml(doc: Document): string {
  return new XMLSerializer().serializeToString(doc);
}

function isEl(node: Node | null, ns: Set<string>, local: string): node is Element {
  return (
    !!node &&
    node.nodeType === 1 &&
    (node as Element).localName === local &&
    ns.has((node as Element).namespaceURI ?? '')
  );
}

function children(el: Element): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n as Element);
  return out;
}

function child(el: Element, ns: Set<string>, local: string): Element | null {
  for (let n = el.firstChild; n; n = n.nextSibling) if (isEl(n, ns, local)) return n;
  return null;
}

function childrenNamed(el: Element, ns: Set<string>, local: string): Element[] {
  return children(el).filter((c) => isEl(c, ns, local));
}

/** Every descendant element with that name, in document order. */
function descendants(el: Element, ns: Set<string>, local: string): Element[] {
  const out: Element[] = [];
  const walk = (e: Element): void => {
    for (const c of children(e)) {
      if (isEl(c, ns, local)) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

/** A namespaced attribute (`w:val`, `r:id`) by local name. */
function attrNs(el: Element, ns: Set<string>, local: string): string | null {
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i];
    if (a.localName === local && ns.has(a.namespaceURI ?? '')) return a.value;
  }
  return null;
}

/** A new element in `like`'s namespace, with its prefix. */
function mk(like: Element, local: string): Element {
  const doc = like.ownerDocument;
  const name = like.prefix ? `${like.prefix}:${local}` : local;
  return doc.createElementNS(like.namespaceURI, name);
}

function textOf(el: Element): string {
  return el.textContent ?? '';
}

function removeNode(n: Node): void {
  n.parentNode?.removeChild(n);
}

function insertAfterNode(node: Node, ref: Node): void {
  const parent = ref.parentNode;
  if (!parent) throw new DocError('Internal: node without parent.');
  parent.insertBefore(node, ref.nextSibling);
}

/** XML 1.0 can't carry most control characters; CRLF becomes LF. */
function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}

// ── Package (zip + relationships) ───────────────────────────────────────────

interface Rel {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

class Pkg {
  private readonly docs = new Map<string, Document>();
  private readonly dirty = new Set<string>();
  private readonly removed = new Set<string>();

  private constructor(readonly zip: JSZip) {}

  static async open(buf: Buffer): Promise<Pkg> {
    let zip: JSZip;
    try {
      zip = await JSZipLib.loadAsync(buf);
    } catch {
      throw new DocError('The file is not a valid Office document (not a zip archive).');
    }
    return new Pkg(zip);
  }

  has(part: string): boolean {
    return !this.removed.has(part) && !!this.zip.file(part);
  }

  async xml(part: string): Promise<Document> {
    const cached = this.docs.get(part);
    if (cached) return cached;
    const file = this.removed.has(part) ? null : this.zip.file(part);
    if (!file) throw new DocError(`The document has no ${part} part.`);
    let text = await file.async('string');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const doc = parseXml(text, part);
    this.docs.set(part, doc);
    return doc;
  }

  async xmlIfAny(part: string): Promise<Document | null> {
    return this.has(part) ? this.xml(part) : null;
  }

  markDirty(part: string): void {
    this.dirty.add(part);
  }

  remove(part: string): void {
    this.removed.add(part);
    this.dirty.delete(part);
  }

  /** Relationships of `part`, targets resolved to zip paths. */
  async rels(part: string): Promise<Rel[]> {
    const relsPart = relsPartOf(part);
    const doc = await this.xmlIfAny(relsPart);
    if (!doc) return [];
    const out: Rel[] = [];
    for (const r of children(doc.documentElement)) {
      if (r.localName !== 'Relationship') continue;
      const external = r.getAttribute('TargetMode') === 'External';
      const target = r.getAttribute('Target') ?? '';
      out.push({
        id: r.getAttribute('Id') ?? '',
        type: r.getAttribute('Type') ?? '',
        target: external ? target : resolveTarget(part, target),
        external,
      });
    }
    return out;
  }

  /** The package's main part (word/document.xml etc.) from _rels/.rels. */
  async mainPart(fallback: string): Promise<string> {
    const rels = await this.rels('');
    const main = rels.find((r) => /\/officeDocument$/.test(r.type) && !r.external);
    return main && this.has(main.target) ? main.target : fallback;
  }

  async toBuffer(): Promise<Buffer> {
    for (const part of this.removed) this.zip.remove(part);
    for (const part of this.dirty) {
      const doc = this.docs.get(part);
      if (doc) this.zip.file(part, serializeXml(doc), { createFolders: false });
    }
    return this.zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
  }
}

function relsPartOf(part: string): string {
  if (part === '') return '_rels/.rels';
  const dir = path.posix.dirname(part);
  const base = path.posix.basename(part);
  return dir === '.' ? `_rels/${base}.rels` : `${dir}/_rels/${base}.rels`;
}

function resolveTarget(source: string, target: string): string {
  let t = target;
  try {
    t = decodeURI(target);
  } catch {
    /* keep as written */
  }
  if (t.startsWith('/')) return t.slice(1);
  const dir = source === '' ? '' : path.posix.dirname(source);
  return path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, t)).replace(/^\/+/, '');
}

// ── Kinds ───────────────────────────────────────────────────────────────────

/** .docx / .pptx / .xlsx by extension (macro-enabled variants are refused). */
export function docKindOf(filePath: string): DocKind | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.pptx') return 'pptx';
  if (ext === '.xlsx') return 'xlsx';
  return null;
}

const KIND_NAME: Record<DocKind, string> = {
  docx: 'Word document',
  pptx: 'PowerPoint presentation',
  xlsx: 'Excel workbook',
};

// ── Word ────────────────────────────────────────────────────────────────────

interface WordPara {
  el: Element;
  table: boolean;
}

interface WordDoc {
  part: string;
  doc: Document;
  body: Element;
  paras: WordPara[];
  headingByStyle: Map<string, number>;
}

/** Containers looked through when numbering body paragraphs. */
const WORD_CONTAINERS = new Set(['tbl', 'tr', 'tc', 'sdt', 'sdtContent', 'customXml']);

function wordParagraphs(body: Element): WordPara[] {
  const out: WordPara[] = [];
  const walk = (el: Element, table: boolean): void => {
    for (const c of children(el)) {
      if (!W_NS.has(c.namespaceURI ?? '')) continue;
      if (c.localName === 'p') out.push({ el: c, table });
      else if (WORD_CONTAINERS.has(c.localName ?? '')) walk(c, table || c.localName === 'tbl');
    }
  };
  walk(body, false);
  return out;
}

/** Elements whose text isn't the paragraph's visible text. */
const WORD_TEXT_SKIP = new Set([
  'pPr',
  'rPr',
  'del',
  'moveFrom',
  'drawing',
  'pict',
  'object',
  'AlternateContent',
  'instrText',
  'delText',
  'footnoteReference',
  'endnoteReference',
  'commentReference',
]);

function wordParaText(p: Element): string {
  let text = '';
  const walk = (el: Element): void => {
    for (const c of children(el)) {
      const name = c.localName ?? '';
      if (WORD_TEXT_SKIP.has(name)) continue;
      if (W_NS.has(c.namespaceURI ?? '')) {
        if (name === 't') {
          text += textOf(c);
          continue;
        }
        if (name === 'tab' || name === 'ptab') {
          text += '\t';
          continue;
        }
        if (name === 'br' || name === 'cr') {
          text += '\n';
          continue;
        }
        if (name === 'noBreakHyphen') {
          text += '-';
          continue;
        }
      }
      walk(c);
    }
  };
  walk(p);
  return text;
}

function wordStyleOf(p: Element): string | null {
  const pPr = child(p, W_NS, 'pPr');
  const style = pPr && child(pPr, W_NS, 'pStyle');
  return style ? attrNs(style, W_NS, 'val') : null;
}

function headingLevelFromName(name: string): number | undefined {
  const m = /^heading\s*([1-6])$/i.exec(name.trim());
  if (m) return Number(m[1]);
  if (/^title$/i.test(name.trim())) return 1;
  return undefined;
}

async function wordHeadingStyles(pkg: Pkg, mainPart: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const rels = await pkg.rels(mainPart);
  const stylesPart =
    rels.find((r) => /\/styles$/.test(r.type) && !r.external)?.target ?? 'word/styles.xml';
  const doc = await pkg.xmlIfAny(stylesPart).catch(() => null);
  if (!doc) return map;
  for (const s of childrenNamed(doc.documentElement, W_NS, 'style')) {
    const id = attrNs(s, W_NS, 'styleId');
    if (!id) continue;
    const nameEl = child(s, W_NS, 'name');
    const name = nameEl ? attrNs(nameEl, W_NS, 'val') : null;
    const level = (name ? headingLevelFromName(name) : undefined) ?? headingLevelFromName(id);
    if (level) map.set(id, level);
  }
  return map;
}

async function openWord(pkg: Pkg): Promise<WordDoc> {
  const part = await pkg.mainPart('word/document.xml');
  const doc = await pkg.xml(part);
  const body = child(doc.documentElement, W_NS, 'body');
  if (!body) throw new DocError('The Word document has no body.');
  return {
    part,
    doc,
    body,
    paras: wordParagraphs(body),
    headingByStyle: await wordHeadingStyles(pkg, part),
  };
}

function wordModel(w: WordDoc): DocParagraph[] {
  return w.paras.map(({ el, table }, i) => {
    const para: DocParagraph = { n: i + 1, text: wordParaText(el) };
    const style = wordStyleOf(el);
    const heading = style
      ? (w.headingByStyle.get(style) ?? headingLevelFromName(style))
      : undefined;
    if (heading) para.heading = heading;
    if (table) para.table = true;
    const pPr = child(el, W_NS, 'pPr');
    if (pPr && child(pPr, W_NS, 'numPr')) para.list = true;
    return para;
  });
}

/** The run whose formatting a replacement keeps: the first with text, else the first. */
function firstRun(p: Element): Element | null {
  const runs = descendants(p, W_NS, 'r').filter((r) => {
    for (let a = r.parentNode; a && a !== p; a = a.parentNode) {
      const name = (a as Element).localName;
      if (name === 'del' || name === 'moveFrom' || name === 'txbxContent') return false;
    }
    return true;
  });
  return runs.find((r) => child(r, W_NS, 't')) ?? runs[0] ?? null;
}

interface WordTemplate {
  pPr: Element | null;
  rPr: Element | null;
}

function wordTemplate(p: Element): WordTemplate {
  const pPr = child(p, W_NS, 'pPr');
  const run = firstRun(p);
  const rPr = run ? child(run, W_NS, 'rPr') : null;
  return {
    pPr: pPr ? (pPr.cloneNode(true) as Element) : null,
    rPr: rPr ? (rPr.cloneNode(true) as Element) : null,
  };
}

/** One `w:r` carrying `text` ("\t" → w:tab, "\n" → w:br), or null for "". */
function wordRun(like: Element, rPr: Element | null, text: string): Element | null {
  if (text === '') return null;
  const r = mk(like, 'r');
  if (rPr) r.appendChild(rPr.cloneNode(true));
  for (const piece of text.split(/(\t|\n)/)) {
    if (piece === '') continue;
    if (piece === '\t') r.appendChild(mk(like, 'tab'));
    else if (piece === '\n') r.appendChild(mk(like, 'br'));
    else {
      const t = mk(like, 't');
      t.setAttribute('xml:space', 'preserve');
      t.appendChild(like.ownerDocument.createTextNode(piece));
      r.appendChild(t);
    }
  }
  return r;
}

const WORD_KEEP_MARKERS = new Set([
  'bookmarkStart',
  'bookmarkEnd',
  'commentRangeStart',
  'commentRangeEnd',
  'permStart',
  'permEnd',
]);

function isKeptWordChild(c: Element): boolean {
  if (!W_NS.has(c.namespaceURI ?? '')) return false;
  const name = c.localName ?? '';
  if (WORD_KEEP_MARKERS.has(name)) return true;
  // A run that only anchors a comment keeps the comment attached.
  return name === 'r' && !!child(c, W_NS, 'commentReference') && !child(c, W_NS, 't');
}

function replaceWordParagraph(p: Element, template: WordTemplate, text: string): void {
  const run = wordRun(p, template.rPr, text);
  const first = firstRun(p);
  // The direct child of p that holds the first run (a hyperlink, ins, …).
  let anchor: Node | null = first;
  while (anchor && anchor.parentNode !== p) anchor = anchor.parentNode;
  let placed = false;
  for (const c of children(p)) {
    if (isEl(c, W_NS, 'pPr')) continue;
    if (c === anchor && run) {
      p.insertBefore(run, c);
      placed = true;
    }
    if (!isKeptWordChild(c)) removeNode(c);
  }
  if (run && !placed) {
    const pPr = child(p, W_NS, 'pPr');
    // No run before: text goes after the leading markers (bookmarkStart…).
    let ref: Node | null = pPr ? pPr.nextSibling : p.firstChild;
    while (ref && ref.nodeType === 1 && /Start$/.test((ref as Element).localName ?? ''))
      ref = ref.nextSibling;
    p.insertBefore(run, ref);
  }
}

function newWordParagraph(like: Element, template: WordTemplate, text: string): Element {
  const p = mk(like, 'p');
  if (template.pPr) {
    const pPr = template.pPr.cloneNode(true) as Element;
    // A cloned section break or tracked property change would duplicate them.
    for (const c of children(pPr))
      if (isEl(c, W_NS, 'sectPr') || isEl(c, W_NS, 'pPrChange')) removeNode(c);
    p.appendChild(pPr);
  }
  const run = wordRun(like, template.rPr, text);
  if (run) p.appendChild(run);
  return p;
}

// ── PowerPoint ──────────────────────────────────────────────────────────────

interface PptShape {
  name: string;
  el: Element;
  txBody: Element;
  title: boolean;
}

interface PptSlide {
  part: string;
  doc: Document;
  shapes: PptShape[];
}

async function openPpt(pkg: Pkg): Promise<PptSlide[]> {
  const part = await pkg.mainPart('ppt/presentation.xml');
  const pres = await pkg.xml(part);
  const rels = new Map((await pkg.rels(part)).map((r) => [r.id, r]));
  const list = child(pres.documentElement, P_NS, 'sldIdLst');
  const slides: PptSlide[] = [];
  for (const sldId of list ? childrenNamed(list, P_NS, 'sldId') : []) {
    const rid = attrNs(sldId, R_NS, 'id');
    const rel = rid ? rels.get(rid) : undefined;
    if (!rel || rel.external || !pkg.has(rel.target)) continue;
    const doc = await pkg.xml(rel.target);
    slides.push({ part: rel.target, doc, shapes: pptShapes(doc) });
  }
  return slides;
}

function pptShapes(doc: Document): PptShape[] {
  const cSld = child(doc.documentElement, P_NS, 'cSld');
  const tree = cSld && child(cSld, P_NS, 'spTree');
  const found: Array<Omit<PptShape, 'name'> & { raw: string }> = [];
  const walk = (el: Element): void => {
    for (const c of children(el)) {
      if (isEl(c, P_NS, 'grpSp')) walk(c);
      else if (isEl(c, P_NS, 'sp')) {
        const txBody = child(c, P_NS, 'txBody');
        if (!txBody) continue;
        const nv = child(c, P_NS, 'nvSpPr');
        const cNvPr = nv && child(nv, P_NS, 'cNvPr');
        const nvPr = nv && child(nv, P_NS, 'nvPr');
        const ph = nvPr && child(nvPr, P_NS, 'ph');
        const phType = ph?.getAttribute('type') ?? '';
        const raw =
          cNvPr?.getAttribute('name')?.trim() ||
          `Shape ${cNvPr?.getAttribute('id') ?? found.length + 1}`;
        found.push({ el: c, txBody, raw, title: phType === 'title' || phType === 'ctrTitle' });
      }
    }
  };
  if (tree) walk(tree);
  const seen = new Map<string, number>();
  const taken = new Set(found.map((f) => f.raw));
  return found.map(({ raw, ...rest }) => {
    const count = (seen.get(raw) ?? 0) + 1;
    seen.set(raw, count);
    let name = raw;
    if (count > 1) {
      let k = count;
      while (taken.has(`${raw} (${k})`)) k++;
      name = `${raw} (${k})`;
      taken.add(name);
    }
    return { ...rest, name };
  });
}

function pptParaText(p: Element): string {
  let text = '';
  for (const c of children(p)) {
    if (isEl(c, A_NS, 'r') || isEl(c, A_NS, 'fld')) {
      const t = child(c, A_NS, 't');
      if (t) text += textOf(t);
    } else if (isEl(c, A_NS, 'br')) text += '\n';
  }
  return text;
}

function pptShapeText(txBody: Element): string {
  return childrenNamed(txBody, A_NS, 'p').map(pptParaText).join('\n');
}

function findShape(slide: PptSlide, name: string): PptShape | undefined {
  const exact = slide.shapes.find((s) => s.name === name);
  if (exact) return exact;
  const lower = name.trim().toLowerCase();
  const loose = slide.shapes.filter((s) => s.name.toLowerCase() === lower);
  return loose.length === 1 ? loose[0] : undefined;
}

function replaceShapeText(txBody: Element, text: string): void {
  const paras = childrenNamed(txBody, A_NS, 'p');
  const first = paras[0];
  const pPr = first ? child(first, A_NS, 'pPr') : null;
  const firstR = paras.map((p) => child(p, A_NS, 'r')).find((r): r is Element => !!r) ?? null;
  const rPr = firstR ? child(firstR, A_NS, 'rPr') : null;
  const endRPr = first ? child(first, A_NS, 'endParaRPr') : null;
  // Where the new paragraphs go: where the old ones were (before any extLst).
  const next = paras.length ? paras[paras.length - 1].nextSibling : null;
  const like = first ?? child(txBody, A_NS, 'bodyPr');
  if (!like) throw new DocError('A shape has a text body without a:bodyPr.');
  for (const p of paras) removeNode(p);
  for (const line of text.split('\n')) {
    const p = mk(like, 'p');
    if (pPr) p.appendChild(pPr.cloneNode(true));
    if (line !== '') {
      const r = mk(like, 'r');
      if (rPr) r.appendChild(rPr.cloneNode(true));
      const t = mk(like, 't');
      t.appendChild(like.ownerDocument.createTextNode(line));
      r.appendChild(t);
      p.appendChild(r);
    }
    if (endRPr) p.appendChild(endRPr.cloneNode(true));
    txBody.insertBefore(p, next);
  }
}

// ── Excel ───────────────────────────────────────────────────────────────────

interface XlsxSheetRef {
  name: string;
  part: string;
}

interface XlsxBook {
  part: string;
  doc: Document;
  sheets: XlsxSheetRef[];
  shared: string[];
}

interface XlsxCellEl {
  el: Element;
  row: number;
  col: number;
}

interface XlsxRowEl {
  el: Element;
  row: number;
  cells: XlsxCellEl[];
}

interface XlsxSheetDoc {
  doc: Document;
  sheetData: Element;
  rows: XlsxRowEl[];
}

const MAX_COL = 16_384;
const MAX_ROW = 1_048_576;

function colName(col: number): string {
  let s = '';
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function colNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** "C5" → {row 5, col 3}; null when it isn't a cell reference Excel allows. */
function parseCellRef(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref.trim());
  if (!m) return null;
  const col = colNumber(m[1]);
  const row = Number(m[2]);
  if (col < 1 || col > MAX_COL || row < 1 || row > MAX_ROW) return null;
  return { row, col };
}

function cellRef(row: number, col: number): string {
  return `${colName(col)}${row}`;
}

/** "Sheet1!C5", "'My Sheet'!C5", "C5" → sheet (if any) + the rest. */
function splitSheet(ref: string): { sheet?: string; rest: string } {
  const quoted = /^'((?:[^']|'')+)'!(.*)$/.exec(ref);
  if (quoted) return { sheet: quoted[1].replace(/''/g, "'"), rest: quoted[2] };
  const bang = ref.lastIndexOf('!');
  if (bang > 0) return { sheet: ref.slice(0, bang), rest: ref.slice(bang + 1) };
  return { rest: ref };
}

async function openXlsx(pkg: Pkg): Promise<XlsxBook> {
  const part = await pkg.mainPart('xl/workbook.xml');
  const doc = await pkg.xml(part);
  const rels = await pkg.rels(part);
  const byId = new Map(rels.map((r) => [r.id, r]));
  const sheetsEl = child(doc.documentElement, S_NS, 'sheets');
  const sheets: XlsxSheetRef[] = [];
  for (const s of sheetsEl ? childrenNamed(sheetsEl, S_NS, 'sheet') : []) {
    const rid = attrNs(s, R_NS, 'id');
    const rel = rid ? byId.get(rid) : undefined;
    // Chart sheets and dialog sheets have no cells.
    if (!rel || rel.external || !/\/worksheet$/.test(rel.type) || !pkg.has(rel.target)) continue;
    sheets.push({ name: s.getAttribute('name') ?? '', part: rel.target });
  }
  const sstPart = rels.find((r) => /\/sharedStrings$/.test(r.type) && !r.external)?.target;
  const shared: string[] = [];
  const sst = sstPart ? await pkg.xmlIfAny(sstPart) : null;
  if (sst)
    for (const si of childrenNamed(sst.documentElement, S_NS, 'si')) shared.push(richText(si));
  return { part, doc, sheets, shared };
}

/** A string item: its `t`, or its runs' `t`s (phonetic runs skipped). */
function richText(si: Element): string {
  const t = child(si, S_NS, 't');
  if (t) return textOf(t);
  return childrenNamed(si, S_NS, 'r')
    .map((r) => {
      const rt = child(r, S_NS, 't');
      return rt ? textOf(rt) : '';
    })
    .join('');
}

function readSheetDoc(doc: Document): XlsxSheetDoc {
  const sheetData = child(doc.documentElement, S_NS, 'sheetData');
  if (!sheetData) throw new DocError('A worksheet has no sheetData.');
  const rows: XlsxRowEl[] = [];
  let lastRow = 0;
  for (const rowEl of childrenNamed(sheetData, S_NS, 'row')) {
    const r = Number(rowEl.getAttribute('r'));
    const row = Number.isInteger(r) && r > 0 ? r : lastRow + 1;
    lastRow = row;
    const cells: XlsxCellEl[] = [];
    let lastCol = 0;
    for (const c of childrenNamed(rowEl, S_NS, 'c')) {
      const parsed = parseCellRef(c.getAttribute('r') ?? '');
      const col = parsed ? parsed.col : lastCol + 1;
      lastCol = col;
      cells.push({ el: c, row, col });
    }
    rows.push({ el: rowEl, row, cells });
  }
  return { doc, sheetData, rows };
}

function cellValue(c: Element, shared: string[]): string {
  const t = c.getAttribute('t') ?? 'n';
  if (t === 'inlineStr') {
    const is = child(c, S_NS, 'is');
    return is ? richText(is) : '';
  }
  const v = child(c, S_NS, 'v');
  const raw = v ? textOf(v) : '';
  if (t === 's') return shared[Number(raw)] ?? '';
  if (t === 'b') return raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
  return raw;
}

/** The formula text, when this cell carries it (shared-formula dependents don't). */
function cellFormula(c: Element): string | undefined {
  const f = child(c, S_NS, 'f');
  if (!f) return undefined;
  const text = textOf(f);
  return text === '' ? undefined : text;
}

function toDocCell(c: XlsxCellEl, shared: string[]): DocCell {
  const cell: DocCell = { ref: cellRef(c.row, c.col), value: cellValue(c.el, shared) };
  const formula = cellFormula(c.el);
  if (formula !== undefined) cell.formula = formula;
  return cell;
}

function sheetModel(
  name: string,
  sheet: XlsxSheetDoc,
  shared: string[],
  maxRows: number,
): DocSheet {
  let minR = Infinity;
  let minC = Infinity;
  let maxR = 0;
  let maxC = 0;
  const rows: DocCell[][] = [];
  let truncated = false;
  for (const row of sheet.rows) {
    if (row.cells.length === 0) continue;
    for (const c of row.cells) {
      minR = Math.min(minR, c.row);
      maxR = Math.max(maxR, c.row);
      minC = Math.min(minC, c.col);
      maxC = Math.max(maxC, c.col);
    }
    if (rows.length >= maxRows) {
      truncated = true;
      continue;
    }
    rows.push(row.cells.map((c) => toDocCell(c, shared)));
  }
  const range =
    maxR === 0
      ? ''
      : minR === maxR && minC === maxC
        ? cellRef(minR, minC)
        : `${cellRef(minR, minC)}:${cellRef(maxR, maxC)}`;
  const out: DocSheet = { name, range, rows };
  if (truncated) out.truncated = true;
  return out;
}

function findSheet(book: XlsxBook, name: string): XlsxSheetRef | undefined {
  return (
    book.sheets.find((s) => s.name === name) ??
    book.sheets.find((s) => s.name.toLowerCase() === name.toLowerCase())
  );
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** A document's numbered places. Throws on files that aren't that kind of document. */
export async function readDocModel(
  buf: Buffer,
  kind: DocKind,
  opts: { maxRows?: number } = {},
): Promise<DocModel> {
  const pkg = await Pkg.open(buf);
  if (kind === 'docx') return { kind, paragraphs: wordModel(await openWord(pkg)) };
  if (kind === 'pptx') {
    const slides = await openPpt(pkg);
    return {
      kind,
      slides: slides.map((s, i): DocSlide => ({
        n: i + 1,
        shapes: s.shapes.map((sh): DocShape => {
          const shape: DocShape = { name: sh.name, text: pptShapeText(sh.txBody) };
          if (sh.title) shape.title = true;
          return shape;
        }),
      })),
    };
  }
  const book = await openXlsx(pkg);
  const maxRows = Math.max(1, Math.floor(opts.maxRows ?? DOC_MAX_ROWS));
  const sheets: DocSheet[] = [];
  for (const ref of book.sheets) {
    sheets.push(sheetModel(ref.name, readSheetDoc(await pkg.xml(ref.part)), book.shared, maxRows));
  }
  return { kind, sheets };
}

// ── Edit validation ─────────────────────────────────────────────────────────

const EDIT_KIND_FOR: Record<DocEdit['kind'], DocKind> = {
  para: 'docx',
  insertAfter: 'docx',
  shape: 'pptx',
  cell: 'xlsx',
};

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function wholeNumber(x: unknown, min: number): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= min;
}

/**
 * Checks that `x` is a well-formed DocEdit (any source: JSON from an agent,
 * a network message). Returns a clean copy or throws an Error saying what's wrong.
 */
export function validateDocEdit(x: unknown): DocEdit {
  if (!isPlainObject(x))
    throw new Error('an edit must be an object like {"kind":"para","n":3,"text":"…"}.');
  const text = (field: string, max: number): string => {
    const v = x[field];
    if (typeof v !== 'string') throw new Error(`"${field}" must be a string.`);
    if (v.length > max) throw new Error(`"${field}" is longer than ${max} characters.`);
    return v;
  };
  switch (x.kind) {
    case 'para':
    case 'insertAfter': {
      if (!wholeNumber(x.n, x.kind === 'para' ? 1 : 0))
        throw new Error(
          `"n" must be a paragraph number${x.kind === 'para' ? ' from 1' : ' (0 = before the first)'}.`,
        );
      return { kind: x.kind, n: x.n, text: text('text', DOC_EDIT_TEXT_MAX_CHARS) };
    }
    case 'shape': {
      if (!wholeNumber(x.slide, 1)) throw new Error('"slide" must be a slide number from 1.');
      const shape = text('shape', 1_000);
      if (shape.trim() === '') throw new Error('"shape" must name a shape, e.g. "Title 1".');
      return { kind: 'shape', slide: x.slide, shape, text: text('text', DOC_EDIT_TEXT_MAX_CHARS) };
    }
    case 'cell': {
      const ref = text('ref', 300);
      if (ref.trim() === '') throw new Error('"ref" must be a cell like "C5".');
      const edit: DocEdit = { kind: 'cell', ref, value: text('value', DOC_CELL_MAX_CHARS) };
      if (x.sheet !== undefined) {
        const sheet = text('sheet', 300);
        if (sheet !== '') edit.sheet = sheet;
      }
      return edit;
    }
    default:
      throw new Error('"kind" must be "para", "insertAfter", "shape" or "cell".');
  }
}

const NUMBER_RE = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

function whereOf(edit: { kind: 'para' | 'insertAfter'; n: number }): string {
  if (edit.kind === 'para') return `¶${edit.n}`;
  return edit.n === 0 ? 'before ¶1' : `after ¶${edit.n}`;
}

type EditResult =
  { ok: true; buffer: Buffer; previews: DocEditPreview[] } | { ok: false; error: string };

/**
 * Apply `edits` in order, all or nothing. Every number and name refers to the
 * document as it was BEFORE the batch (an insert doesn't renumber later edits).
 */
export async function applyDocEdits(
  buf: Buffer,
  kind: DocKind,
  edits: DocEdit[],
): Promise<EditResult> {
  if (!Array.isArray(edits) || edits.length === 0) return { ok: false, error: 'No edits.' };
  if (edits.length > DOC_MAX_EDITS)
    return { ok: false, error: `At most ${DOC_MAX_EDITS} edits at once.` };
  const clean: DocEdit[] = [];
  for (let i = 0; i < edits.length; i++) {
    try {
      const e = validateDocEdit(edits[i]);
      if (EDIT_KIND_FOR[e.kind] !== kind)
        throw new Error(`a ${e.kind} edit can't be applied to a ${KIND_NAME[kind]}.`);
      clean.push(e);
    } catch (err) {
      return { ok: false, error: `Edit ${i + 1}: ${(err as Error).message}` };
    }
  }
  let pkg: Pkg;
  try {
    pkg = await Pkg.open(buf);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  try {
    let previews: DocEditPreview[];
    if (kind === 'docx') previews = await editWord(pkg, clean);
    else if (kind === 'pptx') previews = await editPpt(pkg, clean);
    else previews = await editXlsx(pkg, clean);
    return { ok: true, buffer: await pkg.toBuffer(), previews };
  } catch (err) {
    if (err instanceof EditError || err instanceof DocError)
      return { ok: false, error: err.message };
    return { ok: false, error: `Could not edit the ${KIND_NAME[kind]}: ${(err as Error).message}` };
  }
}

class EditError extends Error {
  constructor(index: number, message: string) {
    super(`Edit ${index + 1}: ${message}`);
  }
}

async function editWord(pkg: Pkg, edits: DocEdit[]): Promise<DocEditPreview[]> {
  const w = await openWord(pkg);
  const count = w.paras.length;
  const templates = new Map<number, WordTemplate>();
  edits.forEach((e, i) => {
    if (e.kind !== 'para' && e.kind !== 'insertAfter') return;
    if (e.kind === 'para' && e.n > count)
      throw new EditError(i, `there is no paragraph ${e.n} (the document has ${count}).`);
    if (e.kind === 'insertAfter' && e.n > count)
      throw new EditError(i, `can't insert after paragraph ${e.n} (the document has ${count}).`);
    if (e.n > 0 && !templates.has(e.n)) templates.set(e.n, wordTemplate(w.paras[e.n - 1].el));
  });
  const previews: DocEditPreview[] = [];
  // Consecutive inserts after the same paragraph keep their order.
  const lastInserted = new Map<number, Element>();
  for (const e of edits) {
    if (e.kind === 'para') {
      const p = w.paras[e.n - 1].el;
      const before = wordParaText(p);
      const text = cleanText(e.text);
      replaceWordParagraph(p, templates.get(e.n) as WordTemplate, text);
      previews.push({ edit: e, where: whereOf(e), before, after: text });
    } else if (e.kind === 'insertAfter') {
      const text = cleanText(e.text);
      const template = e.n > 0 ? (templates.get(e.n) as WordTemplate) : { pPr: null, rPr: null };
      const p = newWordParagraph(w.body, template, text);
      const prev = lastInserted.get(e.n);
      if (prev) insertAfterNode(p, prev);
      else if (e.n > 0) insertAfterNode(p, w.paras[e.n - 1].el);
      else w.body.insertBefore(p, children(w.body)[0] ?? null);
      lastInserted.set(e.n, p);
      previews.push({ edit: e, where: whereOf(e), before: '', after: text });
    }
  }
  pkg.markDirty(w.part);
  return previews;
}

async function editPpt(pkg: Pkg, edits: DocEdit[]): Promise<DocEditPreview[]> {
  const slides = await openPpt(pkg);
  const targets = edits.map((e, i) => {
    if (e.kind !== 'shape') throw new EditError(i, 'not a shape edit.');
    const slide = slides[e.slide - 1];
    if (!slide)
      throw new EditError(
        i,
        `there is no slide ${e.slide} (the presentation has ${slides.length}).`,
      );
    const shape = findShape(slide, e.shape);
    if (!shape) {
      const names = slide.shapes.map((s) => `“${s.name}”`).join(', ') || 'none';
      throw new EditError(i, `slide ${e.slide} has no text shape “${e.shape}” (it has ${names}).`);
    }
    return { e, slide, shape };
  });
  const previews: DocEditPreview[] = [];
  for (const { e, slide, shape } of targets) {
    const before = pptShapeText(shape.txBody);
    const text = cleanText((e as Extract<DocEdit, { kind: 'shape' }>).text);
    replaceShapeText(shape.txBody, text);
    pkg.markDirty(slide.part);
    previews.push({
      edit: e,
      where: `slide ${slides.indexOf(slide) + 1} “${shape.name}”`,
      before,
      after: text,
    });
  }
  return previews;
}

interface CellTarget {
  e: Extract<DocEdit, { kind: 'cell' }>;
  sheet: XlsxSheetRef;
  row: number;
  col: number;
  value: string;
}

/** Shared-formula masters that other cells reuse, and array-formula ranges, per sheet. */
function formulaGuards(sheet: XlsxSheetDoc): {
  sharedMasters: Set<string>;
  arrays: Array<{ master: string; r1: number; c1: number; r2: number; c2: number }>;
} {
  const masterBySi = new Map<string, string>();
  const users = new Map<string, number>();
  const arrays: Array<{ master: string; r1: number; c1: number; r2: number; c2: number }> = [];
  for (const row of sheet.rows)
    for (const c of row.cells) {
      const f = child(c.el, S_NS, 'f');
      if (!f) continue;
      const t = f.getAttribute('t');
      const ref = cellRef(c.row, c.col);
      if (t === 'shared') {
        const si = f.getAttribute('si') ?? '';
        if (textOf(f) !== '') masterBySi.set(si, ref);
        else users.set(si, (users.get(si) ?? 0) + 1);
      } else if (t === 'array') {
        const [a, b] = (f.getAttribute('ref') ?? ref).split(':');
        const p1 = parseCellRef(a);
        const p2 = parseCellRef(b ?? a);
        if (p1 && p2)
          arrays.push({
            master: ref,
            r1: Math.min(p1.row, p2.row),
            c1: Math.min(p1.col, p2.col),
            r2: Math.max(p1.row, p2.row),
            c2: Math.max(p1.col, p2.col),
          });
      }
    }
  const sharedMasters = new Set<string>();
  for (const [si, ref] of masterBySi) if ((users.get(si) ?? 0) > 0) sharedMasters.add(ref);
  return { sharedMasters, arrays };
}

async function editXlsx(pkg: Pkg, edits: DocEdit[]): Promise<DocEditPreview[]> {
  const book = await openXlsx(pkg);
  if (book.sheets.length === 0) throw new DocError('The workbook has no worksheets.');
  const sheets = new Map<string, XlsxSheetDoc>();
  const sheetDoc = async (ref: XlsxSheetRef): Promise<XlsxSheetDoc> => {
    let s = sheets.get(ref.part);
    if (!s) {
      s = readSheetDoc(await pkg.xml(ref.part));
      sheets.set(ref.part, s);
    }
    return s;
  };

  const targets: CellTarget[] = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (e.kind !== 'cell') throw new EditError(i, 'not a cell edit.');
    const split = splitSheet(e.ref.trim());
    if (split.sheet && e.sheet && split.sheet.toLowerCase() !== e.sheet.toLowerCase())
      throw new EditError(
        i,
        `the ref names sheet “${split.sheet}” but the edit says “${e.sheet}”.`,
      );
    const sheetName = split.sheet ?? e.sheet;
    const sheet = sheetName ? findSheet(book, sheetName) : book.sheets[0];
    if (!sheet)
      throw new EditError(
        i,
        `there is no sheet “${sheetName}” (the workbook has ${book.sheets.map((s) => `“${s.name}”`).join(', ')}).`,
      );
    const pos = parseCellRef(split.rest);
    if (!pos) throw new EditError(i, `“${split.rest}” is not a cell like C5.`);
    const value = cleanText(e.value);
    if (value.startsWith('=') && value.slice(1).trim() === '')
      throw new EditError(i, 'the formula is empty.');
    const doc = await sheetDoc(sheet);
    const ref = cellRef(pos.row, pos.col);
    const guards = formulaGuards(doc);
    if (guards.sharedMasters.has(ref))
      throw new EditError(
        i,
        `${sheet.name}!${ref} holds a shared formula other cells reuse; editing it here would break them.`,
      );
    const arr = guards.arrays.find(
      (a) =>
        pos.row >= a.r1 &&
        pos.row <= a.r2 &&
        pos.col >= a.c1 &&
        pos.col <= a.c2 &&
        a.master !== ref,
    );
    if (arr)
      throw new EditError(
        i,
        `${sheet.name}!${ref} is part of an array formula entered at ${arr.master}.`,
      );
    targets.push({ e, sheet, row: pos.row, col: pos.col, value });
  }

  const previews: DocEditPreview[] = [];
  let formulasTouched = false;
  for (const t of targets) {
    const doc = await sheetDoc(t.sheet);
    const ref = cellRef(t.row, t.col);
    const existing = findCell(doc, t.row, t.col);
    let before = '';
    if (existing) {
      const f = cellFormula(existing.el);
      if (child(existing.el, S_NS, 'f')) formulasTouched = true;
      before = f !== undefined ? `=${f}` : cellValue(existing.el, book.shared);
    }
    if (t.value.startsWith('=')) formulasTouched = true;
    writeCell(doc, t.row, t.col, t.value);
    pkg.markDirty(t.sheet.part);
    previews.push({ edit: t.e, where: `${t.sheet.name}!${ref}`, before, after: t.value });
  }

  let anyFormulas = formulasTouched;
  if (!anyFormulas) {
    for (const s of book.sheets) {
      const d = await sheetDoc(s);
      if (d.rows.some((r) => r.cells.some((c) => child(c.el, S_NS, 'f')))) {
        anyFormulas = true;
        break;
      }
    }
  }
  if (anyFormulas) setFullCalcOnLoad(book.doc);
  if (anyFormulas) pkg.markDirty(book.part);
  if (formulasTouched) await dropCalcChain(pkg, book.part);
  return previews;
}

function findCell(sheet: XlsxSheetDoc, row: number, col: number): XlsxCellEl | undefined {
  return sheet.rows.find((r) => r.row === row)?.cells.find((c) => c.col === col);
}

/** Give every row and cell an explicit `r`, so inserting can't shift implicit positions. */
function materializeRefs(sheet: XlsxSheetDoc): void {
  for (const row of sheet.rows) {
    row.el.setAttribute('r', String(row.row));
    for (const c of row.cells) c.el.setAttribute('r', cellRef(c.row, c.col));
  }
}

function writeCell(sheet: XlsxSheetDoc, rowN: number, col: number, value: string): void {
  let row = sheet.rows.find((r) => r.row === rowN);
  let cell = row?.cells.find((c) => c.col === col);
  materializeRefs(sheet);
  if (value === '') {
    if (!cell) return;
    if (cell.el.getAttribute('s') && cell.el.getAttribute('s') !== '0') {
      // Keep the styled (now empty) cell so its format survives.
      for (const c of children(cell.el)) if (!isEl(c, S_NS, 'extLst')) removeNode(c);
      cell.el.removeAttribute('t');
      cell.el.removeAttribute('cm');
      cell.el.removeAttribute('vm');
    } else {
      removeNode(cell.el);
      row?.cells.splice(row.cells.indexOf(cell), 1);
    }
    return;
  }
  if (!row) {
    const el = mk(sheet.sheetData, 'row');
    el.setAttribute('r', String(rowN));
    const after = sheet.rows.find((r) => r.row > rowN);
    sheet.sheetData.insertBefore(el, after ? after.el : null);
    row = { el, row: rowN, cells: [] };
    sheet.rows.splice(after ? sheet.rows.indexOf(after) : sheet.rows.length, 0, row);
  }
  if (!cell) {
    const el = mk(row.el, 'c');
    el.setAttribute('r', cellRef(rowN, col));
    const after = row.cells.find((c) => c.col > col);
    row.el.insertBefore(el, after ? after.el : (child(row.el, S_NS, 'extLst') ?? null));
    cell = { el, row: rowN, col };
    row.cells.splice(after ? row.cells.indexOf(after) : row.cells.length, 0, cell);
    widenSpans(row.el, col);
  }
  const c = cell.el;
  for (const k of children(c)) if (!isEl(k, S_NS, 'extLst')) removeNode(k);
  c.removeAttribute('t');
  c.removeAttribute('cm');
  c.removeAttribute('vm');
  const ext = child(c, S_NS, 'extLst');
  if (value.startsWith('=')) {
    const f = mk(c, 'f');
    f.appendChild(c.ownerDocument.createTextNode(value.slice(1)));
    c.insertBefore(f, ext);
  } else if (NUMBER_RE.test(value.trim())) {
    const v = mk(c, 'v');
    v.appendChild(c.ownerDocument.createTextNode(value.trim()));
    c.insertBefore(v, ext);
  } else {
    c.setAttribute('t', 'inlineStr');
    const is = mk(c, 'is');
    const t = mk(c, 't');
    t.setAttribute('xml:space', 'preserve');
    t.appendChild(c.ownerDocument.createTextNode(value));
    is.appendChild(t);
    c.insertBefore(is, ext);
  }
  growDimension(sheet, rowN, col);
}

function widenSpans(rowEl: Element, col: number): void {
  const spans = rowEl.getAttribute('spans');
  const m = spans ? /^(\d+):(\d+)$/.exec(spans) : null;
  if (!m) return;
  rowEl.setAttribute('spans', `${Math.min(Number(m[1]), col)}:${Math.max(Number(m[2]), col)}`);
}

function growDimension(sheet: XlsxSheetDoc, row: number, col: number): void {
  const dim = child(sheet.doc.documentElement, S_NS, 'dimension');
  if (!dim) return;
  const [a, b] = (dim.getAttribute('ref') ?? '').split(':');
  const p1 = parseCellRef(a ?? '');
  const p2 = parseCellRef(b ?? a ?? '');
  if (!p1 || !p2) return;
  // "A1" alone is what an empty sheet says; a first cell elsewhere replaces it.
  const empty = sheet.rows.every(
    (r) => r.cells.length === 0 || (r.row === row && r.cells.length === 1),
  );
  const r1 = empty ? row : Math.min(p1.row, p2.row, row);
  const c1 = empty ? col : Math.min(p1.col, p2.col, col);
  const r2 = empty ? row : Math.max(p1.row, p2.row, row);
  const c2 = empty ? col : Math.max(p1.col, p2.col, col);
  dim.setAttribute(
    'ref',
    r1 === r2 && c1 === c2 ? cellRef(r1, c1) : `${cellRef(r1, c1)}:${cellRef(r2, c2)}`,
  );
}

const CALC_PR_SUCCESSORS = new Set([
  'oleSize',
  'customWorkbookViews',
  'pivotCaches',
  'smartTagPr',
  'smartTagTypes',
  'webPublishing',
  'fileRecoveryPr',
  'webPublishObjects',
  'extLst',
]);

function setFullCalcOnLoad(workbook: Document): void {
  const root = workbook.documentElement;
  let calcPr = child(root, S_NS, 'calcPr');
  if (!calcPr) {
    calcPr = mk(root, 'calcPr');
    const next = children(root).find((c) => CALC_PR_SUCCESSORS.has(c.localName ?? '')) ?? null;
    root.insertBefore(calcPr, next);
  }
  calcPr.setAttribute('fullCalcOnLoad', '1');
}

/** calcChain.xml lists formula cells; a stale one makes Excel "repair" the file. */
async function dropCalcChain(pkg: Pkg, workbookPart: string): Promise<void> {
  const rels = await pkg.rels(workbookPart);
  const chain = rels.find((r) => /\/calcChain$/.test(r.type) && !r.external);
  const chainPart = chain?.target ?? 'xl/calcChain.xml';
  if (chain) {
    const relsPart = relsPartOf(workbookPart);
    const doc = await pkg.xml(relsPart);
    for (const r of children(doc.documentElement))
      if (r.getAttribute('Id') === chain.id) removeNode(r);
    pkg.markDirty(relsPart);
  }
  if (pkg.has(chainPart)) pkg.remove(chainPart);
  const ct = await pkg.xmlIfAny('[Content_Types].xml');
  if (ct) {
    let changed = false;
    for (const o of children(ct.documentElement)) {
      if (o.localName === 'Override' && o.getAttribute('PartName') === `/${chainPart}`) {
        removeNode(o);
        changed = true;
      }
    }
    if (changed) pkg.markDirty('[Content_Types].xml');
  }
}

// ── Places (pointing at part of a document) ─────────────────────────────────

export type DocPlace =
  | { para: [number, number] }
  | { slide: number; shape?: string }
  /** "Sheet1!C2:C4", "C2:C4" or "C5" (the first sheet when none is named). */
  | { cells: string };

/** Build a DocPlace from CLI flags: --para 3 / 3-4, --slide N [--shape NAME], --cell RANGE. */
export function parseDocPlace(args: {
  para?: string;
  slide?: string;
  shape?: string;
  cell?: string;
}): DocPlace {
  if (args.shape !== undefined && args.slide === undefined)
    throw new Error('--shape needs --slide N.');
  const given = [args.para, args.slide, args.cell].filter((v) => v !== undefined).length;
  if (given === 0)
    throw new Error('Say which place: --para A[-B], --slide N [--shape NAME] or --cell RANGE.');
  if (given > 1) throw new Error('Give only one of --para, --slide and --cell.');
  if (args.para !== undefined) {
    const m = /^\s*(\d+)\s*(?:[-–:]\s*(\d+)\s*)?$/.exec(args.para);
    if (!m) throw new Error('--para takes a paragraph number or a range, e.g. 12 or 12-15.');
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < 1) throw new Error('Paragraphs are numbered from 1.');
    return { para: [Math.min(a, b), Math.max(a, b)] };
  }
  if (args.slide !== undefined) {
    const n = Number(args.slide.trim());
    if (!Number.isInteger(n) || n < 1) throw new Error('--slide takes a slide number from 1.');
    const place: DocPlace = { slide: n };
    if (args.shape !== undefined && args.shape.trim() !== '') place.shape = args.shape;
    return place;
  }
  const cells = (args.cell ?? '').trim();
  if (cells === '')
    throw new Error('--cell takes a cell or a range, e.g. C5, C2:C4 or "Sheet1!C2:C4".');
  return { cells };
}

function modelKind(model: DocModel): string {
  return KIND_NAME[model.kind];
}

/** Plain text of exactly that place, each line prefixed with its label. Throws when it doesn't exist. */
export function readDocPlace(model: DocModel, place: DocPlace): string {
  if ('para' in place) {
    if (model.kind !== 'docx')
      throw new Error(`Paragraphs are for Word documents; this is a ${modelKind(model)}.`);
    const [a, b] = place.para;
    const count = model.paragraphs.length;
    if (a < 1 || a > count)
      throw new Error(`There is no paragraph ${a} (the document has ${count}).`);
    if (b > count) throw new Error(`There is no paragraph ${b} (the document has ${count}).`);
    return model.paragraphs
      .slice(a - 1, b)
      .map((p) => `¶${p.n} ${p.text}`)
      .join('\n');
  }
  if ('slide' in place) {
    if (model.kind !== 'pptx')
      throw new Error(`Slides are for PowerPoint files; this is a ${modelKind(model)}.`);
    const slide = model.slides[place.slide - 1];
    if (!slide)
      throw new Error(
        `There is no slide ${place.slide} (the presentation has ${model.slides.length}).`,
      );
    let shapes = slide.shapes;
    if (place.shape !== undefined) {
      const want = place.shape;
      const exact = shapes.filter((s) => s.name === want);
      const loose = shapes.filter((s) => s.name.toLowerCase() === want.trim().toLowerCase());
      shapes = exact.length ? exact : loose.length === 1 ? loose : [];
      if (!shapes.length) {
        const names = slide.shapes.map((s) => `“${s.name}”`).join(', ') || 'none';
        throw new Error(`Slide ${slide.n} has no text shape “${want}” (it has ${names}).`);
      }
      return shapes.map((s) => `[${s.name}] ${s.text}`).join('\n');
    }
    return [`Slide ${slide.n}`, ...shapes.map((s) => `[${s.name}] ${s.text}`)].join('\n');
  }
  if (model.kind !== 'xlsx')
    throw new Error(`Cells are for Excel workbooks; this is a ${modelKind(model)}.`);
  const split = splitSheet(place.cells.trim());
  const sheet = split.sheet
    ? (model.sheets.find((s) => s.name === split.sheet) ??
      model.sheets.find((s) => s.name.toLowerCase() === split.sheet?.toLowerCase()))
    : model.sheets[0];
  if (!sheet) {
    const names = model.sheets.map((s) => `“${s.name}”`).join(', ') || 'none';
    throw new Error(`There is no sheet “${split.sheet ?? ''}” (the workbook has ${names}).`);
  }
  const [ra, rb] = split.rest.split(':');
  const p1 = parseCellRef(ra ?? '');
  const p2 = parseCellRef(rb ?? ra ?? '');
  if (!p1 || !p2) throw new Error(`“${split.rest}” is not a cell or range like C5 or C2:C4.`);
  const r1 = Math.min(p1.row, p2.row);
  const r2 = Math.max(p1.row, p2.row);
  const c1 = Math.min(p1.col, p2.col);
  const c2 = Math.max(p1.col, p2.col);
  const lines: string[] = [];
  for (const row of sheet.rows)
    for (const cell of row) {
      const pos = parseCellRef(cell.ref);
      if (!pos || pos.row < r1 || pos.row > r2 || pos.col < c1 || pos.col > c2) continue;
      lines.push(
        cell.formula !== undefined
          ? `${cell.ref} =${cell.formula} → ${cell.value}`
          : `${cell.ref} ${cell.value}`,
      );
    }
  const label = r1 === r2 && c1 === c2 ? cellRef(r1, c1) : `${cellRef(r1, c1)}:${cellRef(r2, c2)}`;
  if (lines.length === 0) {
    const more = sheet.truncated ? ' (only the first rows of this sheet were read)' : '';
    return `${sheet.name}!${label} is empty${more}.`;
  }
  return lines.join('\n');
}
