import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  BURN_TYPING_SPEED,
  PERMISSION_PROMPTS_MAX_SHOWN,
  WHATS_NEW_AUTO_CLOSE_MS,
} from '../src/constants.js';
import { burnLevelFor } from '../src/officeChat.js';
import {
  clampTunable,
  defaultTunables,
  orderedRange,
  readTunables,
  TUNABLE_GROUPS,
  TUNABLE_KEYS,
  tunableOverrides,
  TUNABLES,
} from '../src/tunables.js';
import { tunable } from '../src/tunableStore.js';

test('every default is the constant it replaces, inside its own bounds', () => {
  assert.equal(TUNABLES.permissionPromptsMaxShown.default, PERMISSION_PROMPTS_MAX_SHOWN);
  assert.equal(TUNABLES.burnFireTypingSpeed.default, BURN_TYPING_SPEED[2]);
  assert.equal(TUNABLES.whatsNewAutoCloseSec.default * 1000, WHATS_NEW_AUTO_CLOSE_MS);
  const groups = new Set<string>(TUNABLE_GROUPS.map((g) => g.id));
  for (const k of TUNABLE_KEYS) {
    const d = TUNABLES[k];
    assert.ok(d.min <= d.default && d.default <= d.max, `${k} default out of bounds`);
    assert.ok(d.step > 0, `${k} step`);
    assert.ok(groups.has(d.group), `${k} group`);
    if (d.percent) assert.ok(d.max <= 1, `${k} is a fraction`);
  }
});

test('nothing stored or unreadable storage gives the defaults', () => {
  assert.deepEqual(readTunables(null), defaultTunables());
  assert.deepEqual(readTunables(''), defaultTunables());
  assert.deepEqual(readTunables('not json'), defaultTunables());
  assert.deepEqual(readTunables('[1,2,3]'), defaultTunables());
  assert.deepEqual(readTunables('null'), defaultTunables());
  assert.deepEqual(readTunables('42'), defaultTunables());
});

test('stored values are clamped, rounded where whole, and junk falls back', () => {
  const v = readTunables(
    JSON.stringify({
      permissionPromptsMaxShown: 99,
      chatCardWidthPx: -5,
      docTableMaxRows: 1234.6,
      headlessAlpha: 0.33,
      walkSpeedPxPerSec: 'fast',
      burnWarmPerMin: null,
      contextWarnThreshold: Number.NaN,
    }),
  );
  assert.equal(v.permissionPromptsMaxShown, TUNABLES.permissionPromptsMaxShown.max);
  assert.equal(v.chatCardWidthPx, TUNABLES.chatCardWidthPx.min);
  assert.equal(v.docTableMaxRows, 1235);
  assert.equal(v.headlessAlpha, 0.33);
  assert.equal(v.walkSpeedPxPerSec, TUNABLES.walkSpeedPxPerSec.default);
  assert.equal(v.burnWarmPerMin, TUNABLES.burnWarmPerMin.default);
  assert.equal(v.contextWarnThreshold, TUNABLES.contextWarnThreshold.default);
});

test('unknown and inherited keys are ignored', () => {
  const v = readTunables('{"noSuchSetting":5,"toString":1,"__proto__":{"chatCardWidthPx":999}}');
  assert.deepEqual(v, defaultTunables());
  assert.equal(Object.prototype.hasOwnProperty.call(v, 'noSuchSetting'), false);
});

test('only changed values are stored', () => {
  const v = { ...defaultTunables(), chatPeekMaxChars: 120 };
  assert.deepEqual(tunableOverrides(v), { chatPeekMaxChars: 120 });
  assert.deepEqual(tunableOverrides(defaultTunables()), {});
  // What is stored reads back to the same values.
  assert.deepEqual(readTunables(JSON.stringify(tunableOverrides(v))), v);
});

test('clampTunable handles the edges', () => {
  const d = TUNABLES.waitingBubbleSec;
  assert.equal(clampTunable(d, Infinity), d.default);
  assert.equal(clampTunable(d, d.max + 1), d.max);
  assert.equal(clampTunable(d, 2.25), 2.25);
});

test('crossed shortest/longest pairs are read the other way round', () => {
  assert.deepEqual(orderedRange(5, 2), [2, 5]);
  assert.deepEqual(orderedRange(2, 5), [2, 5]);
});

test('imperative code sees defaults outside a browser, and burn thresholds are overridable', () => {
  assert.equal(tunable('docTableMaxRows'), TUNABLES.docTableMaxRows.default);
  assert.equal(burnLevelFor(500, 100, 1_000), 1);
  assert.equal(burnLevelFor(1_000, 100, 1_000), 2);
  assert.equal(burnLevelFor(99, 100, 1_000), 0);
});
