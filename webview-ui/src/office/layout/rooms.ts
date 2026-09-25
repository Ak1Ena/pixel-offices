import type {
  AreaDefinition,
  DoorSide,
  OfficeLayout,
  PlacedFurniture,
  Portal,
  RoomDoor,
  RoomRect,
} from '../types.js';
import { TileType } from '../types.js';

/**
 * Team rooms as the room tool sees them (DOM-free, Node-testable): drawing
 * and resizing rectangles, the door every room has, the walls that block
 * walking everywhere else, portals, and ready-made rooms and fill presets.
 */

const SIDES: Array<{ side: DoorSide; dc: number; dr: number }> = [
  { side: 'S', dc: 0, dr: 1 },
  { side: 'E', dc: 1, dr: 0 },
  { side: 'W', dc: -1, dr: 0 },
  { side: 'N', dc: 0, dr: -1 },
];

const tileKey = (c: number, r: number) => `${c},${r}`;
export const edgeKey = (c: number, r: number, nc: number, nr: number) => `${c},${r}>${nc},${nr}`;

function labelAt(layout: OfficeLayout, c: number, r: number): string | null {
  if (c < 0 || r < 0 || c >= layout.cols || r >= layout.rows) return null;
  return layout.areaTiles?.[r * layout.cols + c] ?? null;
}

function tileAt(layout: OfficeLayout, c: number, r: number): number | null {
  if (c < 0 || r < 0 || c >= layout.cols || r >= layout.rows) return null;
  return layout.tiles[r * layout.cols + c];
}

function isFloor(t: number | null): boolean {
  return t !== null && t !== TileType.WALL && t !== TileType.VOID;
}

export function teamRooms(layout: OfficeLayout): AreaDefinition[] {
  return (layout.areas ?? []).filter((a) => a.teamRoom);
}

export function roomTiles(
  layout: OfficeLayout,
  label: string,
): Array<{ col: number; row: number }> {
  const out: Array<{ col: number; row: number }> = [];
  const tiles = layout.areaTiles ?? [];
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] === label) out.push({ col: i % layout.cols, row: Math.floor(i / layout.cols) });
  }
  return out;
}

/** Every side of a room tile that faces a tile outside the room (inside the grid). */
export function boundaryEdges(layout: OfficeLayout, label: string): RoomDoor[] {
  const edges: RoomDoor[] = [];
  for (const { col, row } of roomTiles(layout, label)) {
    for (const { side, dc, dr } of SIDES) {
      const nc = col + dc;
      const nr = row + dr;
      if (tileAt(layout, nc, nr) === null) continue;
      if (labelAt(layout, nc, nr) !== label) edges.push({ col, row, side });
    }
  }
  return edges;
}

function outside(door: RoomDoor): { col: number; row: number } {
  const s = SIDES.find((x) => x.side === door.side)!;
  return { col: door.col + s.dc, row: door.row + s.dr };
}

/** A usable door: on the room's boundary, floor on both sides, the outside in no other room. */
export function isValidDoor(
  layout: OfficeLayout,
  label: string,
  door: RoomDoor | undefined,
): boolean {
  if (!door || labelAt(layout, door.col, door.row) !== label) return false;
  const out = outside(door);
  if (labelAt(layout, out.col, out.row) === label) return false;
  if (!isFloor(tileAt(layout, door.col, door.row)) || !isFloor(tileAt(layout, out.col, out.row)))
    return false;
  const other = labelAt(layout, out.col, out.row);
  return !other || !teamRooms(layout).some((a) => a.label === other);
}

/**
 * Where a room's door goes by default: the middle of its bottom wall if that
 * opens onto floor, else the right, left, then top — the side facing the open
 * office in most layouts.
 */
export function defaultDoor(layout: OfficeLayout, label: string): RoomDoor | null {
  const edges = boundaryEdges(layout, label).filter((d) => isValidDoor(layout, label, d));
  if (edges.length === 0) return null;
  const tiles = roomTiles(layout, label);
  const cx = tiles.reduce((s, t) => s + t.col, 0) / tiles.length;
  const cy = tiles.reduce((s, t) => s + t.row, 0) / tiles.length;
  const order: DoorSide[] = ['S', 'E', 'W', 'N'];
  edges.sort((a, b) => {
    const bySide = order.indexOf(a.side) - order.indexOf(b.side);
    if (bySide !== 0) return bySide;
    return Math.hypot(a.col - cx, a.row - cy) - Math.hypot(b.col - cx, b.row - cy);
  });
  return edges[0];
}

/** Every team room gets a valid door (older layouts had none). Same layout when nothing changed. */
function tileBounds(layout: OfficeLayout, label: string): RoomRect | null {
  const cells = roomTiles(layout, label);
  if (cells.length === 0) return null;
  let c0 = Infinity,
    r0 = Infinity,
    c1 = -Infinity,
    r1 = -Infinity;
  for (const t of cells) {
    c0 = Math.min(c0, t.col);
    r0 = Math.min(r0, t.row);
    c1 = Math.max(c1, t.col + 1);
    r1 = Math.max(r1, t.row + 1);
  }
  return { col: c0, row: r0, w: c1 - c0, h: r1 - r0 };
}

export function ensureRoomDoors(layout: OfficeLayout): OfficeLayout {
  const rooms = teamRooms(layout);
  if (rooms.length === 0) return layout;
  let changed = false;
  const areas = (layout.areas ?? []).map((orig) => {
    let a = orig;
    // A rect that no longer matches the painted tiles (an older map grow moved
    // the tiles but not the rect) is re-read from the tiles.
    const box = a.teamRoom && a.rect ? tileBounds(layout, a.label) : null;
    if (
      box &&
      a.rect &&
      (box.col !== a.rect.col || box.row !== a.rect.row || box.w !== a.rect.w || box.h !== a.rect.h)
    ) {
      changed = true;
      a = { ...a, rect: box };
    }
    if (!a.teamRoom || isValidDoor(layout, a.label, a.door)) return a;
    const door = defaultDoor(layout, a.label);
    if (!door && !a.door) return a;
    changed = true;
    const next = { ...a };
    if (door) next.door = door;
    else delete next.door;
    return next;
  });
  return changed ? { ...layout, areas } : layout;
}

/** Room walls block walking across a room's edge except through its door. */
export function blockedEdges(layout: OfficeLayout): Set<string> {
  const blocked = new Set<string>();
  for (const room of teamRooms(layout)) {
    const door = isValidDoor(layout, room.label, room.door) ? room.door : undefined;
    for (const edge of boundaryEdges(layout, room.label)) {
      if (door && edge.col === door.col && edge.row === door.row && edge.side === door.side)
        continue;
      const out = outside(edge);
      blocked.add(edgeKey(edge.col, edge.row, out.col, out.row));
      blocked.add(edgeKey(out.col, out.row, edge.col, edge.row));
    }
  }
  return blocked;
}

/** Portal tile → the tile it leads to (both directions). */
export function portalLinks(layout: OfficeLayout): Map<string, { col: number; row: number }> {
  const links = new Map<string, { col: number; row: number }>();
  for (const p of layout.portals ?? []) {
    links.set(tileKey(p.a.col, p.a.row), { ...p.b });
    links.set(tileKey(p.b.col, p.b.row), { ...p.a });
  }
  return links;
}

/**
 * Rooms nobody can walk into: from any walkable tile outside every room,
 * through doors and portals, no room tile is reached.
 */
export function unreachableRooms(layout: OfficeLayout, blockedTiles: Set<string>): string[] {
  const rooms = teamRooms(layout);
  if (rooms.length === 0) return [];
  const roomLabels = new Set(rooms.map((r) => r.label));
  const walkable = (c: number, r: number) =>
    isFloor(tileAt(layout, c, r)) && !blockedTiles.has(tileKey(c, r));
  const blocked = blockedEdges(layout);
  const links = portalLinks(layout);
  const seen = new Set<string>();
  const queue: Array<{ col: number; row: number }> = [];
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      const label = labelAt(layout, c, r);
      if (walkable(c, r) && !(label && roomLabels.has(label))) {
        seen.add(tileKey(c, r));
        queue.push({ col: c, row: r });
      }
    }
  }
  while (queue.length > 0) {
    const { col, row } = queue.shift()!;
    const next = SIDES.map(({ dc, dr }) => ({ col: col + dc, row: row + dr })).filter(
      (n) => !blocked.has(edgeKey(col, row, n.col, n.row)),
    );
    const via = links.get(tileKey(col, row));
    if (via) next.push(via);
    for (const n of next) {
      const k = tileKey(n.col, n.row);
      if (seen.has(k) || !walkable(n.col, n.row)) continue;
      seen.add(k);
      queue.push(n);
    }
  }
  return rooms
    .filter((room) => {
      const tiles = roomTiles(layout, room.label).filter((t) => walkable(t.col, t.row));
      return tiles.length > 0 && !tiles.some((t) => seen.has(tileKey(t.col, t.row)));
    })
    .map((r) => r.label);
}

/** A rectangle clamped to the grid; w/h at least 1. */
export function normalizeRect(
  a: { col: number; row: number },
  b: { col: number; row: number },
  square = false,
): RoomRect {
  let w = Math.abs(b.col - a.col) + 1;
  let h = Math.abs(b.row - a.row) + 1;
  if (square) w = h = Math.max(w, h);
  const col = b.col >= a.col ? a.col : a.col - w + 1;
  const row = b.row >= a.row ? a.row : a.row - h + 1;
  return { col, row, w, h };
}

/** Whether a rectangle fits: inside the grid, and not over another area (`except` may overlap). */
export function canPlaceRect(layout: OfficeLayout, rect: RoomRect, except?: string): boolean {
  if (rect.w < 2 || rect.h < 2) return false;
  if (
    rect.col < 0 ||
    rect.row < 0 ||
    rect.col + rect.w > layout.cols ||
    rect.row + rect.h > layout.rows
  )
    return false;
  let floor = 0;
  for (let r = rect.row; r < rect.row + rect.h; r++) {
    for (let c = rect.col; c < rect.col + rect.w; c++) {
      const label = labelAt(layout, c, r);
      if (label && label !== except) return false;
      if (isFloor(tileAt(layout, c, r))) floor++;
    }
  }
  return floor >= 4;
}

/** Paint `label` over exactly `rect` (floor tiles only), clearing wherever it was before. */
export function paintRect(layout: OfficeLayout, label: string, rect: RoomRect): OfficeLayout {
  const areaTiles = [
    ...(layout.areaTiles ?? new Array<string | null>(layout.cols * layout.rows).fill(null)),
  ];
  for (let i = 0; i < areaTiles.length; i++) if (areaTiles[i] === label) areaTiles[i] = null;
  for (let r = rect.row; r < rect.row + rect.h; r++) {
    for (let c = rect.col; c < rect.col + rect.w; c++) {
      if (c < 0 || r < 0 || c >= layout.cols || r >= layout.rows) continue;
      if (isFloor(tileAt(layout, c, r))) areaTiles[r * layout.cols + c] = label;
    }
  }
  const areas = (layout.areas ?? []).map((a) =>
    a.label === label ? { ...a, rect: { ...rect } } : a,
  );
  return ensureDoor({ ...layout, areaTiles, areas }, label);
}

function ensureDoor(layout: OfficeLayout, label: string): OfficeLayout {
  const area = (layout.areas ?? []).find((a) => a.label === label);
  if (!area?.teamRoom || isValidDoor(layout, label, area.door)) return layout;
  const door = defaultDoor(layout, label);
  const areas = (layout.areas ?? []).map((a) => {
    if (a.label !== label) return a;
    const next = { ...a };
    if (door) next.door = door;
    else delete next.door;
    return next;
  });
  return { ...layout, areas };
}

/** "Room 3": the first free numbered name. */
export function nextRoomLabel(layout: OfficeLayout): string {
  const taken = new Set((layout.areas ?? []).map((a) => a.label));
  for (let n = 1; ; n++) if (!taken.has(`Room ${n}`)) return `Room ${n}`;
}

export function createRectRoom(
  layout: OfficeLayout,
  rect: RoomRect,
  label: string,
  color: string,
): OfficeLayout {
  if ((layout.areas ?? []).some((a) => a.label === label)) return layout;
  const withArea: OfficeLayout = {
    ...layout,
    areas: [...(layout.areas ?? []), { label, color, teamRoom: true, rect: { ...rect } }],
  };
  return paintRect(withArea, label, rect);
}

/** A room's bounds: its rect, else the box around its tiles. */
export function roomBounds(layout: OfficeLayout, label: string): RoomRect | null {
  const area = (layout.areas ?? []).find((a) => a.label === label);
  if (area?.rect) return { ...area.rect };
  const tiles = roomTiles(layout, label);
  if (tiles.length === 0) return null;
  const cols = tiles.map((t) => t.col);
  const rows = tiles.map((t) => t.row);
  const col = Math.min(...cols);
  const row = Math.min(...rows);
  return { col, row, w: Math.max(...cols) - col + 1, h: Math.max(...rows) - row + 1 };
}

/** Furniture whose anchor tile lies inside `rect`. */
function furnitureIn(layout: OfficeLayout, rect: RoomRect): PlacedFurniture[] {
  return layout.furniture.filter(
    (f) =>
      f.col >= rect.col &&
      f.col < rect.col + rect.w &&
      f.row >= rect.row &&
      f.row < rect.row + rect.h,
  );
}

/** Move a room by (dc, dr), taking the furniture and door inside along. Same layout when it can't. */
export function moveRoom(
  layout: OfficeLayout,
  label: string,
  dc: number,
  dr: number,
): OfficeLayout {
  const rect = roomBounds(layout, label);
  if (!rect || (dc === 0 && dr === 0)) return layout;
  const target = { ...rect, col: rect.col + dc, row: rect.row + dr };
  if (!canPlaceRect(layout, target, label)) return layout;
  const moving = new Set(furnitureIn(layout, rect).map((f) => f.uid));
  const furniture = layout.furniture.map((f) =>
    moving.has(f.uid) ? { ...f, col: f.col + dc, row: f.row + dr } : f,
  );
  const areas = (layout.areas ?? []).map((a) =>
    a.label === label && a.door
      ? { ...a, door: { ...a.door, col: a.door.col + dc, row: a.door.row + dr } }
      : a,
  );
  return paintRect({ ...layout, furniture, areas }, label, target);
}

export function resizeRoom(layout: OfficeLayout, label: string, rect: RoomRect): OfficeLayout {
  if (!canPlaceRect(layout, rect, label)) return layout;
  return paintRect(layout, label, rect);
}

export function setRoomDoor(layout: OfficeLayout, label: string, door: RoomDoor): OfficeLayout {
  if (!isValidDoor(layout, label, door)) return layout;
  return {
    ...layout,
    areas: (layout.areas ?? []).map((a) => (a.label === label ? { ...a, door: { ...door } } : a)),
  };
}

/** The boundary edge nearest a tile — where a dragged door snaps to. */
export function nearestDoorEdge(
  layout: OfficeLayout,
  label: string,
  col: number,
  row: number,
): RoomDoor | null {
  let best: RoomDoor | null = null;
  let bestDist = Infinity;
  for (const edge of boundaryEdges(layout, label)) {
    if (!isValidDoor(layout, label, edge)) continue;
    const out = outside(edge);
    const d = Math.hypot((edge.col + out.col) / 2 - col, (edge.row + out.row) / 2 - row);
    if (d < bestDist) {
      bestDist = d;
      best = edge;
    }
  }
  return best;
}

export function addPortal(
  layout: OfficeLayout,
  a: { col: number; row: number },
  b: { col: number; row: number },
): OfficeLayout {
  if (a.col === b.col && a.row === b.row) return layout;
  if (!isFloor(tileAt(layout, a.col, a.row)) || !isFloor(tileAt(layout, b.col, b.row)))
    return layout;
  const used = new Set(
    (layout.portals ?? []).flatMap((p) => [tileKey(p.a.col, p.a.row), tileKey(p.b.col, p.b.row)]),
  );
  if (used.has(tileKey(a.col, a.row)) || used.has(tileKey(b.col, b.row))) return layout;
  const portal: Portal = { id: `portal-${Date.now().toString(36)}`, a: { ...a }, b: { ...b } };
  return { ...layout, portals: [...(layout.portals ?? []), portal] };
}

export function removePortal(layout: OfficeLayout, id: string): OfficeLayout {
  return { ...layout, portals: (layout.portals ?? []).filter((p) => p.id !== id) };
}

// ── Ready-made rooms and fill presets ─────────────────────────────

export interface FurnitureSpot {
  type: string;
  col: number;
  row: number;
}

export interface RoomTemplate {
  id: string;
  name: string;
  w: number;
  h: number;
  seats: number;
  furniture: FurnitureSpot[];
}

/** A desk (3×2, facing down) with its chair below it, facing up at the desk. */
function workstation(col: number, row: number): FurnitureSpot[] {
  return [
    { type: 'DESK_FRONT', col, row },
    { type: 'PC_FRONT_OFF', col: col + 1, row },
    { type: 'WOODEN_CHAIR_BACK', col: col + 1, row: row + 2 },
  ];
}

export const ROOM_TEMPLATES: RoomTemplate[] = [
  {
    id: 'pair',
    name: 'Pair room',
    w: 8,
    h: 5,
    seats: 2,
    furniture: [...workstation(1, 1), ...workstation(4, 1)],
  },
  {
    id: 'squad',
    name: 'Squad room',
    w: 9,
    h: 9,
    seats: 4,
    furniture: [
      ...workstation(1, 1),
      ...workstation(5, 1),
      ...workstation(1, 5),
      ...workstation(5, 5),
    ],
  },
  {
    id: 'big',
    name: 'Big room',
    w: 13,
    h: 9,
    seats: 6,
    furniture: [
      ...workstation(1, 1),
      ...workstation(5, 1),
      ...workstation(9, 1),
      ...workstation(1, 5),
      ...workstation(5, 5),
      ...workstation(9, 5),
    ],
  },
  {
    id: 'meeting',
    name: 'Meeting room',
    w: 8,
    h: 6,
    seats: 4,
    furniture: [
      { type: 'COFFEE_TABLE', col: 3, row: 2 },
      { type: 'WOODEN_CHAIR_FRONT', col: 3, row: 0 },
      { type: 'WOODEN_CHAIR_FRONT', col: 4, row: 0 },
      { type: 'WOODEN_CHAIR_BACK', col: 3, row: 4 },
      { type: 'WOODEN_CHAIR_BACK', col: 4, row: 4 },
      { type: 'PLANT', col: 0, row: 0 },
    ],
  },
];

export interface FillPreset {
  id: string;
  name: string;
  hint: string;
  /** Laid out left to right; each spot is relative to the preset's own corner. */
  furniture: FurnitureSpot[];
}

export const FILL_PRESETS: FillPreset[] = [
  {
    id: 'desks',
    name: 'Desk row',
    hint: 'two more desks and chairs',
    furniture: [...workstation(0, 0), ...workstation(3, 0)],
  },
  {
    id: 'lounge',
    name: 'Lounge corner',
    hint: 'sofa, bean bag, rug',
    furniture: [
      { type: 'RUG', col: 0, row: 1 },
      { type: 'SOFA_FRONT', col: 0, row: 0 },
      { type: 'BEAN_BAG', col: 3, row: 1 },
      { type: 'FLOOR_LAMP_OFF', col: 3, row: 0 },
    ],
  },
  {
    id: 'games',
    name: 'Game table',
    hint: 'ping-pong and an arcade',
    furniture: [
      { type: 'PING_PONG_TABLE', col: 0, row: 0 },
      { type: 'ARCADE_CABINET_OFF', col: 3, row: 0 },
    ],
  },
  {
    id: 'kitchen',
    name: 'Kitchen wall',
    hint: 'coffee, water, snacks, fridge',
    furniture: [
      { type: 'COFFEE', col: 0, row: 1 },
      { type: 'WATER_COOLER', col: 1, row: 0 },
      { type: 'VENDING_MACHINE', col: 2, row: 0 },
      { type: 'FRIDGE', col: 3, row: 0 },
    ],
  },
];

export type CanPlace = (layout: OfficeLayout, type: string, col: number, row: number) => boolean;

let uidCounter = 0;
function newUid(): string {
  uidCounter = (uidCounter + 1) % 1_000_000;
  return `f-${Date.now().toString(36)}-${uidCounter.toString(36)}`;
}

/** Place spots (relative to `origin`) one by one; null when any of them doesn't fit. */
export function placeSpots(
  layout: OfficeLayout,
  spots: FurnitureSpot[],
  origin: { col: number; row: number },
  canPlace: CanPlace,
): OfficeLayout | null {
  let next = layout;
  for (const spot of spots) {
    const col = origin.col + spot.col;
    const row = origin.row + spot.row;
    if (!canPlace(next, spot.type, col, row)) return null;
    next = {
      ...next,
      furniture: [...next.furniture, { uid: newUid(), type: spot.type, col, row }],
    };
  }
  return next;
}

/** A ready-made room with its furniture, its top-left at `at`. Null when it doesn't fit there. */
export function placeTemplate(
  layout: OfficeLayout,
  template: RoomTemplate,
  at: { col: number; row: number },
  label: string,
  color: string,
  canPlace: CanPlace,
): OfficeLayout | null {
  const rect = { col: at.col, row: at.row, w: template.w, h: template.h };
  if (!canPlaceRect(layout, rect)) return null;
  const withRoom = createRectRoom(layout, rect, label, color);
  return placeSpots(withRoom, template.furniture, at, canPlace);
}

/** A fill preset at the first spot inside the room where all of it fits (reading order). */
export function fillRoom(
  layout: OfficeLayout,
  label: string,
  preset: FillPreset,
  canPlace: CanPlace,
): OfficeLayout | null {
  const rect = roomBounds(layout, label);
  if (!rect) return null;
  const inRoom = (c: number, r: number) => labelAt(layout, c, r) === label;
  for (let r = rect.row; r < rect.row + rect.h; r++) {
    for (let c = rect.col; c < rect.col + rect.w; c++) {
      // Every spot's anchor must land in the room itself.
      if (!preset.furniture.every((s) => inRoom(c + s.col, r + s.row))) continue;
      const placed = placeSpots(layout, preset.furniture, { col: c, row: r }, canPlace);
      if (placed) return placed;
    }
  }
  return null;
}

/** Desks that fit in a rect, for the size label while drawing (one per 4×4 of floor). */
export function desksThatFit(rect: RoomRect): number {
  return Math.max(0, Math.floor((rect.w - 1) / 4)) * Math.max(0, Math.floor((rect.h - 1) / 4));
}
