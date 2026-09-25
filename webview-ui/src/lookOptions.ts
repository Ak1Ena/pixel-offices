/**
 * Character studio choices and helpers (no Three.js here, so forms can import
 * it without pulling the 3D view into the main bundle).
 */

import type { AgentLook } from '../../core/src/agentLook.js';
import { OFFICE3D_SWATCHES } from './constants.js';

export const HAIR_OPTIONS: Array<[AgentLook['hair'], string]> = [
  ['short', 'Short'],
  ['bob', 'Bob'],
  ['long', 'Long'],
  ['bun', 'Bun'],
  ['spiky', 'Spiky'],
  ['curly', 'Curly'],
  ['bald', 'None'],
];
export const TOP_OPTIONS: Array<[AgentLook['top'], string]> = [
  ['tee', 'T-shirt'],
  ['hoodie', 'Hoodie'],
  ['tie', 'Shirt + tie'],
];
export const HEIGHT_OPTIONS: Array<[AgentLook['height'], string]> = [
  ['short', 'Short'],
  ['average', 'Average'],
  ['tall', 'Tall'],
];
export const EXTRA_OPTIONS: Array<[AgentLook['extras'][number], string]> = [
  ['glasses', 'Glasses'],
  ['headphones', 'Headphones'],
  ['cap', 'Cap'],
  ['beanie', 'Beanie'],
  ['beard', 'Beard'],
];

function any<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

export function randomLook(): AgentLook {
  const extras: AgentLook['extras'] = [];
  if (Math.random() < 0.35) extras.push('glasses');
  if (Math.random() < 0.25) extras.push('headphones');
  if (Math.random() < 0.2) extras.push(any(['cap', 'beanie'] as const));
  if (Math.random() < 0.15) extras.push('beard');
  return {
    hair: any(HAIR_OPTIONS.slice(0, 6))[0],
    top: any(['tee', 'tee', 'hoodie', 'tie'] as const),
    height: any(['short', 'average', 'average', 'tall'] as const),
    extras,
    skin: any(OFFICE3D_SWATCHES.skin),
    hairColor: any(OFFICE3D_SWATCHES.hairColor.slice(0, 7)),
    shirt: any(OFFICE3D_SWATCHES.shirt),
    pants: any(OFFICE3D_SWATCHES.pants),
  };
}

/** Toggle an extra; only one hat at a time. */
export function toggleExtra(look: AgentLook, x: AgentLook['extras'][number]): AgentLook {
  if (look.extras.includes(x)) return { ...look, extras: look.extras.filter((e) => e !== x) };
  const hat = x === 'cap' || x === 'beanie';
  const rest = hat ? look.extras.filter((e) => e !== 'cap' && e !== 'beanie') : look.extras;
  return { ...look, extras: [...rest, x] };
}
