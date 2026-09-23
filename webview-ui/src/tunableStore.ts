import { TUNABLES_KEY } from './constants.js';
import type { TunableKey, TunableValues } from './tunables.js';
import { clampTunable, readTunables, tunableOverrides, TUNABLES } from './tunables.js';

/**
 * The live Settings → Advanced values, per viewer. Imperative code (engine,
 * renderer, pure helpers) calls `tunable(key)` at each use — never captured at
 * import — so a change applies on the next frame. React components subscribe
 * through `hooks/useTunables.ts`. Outside a browser (Node tests) every value is
 * its default.
 */

function load(): TunableValues {
  try {
    return readTunables(
      typeof localStorage === 'undefined' ? null : localStorage.getItem(TUNABLES_KEY),
    );
  } catch {
    return readTunables(null);
  }
}

let current: TunableValues = load();
const listeners = new Set<() => void>();

export function tunable(key: TunableKey): number {
  return current[key];
}

export function allTunables(): TunableValues {
  return current;
}

function commit(next: TunableValues): void {
  current = next;
  try {
    localStorage.setItem(TUNABLES_KEY, JSON.stringify(tunableOverrides(next)));
  } catch {
    /* blocked storage: the change applies for this visit only */
  }
  for (const l of listeners) l();
}

export function setTunable(key: TunableKey, value: number): void {
  commit({ ...current, [key]: clampTunable(TUNABLES[key], value) });
}

export function resetTunable(key: TunableKey): void {
  commit({ ...current, [key]: TUNABLES[key].default });
}

export function resetAllTunables(): void {
  commit(readTunables(null));
}

export function subscribeTunables(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
