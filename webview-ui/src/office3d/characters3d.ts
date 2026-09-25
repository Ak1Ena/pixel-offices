/**
 * Soft Dollhouse characters: one rig per office Character, posed each frame from
 * the character's own state (walk / type / idle, tool, bubble). The rig never
 * decides anything — OfficeState moves characters, this only draws them.
 */

import * as THREE from 'three';

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

function shade(hex: string, hueDeg: number): string {
  if (!hueDeg) return hex;
  const c = new THREE.Color(hex);
  c.offsetHSL(hueDeg / 360, 0, 0);
  return '#' + c.getHexString();
}

export function lookKey(ch: Character): string {
  return `${ch.palette}:${ch.hueShift}:${ch.isSubagent ? 's' : ''}`;
}

export function buildRig(ch: Character): Rig {
  const pal = OFFICE3D_PALETTES[((ch.palette % 6) + 6) % 6];
  const shirt = shade(pal.shirt, ch.hueShift);
  const g = new THREE.Group();
  const root = new THREE.Group();
  g.add(root);
  const scale = ch.isSubagent ? OFFICE3D_SUBAGENT_SCALE : 1;
  root.scale.setScalar(scale);
  g.userData.agentId = ch.id;

  const legs: THREE.Group[] = [];
  const arms: THREE.Group[] = [];
  for (const sd of [-1, 1]) {
    const p = new THREE.Group();
    p.position.set(sd * 0.1, LEG_H, 0);
    root.add(p);
    rbox(0.15, LEG_H - 0.04, 0.17, pal.pants, 0, -LEG_H + 0.04, 0, p);
    rbox(0.17, 0.08, 0.23, C.shoes, 0, -LEG_H, 0.03, p);
    legs.push(p);
  }
  rbox(0.42, TORSO_H, 0.26, shirt, 0, LEG_H, 0, root);
  for (const sd of [-1, 1]) {
    const p = new THREE.Group();
    p.position.set(sd * 0.27, LEG_H + TORSO_H - 0.05, 0);
    root.add(p);
    rbox(0.11, 0.32, 0.12, shirt, 0, -0.33, 0, p);
    rbox(0.1, 0.1, 0.11, pal.skin, 0, -0.42, 0, p);
    arms.push(p);
  }
  const head = new THREE.Group();
  head.position.y = LEG_H + TORSO_H + 0.02;
  root.add(head);
  rbox(0.4, 0.37, 0.36, pal.skin, 0, 0, 0, head);
  rbox(0.43, 0.13, 0.39, pal.hair, 0, 0.3, -0.005, head);
  rbox(0.43, 0.26, 0.12, pal.hair, 0, 0.1, -0.14, head);
  rbox(0.05, 0.07, 0.02, C.eyes, -0.085, 0.16, 0.18, head);
  rbox(0.05, 0.07, 0.02, C.eyes, 0.085, 0.16, 0.18, head);
  rbox(0.06, 0.03, 0.015, C.cheek, -0.14, 0.09, 0.18, head);
  rbox(0.06, 0.03, 0.015, C.cheek, 0.14, 0.09, 0.18, head);

  return {
    g,
    root,
    head,
    legs,
    arms,
    height: (LEG_H + TORSO_H + 0.45) * scale,
    scale,
    lookKey: lookKey(ch),
    phase: Math.random() * Math.PI * 2,
  };
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
