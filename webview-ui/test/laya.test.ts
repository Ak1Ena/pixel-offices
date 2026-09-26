/**
 * Laya, the decision model, as a character in the office (OfficeState half):
 * she is shown while the model runs, is never an agent, and an agent she is
 * asked about walks over, talks for a moment and goes back to its desk.
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { LAYA_CHAR_ID, LAYA_TALK_SEC } from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { OfficeLayout } from '../src/office/types.js';
import { CharacterState, MATRIX_EFFECT_DURATION, TileType } from '../src/office/types.js';
import { type DeskColumn, subColumns } from '../src/taskDesk.js';

function floorLayout(cols = 12, rows = 9): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
}

/** Run the office forward in small steps. */
function run(os: OfficeState, seconds: number): void {
  for (let t = 0; t < seconds; t += 0.05) os.update(0.05);
}

test('Laya appears as a character, never as an agent', () => {
  const os = new OfficeState(floorLayout());
  os.spawnLaya();
  assert.ok(os.laya);
  assert.equal(os.laya.id, LAYA_CHAR_ID);
  assert.equal(os.laya.isLaya, true);
  assert.equal(os.characters.has(LAYA_CHAR_ID), false, 'not in the agents');
  assert.ok(os.getCharacters().includes(os.laya), 'but drawn');
  os.despawnLaya();
  run(os, MATRIX_EFFECT_DURATION + 0.1);
  assert.equal(os.laya, null);
});

test('an agent asked about walks to Laya, talks, then goes back', () => {
  const os = new OfficeState(floorLayout());
  os.spawnLaya();
  run(os, MATRIX_EFFECT_DURATION + 0.1);
  os.addAgent(1, undefined, undefined, undefined, true);
  const ch = os.characters.get(1)!;
  ch.isActive = false;
  const start = { col: ch.tileCol, row: ch.tileRow };

  os.consultLaya(1, 'Is the work done?');
  assert.equal(ch.state, CharacterState.WALK, 'walks over');
  assert.equal(os.layaTopicOf(1), null, 'no question shown until it arrives');
  for (let t = 0; t < 15 && os.layaTopicOf(1) === null; t += 0.05) os.update(0.05);
  assert.equal(os.layaTopicOf(1), 'Is the work done?', 'talks once there');
  assert.ok(
    Math.abs(ch.tileCol - os.laya!.tileCol) + Math.abs(ch.tileRow - os.laya!.tileRow) <= 2,
    'next to Laya',
  );
  assert.equal(os.layaIsTalking(), true);
  run(os, LAYA_TALK_SEC + 0.5);
  assert.equal(os.layaTopicOf(1), null, 'done talking');
  assert.notDeepEqual({ col: ch.tileCol, row: ch.tileRow }, start);
});

test('a busy agent stays at its desk and only shows the question', () => {
  const os = new OfficeState(floorLayout());
  os.spawnLaya();
  os.addAgent(1, undefined, undefined, undefined, true);
  const ch = os.characters.get(1)!;
  ch.isActive = true;
  const before = { col: ch.tileCol, row: ch.tileRow };
  os.consultLaya(1, 'Who is this for?');
  assert.equal(os.layaTopicOf(1), 'Who is this for?');
  assert.deepEqual({ col: ch.tileCol, row: ch.tileRow }, before);
});

test('nothing happens without Laya in the office', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, undefined, undefined, undefined, true);
  os.consultLaya(1, 'x');
  assert.equal(os.layaTopicOf(1), null);
});

test('board columns split a state; cards sit in their column, else the first', () => {
  const column: DeskColumn = {
    key: 'working',
    title: 'Working',
    hint: '',
    yours: false,
    states: ['working'],
    tasks: [
      { id: 'a', state: 'working', column: 'testing' },
      { id: 'b', state: 'working' },
    ] as DeskColumn['tasks'],
  };
  const flow = [
    { id: 'coding', name: 'Coding', description: '', phase: 'working' as const, laya: true },
    { id: 'testing', name: 'Testing', description: '', phase: 'working' as const, laya: true },
  ];
  const parts = subColumns(column, flow);
  assert.deepEqual(
    parts.map((p) => [p.def?.id, p.tasks.map((t) => t.id)]),
    [
      ['coding', ['b']],
      ['testing', ['a']],
    ],
  );
  assert.deepEqual(subColumns(column, []), []);
});
