/**
 * Viewer text settings: how big the office's text is and which face it reads in.
 * Pure (DOM-free) so it runs under the Node test runner; `hooks/useTextPrefs.ts`
 * owns storage and applies the result to `document.documentElement`.
 *
 * Two faces, two jobs (see index.css): the INTERFACE face draws chrome — toolbars,
 * labels, buttons, meta lines — and stays the pixel font by default; the READING
 * face draws what agents and people wrote — chat and Messenger bodies, long
 * descriptions — and is the system sans by default.
 */

import { TEXT_SIZE_SCALES } from './constants.js';

export type TextSize = keyof typeof TEXT_SIZE_SCALES;
export type ReadingFont = 'pixel' | 'sans' | 'serif' | 'mono';
export type UiFont = 'pixel' | 'system';

export interface TextPrefs {
  size: TextSize;
  readingFont: ReadingFont;
  uiFont: UiFont;
}

export const DEFAULT_TEXT_PREFS: TextPrefs = {
  size: 'normal',
  readingFont: 'sans',
  uiFont: 'system',
};

export const TEXT_SIZES: ReadonlyArray<{ id: TextSize; label: string; short: string }> = [
  { id: 'small', label: 'Small', short: 'S' },
  { id: 'normal', label: 'Normal', short: 'M' },
  { id: 'large', label: 'Large', short: 'L' },
  { id: 'xlarge', label: 'Extra large', short: 'XL' },
];

export const READING_FONTS: ReadonlyArray<{ id: ReadingFont; label: string }> = [
  { id: 'sans', label: 'Sans' },
  { id: 'serif', label: 'Serif' },
  { id: 'mono', label: 'Mono' },
  { id: 'pixel', label: 'Pixel' },
];

export const UI_FONTS: ReadonlyArray<{ id: UiFont; label: string }> = [
  { id: 'system', label: 'Modern' },
  { id: 'pixel', label: 'Pixel' },
];

/**
 * Faces differ in how big they look at the same px: FS Pixel Sans draws small
 * for its em, so the chrome scale (tuned for it) shrinks for a system face and the
 * reading scale (tuned for a system face) grows for the pixel one. Families are
 * named by their CSS stack variable (index.css) so no font stack lives in JS.
 */
const UI_FACE: Record<UiFont, { stack: string; k: number }> = {
  pixel: { stack: 'var(--font-stack-pixel)', k: 1 },
  system: { stack: 'var(--font-stack-sans)', k: 0.66 },
};

const READING_FACE: Record<ReadingFont, { stack: string; k: number }> = {
  sans: { stack: 'var(--font-stack-sans)', k: 1 },
  serif: { stack: 'var(--font-stack-serif)', k: 1.07 },
  mono: { stack: 'var(--font-stack-mono)', k: 0.93 },
  pixel: { stack: 'var(--font-stack-pixel)', k: 1.33 },
};

function isSize(v: unknown): v is TextSize {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(TEXT_SIZE_SCALES, v);
}

function isReadingFont(v: unknown): v is ReadingFont {
  return v === 'pixel' || v === 'sans' || v === 'serif' || v === 'mono';
}

function isUiFont(v: unknown): v is UiFont {
  return v === 'pixel' || v === 'system';
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const p: unknown = JSON.parse(raw);
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Stored text prefs, each field falling back to its default when missing or
 * malformed. With nothing stored yet, the Messenger's old reading settings
 * (`legacyMessengerRaw`: it had its own "Message font" and "Text size") seed
 * the answer once, so a viewer who picked Pixel or Large there keeps it.
 */
export function readTextPrefs(raw: string | null, legacyMessengerRaw?: string | null): TextPrefs {
  const p = parseObject(raw);
  if (p) {
    return {
      size: isSize(p.size) ? p.size : DEFAULT_TEXT_PREFS.size,
      readingFont: isReadingFont(p.readingFont) ? p.readingFont : DEFAULT_TEXT_PREFS.readingFont,
      uiFont: isUiFont(p.uiFont) ? p.uiFont : DEFAULT_TEXT_PREFS.uiFont,
    };
  }
  const legacy = parseObject(legacyMessengerRaw ?? null);
  return {
    ...DEFAULT_TEXT_PREFS,
    ...(legacy?.font === 'pixel' ? { readingFont: 'pixel' as const } : {}),
    ...(legacy?.size === 'large' ? { size: 'large' as const } : {}),
  };
}

/** The CSS custom properties (set on :root) that carry `prefs` into every token. */
export function textPrefsCssVars(prefs: TextPrefs): Record<string, string> {
  const ui = UI_FACE[prefs.uiFont];
  const reading = READING_FACE[prefs.readingFont];
  return {
    '--font-scale': String(TEXT_SIZE_SCALES[prefs.size]),
    '--font-ui': ui.stack,
    '--font-ui-k': String(ui.k),
    '--font-read': reading.stack,
    '--font-read-k': String(reading.k),
  };
}
