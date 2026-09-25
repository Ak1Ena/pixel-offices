/**
 * Soft Dollhouse models for the furniture catalog. Each builder draws one item
 * in local space: centred on its footprint, floor at y = 0, front facing +z.
 * `buildModel` picks a builder by the asset's name; unknown items return false
 * and the caller draws a soft block in the asset's colour instead.
 */

import * as THREE from 'three';

import {
  OFFICE3D_ART_COLORS,
  OFFICE3D_BOOK_COLORS,
  OFFICE3D_COLORS as C,
  OFFICE3D_DESK_HEIGHT_M,
  OFFICE3D_FURNITURE as F,
  OFFICE3D_SEAT_HEIGHT_M,
} from '../constants.js';

type Box = (
  w: number,
  h: number,
  d: number,
  color: string | THREE.Color,
  x: number,
  y: number,
  z: number,
  parent: THREE.Object3D,
) => THREE.Mesh;

export interface ModelKit {
  box: Box;
  /** A matte material per colour (shared). */
  mat: (c: string | THREE.Color) => THREE.MeshStandardMaterial;
  /** Monitor screens register here so the office can light them. */
  screen: (m: THREE.Mesh) => void;
}

/** Deterministic 0..1 noise from a seed, so a layout always looks the same. */
function rand(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mesh(
  geo: THREE.BufferGeometry,
  m: THREE.Material,
  x: number,
  y: number,
  z: number,
  p: THREE.Object3D,
) {
  const o = new THREE.Mesh(geo, m);
  o.position.set(x, y, z);
  o.castShadow = true;
  o.receiveShadow = true;
  p.add(o);
  return o;
}

function blob(
  _k: ModelKit,
  r: number,
  color: string,
  x: number,
  y: number,
  z: number,
  p: THREE.Object3D,
) {
  return mesh(
    new THREE.IcosahedronGeometry(r, 1),
    new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true }),
    x,
    y,
    z,
    p,
  );
}

function cyl(
  k: ModelKit,
  rt: number,
  rb: number,
  h: number,
  color: string,
  x: number,
  y: number,
  z: number,
  p: THREE.Object3D,
) {
  return mesh(new THREE.CylinderGeometry(rt, rb, h, 16), k.mat(color), x, y + h / 2, z, p);
}

/** The asset's base name: DESK_FRONT_ON → DESK. */
export function baseName(type: string): string {
  return type
    .replace(/:left$/i, '')
    .toUpperCase()
    .replace(/_(FRONT|BACK|LEFT|RIGHT|SIDE)(?=_|$)/g, '')
    .replace(/_(ON|OFF)$/g, '')
    .replace(/_\d+$/, (m) => (/^_(2|3)$/.test(m) ? m : ''));
}

/** Yaw that turns a front-facing (+z) model to face the asset's orientation.
 *  "side" assets face right; their mirrored `:left` copies face left. */
export function yawOf(orientation: string | undefined, type = ''): number {
  if (orientation === 'side') return type.endsWith(':left') ? -Math.PI / 2 : Math.PI / 2;
  return orientation === 'back'
    ? Math.PI
    : orientation === 'left'
      ? -Math.PI / 2
      : orientation === 'right'
        ? Math.PI / 2
        : 0;
}

/**
 * Draws a known item into `g` (already placed and turned). `w`/`d` are the
 * footprint in metres, `color` the asset's own colour, `onDesk` = sits on a desk top.
 */
export function buildModel(
  name: string,
  k: ModelKit,
  g: THREE.Group,
  w: number,
  d: number,
  color: string | THREE.Color,
  onDesk: boolean,
  seed: string,
): boolean {
  const b = k.box;
  const y0 = onDesk ? OFFICE3D_DESK_HEIGHT_M : 0;
  const r = rand(hashStr(seed));
  const H = OFFICE3D_DESK_HEIGHT_M;
  switch (name) {
    case 'DESK':
    case 'OFFICE_DESK':
    case 'SMALL_TABLE':
    case 'TABLE':
    case 'COFFEE_TABLE':
    case 'STANDING_DESK': {
      const h = name === 'COFFEE_TABLE' ? 0.42 : name === 'STANDING_DESK' ? 1.0 : H;
      b(w - 0.06, 0.06, d - 0.08, C.deskTop, 0, h - 0.06, 0, g);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1])
          b(0.06, h - 0.06, 0.06, C.deskLeg, sx * (w / 2 - 0.12), 0, sz * (d / 2 - 0.12), g);
      }
      if (name === 'OFFICE_DESK' || (name === 'DESK' && w >= 2)) {
        // A drawer unit under one end.
        b(0.42, h - 0.12, d * 0.6, C.deskLeg, w / 2 - 0.3, 0, -d * 0.1, g);
      }
      return true;
    }
    case 'TABLE_FRONT': {
      b(w - 0.1, 0.07, d - 0.1, C.deskTop, 0, H - 0.07, 0, g);
      b(0.3, H - 0.07, d * 0.5, C.deskLeg, 0, 0, 0, g);
      return true;
    }
    case 'CUSHIONED_CHAIR':
    case 'CHAIR': {
      b(0.48, 0.09, 0.46, F.cushion, 0, OFFICE3D_SEAT_HEIGHT_M - 0.09, 0.02, g);
      b(0.46, 0.44, 0.08, F.cushion, 0, OFFICE3D_SEAT_HEIGHT_M, -0.22, g);
      b(0.08, OFFICE3D_SEAT_HEIGHT_M - 0.12, 0.08, F.metal, 0, 0.05, 0, g);
      b(0.46, 0.05, 0.08, F.metal, 0, 0, 0, g);
      b(0.08, 0.05, 0.46, F.metal, 0, 0, 0, g);
      return true;
    }
    case 'WOODEN_CHAIR': {
      b(0.44, 0.06, 0.42, F.wood, 0, OFFICE3D_SEAT_HEIGHT_M - 0.06, 0, g);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1])
          b(0.05, OFFICE3D_SEAT_HEIGHT_M - 0.06, 0.05, F.woodDark, sx * 0.17, 0, sz * 0.16, g);
      }
      for (const sx of [-0.14, 0, 0.14])
        b(0.05, 0.42, 0.04, F.woodDark, sx, OFFICE3D_SEAT_HEIGHT_M, -0.19, g);
      b(0.44, 0.06, 0.05, F.wood, 0, OFFICE3D_SEAT_HEIGHT_M + 0.4, -0.19, g);
      return true;
    }
    case 'SOFA': {
      const sw = w - 0.1;
      b(sw, 0.42, 0.8, color, 0, 0, 0, g);
      b(sw, 0.5, 0.22, color, 0, 0.42, -0.3, g);
      for (const sx of [-1, 1]) b(0.22, 0.62, 0.8, color, sx * (sw / 2 - 0.11), 0, 0, g);
      for (const sx of [-0.35, 0.35])
        b(sw / 2 - 0.3, 0.12, 0.5, F.sofa, sx * (sw / 2), 0.42, 0.08, g);
      return true;
    }
    case 'BEAN_BAG': {
      const m = blob(
        k,
        0.38,
        typeof color === 'string' ? color : '#' + color.getHexString(),
        0,
        0.25,
        0,
        g,
      );
      m.scale.set(1.1, 0.7, 1.1);
      return true;
    }
    case 'CUSHIONED_BENCH':
    case 'WOODEN_BENCH': {
      const top = name === 'CUSHIONED_BENCH' ? F.cushion : F.wood;
      b(w - 0.1, 0.1, d * 0.5, top, 0, 0.36, 0, g);
      for (const sx of [-1, 1]) b(0.08, 0.36, d * 0.4, F.woodDark, sx * (w / 2 - 0.15), 0, 0, g);
      return true;
    }
    case 'PC':
    case 'DUAL_MONITOR': {
      const n = name === 'DUAL_MONITOR' ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const sx = n === 2 ? (i ? 0.33 : -0.33) : 0;
        const mon = new THREE.Group();
        mon.position.set(sx, y0, 0);
        if (n === 2) mon.rotation.y = i ? -0.18 : 0.18;
        g.add(mon);
        b(0.1, 0.1, 0.08, C.screen, 0, 0, -0.05, mon);
        b(0.62, 0.38, 0.05, C.screen, 0, 0.1, -0.05, mon);
        const scr = new THREE.Mesh(
          new THREE.PlaneGeometry(0.55, 0.31),
          new THREE.MeshBasicMaterial({ color: C.screen }),
        );
        scr.position.set(0, 0.29, -0.02);
        mon.add(scr);
        k.screen(scr);
      }
      b(0.5, 0.025, 0.16, F.white, 0, y0, 0.22, g);
      return true;
    }
    case 'PRINTER': {
      b(0.62, 0.34, 0.5, F.white, 0, y0, 0, g);
      b(0.44, 0.04, 0.22, F.paper, 0, y0 + 0.34, 0.08, g);
      b(0.5, 0.06, 0.08, F.dark, 0, y0 + 0.18, 0.26, g);
      return true;
    }
    case 'COFFEE': {
      b(0.36, 0.46, 0.32, F.dark, 0, y0, -0.02, g);
      cyl(k, 0.05, 0.045, 0.1, F.white, 0.08, y0, 0.12, g);
      return true;
    }
    case 'FRIDGE': {
      b(0.74, 1.8, 0.66, F.fridge, 0, 0, 0, g);
      b(0.04, 0.5, 0.04, F.metal, 0.3, 0.95, 0.34, g);
      b(0.04, 0.3, 0.04, F.metal, 0.3, 0.5, 0.34, g);
      b(0.72, 0.02, 0.02, F.metal, 0, 0.85, 0.34, g);
      return true;
    }
    case 'VENDING_MACHINE': {
      b(0.8, 1.8, 0.7, F.vending, 0, 0, 0, g);
      b(0.5, 1.1, 0.02, C.glass, -0.1, 0.5, 0.36, g);
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 3; col++) {
          b(
            0.1,
            0.12,
            0.05,
            OFFICE3D_BOOK_COLORS[(row * 3 + col) % 6],
            -0.25 + col * 0.15,
            0.6 + row * 0.25,
            0.3,
            g,
          );
        }
      }
      return true;
    }
    case 'WATER_COOLER': {
      b(0.4, 0.95, 0.4, F.white, 0, 0, 0, g);
      cyl(k, 0.16, 0.16, 0.42, F.cooler, 0, 0.95, 0, g);
      return true;
    }
    case 'SERVER_RACK': {
      b(0.7, 1.9, 0.8, F.server, 0, 0, 0, g);
      for (let i = 0; i < 8; i++) b(0.5, 0.05, 0.02, F.dark, 0, 0.25 + i * 0.2, 0.41, g);
      for (let i = 0; i < 8; i++) {
        const led = mesh(
          new THREE.BoxGeometry(0.04, 0.04, 0.02),
          new THREE.MeshBasicMaterial({ color: F.led }),
          0.28,
          0.27 + i * 0.2,
          0.42,
          g,
        );
        led.castShadow = false;
      }
      return true;
    }
    case 'ARCADE_CABINET': {
      b(0.7, 1.7, 0.6, F.arcade, 0, 0, 0, g);
      const scr = mesh(
        new THREE.PlaneGeometry(0.5, 0.4),
        new THREE.MeshBasicMaterial({ color: C.screenOn }),
        0,
        1.25,
        0.31,
        g,
      );
      scr.castShadow = false;
      b(0.6, 0.08, 0.3, F.dark, 0, 0.9, 0.3, g);
      return true;
    }
    case 'PING_PONG_TABLE': {
      b(w - 0.2, 0.06, d - 0.3, F.table, 0, 0.72, 0, g);
      b(w - 0.2, 0.012, 0.02, F.white, 0, 0.78, 0, g);
      b(0.02, 0.15, d - 0.3, F.white, 0, 0.78, 0, g);
      for (const sx of [-1, 1]) b(0.08, 0.72, 0.5, F.dark, sx * (w / 2 - 0.5), 0, 0, g);
      return true;
    }
    case 'FISH_TANK': {
      b(w - 0.1, 0.6, d * 0.6, F.woodDark, 0, 0, 0, g);
      const glass = mesh(
        new THREE.BoxGeometry(w - 0.14, 0.6, d * 0.55),
        new THREE.MeshStandardMaterial({
          color: F.water,
          transparent: true,
          opacity: 0.55,
          roughness: 0.1,
        }),
        0,
        0.9,
        0,
        g,
      );
      glass.castShadow = false;
      for (let i = 0; i < 3; i++)
        blob(k, 0.05, F.fish, (r() - 0.5) * (w - 0.4), 0.8 + r() * 0.3, (r() - 0.5) * 0.2, g);
      return true;
    }
    case 'FLOOR_LAMP': {
      cyl(k, 0.02, 0.02, 1.5, F.dark, 0, 0, 0, g);
      cyl(k, 0.18, 0.18, 0.03, F.dark, 0, 0, 0, g);
      cyl(k, 0.16, 0.24, 0.3, F.lampShade, 0, 1.4, 0, g);
      return true;
    }
    case 'BIN': {
      cyl(k, 0.17, 0.14, 0.4, F.bin, 0, 0, 0, g);
      return true;
    }
    case 'RUG': {
      const m = b(w - 0.2, 0.025, d - 0.2, color, 0, 0, 0, g);
      m.castShadow = false;
      return true;
    }
    case 'CUBICLE_DIVIDER': {
      b(w - 0.05, 1.1, 0.08, F.divider, 0, 0, 0, g);
      b(w - 0.05, 0.05, 0.1, F.metal, 0, 1.1, 0, g);
      return true;
    }
    case 'PLANT':
    case 'PLANT_2':
    case 'POT':
    case 'LARGE_PLANT':
    case 'PLANTER':
    case 'CACTUS': {
      const s = name === 'LARGE_PLANT' ? 1.5 : name === 'POT' ? 0.7 : 1;
      if (name === 'PLANTER') {
        b(w - 0.15, 0.4, d * 0.5, F.woodDark, 0, 0, 0, g);
        for (let i = 0; i < 3; i++)
          blob(k, 0.22, i % 2 ? F.leafLight : C.leaf, (i - 1) * (w / 3.5), 0.55, 0, g);
        return true;
      }
      b(0.36 * s, 0.32 * s, 0.36 * s, C.pot, 0, y0, 0, g);
      if (name === 'CACTUS') {
        const c = cyl(k, 0.1, 0.12, 0.5, F.cactus, 0, y0 + 0.3, 0, g);
        c.castShadow = true;
        cyl(k, 0.05, 0.06, 0.2, F.cactus, 0.12, y0 + 0.45, 0, g);
        return true;
      }
      blob(k, 0.3 * s, name === 'PLANT_2' ? F.leafLight : C.leaf, 0, y0 + 0.55 * s, 0, g);
      blob(k, 0.2 * s, F.leafLight, 0.1 * s, y0 + 0.82 * s, -0.05, g);
      if (name === 'LARGE_PLANT') blob(k, 0.22 * s, C.leaf, -0.12 * s, y0 + 1.0 * s, 0.05, g);
      return true;
    }
    default:
      return false;
  }
}

/**
 * Wall items, hung on the wall face that looks into the room. `g` sits at the
 * item's centre on the face (y = 0 at the floor), front facing +z.
 */
export function buildWallModel(
  name: string,
  k: ModelKit,
  g: THREE.Group,
  w: number,
  color: string | THREE.Color,
  seed: string,
): boolean {
  const b = k.box;
  const r = rand(hashStr(seed));
  switch (name) {
    case 'BOOKSHELF':
    case 'DOUBLE_BOOKSHELF': {
      const sw = w - 0.1,
        sh = name === 'DOUBLE_BOOKSHELF' ? 1.05 : 0.8;
      b(sw, sh, 0.36, F.woodDark, 0, 0, 0.18, g);
      const rows = name === 'DOUBLE_BOOKSHELF' ? 3 : 2;
      for (let row = 0; row < rows; row++) {
        const y = 0.08 + row * (sh / rows);
        b(sw - 0.08, 0.03, 0.32, C.deskTop, 0, y, 0.2, g);
        let x = -sw / 2 + 0.08;
        while (x < sw / 2 - 0.12) {
          const bw = 0.05 + r() * 0.05,
            bh = sh / rows - 0.12 - r() * 0.06;
          b(bw, bh, 0.24, OFFICE3D_BOOK_COLORS[Math.floor(r() * 6)], x + bw / 2, y + 0.03, 0.2, g);
          x += bw + 0.012;
        }
      }
      return true;
    }
    case 'LARGE_PAINTING':
    case 'SMALL_PAINTING':
    case 'SMALL_PAINTING_2': {
      const pw = name === 'LARGE_PAINTING' ? Math.min(1.5, w - 0.2) : 0.5,
        ph = name === 'LARGE_PAINTING' ? 0.6 : 0.45;
      b(pw, ph, 0.04, F.woodDark, 0, 0.45, 0.02, g);
      b(pw - 0.08, ph - 0.08, 0.02, OFFICE3D_ART_COLORS[Math.floor(r() * 6)], 0, 0.49, 0.045, g);
      b(
        (pw - 0.08) * 0.5,
        (ph - 0.08) * 0.45,
        0.02,
        OFFICE3D_ART_COLORS[Math.floor(r() * 6)],
        -pw * 0.12,
        0.52,
        0.05,
        g,
      );
      return true;
    }
    case 'CITY_WINDOW': {
      b(w - 0.2, 0.7, 0.05, F.white, 0, 0.3, 0.02, g);
      b(w - 0.3, 0.6, 0.02, F.sky, 0, 0.35, 0.05, g);
      b(0.04, 0.6, 0.03, F.white, 0, 0.35, 0.06, g);
      return true;
    }
    case 'CLOCK': {
      const f = mesh(
        new THREE.CylinderGeometry(0.2, 0.2, 0.04, 24),
        k.mat(F.clockFace),
        0,
        0.75,
        0.03,
        g,
      );
      f.rotation.x = Math.PI / 2;
      b(0.02, 0.14, 0.02, F.dark, 0, 0.75, 0.06, g);
      b(0.1, 0.02, 0.02, F.dark, 0.05, 0.75, 0.06, g);
      return true;
    }
    case 'WHITEBOARD': {
      b(Math.min(1.8, w - 0.1), 0.7, 0.04, F.white, 0, 0.32, 0.02, g);
      for (let i = 0; i < 4; i++) {
        b(
          0.3 + r() * 0.5,
          0.025,
          0.01,
          OFFICE3D_ART_COLORS[i % 6],
          -0.4 + r() * 0.5,
          0.45 + i * 0.12,
          0.045,
          g,
        );
      }
      return true;
    }
    case 'WALL_TV': {
      b(Math.min(1.4, w - 0.1), 0.62, 0.05, F.dark, 0, 0.35, 0.03, g);
      const scr = mesh(
        new THREE.PlaneGeometry(Math.min(1.3, w - 0.2), 0.52),
        new THREE.MeshBasicMaterial({ color: C.screenOn }),
        0,
        0.66,
        0.06,
        g,
      );
      scr.castShadow = false;
      return true;
    }
    case 'HANGING_PLANT': {
      cyl(k, 0.14, 0.1, 0.18, C.pot, 0, 0.55, 0.14, g);
      blob(k, 0.2, C.leaf, 0, 0.72, 0.14, g);
      blob(k, 0.12, F.leafLight, 0.08, 0.5, 0.2, g);
      return true;
    }
    default: {
      b(w * 0.8, 0.5, 0.05, color, 0, 0.4, 0.03, g);
      return true;
    }
  }
}
