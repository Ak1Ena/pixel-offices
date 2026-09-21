import assert from 'node:assert/strict';

import { test } from 'vitest';

import { BURN_FIRE_PER_MIN, BURN_WARM_PER_MIN } from '../src/constants.js';
import { burnLevelFor, formatTokens } from '../src/officeChat.js';

test('token counts read compactly', () => {
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(3_210), '3.2k');
  assert.equal(formatTokens(412_000), '412k');
  assert.equal(formatTokens(3_800_000), '3.8M');
});

test('burn rate maps to smoke, then fire', () => {
  assert.equal(burnLevelFor(0), 0);
  assert.equal(burnLevelFor(BURN_WARM_PER_MIN - 1), 0);
  assert.equal(burnLevelFor(BURN_WARM_PER_MIN), 1);
  assert.equal(burnLevelFor(BURN_FIRE_PER_MIN), 2);
});
