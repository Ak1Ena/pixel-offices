/**
 * Office documents (Word, PowerPoint, Excel) as the office sees them: numbered
 * places a human or an agent can point at, read, and edit. The server parses
 * the file (server/src/officeDocs.ts); the viewer and `pixel-office doc`
 * share one numbering, so "paragraph 12" means the same thing everywhere.
 * Types only — no runtime code.
 */

export type DocKind = 'docx' | 'pptx' | 'xlsx';

/** A Word body paragraph. `n` counts from 1 in document order; table cells
 *  are flattened row by row, each cell's paragraphs in turn. */
export interface DocParagraph {
  n: number;
  text: string;
  /** Heading level 1-6 when the paragraph's style is a heading. */
  heading?: number;
  /** Inside a table. */
  table?: boolean;
  /** A list item. */
  list?: boolean;
}

/** A text box on a slide. `name` is PowerPoint's shape name ("Title 1"), unique on its slide. */
export interface DocShape {
  name: string;
  text: string;
  /** The slide's title placeholder. */
  title?: boolean;
}

export interface DocSlide {
  /** 1-based, in presentation order. */
  n: number;
  shapes: DocShape[];
}

export interface DocCell {
  /** "B4" */
  ref: string;
  /** What the cell shows (a formula's cached value, a shared string resolved). */
  value: string;
  /** The formula without "=", when the cell has one. */
  formula?: string;
}

export interface DocSheet {
  name: string;
  /** Used range, e.g. "A1:F40" ("" when empty). */
  range: string;
  /** Row-major, only cells that exist in the file; bounded (see `truncated`). */
  rows: DocCell[][];
  /** The sheet had more rows than were read. */
  truncated?: boolean;
}

export type DocModel =
  | { kind: 'docx'; paragraphs: DocParagraph[] }
  | { kind: 'pptx'; slides: DocSlide[] }
  | { kind: 'xlsx'; sheets: DocSheet[] };

/** One change at one place. The rest of the file is left exactly as it was. */
export type DocEdit =
  /** Replace a Word paragraph's text (its first run's formatting is kept). */
  | { kind: 'para'; n: number; text: string }
  /** A new Word paragraph after paragraph `n` (0 = before the first), styled like `n`. */
  | { kind: 'insertAfter'; n: number; text: string }
  /** Replace the text of a named shape on a slide. */
  | { kind: 'shape'; slide: number; shape: string; text: string }
  /** Set a cell. "=SUM(A1:A3)" is a formula, a plain number is a number, "" clears it. */
  | { kind: 'cell'; sheet?: string; ref: string; value: string };

/** An edit with what was there before it, for review and for the agent's report. */
export interface DocEditPreview {
  edit: DocEdit;
  /** "¶12", "slide 2 “Content 3”", "Sheet1!C5" */
  where: string;
  before: string;
  after: string;
}
