/**
 * A character's look in the 3D office: hair, top, height, extras and four
 * colours. Chosen by the human (character studio), persisted with the agent,
 * and sent to every client. The pixel view ignores it and keeps the palette.
 *
 * `sanitizeAgentLook` is the one gate: a look from a client (or a hand-edited
 * state file) is rebuilt field by field from known values, never passed on.
 */

import { DEFAULT_LOOK_COLORS } from './constants.js';

export const LOOK_HAIR = ['short', 'bob', 'long', 'bun', 'spiky', 'curly', 'bald'] as const;
export const LOOK_TOP = ['tee', 'hoodie', 'tie'] as const;
export const LOOK_HEIGHT = ['short', 'average', 'tall'] as const;
export const LOOK_EXTRAS = ['glasses', 'headphones', 'cap', 'beanie', 'beard'] as const;

export type LookHair = (typeof LOOK_HAIR)[number];
export type LookTop = (typeof LOOK_TOP)[number];
export type LookHeight = (typeof LOOK_HEIGHT)[number];
export type LookExtra = (typeof LOOK_EXTRAS)[number];

export interface AgentLook {
  hair: LookHair;
  top: LookTop;
  height: LookHeight;
  extras: LookExtra[];
  /** `#rrggbb` colours. */
  skin: string;
  hairColor: string;
  shirt: string;
  pants: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function pick<T extends string>(list: readonly T[], v: unknown, fallback: T): T {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback;
}

function hex(v: unknown, fallback: string): string {
  return typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fallback;
}

/** Rebuilds a look from untrusted input; `undefined` when it isn't one. */
export function sanitizeAgentLook(raw: unknown): AgentLook | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const extras = Array.isArray(r.extras)
    ? [
        ...new Set(
          r.extras.filter((x): x is LookExtra => (LOOK_EXTRAS as readonly unknown[]).includes(x)),
        ),
      ]
    : [];
  // One hat at a time: a cap and a beanie would sit inside each other.
  const hats = extras.filter((x) => x === 'cap' || x === 'beanie');
  const cleanExtras = hats.length > 1 ? extras.filter((x) => x !== hats[0]) : extras;
  return {
    hair: pick(LOOK_HAIR, r.hair, 'short'),
    top: pick(LOOK_TOP, r.top, 'tee'),
    height: pick(LOOK_HEIGHT, r.height, 'average'),
    extras: cleanExtras,
    skin: hex(r.skin, DEFAULT_LOOK_COLORS.skin),
    hairColor: hex(r.hairColor, DEFAULT_LOOK_COLORS.hairColor),
    shirt: hex(r.shirt, DEFAULT_LOOK_COLORS.shirt),
    pants: hex(r.pants, DEFAULT_LOOK_COLORS.pants),
  };
}

export function sameAgentLook(a: AgentLook | undefined, b: AgentLook | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
