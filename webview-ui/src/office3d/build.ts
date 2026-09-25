/**
 * Builds the 3D office from the same OfficeLayout the pixel view draws.
 *
 * One tile is one metre. Tile (col, row) covers x ∈ [col, col+1], z ∈ [row, row+1];
 * the floor top is y = 0. Nothing here reads the DOM or the office state — it
 * turns a layout into meshes, so the view can rebuild whenever the layout changes.
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

import type { ColorValue } from '../components/ui/types.js';
import {
  OFFICE3D_COLORS as C,
  OFFICE3D_DESK_HEIGHT_M,
  OFFICE3D_LAND_MARGIN,
  OFFICE3D_SEAT_HEIGHT_M,
  OFFICE3D_WALL_HEIGHT_M,
} from '../constants.js';
import { getCatalogEntry } from '../office/layout/furnitureCatalog.js';
import type { OfficeLayout, PlacedFurniture, SpriteData } from '../office/types.js';
import { TileType } from '../office/types.js';

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
  const c = new THREE.Color().setHSL(
    cv.h / 360,
    Math.min(0.45, cv.s / 100),
    0.72 + cv.b / 400 + ((col + row) % 2 ? 0.02 : 0),
  );
  return c;
}

export interface OfficeMeshes {
  group: THREE.Group;
  /** Floor bounds in metres, for the camera and the shadow box. */
  bounds: { x0: number; x1: number; z0: number; z1: number };
  /** Monitor screens per desk tile ("col,row"), lit when someone works there. */
  screens: Map<string, THREE.Mesh>;
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

  // The island: grass slab and earth base under the whole lot.
  const m = OFFICE3D_LAND_MARGIN;
  const lw = x1 - x0 + m * 2,
    ld = z1 - z0 + m * 2,
    cx = (x0 + x1) / 2,
    cz = (z0 + z1) / 2;
  const grass = new THREE.Mesh(new THREE.BoxGeometry(lw, 0.5, ld), mat(C.grass));
  grass.position.set(cx, -0.55, cz);
  grass.receiveShadow = true;
  group.add(grass);
  const base = new THREE.Mesh(new THREE.BoxGeometry(lw, 2.2, ld), mat(C.base));
  base.position.set(cx, -1.9, cz);
  group.add(base);

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

  // Walls: low dollhouse walls with a cap, so the room stays open to the camera.
  const H = OFFICE3D_WALL_HEIGHT_M;
  const walls = new THREE.InstancedMesh(
    new RoundedBoxGeometry(1, H, 1, 2, 0.06),
    mat(C.wall),
    Math.max(1, wallCells.length),
  );
  const caps = new THREE.InstancedMesh(
    new RoundedBoxGeometry(1.04, 0.1, 1.04, 2, 0.04),
    mat(C.wallCap),
    Math.max(1, wallCells.length),
  );
  wallCells.forEach(([col, row], k) => {
    mtx.makeTranslation(col + 0.5, H / 2 - 0.3, row + 0.5);
    walls.setMatrixAt(k, mtx);
    mtx.makeTranslation(col + 0.5, H - 0.25, row + 0.5);
    caps.setMatrixAt(k, mtx);
  });
  walls.count = caps.count = wallCells.length;
  walls.castShadow = walls.receiveShadow = true;
  group.add(walls, caps);

  // Desk tiles, so surface items (monitors, mugs) know to sit on top.
  const deskTiles = new Set<string>();
  for (const f of layout.furniture) {
    const e = getCatalogEntry(f.type);
    if (!e?.isDesk) continue;
    const bg = e.backgroundTiles ?? 0;
    for (let dr = bg; dr < e.footprintH; dr++)
      for (let dc = 0; dc < e.footprintW; dc++) deskTiles.add(`${f.col + dc},${f.row + dr}`);
  }
  for (const f of layout.furniture) buildFurniture(f, group, deskTiles, screens);

  return { group, bounds: { x0, x1, z0, z1 }, screens };
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
