import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { ChatEntry } from '../../core/src/messages.js';
import {
  chatOutline,
  editCounts,
  editRows,
  groupEntries,
  parseInline,
  parseMarkdown,
  readPrefs,
  stepCounts,
} from '../src/messenger.js';

const e = (entryId: string, role: ChatEntry['role'], text: string): ChatEntry => ({
  entryId,
  role,
  text,
});

test('runs of tool rows fold into one steps block', () => {
  const blocks = groupEntries([
    e('1', 'user', 'fix it'),
    e('2', 'tool', 'Read a.ts'),
    e('3', 'tool', 'Edit a.ts'),
    e('4', 'assistant', 'done'),
    e('5', 'tool', 'Bash npm test'),
  ]);
  assert.deepEqual(
    blocks.map((b) => (b.kind === 'steps' ? `steps:${b.entries.length}` : b.entry.entryId)),
    ['1', 'steps:2', '4', 'steps:1'],
  );
});

test('steps are counted by tool', () => {
  assert.deepEqual(
    stepCounts([e('1', 'tool', 'Read a'), e('2', 'tool', 'Read b'), e('3', 'tool', 'Edit c')]),
    [
      { tool: 'Read', count: 2 },
      { tool: 'Edit', count: 1 },
    ],
  );
});

test('inline code and bold', () => {
  assert.deepEqual(parseInline('use `lock()` **now**'), [
    { kind: 'text', text: 'use ' },
    { kind: 'code', text: 'lock()' },
    { kind: 'text', text: ' ' },
    { kind: 'bold', text: 'now' },
  ]);
});

test('markdown blocks: heading, list, code, paragraph', () => {
  const blocks = parseMarkdown(
    '## What changed\n- one\n- two\n  more\n\n```ts\nconst a = 1;\n```\nAll good.\n1. first\n2. second',
  );
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['heading', 'list', 'code', 'para', 'list'],
  );
  const list = blocks[1];
  assert.ok(list.kind === 'list');
  assert.equal(list.items.length, 2);
  assert.deepEqual(list.items[1].at(-1), { kind: 'text', text: ' more' });
  const code = blocks[2];
  assert.ok(code.kind === 'code' && code.lang === 'ts' && code.text === 'const a = 1;');
  const ordered = blocks[4];
  assert.ok(ordered.kind === 'list' && ordered.ordered);
});

test('an unclosed fence still keeps the code', () => {
  const blocks = parseMarkdown('```\nhalf');
  assert.deepEqual(blocks, [{ kind: 'code', lang: '', text: 'half' }]);
});

test('the outline lists the user prompts', () => {
  const outline = chatOutline([
    e('1', 'user', 'Logout does not stick\nmore'),
    e('2', 'assistant', 'x'),
  ]);
  assert.deepEqual(outline, [
    { entryId: '1', label: 'Logout does not stick', timestamp: undefined },
  ]);
});

test('reading prefs fall back to the defaults', () => {
  assert.deepEqual(readPrefs(null), {
    font: 'readable',
    size: 'normal',
    foldSteps: true,
    timestamps: true,
  });
  assert.deepEqual(readPrefs('{"font":"pixel","size":"huge","foldSteps":false}'), {
    font: 'pixel',
    size: 'normal',
    foldSteps: false,
    timestamps: true,
  });
  assert.equal(readPrefs('not json').font, 'readable');
});

test('a file edit breaks out of the steps block as its own card', () => {
  const edit: ChatEntry = {
    ...e('3', 'tool', 'Editing a.ts'),
    edit: { path: '/repo/a.ts', kind: 'edit', hunks: [{ removed: 'a', added: 'b' }] },
  };
  const blocks = groupEntries([e('1', 'tool', 'Read a.ts'), edit, e('4', 'tool', 'Bash test')]);
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['steps', 'edit', 'steps'],
  );
});

test('edit rows trim shared lines to one line of context each side', () => {
  assert.deepEqual(editRows('a\nb\nold\nc\nd', 'a\nb\nnew\nnewer\nc\nd'), [
    { kind: 'ctx', text: 'b' },
    { kind: 'del', text: 'old' },
    { kind: 'add', text: 'new' },
    { kind: 'add', text: 'newer' },
    { kind: 'ctx', text: 'c' },
  ]);
});

test('a write is all added lines, and counts add up across hunks', () => {
  assert.deepEqual(editRows('', 'x\ny'), [
    { kind: 'add', text: 'x' },
    { kind: 'add', text: 'y' },
  ]);
  assert.deepEqual(
    editCounts([
      { removed: 'a', added: 'b\nc' },
      { removed: 'd\ne', added: '' },
    ]),
    { added: 2, removed: 3 },
  );
});
