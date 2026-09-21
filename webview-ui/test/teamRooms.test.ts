import assert from 'node:assert/strict';

import { beforeAll, test } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

const COLS = 10;
const ROWS = 6;

beforeAll(() => {
  buildDynamicCatalog({
    catalog: [
      {
        id: 'CHAIR',
        name: 'Chair',
        label: 'Chair',
        category: 'chairs',
        file: 'CHAIR.png',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        canPlaceOnWalls: false,
      },
    ],
    sprites: { CHAIR: [['#000000']] },
  });
});

/** Open floor, five chairs on the main floor (left), three in each team room (right). */
function layout(): OfficeLayout {
  const tiles = new Array<number>(COLS * ROWS).fill(TileType.FLOOR_1);
  const areaTiles = new Array<string | null>(COLS * ROWS).fill(null);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 5; c < COLS; c++) areaTiles[r * COLS + c] = r < 3 ? 'Room A' : 'Room B';
  }
  const chair = (uid: string, col: number, row: number) => ({ uid, type: 'CHAIR', col, row });
  return {
    version: 1,
    cols: COLS,
    rows: ROWS,
    tiles,
    furniture: [
      chair('m1', 1, 1),
      chair('m2', 2, 1),
      chair('m3', 3, 1),
      chair('m4', 1, 4),
      chair('m5', 2, 4),
      chair('a1', 6, 1),
      chair('a2', 7, 1),
      chair('a3', 8, 1),
      chair('b1', 6, 4),
      chair('b2', 7, 4),
      chair('b3', 8, 4),
    ],
    areas: [
      { label: 'Room A', color: '#3f7fa8', teamRoom: true },
      { label: 'Room B', color: '#2f8f6b', teamRoom: true },
    ],
    areaTiles,
  } as OfficeLayout;
}

const zoneOf = (os: OfficeState, id: number) => {
  const seatId = os.characters.get(id)?.seatId;
  return seatId ? os.seatZone(seatId) : null;
};

test('solo agents stay on the main floor, out of team rooms', () => {
  const os = new OfficeState(layout());
  os.addAgent(1, 0, 0, undefined, true);
  os.addAgent(2, 1, 0, undefined, true);
  assert.equal(zoneOf(os, 1), null);
  assert.equal(zoneOf(os, 2), null);
  assert.equal(os.getTeamRoom(1), null);
});

test('a team takes the first free room; a second team takes the next', () => {
  const os = new OfficeState(layout());
  for (const id of [1, 2, 3, 4, 5]) os.addAgent(id, 0, 0, undefined, true);

  os.setTeamInfo(2, 'payments', 'Pat', false, 1); // teammate links before its lead is marked
  os.setTeamInfo(1, 'payments', undefined, true);
  os.setTeamInfo(3, 'payments', 'Tina', false, 1);
  assert.deepEqual(
    [1, 2, 3].map((id) => zoneOf(os, id)),
    ['Room A', 'Room A', 'Room A'],
  );
  assert.equal(os.getTeamRoom(3), 'Room A');

  os.setTeamInfo(4, 'docs', undefined, true);
  os.setTeamInfo(5, 'docs', 'Dana', false, 4);
  assert.deepEqual(
    [4, 5].map((id) => zoneOf(os, id)),
    ['Room B', 'Room B'],
  );
});

test('a room is free again when its lead leaves', () => {
  const os = new OfficeState(layout());
  for (const id of [1, 2]) os.addAgent(id, 0, 0, undefined, true);
  os.setTeamInfo(1, 'payments', undefined, true);
  assert.equal(os.getTeamRoom(1), 'Room A');
  os.removeAgent(1);
  os.setTeamInfo(2, 'docs', undefined, true);
  assert.equal(os.getTeamRoom(2), 'Room A');
});
