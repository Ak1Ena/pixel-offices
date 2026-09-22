/**
 * Line diff for "Review changes": the original file vs the agent's proposed
 * version, grouped into hunks the user accepts or rejects one by one, and the
 * merge that writes back only what was accepted. Pure and synchronous.
 */

export type DiffOp = { kind: 'same' | 'del' | 'add'; text: string };

/** Longest-common-subsequence diff (trimmed common prefix/suffix first). */
export function diffLines(a: string[], b: string[], maxCells = 4_000_000): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: DiffOp[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  const tail: DiffOp[] = a.slice(endA).map((text) => ({ kind: 'same', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  let mid: DiffOp[];
  if (n === 0 || m === 0 || n * m > maxCells) {
    // Too big to compare line by line (or one side empty): one replacement.
    mid = [
      ...midA.map((text) => ({ kind: 'del' as const, text })),
      ...midB.map((text) => ({ kind: 'add' as const, text })),
    ];
  } else {
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] =
          midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    mid = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        mid.push({ kind: 'same', text: midA[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        mid.push({ kind: 'del', text: midA[i++] });
      } else {
        mid.push({ kind: 'add', text: midB[j++] });
      }
    }
    while (i < n) mid.push({ kind: 'del', text: midA[i++] });
    while (j < m) mid.push({ kind: 'add', text: midB[j++] });
  }
  return [...head, ...mid, ...tail];
}

export interface Hunk {
  hunkId: string;
  /** 1-based line in the original where the change starts (for insertions: the line it goes before). */
  oldStart: number;
  newStart: number;
  /** Context, removed and added lines, in order. */
  lines: Array<{ kind: 'context' | 'del' | 'add'; text: string }>;
  /** Index range in the original replaced by this hunk (0-based, end exclusive), and its replacement. */
  from: number;
  to: number;
  replacement: string[];
}

/** Changes grouped into hunks, with `context` unchanged lines around each. */
export function toHunks(ops: DiffOp[], context = 2): Hunk[] {
  const hunks: Hunk[] = [];
  let oldLine = 0;
  let newLine = 0;
  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind === 'same') {
      oldLine++;
      newLine++;
      i++;
      continue;
    }
    // A run of changes, joining runs separated by fewer than 2*context same lines.
    let j = i;
    let lastChange = i;
    while (j < ops.length) {
      if (ops[j].kind !== 'same') {
        lastChange = j;
        j++;
        continue;
      }
      let k = j;
      while (k < ops.length && ops[k].kind === 'same') k++;
      if (k < ops.length && k - j <= context * 2) j = k;
      else break;
    }
    const run = ops.slice(i, lastChange + 1);
    const before = ops.slice(Math.max(0, i - context), i).filter((o) => o.kind === 'same');
    const afterEnd = Math.min(ops.length, lastChange + 1 + context);
    const after = ops.slice(lastChange + 1, afterEnd).filter((o) => o.kind === 'same');
    const removed = run.filter((o) => o.kind !== 'add').length;
    const replacement = run.filter((o) => o.kind !== 'del').map((o) => o.text);
    hunks.push({
      hunkId: `h${hunks.length + 1}`,
      oldStart: oldLine + 1,
      newStart: newLine + 1,
      lines: [
        ...before.map((o) => ({ kind: 'context' as const, text: o.text })),
        ...run.map((o) => ({
          kind: o.kind === 'same' ? ('context' as const) : o.kind,
          text: o.text,
        })),
        ...after.map((o) => ({ kind: 'context' as const, text: o.text })),
      ],
      from: oldLine,
      to: oldLine + removed,
      replacement,
    });
    for (const o of run) {
      if (o.kind !== 'add') oldLine++;
      if (o.kind !== 'del') newLine++;
    }
    i = lastChange + 1;
  }
  return hunks;
}

/** The original with only the chosen hunks applied. */
export function applyHunks(
  original: string[],
  hunks: Hunk[],
  accepted: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  let cursor = 0;
  for (const h of [...hunks].sort((x, y) => x.from - y.from)) {
    if (!accepted.has(h.hunkId)) continue;
    out.push(...original.slice(cursor, h.from), ...h.replacement);
    cursor = h.to;
  }
  out.push(...original.slice(cursor));
  return out;
}

/** Split text into lines, remembering its line ending and whether it ended with one. */
export function splitText(text: string): { lines: string[]; eol: string; finalEol: boolean } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const finalEol = text.endsWith('\n');
  const body = finalEol ? text.slice(0, text.endsWith('\r\n') ? -2 : -1) : text;
  return { lines: body.length === 0 && !finalEol ? [] : body.split(/\r?\n/), eol, finalEol };
}

export function joinText(lines: string[], eol: string, finalEol: boolean): string {
  return lines.join(eol) + (finalEol && lines.length > 0 ? eol : '');
}
