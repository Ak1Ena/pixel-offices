import type { Proposal, ProposalHunk } from '../../core/src/messages.js';
import { parseCellRef, samePath, viewerKind } from './docViewer.js';

/**
 * An agent's suggested changes to a Word / PowerPoint / Excel file, placed in
 * the document itself (DOM-free helpers). The server keeps the decisions; the
 * viewer only shows each change where it lands.
 */

/** A suggestion about an office document (the viewer shows those in place). */
export function isDocProposal(p: Proposal): boolean {
  const kind = viewerKind(p.path);
  return kind === 'word' || kind === 'slides' || kind === 'sheet';
}

/** The open suggestion for this file, newest first. */
export function openProposalFor(proposals: Proposal[], path: string): Proposal | undefined {
  for (let i = proposals.length - 1; i >= 0; i--) {
    const p = proposals[i];
    if (p.state === 'open' && isDocProposal(p) && samePath(p.path, path)) return p;
  }
  return undefined;
}

/** What is there now and what would replace it. */
export function hunkTexts(h: ProposalHunk): { before: string; after: string } {
  return {
    before: h.lines.find((l) => l.kind === 'del')?.text ?? '',
    after: h.lines.find((l) => l.kind === 'add')?.text ?? '',
  };
}

export interface PlacedSuggestions {
  /** ¶n → the change to that paragraph. */
  para: Map<number, ProposalHunk>;
  /** ¶n → new paragraphs after it (0 = before the first). */
  after: Map<number, ProposalHunk[]>;
  /** "<slide>|<shape, lower case>" → the change to that text box. */
  shape: Map<string, ProposalHunk>;
  /** "<sheet, lower case or ''>|<row>,<col>" (0-based) → the change to that cell. */
  cell: Map<string, ProposalHunk>;
}

export const shapeKey = (slide: number, shape: string): string => `${slide}|${shape.toLowerCase()}`;
export const cellKey = (sheet: string | undefined, r: number, c: number): string =>
  `${(sheet ?? '').toLowerCase()}|${r},${c}`;

/** Every change of a suggestion, by where it lands. */
export function placeSuggestions(p: Proposal | undefined): PlacedSuggestions {
  const out: PlacedSuggestions = {
    para: new Map(),
    after: new Map(),
    shape: new Map(),
    cell: new Map(),
  };
  for (const h of p?.hunks ?? []) {
    const at = h.place;
    if (!at) continue;
    if (at.para !== undefined) out.para.set(at.para, h);
    else if (at.insertAfter !== undefined)
      out.after.set(at.insertAfter, [...(out.after.get(at.insertAfter) ?? []), h]);
    else if (at.slide !== undefined && at.shape) out.shape.set(shapeKey(at.slide, at.shape), h);
    else if (at.cell) {
      const ref = parseCellRef(at.cell);
      if (ref) out.cell.set(cellKey(at.sheet ?? ref.sheet, ref.r0, ref.c0), h);
    }
  }
  return out;
}

/** The cell's change on a sheet: named sheet first, else an unnamed one (the first sheet). */
export function cellSuggestion(
  placed: PlacedSuggestions,
  sheet: string,
  isFirstSheet: boolean,
  r: number,
  c: number,
): ProposalHunk | undefined {
  return (
    placed.cell.get(cellKey(sheet, r, c)) ??
    (isFirstSheet ? placed.cell.get(cellKey(undefined, r, c)) : undefined)
  );
}

/** "2 accepted · 1 rejected · 3 to decide" counts. */
export function decisionCounts(p: Proposal): {
  accepted: number;
  rejected: number;
  pending: number;
} {
  const counts = { accepted: 0, rejected: 0, pending: 0 };
  for (const h of p.hunks) counts[h.decision === 'pending' ? 'pending' : h.decision]++;
  return counts;
}
