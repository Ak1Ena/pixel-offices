import { useSyncExternalStore } from 'react';

import { MESSENGER_PREFS_KEY, TEXT_PREFS_KEY } from '../constants.js';
import type { TextPrefs } from '../textPrefs.js';
import { readTextPrefs, textPrefsCssVars } from '../textPrefs.js';

/**
 * One store for the viewer's text settings, shared by Settings and the
 * Messenger's reading menu so the two controls can never disagree.
 * Per viewer: localStorage, every access wrapped (private windows throw).
 */

function load(): TextPrefs {
  try {
    const raw = localStorage.getItem(TEXT_PREFS_KEY);
    const legacy = localStorage.getItem(MESSENGER_PREFS_KEY);
    const prefs = readTextPrefs(raw, legacy);
    // Seeded from the Messenger's old settings: keep the seed, since the
    // Messenger's next save drops the old fields it came from.
    if (raw === null && legacy !== null)
      localStorage.setItem(TEXT_PREFS_KEY, JSON.stringify(prefs));
    return prefs;
  } catch {
    return readTextPrefs(null);
  }
}

let current: TextPrefs = load();
const listeners = new Set<() => void>();

/** Write the prefs into :root's custom properties (index.css reads them). */
export function applyTextPrefs(prefs: TextPrefs = current): void {
  if (typeof document === 'undefined') return;
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(textPrefsCssVars(prefs))) {
    style.setProperty(name, value);
  }
}

export function setTextPrefs(patch: Partial<TextPrefs>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(TEXT_PREFS_KEY, JSON.stringify(current));
  } catch {
    /* blocked storage: the change applies for this visit only */
  }
  applyTextPrefs(current);
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTextPrefs(): [TextPrefs, (patch: Partial<TextPrefs>) => void] {
  const prefs = useSyncExternalStore(subscribe, () => current);
  return [prefs, setTextPrefs];
}
