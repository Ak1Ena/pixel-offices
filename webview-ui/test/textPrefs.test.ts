import assert from 'node:assert/strict';

import { test } from 'vitest';

import { TEXT_SIZE_SCALES } from '../src/constants.js';
import { DEFAULT_TEXT_PREFS, readTextPrefs, textPrefsCssVars } from '../src/textPrefs.js';

test('nothing stored gives the defaults', () => {
  assert.deepEqual(readTextPrefs(null), DEFAULT_TEXT_PREFS);
  assert.deepEqual(readTextPrefs(null, null), DEFAULT_TEXT_PREFS);
});

test('stored prefs round-trip', () => {
  const prefs = { size: 'xlarge', readingFont: 'serif', uiFont: 'system' } as const;
  assert.deepEqual(readTextPrefs(JSON.stringify(prefs)), prefs);
});

test('bad data falls back field by field', () => {
  assert.deepEqual(readTextPrefs('not json'), DEFAULT_TEXT_PREFS);
  assert.deepEqual(readTextPrefs('[1,2]'), DEFAULT_TEXT_PREFS);
  assert.deepEqual(readTextPrefs('"large"'), DEFAULT_TEXT_PREFS);
  assert.deepEqual(readTextPrefs('{"size":"huge","readingFont":"comic","uiFont":"pixel"}'), {
    ...DEFAULT_TEXT_PREFS,
    uiFont: 'pixel',
  });
  // An inherited key is not a size.
  assert.equal(readTextPrefs('{"size":"toString"}').size, DEFAULT_TEXT_PREFS.size);
});

test("the Messenger's old reading settings seed the text prefs once", () => {
  assert.deepEqual(readTextPrefs(null, '{"font":"pixel","size":"large","foldSteps":false}'), {
    ...DEFAULT_TEXT_PREFS,
    readingFont: 'pixel',
    size: 'large',
  });
  assert.deepEqual(readTextPrefs(null, '{"font":"readable","size":"normal"}'), DEFAULT_TEXT_PREFS);
  assert.deepEqual(readTextPrefs(null, 'garbage'), DEFAULT_TEXT_PREFS);
  // Once text prefs exist, the old settings no longer speak.
  assert.deepEqual(
    readTextPrefs(JSON.stringify(DEFAULT_TEXT_PREFS), '{"font":"pixel","size":"large"}'),
    DEFAULT_TEXT_PREFS,
  );
});

test('prefs become the :root custom properties the tokens read', () => {
  assert.deepEqual(textPrefsCssVars(DEFAULT_TEXT_PREFS), {
    '--font-scale': '1',
    // The interface defaults to the modern face (Figtree), scaled from the pixel-tuned sizes.
    '--font-ui': 'var(--font-stack-sans)',
    '--font-ui-k': '0.66',
    '--font-read': 'var(--font-stack-sans)',
    '--font-read-k': '1',
  });
  assert.equal(
    textPrefsCssVars({ ...DEFAULT_TEXT_PREFS, uiFont: 'pixel' })['--font-ui'],
    'var(--font-stack-pixel)',
  );
  const vars = textPrefsCssVars({ size: 'large', readingFont: 'pixel', uiFont: 'system' });
  assert.equal(vars['--font-scale'], String(TEXT_SIZE_SCALES.large));
  assert.equal(vars['--font-ui'], 'var(--font-stack-sans)');
  // A system face drawn at the pixel-tuned chrome sizes would look too big...
  assert.ok(Number(vars['--font-ui-k']) < 1);
  // ...and the pixel face at the system-tuned reading sizes too small.
  assert.equal(vars['--font-read'], 'var(--font-stack-pixel)');
  assert.ok(Number(vars['--font-read-k']) > 1);
});

test('every size scales up monotonically', () => {
  const order = ['small', 'normal', 'large', 'xlarge'] as const;
  const scales = order.map((s) =>
    Number(textPrefsCssVars({ ...DEFAULT_TEXT_PREFS, size: s })['--font-scale']),
  );
  assert.deepEqual(
    [...scales].sort((a, b) => a - b),
    scales,
  );
  assert.equal(new Set(scales).size, scales.length);
});
