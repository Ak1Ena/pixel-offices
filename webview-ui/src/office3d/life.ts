/**
 * The 3D office's small lives: agents closed from the office walking out the
 * door, smoke and flames on agents burning tokens, and the night.
 */

import * as THREE from 'three';

import {
  OFFICE3D_COLORS as C,
  OFFICE3D_HEMI_INTENSITY,
  OFFICE3D_PX_PER_M,
  OFFICE3D_SUN_INTENSITY,
  WALK_SPEED_PX_PER_SEC,
} from '../constants.js';
import { findPath } from '../office/layout/tileMap.js';
import type { Character, TileType as TileTypeVal } from '../office/types.js';
import { CharacterState } from '../office/types.js';
import type { OfficeMeshes } from './build.js';
import { disposeRig, poseRig, type Rig } from './characters3d.js';

const WALK_M_PER_SEC = WALK_SPEED_PX_PER_SEC / OFFICE3D_PX_PER_M;
const WAVE_SEC = 1.6;
const FADE_SEC = 0.6;

/** A character that has left the office state but is still walking out. */
export interface Leaver {
  id: number;
  rig: Rig;
  /** Stand-in character the pose code reads (x/y in world px). */
  ch: Character;
  path: Array<{ x: number; z: number }>;
  i: number;
  phase: 'walk' | 'wave' | 'out' | 'fade';
  t: number;
  /** Shown above them while they go. */
  say: string;
}

/** Starts the walk to the door for an agent closed from the office. */
export function startLeaving(
  id: number,
  rig: Rig,
  ch: Character,
  door: OfficeMeshes['door'],
  tileMap: TileTypeVal[][],
  blocked: Set<string>,
): Leaver {
  const stand: Character = {
    ...ch,
    state: CharacterState.WALK,
    bubbleType: null,
    matrixEffect: null,
  };
  const path: Array<{ x: number; z: number }> = [];
  if (door) {
    // The seat tile is blocked for everyone else; free it for this last walk.
    const own = `${ch.tileCol},${ch.tileRow}`;
    const had = blocked.has(own);
    if (had) blocked.delete(own);
    const tiles = findPath(
      ch.tileCol,
      ch.tileRow,
      door.inside.col,
      door.inside.row,
      tileMap,
      blocked,
    );
    if (had) blocked.add(own);
    for (const t of tiles) path.push({ x: t.col + 0.5, z: t.row + 0.5 });
  }
  return { id, rig, ch: stand, path, i: 0, phase: 'walk', t: 0, say: 'See you tomorrow!' };
}

/** Advances a leaver; false when it is gone and its rig disposed. */
export function stepLeaver(
  L: Leaver,
  door: OfficeMeshes['door'],
  dt: number,
  time: number,
  scene: THREE.Scene,
): boolean {
  const ch = L.ch;
  const walkTo = (x: number, z: number): boolean => {
    const cx = ch.x / OFFICE3D_PX_PER_M,
      cz = ch.y / OFFICE3D_PX_PER_M;
    const dx = x - cx,
      dz = z - cz,
      d = Math.hypot(dx, dz);
    if (d < 0.03) return true;
    const m = Math.min(d, WALK_M_PER_SEC * dt);
    ch.x = (cx + (dx / d) * m) * OFFICE3D_PX_PER_M;
    ch.y = (cz + (dz / d) * m) * OFFICE3D_PX_PER_M;
    L.rig.g.rotation.y = Math.atan2(dx, dz);
    return false;
  };
  L.t += dt;
  if (L.phase === 'walk') {
    ch.state = CharacterState.WALK;
    const p = L.path[L.i];
    if (!p) {
      L.phase = door ? 'wave' : 'fade';
      L.t = 0;
    } else if (walkTo(p.x, p.z)) L.i++;
  } else if (L.phase === 'wave') {
    ch.state = CharacterState.IDLE;
    if (L.t > WAVE_SEC) {
      L.phase = 'out';
      L.t = 0;
      L.say = '';
    }
  } else if (L.phase === 'out' && door) {
    ch.state = CharacterState.WALK;
    if (walkTo(door.outside.x, door.outside.z)) {
      L.phase = 'fade';
      L.t = 0;
    }
  } else {
    L.phase = 'fade';
  }

  const yaw = L.rig.g.rotation.y;
  poseRig(L.rig, ch, dt, time, L.phase === 'fade' ? Math.max(0, 1 - L.t / FADE_SEC) : 1);
  L.rig.g.rotation.y = L.phase === 'wave' ? 0 : yaw;
  if (L.phase === 'wave') {
    // Turn back to the room and wave goodbye.
    L.rig.arms[1].rotation.x = -2.7;
    L.rig.arms[1].rotation.z = Math.sin(time * 12) * 0.45;
    L.rig.g.rotation.y = (door?.yaw ?? 0) + Math.PI;
  }
  if (L.phase === 'fade' && L.t >= FADE_SEC) {
    scene.remove(L.rig.g);
    disposeRig(L.rig);
    return false;
  }
  return true;
}

// ── Burn: smoke when warm, flames when on fire ─────────────────────

interface BurnFx {
  level: 1 | 2;
  g: THREE.Group;
  parts: Array<{ m: THREE.Mesh; t: number; speed: number }>;
}
const burnFx = new WeakMap<Rig, BurnFx>();

export function updateBurn(rig: Rig, level: 0 | 1 | 2, dt: number): void {
  let fx = burnFx.get(rig);
  if (fx && fx.level !== level) {
    rig.g.remove(fx.g);
    fx.g.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    burnFx.delete(rig);
    fx = undefined;
  }
  if (!level) return;
  if (!fx) {
    const g = new THREE.Group();
    const parts: BurnFx['parts'] = [];
    const n = level === 2 ? 7 : 5;
    for (let i = 0; i < n; i++) {
      const fire = level === 2 && i < 4;
      const m = new THREE.Mesh(
        fire ? new THREE.ConeGeometry(0.07, 0.22, 6) : new THREE.IcosahedronGeometry(0.07, 0),
        new THREE.MeshBasicMaterial({
          color: fire ? (i % 2 ? C.flame : C.flameCore) : C.smoke,
          transparent: true,
          opacity: 0.8,
          depthWrite: false,
        }),
      );
      g.add(m);
      parts.push({ m, t: i / n, speed: fire ? 1.6 : 0.5 });
    }
    rig.g.add(g);
    fx = { level, g, parts };
    burnFx.set(rig, fx);
  }
  const top = rig.height + 0.05;
  for (const p of fx.parts) {
    p.t = (p.t + dt * p.speed) % 1;
    const fire = p.m.geometry.type === 'ConeGeometry';
    const a = p.t * Math.PI * 2 + p.speed;
    p.m.position.set(
      Math.sin(a * 3) * (fire ? 0.08 : 0.12),
      top + p.t * (fire ? 0.35 : 0.8),
      Math.cos(a * 2) * (fire ? 0.06 : 0.1),
    );
    const s = fire ? 1 - p.t * 0.7 : 0.6 + p.t * 1.4;
    p.m.scale.setScalar(s);
    (p.m.material as THREE.MeshBasicMaterial).opacity = (fire ? 0.9 : 0.5) * (1 - p.t);
  }
}

// ── Night ───────────────────────────────────────────────────────────

export interface NightRig {
  hemi: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  lamps: THREE.PointLight[];
  bulbs: THREE.Mesh[];
}

const cA = new THREE.Color(),
  cB = new THREE.Color();

/** k: 0 = day, 1 = night. */
export function applyNight(scene: THREE.Scene, n: NightRig, k: number): void {
  (scene.background as THREE.Color).copy(cA.set(C.sky)).lerp(cB.set(C.skyNight), k);
  n.hemi.intensity = OFFICE3D_HEMI_INTENSITY * (1 - 0.72 * k);
  n.hemi.color.copy(cA.set(C.hemiSky)).lerp(cB.set(C.hemiNight), k);
  n.sun.intensity = OFFICE3D_SUN_INTENSITY * (1 - 0.8 * k);
  n.sun.color.copy(cA.set(C.sun)).lerp(cB.set(C.sunNight), k);
  for (const l of n.lamps) l.intensity = 6 * k;
  for (const b of n.bulbs) (b.material as THREE.MeshBasicMaterial).opacity = 0.65 + 0.35 * k;
}

/** Warm hanging lamps over each desk cluster (at most 8, lights are costly). */
export function buildLamps(
  office: OfficeMeshes,
  g: THREE.Group,
): Pick<NightRig, 'lamps' | 'bulbs'> {
  const lamps: THREE.PointLight[] = [];
  const bulbs: THREE.Mesh[] = [];
  for (const s of office.lampSpots.slice(0, 8)) {
    const l = new THREE.PointLight(C.lamp, 0, 7, 1.6);
    l.position.set(s.x, 2.1, s.z);
    g.add(l);
    lamps.push(l);
    const b = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 12, 8),
      new THREE.MeshBasicMaterial({ color: C.lamp, transparent: true, opacity: 0.25 }),
    );
    b.position.copy(l.position);
    g.add(b);
    bulbs.push(b);
  }
  return { lamps, bulbs };
}
