import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  askMessage,
  fileFolder,
  followUpMessage,
  isInFolder,
  newAgentId,
  parseDocChatAgents,
  rankAgents,
  recentEntries,
} from '../src/askAgent.js';
import { DOC_CHAT_RECENT_ENTRIES } from '../src/constants.js';

test('the folder a file is in', () => {
  assert.equal(fileFolder('/w/q3/report.docx'), '/w/q3');
  assert.equal(fileFolder('~/Docs/a.pptx'), '~/Docs');
  assert.equal(fileFolder('report.docx'), '');
});

test('an agent works in a folder above the file, never a sibling with the same prefix', () => {
  assert.ok(isInFolder('/w/repo/docs/a.docx', '/w/repo'));
  assert.ok(isInFolder('/w/repo/a.docx', '/w/repo/'));
  assert.ok(!isInFolder('/w/repo-old/a.docx', '/w/repo'));
  assert.ok(!isInFolder('/w/repo/a.docx', undefined));
});

test('agents in the file’s folder come first, then idle ones, then by name', () => {
  const ranked = rankAgents([
    { id: 1, label: 'Zed', busy: false, inFolder: false },
    { id: 2, label: 'Bea', busy: true, inFolder: true },
    { id: 3, label: 'Al', busy: false, inFolder: true },
    { id: 4, label: 'Cy', busy: true, inFolder: false },
  ]);
  assert.deepEqual(
    ranked.map((a) => a.id),
    [3, 2, 1, 4],
  );
});

test('the question carries references, the whole file when nothing was picked', () => {
  assert.match(askMessage('  why?  ', [], '/w/r.docx'), /^why\?\n\n\[@\/w\/r\.docx\]$/);
  const picked = askMessage('fix totals', [{ path: '/w/b.xlsx', cell: 'C2:C4' }], '/w/b.xlsx');
  assert.ok(picked.includes('[@/w/b.xlsx cells C2:C4]'));
  assert.ok(picked.includes('pixel-office doc read'));
  assert.ok(askMessage('', [], '/w/a.md').startsWith('Can you help me with this?'));
});

test('follow-ups carry only the new picks; the first message named the file', () => {
  assert.equal(followUpMessage('  and this?  ', []), 'and this?');
  assert.ok(
    followUpMessage('this one', [{ path: '/w/r.docx', paraStart: 4 }]).includes(
      '[@/w/r.docx paragraph 4]',
    ),
  );
});

test('a document chat shows the newest entries first, with the rest behind "Show earlier"', () => {
  const entries = Array.from({ length: DOC_CHAT_RECENT_ENTRIES + 5 }, (_, i) => ({
    entryId: `e${i}`,
    role: 'assistant' as const,
    text: String(i),
  }));
  const recent = recentEntries(entries, false);
  assert.equal(recent.hidden, 5);
  assert.equal(recent.shown[0].entryId, 'e5');
  assert.equal(recentEntries(entries, true).hidden, 0);
});

test('the agent remembered per file survives bad storage', () => {
  assert.deepEqual(parseDocChatAgents('{"/w/a.docx": 3, "/w/b.docx": "x"}'), { '/w/a.docx': 3 });
  assert.deepEqual(parseDocChatAgents('[1]'), {});
  assert.deepEqual(parseDocChatAgents('nope'), {});
});

test('a newly started agent is the one id that appeared', () => {
  assert.equal(newAgentId([1, 2], [1, 2, 7]), 7);
  assert.equal(newAgentId([1], [1]), undefined);
  assert.equal(newAgentId([1], [1, 5, 6]), undefined); // two arrived: can't tell which
});
