/**
 * Builds the 3D office from the same OfficeLayout the pixel view draws.
 *
 * One tile is one metre. Tile (col, row) covers x ∈ [col, col+1], z ∈ [row, row+1];
 * the floor top is y = 0. Nothing here reads the DOM or the office state — it
 * turns a layout into meshes, so the view can rebuild whenever the layout changes.
 */

import './colorMode.js';

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

import type { ColorValue } from '../components/ui/types.js';
import {
  OFFICE3D_COLORS as C,
  OFFICE3D_DESK_HEIGHT_M,
  OFFICE3D_DOOR_HEIGHT_M,
  OFFICE3D_FURNITURE as F,
  OFFICE3D_LAND_MARGIN,
  OFFICE3D_SEAT_HEIGHT_M,
  OFFICE3D_WALL_HEIGHT_M,
  OFFICE3D_WALL_ITEM_LIFT_M,
  OFFICE3D_WALL_THICK_M,
  OFFICE3D_WINDOW_SILL_M,
  OFFICE3D_WINDOW_TOP_M,
} from '../constants.js';
import { getCatalogEntry } from '../office/layout/furnitureCatalog.js';
import { boundaryEdges, isValidDoor, roomTiles, teamRooms } from '../office/layout/rooms.js';
import type { OfficeLayout, PlacedFurniture, SpriteData } from '../office/types.js';
import { TileType } from '../office/types.js';
import { baseName, buildModel, buildWallModel, type ModelKit, yawOf } from './furniture3d.js';

const materials = new Map<string, THREE.MeshStandardMaterial>();
/** Shared matte material per colour (flat faces read as the soft toy look). */
export function mat(color: string | THREE.Color): THREE.MeshStandardMaterial {
  const key = typeof color === 'string' ? color : '#' + color.getHexString();
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: key, roughness: 0.85 });
    materials.set(key, m);
  }
  return m;
}

/** A rounded box whose BOTTOM sits at y (the office builders think in floors, not centres). */
export function rbox(
  w: number,
  h: number,
  d: number,
  color: string | THREE.Color,
  x: number,
  y: number,
  z: number,
  parent: THREE.Object3D,
): THREE.Mesh {
  const r = Math.min(w, h, d) * 0.18;
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, r), mat(color));
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function blob(r: number, color: string, x: number, y: number, z: number, parent: THREE.Object3D) {
  const m = new THREE.Mesh(
    new THREE.IcosahedronGeometry(r, 1),
    new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true }),
  );
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

const avgCache = new Map<string, string>();
/** The average opaque colour of a sprite: furniture keeps its asset's colour in 3D. */
function spriteColor(type: string, sprite: SpriteData | undefined, fallback: string): string {
  const hit = avgCache.get(type);
  if (hit) return hit;
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (const row of sprite ?? []) {
    for (const px of row) {
      if (!px || px.length < 7) continue;
      if (px.length === 9 && parseInt(px.slice(7, 9), 16) < 128) continue;
      r += parseInt(px.slice(1, 3), 16);
      g += parseInt(px.slice(3, 5), 16);
      b += parseInt(px.slice(5, 7), 16);
      n++;
    }
  }
  const out = n
    ? '#' + new THREE.Color(r / n / 255, g / n / 255, b / n / 255).getHexString()
    : fallback;
  avgCache.set(type, out);
  return out;
}

/** Applies a furniture colour override the way the pixel view's Adjust mode reads. */
function tint(base: string, cv: ColorValue | undefined): THREE.Color {
  const c = new THREE.Color(base);
  if (!cv) return c;
  if (cv.colorize) {
    c.setHSL(cv.h / 360, cv.s / 100, 0.5 + cv.b / 200);
  } else {
    c.offsetHSL(cv.h / 360, cv.s / 100, cv.b / 200);
  }
  return c;
}

function tileColor(layout: OfficeLayout, i: number, col: number, row: number): THREE.Color {
  const cv = layout.tileColors?.[i];
  const base = new THREE.Color((col + row) % 2 ? C.floorA : C.floorB);
  if (!cv) return base;
  // Floor colours are always Colorize: keep the hue, soften toward the toy palette.
  // Lightness sits in the toy palette's band (the design's warm beige is ~80%),
  // with a visible checker so the floor reads as tiles.
  const c = new THREE.Color().setHSL(
    cv.h / 360,
    Math.min(0.55, 0.15 + cv.s / 100),
    Math.min(0.86, Math.max(0.6, 0.76 + cv.b / 500)) + ((col + row) % 2 ? 0.035 : 0),
  );
  return c;
}

export interface OfficeMeshes {
  group: THREE.Group;
  /** Floor bounds in metres, for the camera and the shadow box. */
  bounds: { x0: number; x1: number; z0: number; z1: number };
  /** Monitor screens (keyed per item), lit when someone works in front of them. */
  screens: Map<string, THREE.Mesh>;
  /** The front door agents leave by: the wall tile it replaces, the floor
   *  tile inside it, and a point outside on the grass. Null = no outer wall. */
  door: {
    col: number;
    row: number;
    /** A door frame in an outer wall; false = an open edge of the floor. */
    frame: boolean;
    inside: { col: number; row: number };
    outside: { x: number; z: number };
    /** Facing out of the office (radians, as a rig's rotation.y). */
    yaw: number;
  } | null;
  /** Tables big enough to meet around (desks of 2×2 tiles or more), in tiles. */
  tables: Array<{ col: number; row: number; w: number; h: number; room: string | null }>;
  /** String-light bulbs outside (they glow at night). */
  outdoorBulbs: THREE.Mesh[];
  /** Lamp spots for the night: one per desk cluster, in metres. */
  lampSpots: Array<{ x: number; z: number }>;
}

type DoorInfo = OfficeMeshes['door'];

/** A wall tile with floor on one side and nothing on the other: the outer wall.
 *  The door goes in the southmost one, a quarter of the way across. */
function pickDoor(layout: OfficeLayout, x0: number, x1: number): DoorInfo {
  const { cols, rows, tiles } = layout;
  const at = (c: number, r: number) =>
    c < 0 || r < 0 || c >= cols || r >= rows ? TileType.VOID : tiles[r * cols + c];
  const isFloor = (t: number) => t !== TileType.VOID && t !== TileType.WALL;
  let best: DoorInfo = null;
  let bestScore = Infinity;
  const aim = x0 + (x1 - x0) * 0.25;
  // Outward directions, best first: toward the camera (south), then the sides, then north.
  const dirs = [
    { dc: 0, dr: 1, pref: 0 },
    { dc: -1, dr: 0, pref: 1 },
    { dc: 1, dr: 0, pref: 1 },
    { dc: 0, dr: -1, pref: 2 },
  ];
  const consider = (c: number, r: number, frame: boolean, dc: number, dr: number, pref: number) => {
    // Toward the camera first (people leave where you can see them), then a
    // framed door over an open edge, then nearest the aim point.
    // A framed door in a wall beats an open edge; then the wall facing the
    // camera, then a side wall near the front (the design's door), north last.
    const score =
      (frame ? 0 : 100_000) +
      pref * 10_000 +
      (dr !== 0 ? Math.abs(c + 0.5 - aim) : (rows - r) * 10);
    if (score >= bestScore) return;
    bestScore = score;
    const inside = frame ? { col: c - dc, row: r - dr } : { col: c, row: r };
    best = {
      col: c,
      row: r,
      frame,
      inside,
      outside: { x: c + 0.5 + dc * 2.2, z: r + 0.5 + dr * 2.2 },
      yaw: Math.atan2(dc, dr),
    };
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const t = at(c, r);
      for (const { dc, dr, pref } of dirs) {
        if (at(c + dc, r + dr) !== TileType.VOID) continue;
        if (t === TileType.WALL) {
          // A wall with floor behind it and nothing in front: the outer wall.
          if (!isFloor(at(c - dc, r - dr))) continue;
          // Wall on both sides along it, so the frame has something to sit in.
          if (at(c - dr, r - dc) !== TileType.WALL || at(c + dr, r + dc) !== TileType.WALL)
            continue;
          consider(c, r, true, dc, dr, pref);
        } else if (isFloor(t)) {
          // An open edge (dollhouse front): walk off the floor onto the grass.
          consider(c, r, false, dc, dr, pref);
        }
      }
    }
  }
  return best;
}

/** Trees, flowers, a bench and string lights on the grass around the office. */
function buildGarden(
  g: THREE.Group,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  seed: number,
): THREE.Mesh[] {
  let s = seed >>> 0 || 7;
  const r = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const grassY = -0.3;
  const tree = (x: number, z: number, k: number) => {
    const t = new THREE.Group();
    t.position.set(x, grassY, z);
    g.add(t);
    rbox(0.2 * k, 0.9 * k, 0.2 * k, F.trunk, 0, 0, 0, t);
    const leaf = (rad: number, col: string, lx: number, ly: number, lz: number) => {
      const m = new THREE.Mesh(
        new THREE.IcosahedronGeometry(rad, 1),
        new THREE.MeshStandardMaterial({ color: col, roughness: 0.85, flatShading: true }),
      );
      m.position.set(lx, ly, lz);
      m.castShadow = true;
      t.add(m);
    };
    leaf(0.75 * k, C.leaf, 0, 1.3 * k, 0);
    leaf(0.5 * k, F.leafLight, 0.3 * k, 1.8 * k, 0.1 * k);
  };
  const flowers = (x: number, z: number) => {
    const cols = [F.flowerA, F.flowerB, F.flowerC];
    for (let i = 0; i < 5; i++) {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 0), mat(cols[i % 3]));
      m.position.set(x + (r() - 0.5) * 0.8, grassY + 0.08, z + (r() - 0.5) * 0.4);
      g.add(m);
    }
  };
  // Front (+z) and right (+x) edges face the camera; trees in the back corners frame it.
  const front = z1 + 1.6,
    right = x1 + 1.6;
  for (let x = x0 + 1.5; x < x1 - 1; x += 3.2 + r() * 1.5) {
    if (r() < 0.5) tree(x, front + 0.3, 0.7 + r() * 0.35);
    else flowers(x, front);
  }
  for (let z = z0 + 1.5; z < z1 - 1; z += 3.5 + r() * 1.5) {
    if (r() < 0.55) tree(right + 0.2, z, 0.7 + r() * 0.35);
    else flowers(right, z);
  }
  tree(x0 - 1.8, z0 - 1.2, 1.05);
  tree(x1 + 1.8, z0 - 1.4, 0.9);
  tree(x0 - 1.6, z1 + 1.4, 0.95);
  // A bench out front.
  const bench = new THREE.Group();
  bench.position.set((x0 + x1) / 2 + 2, grassY, front);
  g.add(bench);
  rbox(1.6, 0.08, 0.4, F.wood, 0, 0.2, 0, bench);
  for (const bx of [-0.65, 0.65]) rbox(0.08, 0.2, 0.35, F.woodDark, bx, 0, 0, bench);
  // String lights along the front: poles and a sagging line of bulbs.
  const bulbs: THREE.Mesh[] = [];
  const bulbMat = new THREE.MeshBasicMaterial({ color: F.bulb, transparent: true, opacity: 0.65 });
  const zL = z1 + 0.8,
    span = x1 - x0,
    poles = Math.max(2, Math.round(span / 7) + 1);
  const px = (i: number) => x0 + (span * i) / (poles - 1);
  for (let i = 0; i < poles; i++) rbox(0.07, 2.4, 0.07, F.woodDark, px(i), grassY, zL, g);
  for (let i = 0; i < poles - 1; i++) {
    for (let j = 1; j < 10; j++) {
      const t = j / 10;
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), bulbMat);
      b.position.set(
        px(i) + (px(i + 1) - px(i)) * t,
        grassY + 2.35 - Math.sin(Math.PI * t) * 0.35,
        zL,
      );
      g.add(b);
      bulbs.push(b);
    }
  }
  return bulbs;
}

function roomOf(layout: OfficeLayout, col: number, row: number): string | null {
  if (col < 0 || row < 0 || col >= layout.cols || row >= layout.rows) return null;
  const label = layout.areaTiles?.[row * layout.cols + col];
  if (!label) return null;
  return layout.areas?.some((a) => a.teamRoom && a.label === label) ? label : null;
}

export function buildOffice(layout: OfficeLayout): OfficeMeshes {
  const group = new THREE.Group();
  const screens = new Map<string, THREE.Mesh>();
  const { cols, rows, tiles } = layout;

  let x0 = cols,
    x1 = 0,
    z0 = rows,
    z1 = 0;
  const floorCells: Array<[number, number, number]> = [];
  const wallCells: Array<[number, number]> = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const t = tiles[i];
      if (t === TileType.VOID) continue;
      x0 = Math.min(x0, col);
      x1 = Math.max(x1, col + 1);
      z0 = Math.min(z0, row);
      z1 = Math.max(z1, row + 1);
      if (t === TileType.WALL) wallCells.push([col, row]);
      else floorCells.push([col, row, i]);
    }
  }
  if (x1 <= x0) {
    x0 = 0;
    x1 = cols;
    z0 = 0;
    z1 = rows;
  }

  // The island: grass and earth under the whole map (the land), plus a margin
  // around the floor — growing the land in Build grows the island with it.
  const m = OFFICE3D_LAND_MARGIN;
  const lx0 = Math.min(0, x0 - m),
    lx1 = Math.max(cols, x1 + m),
    lz0 = Math.min(0, z0 - m),
    lz1 = Math.max(rows, z1 + m);
  const lw = lx1 - lx0,
    ld = lz1 - lz0,
    cx = (lx0 + lx1) / 2,
    cz = (lz0 + lz1) / 2;
  const grass = new THREE.Mesh(new THREE.BoxGeometry(lw, 0.5, ld), mat(C.grass));
  grass.position.set(cx, -0.55, cz);
  grass.receiveShadow = true;
  group.add(grass);
  const base = new THREE.Mesh(new THREE.BoxGeometry(lw, 2.2, ld), mat(C.base));
  base.position.set(cx, -1.9, cz);
  group.add(base);
  const outdoorBulbs = buildGarden(group, x0, x1, z0, z1, cols * 131 + rows);

  // Floor: one instanced tile per walkable cell.
  const tileGeo = new THREE.BoxGeometry(1, 0.3, 1);
  const floor = new THREE.InstancedMesh(
    tileGeo,
    new THREE.MeshStandardMaterial({ roughness: 0.95 }),
    Math.max(1, floorCells.length),
  );
  const mtx = new THREE.Matrix4();
  floorCells.forEach(([col, row, i], k) => {
    mtx.makeTranslation(col + 0.5, -0.15, row + 0.5);
    floor.setMatrixAt(k, mtx);
    floor.setColorAt(k, tileColor(layout, i, col, row));
  });
  floor.count = floorCells.length;
  floor.receiveShadow = true;
  group.add(floor);

  // Walls: thin dollhouse walls hugging the room (the design's), with windows
  // along long runs and a gap where the door is.
  const door = pickDoor(layout, x0, x1);
  const shownWalls = wallCells.filter(([c, r]) => !door?.frame || c !== door.col || r !== door.row);
  buildWalls(layout, shownWalls, group);
  if (door) buildDoor(door, group);
  buildTeamRooms(layout, group);

  // Desk tiles, so surface items (monitors, mugs) know to sit on top.
  const deskTiles = deskTilesOf(layout);
  buildCarpets(layout, group);
  for (const f of layout.furniture) buildFurniture(f, group, deskTiles, screens);

  const tables: OfficeMeshes['tables'] = [];
  const lampSpots: OfficeMeshes['lampSpots'] = [];
  for (const f of layout.furniture) {
    const e = getCatalogEntry(f.type);
    if (!e?.isDesk) continue;
    const bg = e.backgroundTiles ?? 0;
    const h = e.footprintH - bg;
    if (e.footprintW >= 2 && h >= 2) {
      tables.push({
        col: f.col,
        row: f.row + bg,
        w: e.footprintW,
        h,
        room: roomOf(layout, f.col, f.row + bg),
      });
    }
    const lx = f.col + e.footprintW / 2,
      lz = f.row + bg + h / 2;
    if (!lampSpots.some((p) => Math.hypot(p.x - lx, p.z - lz) < 3.5))
      lampSpots.push({ x: lx, z: lz });
  }

  return { group, bounds: { x0, x1, z0, z1 }, screens, door, tables, lampSpots, outdoorBulbs };
}

function buildDoor(d: NonNullable<DoorInfo>, parent: THREE.Group): void {
  // Built facing +z (out), then turned to face out of the office. The wall
  // hugs the room side of its tile, so the frame sits at local z ≈ -0.5 + T/2.
  const g = new THREE.Group();
  g.position.set(d.col + 0.5, 0, d.row + 0.5);
  g.rotation.y = d.yaw;
  parent.add(g);
  if (d.frame) {
    const H = OFFICE3D_WALL_HEIGHT_M,
      T = OFFICE3D_WALL_THICK_M,
      zc = -0.5 + T / 2,
      top = OFFICE3D_DOOR_HEIGHT_M;
    // Wall above the opening, then the frame.
    rbox(1, H - top, T, C.wall, 0, top, zc, g);
    rbox(1.04, 0.08, T + 0.04, C.wallCap, 0, H, zc, g);
    for (const sx of [-0.46, 0.46]) rbox(0.08, top, T + 0.06, C.doorFrame, sx, 0, zc, g);
    rbox(1, 0.08, T + 0.06, C.doorFrame, 0, top - 0.04, zc, g);
    // The door leaf, swung open into the room.
    const leaf = new THREE.Group();
    leaf.position.set(-0.42, 0, zc - T / 2);
    leaf.rotation.y = -1.15;
    g.add(leaf);
    rbox(0.8, top - 0.06, 0.05, C.doorLeaf, 0.4, 0, 0, leaf);
    rbox(0.05, 0.05, 0.06, C.frames, 0.72, top * 0.5, 0.03, leaf);
    // Green exit sign over the door, on the room side.
    const sign = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.12, 0.03),
      new THREE.MeshBasicMaterial({ color: C.exitSign }),
    );
    sign.position.set(0, top + 0.14, zc - T / 2 - 0.02);
    g.add(sign);
  }
  // A doormat just outside, so the way out reads at a glance.
  rbox(0.9, 0.03, 0.6, C.mat, 0, -0.02, d.frame ? 0.55 : 0.85, g);
}

/**
 * Walls as thin slabs on the room side of each wall tile: one slab per side
 * that faces floor, a post where two runs meet, and a window in every third
 * tile of a straight run. A wall with no floor next to it stays a full block.
 */
function buildWalls(layout: OfficeLayout, cells: Array<[number, number]>, g: THREE.Group): void {
  const { cols, rows, tiles } = layout;
  const at = (c: number, r: number) =>
    c < 0 || r < 0 || c >= cols || r >= rows ? TileType.VOID : tiles[r * cols + c];
  const floor = (c: number, r: number) => {
    const t = at(c, r);
    return t !== TileType.VOID && t !== TileType.WALL;
  };
  const wall = (c: number, r: number) => at(c, r) === TileType.WALL;
  const H = OFFICE3D_WALL_HEIGHT_M,
    T = OFFICE3D_WALL_THICK_M,
    base = -0.3;
  type Piece = { x: number; z: number; w: number; d: number; y0: number; y1: number };
  const solid: Piece[] = [];
  const glass: Piece[] = [];
  const slab = (x: number, z: number, w: number, d: number, win: boolean) => {
    if (!win) {
      solid.push({ x, z, w, d, y0: base, y1: H });
      return;
    }
    solid.push({ x, z, w, d, y0: base, y1: OFFICE3D_WINDOW_SILL_M });
    solid.push({ x, z, w, d, y0: OFFICE3D_WINDOW_TOP_M, y1: H });
    glass.push({ x, z, w, d: d * 0.3, y0: OFFICE3D_WINDOW_SILL_M, y1: OFFICE3D_WINDOW_TOP_M });
  };
  for (const [c, r] of cells) {
    const S = floor(c, r + 1),
      N = floor(c, r - 1),
      E = floor(c + 1, r),
      Wf = floor(c - 1, r);
    const runX = wall(c - 1, r) && wall(c + 1, r);
    const runZ = wall(c, r - 1) && wall(c, r + 1);
    if (S) slab(c + 0.5, r + 1 - T / 2, 1, T, runX && c % 3 === 1);
    if (N) slab(c + 0.5, r + T / 2, 1, T, runX && c % 3 === 1);
    if (E) slab(c + 1 - T / 2, r + 0.5, T, 1, runZ && r % 3 === 1);
    if (Wf) slab(c + T / 2, r + 0.5, T, 1, runZ && r % 3 === 1);
    if (S || N || E || Wf) continue;
    // A corner: a post in the corner that touches floor diagonally.
    const diag: Array<[number, number, number, number]> = [
      [1, 1, c + 1 - T / 2, r + 1 - T / 2],
      [-1, 1, c + T / 2, r + 1 - T / 2],
      [1, -1, c + 1 - T / 2, r + T / 2],
      [-1, -1, c + T / 2, r + T / 2],
    ];
    const hit = diag.find(([dc, dr]) => floor(c + dc, r + dr));
    if (hit) solid.push({ x: hit[2], z: hit[3], w: T, d: T, y0: base, y1: H });
    else solid.push({ x: c + 0.5, z: r + 0.5, w: 1, d: 1, y0: base, y1: H });
  }
  const put = (list: Piece[], m: THREE.Material, capM: THREE.Material | null) => {
    if (!list.length) return;
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), m, list.length);
    const caps = capM
      ? new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), capM, list.length)
      : null;
    const mtx = new THREE.Matrix4(),
      q = new THREE.Quaternion(),
      pos = new THREE.Vector3(),
      sc = new THREE.Vector3();
    let capN = 0;
    list.forEach((p, k) => {
      mtx.compose(pos.set(p.x, (p.y0 + p.y1) / 2, p.z), q, sc.set(p.w, p.y1 - p.y0, p.d));
      inst.setMatrixAt(k, mtx);
      if (caps && p.y1 >= H - 0.001) {
        mtx.compose(pos.set(p.x, H + 0.04, p.z), q, sc.set(p.w + 0.04, 0.08, p.d + 0.04));
        caps.setMatrixAt(capN++, mtx);
      }
    });
    inst.castShadow = inst.receiveShadow = true;
    g.add(inst);
    if (caps) {
      caps.count = capN;
      g.add(caps);
    }
  };
  put(solid, mat(C.wall), mat(C.wallCap));
  put(
    glass,
    new THREE.MeshStandardMaterial({
      color: C.glass,
      transparent: true,
      opacity: 0.45,
      roughness: 0.1,
    }),
    null,
  );
}

/** Glass walls around each team room — along its painted tiles (what walking
 *  obeys), open at its door, none where a real wall already stands. */
function buildTeamRooms(layout: OfficeLayout, g: THREE.Group): void {
  const glass = new THREE.MeshStandardMaterial({
    color: C.glass,
    transparent: true,
    opacity: 0.22,
    roughness: 0.05,
  });
  const hG = 1.1;
  const pane = (x: number, z: number, alongX: boolean) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(alongX ? 1 : 0.04, hG, alongX ? 0.04 : 1),
      glass,
    );
    m.position.set(x, hG / 2, z);
    g.add(m);
    rbox(alongX ? 1 : 0.06, 0.05, alongX ? 0.06 : 1, C.glassFrame, x, hG, z, g);
  };
  const isWall = (col: number, row: number) =>
    col >= 0 &&
    row >= 0 &&
    col < layout.cols &&
    row < layout.rows &&
    layout.tiles[row * layout.cols + col] === TileType.WALL;
  for (const a of teamRooms(layout)) {
    const cells = roomTiles(layout, a.label);
    if (cells.length === 0) continue;
    const door = isValidDoor(layout, a.label, a.door) ? a.door : undefined;
    for (const e of boundaryEdges(layout, a.label)) {
      if (door && door.col === e.col && door.row === e.row && door.side === e.side) continue;
      const oc = e.col + (e.side === 'E' ? 1 : e.side === 'W' ? -1 : 0);
      const or = e.row + (e.side === 'S' ? 1 : e.side === 'N' ? -1 : 0);
      if (isWall(oc, or)) continue;
      if (e.side === 'N') pane(e.col + 0.5, e.row, true);
      else if (e.side === 'S') pane(e.col + 0.5, e.row + 1, true);
      else if (e.side === 'W') pane(e.col, e.row + 0.5, false);
      else pane(e.col + 1, e.row + 0.5, false);
    }
    let c0 = Infinity,
      c1 = -Infinity,
      r1 = -Infinity;
    for (const t of cells) {
      c0 = Math.min(c0, t.col);
      c1 = Math.max(c1, t.col + 1);
      r1 = Math.max(r1, t.row + 1);
    }
    g.add(nameTag(a.label, (c0 + c1) / 2, hG + 0.35, r1));
  }
}

function nameTag(text: string, x: number, y: number, z: number): THREE.Sprite {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 64;
  const ctx = cv.getContext('2d');
  if (ctx) {
    ctx.fillStyle = C.tagBg;
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = C.tagInk;
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text.slice(0, 18), 128, 33);
  }
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: true }),
  );
  s.scale.set(1.6, 0.4, 1);
  s.position.set(x, y, z);
  return s;
}

/** Tiles covered by desk tops ("col,row"). */
export function deskTilesOf(layout: OfficeLayout): Set<string> {
  const deskTiles = new Set<string>();
  for (const f of layout.furniture) {
    const e = getCatalogEntry(f.type);
    if (!e?.isDesk) continue;
    const bg = e.backgroundTiles ?? 0;
    for (let dr = bg; dr < e.footprintH; dr++)
      for (let dc = 0; dc < e.footprintW; dc++) deskTiles.add(`${f.col + dc},${f.row + dr}`);
  }
  return deskTiles;
}

/** One furniture item on its own (the editor's placement preview). */
export function buildFurnitureItem(f: PlacedFurniture, deskTiles: Set<string>): THREE.Group {
  const g = new THREE.Group();
  buildFurniture(f, g, deskTiles, new Map());
  return g;
}

/** Carpets as flat rugs in their main colour. */
function buildCarpets(layout: OfficeLayout, g: THREE.Group): void {
  const cells: Array<[number, number, THREE.Color]> = [];
  (layout.carpetTiles ?? []).forEach((ct, i) => {
    if (!ct) return;
    cells.push([i % layout.cols, Math.floor(i / layout.cols), tint(C.carpet, ct.color)]);
  });
  if (!cells.length) return;
  const rugs = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 0.02, 1),
    new THREE.MeshStandardMaterial({ roughness: 1 }),
    cells.length,
  );
  const mtx = new THREE.Matrix4();
  cells.forEach(([c, r, col], k) => {
    mtx.makeTranslation(c + 0.5, 0.012, r + 0.5);
    rugs.setMatrixAt(k, mtx);
    rugs.setColorAt(k, col);
  });
  rugs.receiveShadow = true;
  g.add(rugs);
}

function buildFurniture(
  f: PlacedFurniture,
  parent: THREE.Group,
  deskTiles: Set<string>,
  screens: Map<string, THREE.Mesh>,
): void {
  const e = getCatalogEntry(f.type);
  if (!e) return;
  const bg = e.canPlaceOnWalls ? 0 : (e.backgroundTiles ?? 0);
  const w = e.footprintW,
    d = Math.max(1, e.footprintH - bg);
  const x = f.col + w / 2,
    z = f.row + bg + d / 2;
  const color = tint(spriteColor(f.type, e.sprite, C.deskTop), f.color);
  const cat = e.category ?? '';
  const name = (e.label + ' ' + f.type).toLowerCase();

  // Detailed Soft Dollhouse model when the asset is one we know.
  const base = baseName(f.type);
  const kit: ModelKit = {
    box: rbox,
    mat,
    screen: (m) => screens.set(`${f.uid}#${screens.size}`, m),
  };
  if (e.canPlaceOnWalls) {
    const g = new THREE.Group();
    // Hung higher on the taller walls; bookshelves stand on the floor.
    const hang = base.includes('BOOKSHELF') ? 0 : OFFICE3D_WALL_ITEM_LIFT_M;
    g.position.set(x, hang, f.row + e.footprintH);
    parent.add(g);
    buildWallModel(base, kit, g, w, color, f.uid);
    return;
  }
  {
    const onDesk = !!e.canPlaceOnSurfaces && deskTiles.has(`${f.col},${f.row + e.footprintH - 1}`);
    const yaw = yawOf(e.orientation, f.type);
    const side = Math.abs(Math.sin(yaw)) > 0.5;
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = yaw;
    if (buildModel(base, kit, g, side ? d : w, side ? w : d, color, onDesk, f.uid)) {
      parent.add(g);
      return;
    }
  }

  if (e.canPlaceOnWalls || cat === 'wall') {
    // Hung on the wall face that looks into the room (the tile's south side).
    const panel = rbox(
      w * 0.8,
      Math.min(1, e.footprintH * 0.5),
      0.06,
      color,
      x,
      0.55,
      f.row + e.footprintH - 0.05,
      parent,
    );
    panel.castShadow = false;
    return;
  }
  if (e.isDesk) {
    const g = new THREE.Group();
    parent.add(g);
    rbox(w - 0.06, 0.06, d - 0.08, C.deskTop, x, OFFICE3D_DESK_HEIGHT_M - 0.06, z, g);
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        rbox(
          0.06,
          OFFICE3D_DESK_HEIGHT_M - 0.06,
          0.06,
          C.deskLeg,
          x + sx * (w / 2 - 0.12),
          0,
          z + sz * (d / 2 - 0.12),
          g,
        );
    return;
  }
  if (cat === 'chairs' || name.includes('chair') || name.includes('stool')) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    // A chair's back is behind whoever sits on it: front-facing seats face +z.
    const o = e.orientation ?? 'front';
    g.rotation.y =
      o === 'back' ? Math.PI : o === 'left' ? -Math.PI / 2 : o === 'right' ? Math.PI / 2 : 0;
    parent.add(g);
    rbox(0.46, 0.07, 0.44, C.chair, 0, OFFICE3D_SEAT_HEIGHT_M - 0.07, 0, g);
    rbox(0.44, 0.4, 0.07, C.chairBack, 0, OFFICE3D_SEAT_HEIGHT_M, -0.22, g);
    rbox(0.08, OFFICE3D_SEAT_HEIGHT_M - 0.07, 0.08, C.chairBack, 0, 0, 0, g);
    return;
  }
  const onDesk = e.canPlaceOnSurfaces && deskTiles.has(`${f.col},${f.row + e.footprintH - 1}`);
  const y0 = onDesk ? OFFICE3D_DESK_HEIGHT_M : 0;
  if (
    cat === 'electronics' &&
    (name.includes('monitor') ||
      name.includes('pc') ||
      name.includes('screen') ||
      name.includes('laptop'))
  ) {
    const g = new THREE.Group();
    parent.add(g);
    rbox(0.1, 0.08, 0.08, C.screen, x, y0, z, g);
    rbox(Math.min(0.62, w * 0.8), 0.36, 0.05, C.screen, x, y0 + 0.08, z, g);
    const scr = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.min(0.54, w * 0.7), 0.28),
      new THREE.MeshBasicMaterial({ color: C.screen }),
    );
    scr.position.set(x, y0 + 0.26, z + 0.03);
    g.add(scr);
    screens.set(`${f.col},${f.row}`, scr);
    return;
  }
  if (name.includes('plant') || name.includes('planter') || name.includes('tree')) {
    const g = new THREE.Group();
    parent.add(g);
    const s = Math.min(w, d);
    rbox(0.42 * s, 0.36 * s, 0.42 * s, C.pot, x, y0, z, g);
    blob(0.32 * s, C.leaf, x, y0 + 0.62 * s, z, g);
    blob(0.22 * s, C.leaf, x + 0.12 * s, y0 + 0.9 * s, z - 0.05, g);
    return;
  }
  // Everything else: a soft block the asset's size and colour.
  const h = onDesk
    ? 0.18
    : cat === 'storage'
      ? 1.2
      : cat === 'electronics'
        ? 0.9
        : cat === 'decor'
          ? 0.5
          : 0.8;
  rbox(w - 0.1, h, d - 0.1, color, x, y0, z, parent);
}

export function disposeGroup(g: THREE.Object3D): void {
  g.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
  });
}
