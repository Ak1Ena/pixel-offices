/**
 * The viewer's own character ("You"): walks the office with WASD / arrow keys
 * or a click on the floor while Walk is on. Client-only — not an agent, never
 * sent to the server; its look is kept per viewer in localStorage.
 */

import type * as THREE from 'three';

import { type AgentLook, sanitizeAgentLook } from '../../../core/src/agentLook.js';
import {
  OFFICE3D_AVATAR_COLORS,
  OFFICE3D_AVATAR_KEY,
  OFFICE3D_AVATAR_RADIUS_M,
  OFFICE3D_AVATAR_SPEED_M,
  OFFICE3D_PX_PER_M,
} from '../constants.js';
import { canStep, findPath, isWalkable } from '../office/layout/tileMap.js';
import type { Character, TileType as TileTypeVal } from '../office/types.js';
import { CharacterState, Direction } from '../office/types.js';
import { buildLookRig, disposeRig, poseRig, type Rig } from './characters3d.js';

/** A look for a first-time viewer: plain and friendly, easy to change. */
export const DEFAULT_AVATAR_LOOK: AgentLook = {
  hair: 'short',
  top: 'hoodie',
  height: 'average',
  extras: [],
  ...OFFICE3D_AVATAR_COLORS,
};

export function loadAvatarLook(): AgentLook {
  try {
    const raw = localStorage.getItem(OFFICE3D_AVATAR_KEY);
    if (raw) return sanitizeAgentLook(JSON.parse(raw)) ?? DEFAULT_AVATAR_LOOK;
  } catch {
    /* no storage: the first look */
  }
  return DEFAULT_AVATAR_LOOK;
}

export function saveAvatarLook(look: AgentLook): void {
  try {
    localStorage.setItem(OFFICE3D_AVATAR_KEY, JSON.stringify(look));
  } catch {
    /* kept for this visit only */
  }
}

interface Nav {
  tileMap: TileTypeVal[][];
  blockedTiles: Set<string>;
}

export class Avatar {
  rig: Rig;
  x = 0;
  z = 0;
  heading = 0;
  moving = false;
  private path: Array<{ col: number; row: number }> = [];
  private placed = false;
  /** The pose input poseRig reads (the avatar is drawn like any character). */
  private readonly body = {
    x: 0,
    y: 0,
    dir: Direction.DOWN,
    state: CharacterState.IDLE,
    currentTool: null,
    bubbleType: null,
  } as unknown as Character;

  private readonly scene: THREE.Scene;
  look: AgentLook;

  constructor(scene: THREE.Scene, look: AgentLook) {
    this.scene = scene;
    this.look = look;
    this.rig = buildLookRig(look);
    scene.add(this.rig.g);
  }

  setLook(look: AgentLook): void {
    this.look = look;
    this.scene.remove(this.rig.g);
    disposeRig(this.rig);
    this.rig = buildLookRig(look);
    this.scene.add(this.rig.g);
  }

  /** Stand on a tile (the door, the first time; again when the layout changes
   *  under the avatar's feet). */
  placeAt(col: number, row: number): void {
    this.x = col + 0.5;
    this.z = row + 0.5;
    this.path = [];
    this.placed = true;
  }

  get isPlaced(): boolean {
    return this.placed;
  }

  get tile(): { col: number; row: number } {
    return { col: Math.floor(this.x), row: Math.floor(this.z) };
  }

  /** Walk to a tile along the office's paths (a click on the floor). */
  goTo(col: number, row: number, nav: Nav): boolean {
    const t = this.tile;
    const path = findPath(t.col, t.row, col, row, nav.tileMap, nav.blockedTiles);
    if (path.length === 0) return false;
    this.path = path;
    return true;
  }

  /** Walk up next to a tile that can't be stood on (an agent at a desk). */
  goNear(col: number, row: number, nav: Nav): boolean {
    let best: Array<{ col: number; row: number }> | null = null;
    const t = this.tile;
    for (const [dc, dr] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ]) {
      const c = col + dc,
        r = row + dr;
      if (c === t.col && r === t.row) return true;
      if (!isWalkable(c, r, nav.tileMap, nav.blockedTiles)) continue;
      const p = findPath(t.col, t.row, c, r, nav.tileMap, nav.blockedTiles);
      if (p.length > 0 && (!best || p.length < best.length)) best = p;
    }
    if (!best) return false;
    this.path = best;
    return true;
  }

  /** Can the avatar's body stand at (x, z), coming from its current tile? */
  private fits(x: number, z: number, nav: Nav): boolean {
    const r = OFFICE3D_AVATAR_RADIUS_M;
    const from = this.tile;
    for (const [px, pz] of [
      [x - r, z - r],
      [x + r, z - r],
      [x - r, z + r],
      [x + r, z + r],
    ]) {
      const c = Math.floor(px),
        row = Math.floor(pz);
      if (!isWalkable(c, row, nav.tileMap, nav.blockedTiles)) return false;
      if (c === from.col && row === from.row) continue;
      const walk = (a: number, b: number) => isWalkable(a, b, nav.tileMap, nav.blockedTiles);
      if (c === from.col || row === from.row) {
        // Straight across an edge: room glass blocks it except at the door.
        if (!canStep(from.col, from.row, c, row)) return false;
      } else {
        // Diagonal: one of the two L-shaped ways round must be open.
        const viaCol =
          walk(c, from.row) &&
          canStep(from.col, from.row, c, from.row) &&
          canStep(c, from.row, c, row);
        const viaRow =
          walk(from.col, row) &&
          canStep(from.col, from.row, from.col, row) &&
          canStep(from.col, row, c, row);
        if (!viaCol && !viaRow) return false;
      }
    }
    return true;
  }

  /**
   * One frame. `steer` = the keys, in world metres (x, z), length ≤ 1; keys
   * cancel a click-walk. Returns whether the avatar moved.
   */
  update(steer: { x: number; z: number }, dt: number, time: number, nav: Nav): boolean {
    let dx = steer.x,
      dz = steer.z;
    /** Metres to the next path tile's centre: never step past it. */
    let left = Infinity;
    if (dx !== 0 || dz !== 0) {
      this.path = [];
    } else {
      while (this.path.length > 0) {
        const next = this.path[0];
        const tx = next.col + 0.5 - this.x,
          tz = next.row + 0.5 - this.z;
        const d = Math.hypot(tx, tz);
        if (d < 0.02) {
          this.path.shift();
          continue;
        }
        dx = tx / d;
        dz = tz / d;
        left = d;
        break;
      }
    }
    const len = Math.hypot(dx, dz);
    this.moving = len > 0.01;
    if (this.moving) {
      const step = Math.min(Math.min(1, len) * OFFICE3D_AVATAR_SPEED_M * dt, left);
      const ux = (dx / len) * step,
        uz = (dz / len) * step;
      // Slide along walls: try both axes, then each alone.
      if (this.fits(this.x + ux, this.z + uz, nav)) {
        this.x += ux;
        this.z += uz;
      } else if (this.fits(this.x + ux, this.z, nav)) {
        this.x += ux;
      } else if (this.fits(this.x, this.z + uz, nav)) {
        this.z += uz;
      } else if (this.path.length > 0) {
        // A click-walk squeezing a corner: go straight to the tile centre.
        this.x += ux;
        this.z += uz;
      }
      this.heading = Math.atan2(dx, dz);
    }

    const b = this.body as unknown as {
      x: number;
      y: number;
      state: string;
    };
    b.x = this.x * OFFICE3D_PX_PER_M;
    b.y = this.z * OFFICE3D_PX_PER_M;
    b.state = this.moving ? CharacterState.WALK : CharacterState.IDLE;
    const g = this.rig.g;
    const turned = g.rotation.y;
    poseRig(this.rig, this.body, dt, time, 1);
    // poseRig turns to the four tile directions; the avatar turns freely.
    g.rotation.y = turned;
    let d = this.heading - g.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    g.rotation.y += d * Math.min(1, dt * 14);
    return this.moving;
  }

  dispose(): void {
    this.scene.remove(this.rig.g);
    disposeRig(this.rig);
  }
}
