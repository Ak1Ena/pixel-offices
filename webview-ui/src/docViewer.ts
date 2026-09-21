import { DOC_TABLE_MAX_ROWS } from './constants.js';

/**
 * Pure helpers for the document viewer (DOM-free, Node-testable).
 */

export type ViewerKind = 'pdf' | 'word' | 'sheet' | 'csv' | 'text' | 'image' | 'unsupported';

const KIND_BY_EXT: Record<string, ViewerKind> = {
  pdf: 'pdf',
  docx: 'word',
  xlsx: 'sheet',
  csv: 'csv',
  txt: 'text',
  md: 'text',
  log: 'text',
  json: 'text',
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
  const rows = data.slice(0, DOC_TABLE_MAX_ROWS).map((r) =>
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
