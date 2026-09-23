import type { DocCell, DocEdit, DocSheet } from '../../core/src/docModel.js';
import type { DocEditNotice } from '../../core/src/messages.js';
import { DOC_READ_HINT } from './constants.js';
import { tunable } from './tunableStore.js';

/**
 * Pure helpers for the document viewer (DOM-free, Node-testable).
 */

export type ViewerKind =
  'pdf' | 'word' | 'slides' | 'sheet' | 'csv' | 'text' | 'image' | 'unsupported';

const KIND_BY_EXT: Record<string, ViewerKind> = {
  pdf: 'pdf',
  docx: 'word',
  pptx: 'slides',
  xlsx: 'sheet',
  csv: 'csv',
  txt: 'text',
  md: 'text',
  log: 'text',
  json: 'text',
  ts: 'text',
  tsx: 'text',
  js: 'text',
  jsx: 'text',
  mjs: 'text',
  cjs: 'text',
  py: 'text',
  rb: 'text',
  go: 'text',
  rs: 'text',
  java: 'text',
  kt: 'text',
  swift: 'text',
  c: 'text',
  h: 'text',
  cpp: 'text',
  hpp: 'text',
  cs: 'text',
  php: 'text',
  sh: 'text',
  zsh: 'text',
  bash: 'text',
  yaml: 'text',
  yml: 'text',
  toml: 'text',
  ini: 'text',
  sql: 'text',
  css: 'text',
  scss: 'text',
  graphql: 'text',
  vue: 'text',
  svelte: 'text',
  lua: 'text',
  dart: 'text',
  scala: 'text',
  r: 'text',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
};

export function fileExtension(name: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(name.trim());
  return match ? match[1].toLowerCase() : '';
}

/** How the viewer shows a file, judged by its name. */
export function viewerKind(name: string): ViewerKind {
  return KIND_BY_EXT[fileExtension(name)] ?? 'unsupported';
}

/** Last path segment, for titles. */
export function fileBaseName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? path
  );
}

/** RFC 4180-style CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface SheetView {
  name: string;
  rows: string[][];
  /** Rows in the source, which may be more than `rows` holds. */
  totalRows: number;
}

/** Cap a sheet for display and turn every cell into text. */
export function toSheetView(name: string, data: unknown[][]): SheetView {
  const rows = data.slice(0, tunable('docTableMaxRows')).map((r) =>
    r.map((cell) => {
      if (cell === null || cell === undefined) return '';
      if (cell instanceof Date) return cell.toISOString().slice(0, 10);
      return String(cell);
    }),
  );
  return { name, rows, totalRows: data.length };
}

/** Spreadsheet column letter: 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let n = index;
  let label = '';
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/** A cell or range in a sheet, 0-based and inclusive. */
export interface CellRange {
  sheet?: string;
  c0: number;
  r0: number;
  c1: number;
  r1: number;
}

function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** "Q3!B4", "B4:D6", "'My sheet'!A1" → a range, or null when it isn't one. */
export function parseCellRef(ref: string): CellRange | null {
  const m =
    /^(?:(?:'([^']+)'|([^!]+))!)?\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/.exec(
      ref.trim(),
    );
  if (!m) return null;
  const sheet = m[1] ?? m[2];
  const a = { c: columnIndex(m[3]), r: Number(m[4]) - 1 };
  const b = m[5] ? { c: columnIndex(m[5]), r: Number(m[6]) - 1 } : a;
  if (a.r < 0 || b.r < 0) return null;
  return {
    ...(sheet ? { sheet } : {}),
    c0: Math.min(a.c, b.c),
    r0: Math.min(a.r, b.r),
    c1: Math.max(a.c, b.c),
    r1: Math.max(a.r, b.r),
  };
}

/** Where in a file a "show me" request points, for labels: "lines 40–58", "page 3". */
export function spotLabel(spot: {
  lineStart?: number;
  lineEnd?: number;
  page?: number;
  cell?: string;
}): string {
  if (spot.lineStart) {
    return spot.lineEnd && spot.lineEnd !== spot.lineStart
      ? `lines ${spot.lineStart}–${spot.lineEnd}`
      : `line ${spot.lineStart}`;
  }
  if (spot.page) return `page ${spot.page}`;
  if (spot.cell) return spot.cell;
  return '';
}

/** A place in a file the user picked in the viewer, sent to an agent as a reference only. */
export interface DocRef {
  path: string;
  lineStart?: number;
  lineEnd?: number;
  page?: number;
  cell?: string;
  /** Word paragraphs (the office's numbering, see core/src/docModel.ts). */
  paraStart?: number;
  paraEnd?: number;
  /** A PowerPoint slide, and optionally one shape on it. */
  slide?: number;
  shape?: string;
}

/** "¶3–4", "slide 2 “Content 3”" — the place part of a Word / PowerPoint ref. */
function docPlace(ref: DocRef): string {
  if (ref.paraStart) {
    return ref.paraEnd && ref.paraEnd !== ref.paraStart
      ? `¶${ref.paraStart}–${ref.paraEnd}`
      : `¶${ref.paraStart}`;
  }
  if (ref.slide) return ref.shape ? `slide ${ref.slide} “${ref.shape}”` : `slide ${ref.slide}`;
  return '';
}

/** "session.ts:41–43", "budget.xlsx Q3!B4:D6", "plan.pdf p.3" — for chips. */
export function refLabel(ref: DocRef): string {
  const name = fileBaseName(ref.path);
  const place = docPlace(ref);
  if (place) return `${name} ${place}`;
  if (ref.lineStart) {
    return ref.lineEnd && ref.lineEnd !== ref.lineStart
      ? `${name}:${ref.lineStart}–${ref.lineEnd}`
      : `${name}:${ref.lineStart}`;
  }
  if (ref.cell) return `${name} ${ref.cell}`;
  if (ref.page) return `${name} p.${ref.page}`;
  return name;
}

/** What the agent gets: the path and the place, never the text. */
export function refText(ref: DocRef): string {
  if (ref.paraStart) {
    const range =
      ref.paraEnd && ref.paraEnd !== ref.paraStart
        ? `paragraphs ${ref.paraStart}-${ref.paraEnd}`
        : `paragraph ${ref.paraStart}`;
    return `[@${ref.path} ${range}]`;
  }
  if (ref.slide) {
    return `[@${ref.path} slide ${ref.slide}${ref.shape ? ` "${ref.shape.replace(/"/g, "'")}"` : ''}]`;
  }
  const where = ref.lineStart
    ? ref.lineEnd && ref.lineEnd !== ref.lineStart
      ? ` lines ${ref.lineStart}-${ref.lineEnd}`
      : ` line ${ref.lineStart}`
    : ref.cell
      ? ` cells ${ref.cell}`
      : ref.page
        ? ` page ${ref.page}`
        : '';
  return `[@${ref.path}${where}]`;
}

/** Message text with the references appended, one per line. */
export function withRefs(text: string, refs: DocRef[]): string {
  if (refs.length === 0) return text;
  const lines = refs.map(refText);
  // Office files can't be read with a plain file read: say how, once.
  if (refs.some((r) => r.paraStart || r.slide || (r.cell && /\.xlsx$/i.test(r.path)))) {
    lines.push(DOC_READ_HINT);
  }
  return text.trim() ? `${text.trim()}\n\n${lines.join('\n')}` : lines.join('\n');
}

/** "B4:D6" from two clicked cells (0-based), with the sheet name when there are several. */
export function cellRange(
  a: { r: number; c: number },
  b: { r: number; c: number },
  sheet?: string,
): string {
  const c0 = Math.min(a.c, b.c);
  const c1 = Math.max(a.c, b.c);
  const r0 = Math.min(a.r, b.r);
  const r1 = Math.max(a.r, b.r);
  const start = `${columnLetter(c0)}${r0 + 1}`;
  const end = `${columnLetter(c1)}${r1 + 1}`;
  const range = start === end ? start : `${start}:${end}`;
  return sheet ? `${sheet}!${range}` : range;
}

// ── Office document models (core/src/docModel.ts) ──

/** A model sheet as a grid: cells placed by their refs, gaps empty. */
export function modelSheetGrid(sheet: DocSheet): {
  rows: Array<Array<DocCell | null>>;
  cols: number;
} {
  const grid: Array<Array<DocCell | null>> = [];
  let cols = 0;
  for (const row of sheet.rows) {
    for (const cell of row) {
      const at = parseCellRef(cell.ref);
      if (!at) continue;
      while (grid.length <= at.r0) grid.push([]);
      const line = grid[at.r0];
      while (line.length <= at.c0) line.push(null);
      line[at.c0] = cell;
      cols = Math.max(cols, at.c0 + 1);
    }
  }
  return { rows: grid, cols };
}

/** What a cell holds for editing: its formula ("=SUM(…)") or its value. */
export function cellEditText(cell: DocCell | null | undefined): string {
  if (!cell) return '';
  return cell.formula ? `=${cell.formula}` : cell.value;
}

/** Edits the human made in the viewer, one per place (a later change to the same place wins). */
export function mergeDocEdit(edits: DocEdit[], next: DocEdit): DocEdit[] {
  const same = (e: DocEdit): boolean =>
    e.kind === next.kind &&
    ((e.kind === 'para' && next.kind === 'para' && e.n === next.n) ||
      (e.kind === 'shape' &&
        next.kind === 'shape' &&
        e.slide === next.slide &&
        e.shape === next.shape) ||
      (e.kind === 'cell' &&
        next.kind === 'cell' &&
        (e.sheet ?? '') === (next.sheet ?? '') &&
        e.ref.toUpperCase() === next.ref.toUpperCase()));
  // insertAfter edits each add a paragraph: never merged.
  if (next.kind === 'insertAfter') return [...edits, next];
  return [...edits.filter((e) => !same(e)), next];
}

/** Text files the viewer can edit (mirrors the server's list; code files stay read-only). */
const TEXT_EDITABLE_EXT = new Set([
  'txt',
  'md',
  'csv',
  'log',
  'json',
  'yaml',
  'yml',
  'toml',
  'ini',
]);

export function isTextEditableName(name: string): boolean {
  return TEXT_EDITABLE_EXT.has(fileExtension(name));
}

/** A model sheet as the table view shows it, with staged cell edits drawn in. */
export function modelSheetView(sheet: DocSheet, edits: DocEdit[] = []): SheetView {
  const { rows, cols } = modelSheetGrid(sheet);
  const text = rows.map((row) => Array.from({ length: cols }, (_, c) => row[c]?.value ?? ''));
  for (const e of edits) {
    if (e.kind !== 'cell' || (e.sheet && e.sheet !== sheet.name)) continue;
    const at = parseCellRef(e.ref);
    if (!at) continue;
    while (text.length <= at.r0) text.push([]);
    while (text[at.r0].length <= at.c0) text[at.r0].push('');
    text[at.r0][at.c0] = e.value;
  }
  return { name: sheet.name, rows: text, totalRows: text.length };
}

/** Whether a notice's path (absolute, resolved by the server) is the pin's path (may start with ~). */
export function samePath(noticePath: string, pinPath: string): boolean {
  const pin = pinPath.trim();
  if (noticePath === pin) return true;
  return pin.startsWith('~/') && noticePath.endsWith(pin.slice(1));
}

/** "<editId>:<undone>" of the newest edit to `path`, so a viewer knows to reload. */
export function lastEditKeyFor(edits: DocEditNotice[], path: string): string | undefined {
  for (let i = edits.length - 1; i >= 0; i--) {
    if (samePath(edits[i].path, path)) return `${edits[i].editId}:${edits[i].undone}`;
  }
  return undefined;
}

/** Text compared for matching: whitespace (tabs, breaks, runs of spaces) removed. */
function matchKey(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * Line up the office's Word paragraphs (the ¶ numbering) with the paragraphs a
 * renderer drew, by text, in order. A drawn paragraph may offer several texts
 * (e.g. with and without footnote markers the renderer adds). Returns, for each
 * drawn paragraph, the ¶ number it shows — or null for one the office doesn't
 * number (text boxes, anything that didn't match). A drawn paragraph is only
 * skipped when the next few don't match either, so one oddity can't shift the
 * rest.
 */
export function matchParagraphs(
  model: string[],
  drawn: Array<string | string[]>,
  lookAhead = 6,
): Array<number | null> {
  const out: Array<number | null> = drawn.map(() => null);
  const keys = drawn.map((d) => (Array.isArray(d) ? d : [d]).map(matchKey));
  let d = 0;
  for (let m = 0; m < model.length && d < drawn.length; m++) {
    const want = matchKey(model[m]);
    let found = -1;
    for (let k = d; k < Math.min(drawn.length, d + lookAhead); k++) {
      if (keys[k].includes(want)) {
        found = k;
        break;
      }
    }
    if (found === -1) continue; // not drawn (or drawn differently): leave it unmatched
    out[found] = m + 1;
    d = found + 1;
  }
  return out;
}
