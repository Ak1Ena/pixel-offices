import { describe, expect, it } from 'vitest';

import { applyHunks, diffLines, joinText, splitText, toHunks } from '../src/lineDiff.js';

const A = [
  '# Title',
  '',
  'Install:',
  'npm install -g pixel-agents',
  '',
  'Node 18 or newer.',
  'Thanks',
];
const B = [
  '# Title',
  '',
  'Install:',
  'npx @ak1ena/pixel-office',
  '',
  'Node 20 or newer.',
  'Thanks',
];

describe('line diff', () => {
  it('finds the changed lines and keeps the rest', () => {
    const ops = diffLines(A, B);
    expect(ops.filter((o) => o.kind === 'del').map((o) => o.text)).toEqual([
      'npm install -g pixel-agents',
      'Node 18 or newer.',
    ]);
    expect(ops.filter((o) => o.kind === 'add').map((o) => o.text)).toEqual([
      'npx @ak1ena/pixel-office',
      'Node 20 or newer.',
    ]);
  });

  it('groups nearby changes into one hunk and far ones into separate hunks', () => {
    expect(toHunks(diffLines(A, B), 2)).toHaveLength(1);
    const long = [...A.slice(0, 4), 'x1', 'x2', 'x3', 'x4', 'x5', ...A.slice(4)];
    const longB = [...B.slice(0, 4), 'x1', 'x2', 'x3', 'x4', 'x5', ...B.slice(4)];
    const hunks = toHunks(diffLines(long, longB), 2);
    expect(hunks.map((h) => h.oldStart)).toEqual([4, 11]);
  });

  it('applies only the accepted hunks', () => {
    const long = [...A.slice(0, 4), 'x1', 'x2', 'x3', 'x4', 'x5', ...A.slice(4)];
    const longB = [...B.slice(0, 4), 'x1', 'x2', 'x3', 'x4', 'x5', ...B.slice(4)];
    const hunks = toHunks(diffLines(long, longB), 2);
    expect(applyHunks(long, hunks, new Set([hunks[0].hunkId]))).toEqual([
      ...B.slice(0, 4),
      'x1',
      'x2',
      'x3',
      'x4',
      'x5',
      ...A.slice(4),
    ]);
    expect(applyHunks(long, hunks, new Set(hunks.map((h) => h.hunkId)))).toEqual(longB);
    expect(applyHunks(long, hunks, new Set())).toEqual(long);
  });

  it('handles pure insertions and deletions', () => {
    const ins = toHunks(diffLines(['a', 'b'], ['a', 'new', 'b']));
    expect(applyHunks(['a', 'b'], ins, new Set(['h1']))).toEqual(['a', 'new', 'b']);
    const del = toHunks(diffLines(['a', 'gone', 'b'], ['a', 'b']));
    expect(applyHunks(['a', 'gone', 'b'], del, new Set(['h1']))).toEqual(['a', 'b']);
  });

  it('keeps line endings and the final newline', () => {
    const t = splitText('a\r\nb\r\n');
    expect(t).toEqual({ lines: ['a', 'b'], eol: '\r\n', finalEol: true });
    expect(joinText(t.lines, t.eol, t.finalEol)).toBe('a\r\nb\r\n');
    expect(joinText(splitText('x').lines, '\n', false)).toBe('x');
  });
});
