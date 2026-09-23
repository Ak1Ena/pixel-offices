import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { Proposal, ProposalHunk } from '../../core/src/messages.js';
import {
  cellSuggestion,
  decisionCounts,
  hunkTexts,
  isDocProposal,
  openProposalFor,
  placeSuggestions,
  shapeKey,
} from '../src/docSuggestions.js';

const hunk = (
  id: string,
  place: ProposalHunk['place'],
  extra: Partial<ProposalHunk> = {},
): ProposalHunk => ({
  hunkId: id,
  oldStart: 0,
  newStart: 0,
  lines: [
    { kind: 'del', text: 'old' },
    { kind: 'add', text: 'new' },
  ],
  decision: 'pending',
  ...(place ? { place } : {}),
  ...extra,
});
const proposal = (
  path: string,
  hunks: ProposalHunk[],
  extra: Partial<Proposal> = {},
): Proposal => ({
  proposalId: `p_${path}`,
  path,
  state: 'open',
  hunks,
  createdAt: '',
  ...extra,
});

test('only office documents are reviewed in place; the newest open one for the file wins', () => {
  const doc = proposal('/w/a.docx', []);
  const newer = proposal('/w/a.docx', [], { proposalId: 'p2' });
  assert.ok(isDocProposal(doc));
  assert.ok(!isDocProposal(proposal('/w/a.ts', [])));
  assert.equal(openProposalFor([doc, newer], '/w/a.docx')?.proposalId, 'p2');
  assert.equal(openProposalFor([{ ...doc, state: 'applied' }], '/w/a.docx'), undefined);
  assert.equal(openProposalFor([doc], '~/w/a.docx')?.proposalId, doc.proposalId); // a ~ pin
  assert.equal(openProposalFor([doc], '/w/b.docx'), undefined);
});

test('changes are placed on paragraphs, after paragraphs, on text boxes and on cells', () => {
  const placed = placeSuggestions(
    proposal('/w/a.docx', [
      hunk('d1', { para: 3 }),
      hunk('d2', { insertAfter: 3 }),
      hunk('d3', { insertAfter: 3 }),
      hunk('d4', { slide: 2, shape: 'Content 3' }),
      hunk('d5', { cell: 'Q3!B4' }),
      hunk('d6', { cell: 'C5' }),
      hunk('d7', undefined),
    ]),
  );
  assert.equal(placed.para.get(3)?.hunkId, 'd1');
  assert.deepEqual(
    placed.after.get(3)?.map((h) => h.hunkId),
    ['d2', 'd3'],
  );
  assert.equal(placed.shape.get(shapeKey(2, 'content 3'))?.hunkId, 'd4');
  assert.equal(cellSuggestion(placed, 'Q3', false, 3, 1)?.hunkId, 'd5');
  assert.equal(cellSuggestion(placed, 'Sheet1', true, 4, 2)?.hunkId, 'd6');
  assert.equal(cellSuggestion(placed, 'Other', false, 4, 2), undefined);
});

test('texts and counts', () => {
  assert.deepEqual(hunkTexts(hunk('a', { para: 1 })), { before: 'old', after: 'new' });
  assert.deepEqual(
    decisionCounts(
      proposal('/w/a.docx', [
        hunk('a', undefined, { decision: 'accepted' }),
        hunk('b', undefined, { decision: 'rejected' }),
        hunk('c', undefined),
      ]),
    ),
    { accepted: 1, rejected: 1, pending: 1 },
  );
});
