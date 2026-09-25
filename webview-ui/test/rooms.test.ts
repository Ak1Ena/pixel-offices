import assert from 'node:assert/strict';

import { test } from 'vitest';

import { TEAM_ROOM_AREA_COLOR } from '../src/constants.js';
import { expandLayout } from '../src/office/editor/editorActions.js';
import {
  addPortal,
  blockedEdges,
  canPlaceRect,
  createRectRoom,
  defaultDoor,
  edgeKey,
  ensureRoomDoors,
  fillRoom,
  moveRoom,
  nearestDoorEdge,
  normalizeRect,
  placeTemplate,
  resizeRoom,
  ROOM_TEMPLATES,
  unreachableRooms,
} from '../src/office/layout/rooms.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

function floor(cols: number, rows: number): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
}

const anywhere = () => true;

test('drawing a rectangle makes a team room with a door on its bottom wall', () => {
  const layout = createRectRoom(
    floor(12, 10),
    { col: 2, row: 2, w: 4, h: 3 },
    'Room 1',
    TEAM_ROOM_AREA_COLOR,
  );
  const area = layout.areas?.[0];
  assert.equal(area?.teamRoom, true);
  assert.deepEqual(area?.rect, { col: 2, row: 2, w: 4, h: 3 });
  assert.equal(layout.areaTiles?.filter((t) => t === 'Room 1').length, 12);
  assert.equal(area?.door?.side, 'S');
  assert.equal(area?.door?.row, 4);
});

test('walls block every edge but the door', () => {
  const layout = createRectRoom(
    floor(12, 10),
    { col: 2, row: 2, w: 4, h: 3 },
    'Room 1',
    TEAM_ROOM_AREA_COLOR,
  );
  const door = layout.areas![0].door!;
  const blocked = blockedEdges(layout);
  assert.equal(blocked.has(edgeKey(door.col, door.row, door.col, door.row + 1)), false);
  assert.equal(blocked.has(edgeKey(2, 2, 1, 2)), true);
  assert.equal(blocked.has(edgeKey(1, 2, 2, 2)), true);
  assert.deepEqual(unreachableRooms(layout, new Set()), []);
});

test('a room with no floor around it is out of reach until a portal joins it', () => {
  const base = floor(12, 6);
  // A column of void splits the map into a left and a right part.
  for (let r = 0; r < 6; r++) base.tiles[r * 12 + 6] = TileType.VOID;
  // The right part becomes a room that fills it completely: no outside floor for a door.
  const layout = createRectRoom(base, { col: 7, row: 0, w: 5, h: 6 }, 'Lab', TEAM_ROOM_AREA_COLOR);
  assert.equal(layout.areas![0].door, undefined);
  assert.deepEqual(unreachableRooms(layout, new Set()), ['Lab']);
  const joined = addPortal(layout, { col: 2, row: 2 }, { col: 9, row: 3 });
  assert.equal(joined.portals?.length, 1);
  assert.deepEqual(unreachableRooms(joined, new Set()), []);
});

test('rectangles must fit the grid and not cover another room', () => {
  const layout = createRectRoom(
    floor(12, 10),
    { col: 2, row: 2, w: 4, h: 3 },
    'Room 1',
    TEAM_ROOM_AREA_COLOR,
  );
  assert.equal(canPlaceRect(layout, { col: 8, row: 2, w: 3, h: 3 }), true);
  assert.equal(canPlaceRect(layout, { col: 4, row: 3, w: 3, h: 3 }), false);
  assert.equal(canPlaceRect(layout, { col: 10, row: 8, w: 3, h: 3 }), false);
  assert.equal(canPlaceRect(layout, { col: 4, row: 3, w: 3, h: 3 }, 'Room 1'), true);
});

test('a rectangle can be drawn in any direction, and square', () => {
  assert.deepEqual(normalizeRect({ col: 5, row: 5 }, { col: 2, row: 3 }), {
    col: 2,
    row: 3,
    w: 4,
    h: 3,
  });
  assert.deepEqual(normalizeRect({ col: 2, row: 2 }, { col: 5, row: 3 }, true), {
    col: 2,
    row: 2,
    w: 4,
    h: 4,
  });
});

test('moving a room takes its furniture and door along; resizing keeps a valid door', () => {
  let layout = createRectRoom(
    floor(14, 10),
    { col: 1, row: 1, w: 4, h: 3 },
    'Room 1',
    TEAM_ROOM_AREA_COLOR,
  );
  layout = {
    ...layout,
    furniture: [
      { uid: 'a', type: 'X', col: 2, row: 2 },
      { uid: 'b', type: 'X', col: 9, row: 9 },
    ],
  };
  const moved = moveRoom(layout, 'Room 1', 5, 2);
  assert.deepEqual(moved.areas![0].rect, { col: 6, row: 3, w: 4, h: 3 });
  assert.deepEqual(
    moved.furniture.map((f) => [f.uid, f.col, f.row]),
    [
      ['a', 7, 4],
      ['b', 9, 9],
    ],
  );
  assert.equal(moved.areas![0].door!.row, 5);
  const grown = resizeRoom(moved, 'Room 1', { col: 6, row: 3, w: 6, h: 5 });
  assert.equal(grown.areaTiles?.filter((t) => t === 'Room 1').length, 30);
  assert.equal(grown.areas![0].door!.row, 7);
});

test('older rooms without a door get one when the layout loads', () => {
  const layout = createRectRoom(
    floor(12, 10),
    { col: 2, row: 2, w: 4, h: 3 },
    'Room 1',
    TEAM_ROOM_AREA_COLOR,
  );
  const old: OfficeLayout = {
    ...layout,
    areas: layout.areas!.map((a) => {
      const bare = { ...a };
      delete bare.door;
      delete bare.rect;
      return bare;
    }),
  };
  const fixed = ensureRoomDoors(old);
  assert.deepEqual(fixed.areas![0].door, defaultDoor(old, 'Room 1'));
  assert.equal(ensureRoomDoors(fixed), fixed);
});

test('a dragged door snaps to the nearest wall', () => {
  const layout = createRectRoom(
    floor(12, 10),
    { col: 2, row: 2, w: 4, h: 3 },
    'Room 1',
    TEAM_ROOM_AREA_COLOR,
  );
  assert.deepEqual(nearestDoorEdge(layout, 'Room 1', 6.4, 3), { col: 5, row: 3, side: 'E' });
});

test('ready-made rooms and fill presets place everything or nothing', () => {
  const squad = ROOM_TEMPLATES.find((t) => t.id === 'squad')!;
  const placed = placeTemplate(
    floor(20, 14),
    squad,
    { col: 1, row: 1 },
    'Squad',
    TEAM_ROOM_AREA_COLOR,
    anywhere,
  );
  assert.ok(placed);
  assert.equal(placed.furniture.length, squad.furniture.length);
  assert.equal(
    placeTemplate(floor(6, 6), squad, { col: 0, row: 0 }, 'Squad', TEAM_ROOM_AREA_COLOR, anywhere),
    null,
  );
  const room = createRectRoom(
    floor(14, 10),
    { col: 1, row: 1, w: 8, h: 4 },
    'R',
    TEAM_ROOM_AREA_COLOR,
  );
  const filled = fillRoom(
    room,
    'R',
    { id: 'x', name: 'x', hint: '', furniture: [{ type: 'A', col: 0, row: 0 }] },
    anywhere,
  );
  assert.deepEqual(
    filled?.furniture.map((f) => [f.col, f.row]),
    [[1, 1]],
  );
  assert.equal(
    fillRoom(
      room,
      'R',
      { id: 'y', name: 'y', hint: '', furniture: [{ type: 'A', col: 0, row: 0 }] },
      () => false,
    ),
    null,
  );
});

test('growing the map left or up moves team rooms, doors and portals with it', () => {
  let layout = createRectRoom(
    floor(12, 10),
    { col: 2, row: 2, w: 4, h: 3 },
    'Room',
    TEAM_ROOM_AREA_COLOR,
  );
  layout = { ...layout, portals: [{ id: 'p', a: { col: 1, row: 1 }, b: { col: 3, row: 3 } }] };
  const door = layout.areas?.[0].door;
  const left = expandLayout(layout, 'left');
  const up = left && expandLayout(left.layout, 'up');
  assert.ok(up && door);
  const room = up.layout.areas?.[0];
  assert.deepEqual(room?.rect, { col: 3, row: 3, w: 4, h: 3 });
  assert.deepEqual(room?.door, { ...door, col: door.col + 1, row: door.row + 1 });
  assert.deepEqual(up.layout.portals?.[0].a, { col: 2, row: 2 });
  assert.deepEqual(up.layout.portals?.[0].b, { col: 4, row: 4 });
});

test('a room rect that no longer matches its painted tiles is re-read from them', () => {
  const layout = createRectRoom(
    floor(12, 10),
    { col: 2, row: 2, w: 4, h: 3 },
    'Room',
    TEAM_ROOM_AREA_COLOR,
  );
  const stale = {
    ...layout,
    areas: layout.areas?.map((a) => ({ ...a, rect: { col: 0, row: 0, w: 4, h: 3 } })),
  };
  assert.deepEqual(ensureRoomDoors(stale).areas?.[0].rect, { col: 2, row: 2, w: 4, h: 3 });
});
