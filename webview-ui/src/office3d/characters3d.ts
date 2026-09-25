/**
 * Soft Dollhouse characters: one rig per office Character, posed each frame from
 * the character's own state (walk / type / idle, tool, bubble). The rig never
 * decides anything — OfficeState moves characters, this only draws them.
 */

import * as THREE from 'three';

import type { AgentLook } from '../../../core/src/agentLook.js';
import {
  OFFICE3D_COLORS as C,
  OFFICE3D_PALETTES,
  OFFICE3D_PX_PER_M,
  OFFICE3D_SEAT_HEIGHT_M,
  OFFICE3D_SUBAGENT_SCALE,
  OFFICE3D_WALK_SWING,
} from '../constants.js';
import { isReadingTool } from '../office/engine/characters.js';
import type { Character } from '../office/types.js';
import { CharacterState, Direction } from '../office/types.js';
import { rbox } from './build.js';

const LEG_H = 0.36;
const TORSO_H = 0.44;

export interface Rig {
  g: THREE.Group;
  root: THREE.Group;
  head: THREE.Group;
  legs: THREE.Group[];
  arms: THREE.Group[];
  /** Height of the head top above the floor when standing, in metres. */
  height: number;
  scale: number;
  lookKey: string;
  phase: number;
}

function hueShifted(hex: string, hueDeg: number): string {
  if (!hueDeg) return hex;
  const c = new THREE.Color(hex);
  c.offsetHSL(hueDeg / 360, 0, 0);
  return '#' + c.getHexString();
}

/** Lighter (+) or darker (−) by `pct` lightness points. */
function light(hex: string, pct: number): string {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, pct / 100);
  return '#' + c.getHexString();
}

/** The look a character is drawn with: its own, else one made from its palette. */
export function lookFor(ch: Character): AgentLook {
  if (ch.look) return ch.look;
  const pal = OFFICE3D_PALETTES[((ch.palette % 6) + 6) % 6];
  return {
    hair: 'short',
    top: 'tee',
    height: 'average',
    extras: [],
    skin: pal.skin,
    hairColor: pal.hair,
    shirt: hueShifted(pal.shirt, ch.hueShift),
    pants: pal.pants,
  };
}

export function lookKey(ch: Character): string {
  return JSON.stringify(lookFor(ch)) + (ch.isSubagent ? ':s' : '');
}

export function buildRig(ch: Character): Rig {
  const r = buildLookRig(lookFor(ch), ch.isSubagent);
  r.g.userData.agentId = ch.id;
  r.lookKey = lookKey(ch);
  return r;
}

const HEIGHT_K: Record<AgentLook['height'], number> = { short: 0.92, average: 1, tall: 1.08 };

/** A character from a look alone: the office uses it, and so does the studio preview. */
export function buildLookRig(L: AgentLook, small = false): Rig {
  const g = new THREE.Group();
  const root = new THREE.Group();
  g.add(root);
  const scale = (small ? OFFICE3D_SUBAGENT_SCALE : 1) * HEIGHT_K[L.height];
  root.scale.setScalar(scale);

  const legs: THREE.Group[] = [];
  const arms: THREE.Group[] = [];
  for (const sd of [-1, 1]) {
    const p = new THREE.Group();
    p.position.set(sd * 0.1, LEG_H, 0);
    root.add(p);
    rbox(0.15, LEG_H - 0.04, 0.17, L.pants, 0, -LEG_H + 0.04, 0, p);
    rbox(0.17, 0.08, 0.23, C.shoes, 0, -LEG_H, 0.03, p);
    legs.push(p);
  }
  rbox(0.42, TORSO_H, 0.26, L.shirt, 0, LEG_H, 0, root);
  for (const sd of [-1, 1]) {
    const p = new THREE.Group();
    p.position.set(sd * 0.27, LEG_H + TORSO_H - 0.05, 0);
    root.add(p);
    rbox(0.11, 0.32, 0.12, L.shirt, 0, -0.33, 0, p);
    rbox(0.1, 0.1, 0.11, L.skin, 0, -0.42, 0, p);
    arms.push(p);
  }
  const head = new THREE.Group();
  head.position.y = LEG_H + TORSO_H + 0.02;
  root.add(head);
  rbox(0.4, 0.37, 0.36, L.skin, 0, 0, 0, head);
  rbox(0.05, 0.07, 0.02, C.eyes, -0.085, 0.16, 0.18, head);
  rbox(0.05, 0.07, 0.02, C.eyes, 0.085, 0.16, 0.18, head);
  rbox(0.06, 0.03, 0.015, C.cheek, -0.14, 0.09, 0.18, head);
  rbox(0.06, 0.03, 0.015, C.cheek, 0.14, 0.09, 0.18, head);
  dress(root, head, L);

  return {
    g,
    root,
    head,
    legs,
    arms,
    height: (LEG_H + TORSO_H + 0.45) * scale,
    scale,
    lookKey: JSON.stringify(L),
    phase: Math.random() * Math.PI * 2,
  };
}

/** Hair, extras and top on a box head (W × H × D, bottom at y = 0). */
function dress(root: THREE.Group, hd: THREE.Group, L: AgentLook): void {
  const W = 0.4,
    H = 0.37,
    D = 0.36,
    eye = 0.195;
  const hc = L.hairColor;
  const has = (x: AgentLook['extras'][number]) => L.extras.includes(x);
  const hat = has('cap') || has('beanie');
  const bz = -(D / 2 - 0.04);
  const cap = () => rbox(W + 0.03, 0.13, D + 0.03, hc, 0, H - 0.07, -0.005, hd);
  const back = (ht: number, y: number) => rbox(W + 0.03, ht, 0.12, hc, 0, y, bz, hd);
  const sides = (ht: number, y: number, d: number) => {
    for (const sd of [-1, 1])
      rbox(0.06, ht, d, hc, sd * (W / 2 + 0.015), y, -(D - d) / 2 + 0.02, hd);
  };
  const spike = (x: number, z: number) => {
    const c = new THREE.Mesh(
      new THREE.ConeGeometry(0.07, 0.18, 5),
      new THREE.MeshStandardMaterial({ color: hc, roughness: 0.85, flatShading: true }),
    );
    c.position.set(x, H + 0.12, z);
    c.castShadow = true;
    hd.add(c);
  };
  switch (L.hair) {
    case 'short':
      cap();
      back(0.26, H * 0.27);
      break;
    case 'bob':
      cap();
      back(0.34, 0.02);
      sides(0.3, 0.04, D * 0.8);
      break;
    case 'long':
      cap();
      back(0.62, -0.26);
      sides(0.36, -0.02, D * 0.7);
      break;
    case 'bun':
      cap();
      back(0.26, H * 0.27);
      if (!hat) rbox(0.18, 0.16, 0.16, hc, 0, H + 0.04, -0.1, hd);
      break;
    case 'spiky':
      rbox(W + 0.03, 0.08, D + 0.03, hc, 0, H - 0.03, -0.005, hd);
      back(0.26, H * 0.27);
      if (!hat)
        for (const [x, z] of [
          [-0.12, -0.05],
          [0, -0.08],
          [0.12, -0.05],
          [-0.06, 0.07],
          [0.07, 0.07],
        ])
          spike(x, z);
      break;
    case 'curly':
      cap();
      back(0.3, H * 0.15);
      if (!hat)
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * Math.PI * 2;
          rbox(0.14, 0.12, 0.14, hc, Math.cos(a) * W * 0.42, H - 0.02, Math.sin(a) * D * 0.42, hd);
        }
      break;
    case 'bald':
      break;
  }
  if (has('glasses')) {
    for (const sd of [-1, 1]) {
      rbox(0.13, 0.09, 0.012, C.frames, sd * 0.085, eye - 0.045, D / 2 + 0.012, hd);
      rbox(0.1, 0.06, 0.014, C.lens, sd * 0.085, eye - 0.03, D / 2 + 0.014, hd);
    }
    rbox(0.05, 0.015, 0.012, C.frames, 0, eye + 0.005, D / 2 + 0.012, hd);
  }
  if (has('beard')) {
    rbox(W * 0.86, 0.12, 0.05, hc, 0, -0.005, D / 2 - 0.01, hd);
    for (const sd of [-1, 1]) rbox(0.05, 0.16, D * 0.5, hc, sd * (W / 2 - 0.01), 0, D * 0.18, hd);
  }
  if (has('cap')) {
    rbox(W + 0.05, 0.14, D + 0.05, L.shirt, 0, H - 0.02, 0, hd);
    rbox(W * 0.85, 0.03, 0.2, light(L.shirt, -12), 0, H - 0.02, D / 2 + 0.1, hd);
  } else if (has('beanie')) {
    rbox(W + 0.05, 0.2, D + 0.05, light(L.shirt, -8), 0, H - 0.06, 0, hd);
    rbox(W + 0.07, 0.07, D + 0.07, light(L.shirt, -18), 0, H - 0.08, 0, hd);
    rbox(0.12, 0.12, 0.12, C.collar, 0, H + 0.13, 0, hd);
  }
  if (has('headphones')) {
    const top = H + (hat ? 0.12 : 0.05);
    for (const sd of [-1, 1]) {
      rbox(0.05, top - H * 0.35, 0.05, C.frames, sd * (W / 2 + 0.05), H * 0.35 + 0.05, 0, hd);
      rbox(0.07, 0.15, 0.15, C.cup, sd * (W / 2 + 0.04), H * 0.3, 0, hd);
    }
    rbox(W + 0.15, 0.05, 0.06, C.frames, 0, top, 0, hd);
  }
  const collarY = LEG_H + TORSO_H;
  const front = 0.13;
  if (L.top === 'hoodie') {
    const h2 = light(L.shirt, -10);
    rbox(0.34, 0.16, 0.13, h2, 0, collarY - 0.14, -0.14, root);
    rbox(0.3, 0.06, 0.2, h2, 0, collarY - 0.05, -0.02, root);
    for (const sd of [-1, 1])
      rbox(0.018, 0.14, 0.018, C.collar, sd * 0.06, collarY - 0.2, front + 0.01, root);
  } else if (L.top === 'tie') {
    rbox(0.22, 0.05, 0.03, C.collar, 0, collarY - 0.06, front, root);
    rbox(0.07, TORSO_H * 0.6, 0.025, C.tie, 0, collarY - 0.06 - TORSO_H * 0.6, front + 0.012, root);
    rbox(0.08, 0.05, 0.03, C.tieKnot, 0, collarY - 0.08, front + 0.014, root);
  }
}

const FACING: Record<number, number> = {
  [Direction.DOWN]: 0,
  [Direction.UP]: Math.PI,
  [Direction.RIGHT]: Math.PI / 2,
  [Direction.LEFT]: -Math.PI / 2,
};

function angLerp(a: number, b: number, t: number): number {
  const d = ((((b - a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
  return a + d * t;
}

/** Places and poses a rig from its character. `t` is seconds since the view started. */
export function poseRig(r: Rig, ch: Character, dt: number, t: number, spawnFraction: number): void {
  const g = r.g;
  g.position.set(ch.x / OFFICE3D_PX_PER_M, 0, ch.y / OFFICE3D_PX_PER_M);
  g.rotation.y = angLerp(g.rotation.y, FACING[ch.dir] ?? 0, Math.min(1, dt * 12));
  // Spawn / despawn: grow in, shrink out (the pixel view's digital rain).
  g.scale.setScalar(Math.max(0.001, spawnFraction));

  const [L0, L1] = r.legs;
  const [A0, A1] = r.arms;
  let rootY: number;
  let lean = 0;
  let headX = 0;
  A0.rotation.z = A1.rotation.z = 0;
  if (ch.state === CharacterState.WALK) {
    r.phase += dt * 10;
    const s = Math.sin(r.phase) * OFFICE3D_WALK_SWING;
    L0.rotation.x = s;
    L1.rotation.x = -s;
    A0.rotation.x = -s * 0.8;
    A1.rotation.x = s * 0.8;
    rootY = Math.abs(Math.sin(r.phase)) * 0.035;
  } else if (ch.state === CharacterState.TYPE) {
    L0.rotation.x = L1.rotation.x = -Math.PI / 2;
    rootY = OFFICE3D_SEAT_HEIGHT_M - LEG_H;
    if (isReadingTool(ch.currentTool)) {
      A0.rotation.x = A1.rotation.x = -1.0;
      headX = 0.2 + Math.sin(t * 0.8) * 0.05;
    } else {
      A0.rotation.x = -1.25 + Math.sin(t * 16) * 0.12;
      A1.rotation.x = -1.25 + Math.sin(t * 16 + 2) * 0.12;
      headX = 0.12 + Math.sin(t * 3) * 0.03;
    }
  } else {
    L0.rotation.x = L1.rotation.x = 0;
    A0.rotation.x = Math.sin(t * 1.3 + r.phase) * 0.06;
    A1.rotation.x = -A0.rotation.x;
    rootY = Math.sin(t * 2 + r.phase) * 0.01;
  }
  if (ch.bubbleType === 'permission') {
    // Hand up: this agent needs an answer.
    A1.rotation.x = -2.9;
    A1.rotation.z = Math.sin(t * 6) * 0.25;
    headX = -0.1;
  } else if (ch.bubbleType === 'waiting' && ch.state !== CharacterState.WALK) {
    lean = -0.1;
    headX = -0.15;
  }
  r.root.position.y = rootY;
  r.root.rotation.x = lean;
  r.head.rotation.x = headX;
}

export function disposeRig(r: Rig): void {
  r.g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
  });
}
