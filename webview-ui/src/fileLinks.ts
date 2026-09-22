import { createContext } from 'react';

/**
 * File paths in chat text, so the office can open them in the document viewer.
 * Only paths the server can resolve on its own are links: absolute (`/Users/…`)
 * or home-relative (`~/…`), optionally `@`-mentioned, ending in an extension.
 * A relative path means nothing without the agent's folder, so it stays text.
 */

export type TextPart =
  { kind: 'text'; text: string } | { kind: 'file'; text: string; path: string };

const PATH_RE =
  /(^|[\s(["'])(@?)((?:~|\/)[^\s"'`<>()[\]]*\.[A-Za-z0-9]{1,8})(?=$|[\s)\]"',;:!?.])/g;
/** Sentence punctuation the path can't end with. */
const TRAILING_RE = /[.,;:!?]+$/;

/** Split text into plain runs and file paths. */
export function splitFilePaths(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (let m = PATH_RE.exec(text); m; m = PATH_RE.exec(text)) {
    const path = m[3].replace(TRAILING_RE, '');
    if (!/\.[A-Za-z0-9]{1,8}$/.test(path) || path.includes('//')) continue;
    const start = m.index + m[1].length;
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) });
    const shown = m[2] + path;
    parts.push({ kind: 'file', text: shown, path });
    last = start + shown.length;
  }
  PATH_RE.lastIndex = 0;
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

/** The whole text is one path (an inline `code` span naming a file). */
export function asFilePath(text: string): string | null {
  const parts = splitFilePaths(text.trim());
  return parts.length === 1 && parts[0].kind === 'file' ? parts[0].path : null;
}

/** Opens a path in the document viewer; null where files can't be viewed (VS Code panel). */
export const OpenFileContext = createContext<((path: string) => void) | null>(null);
