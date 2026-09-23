import { OPEN_FILE_RECENT_KEY, OPEN_FILE_RECENT_MAX } from './constants.js';
import { viewerKind } from './docViewer.js';

/**
 * Pure helpers for the Open file dialog (DOM-free apart from the guarded
 * localStorage accessors).
 */

/** Whether the viewer opens a file with this name. */
export function isOpenable(path: string): boolean {
  return viewerKind(path.trim()) !== 'unsupported';
}

/** "12 KB", "3.4 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The recent list with `path` first, no duplicates, bounded. */
export function withRecent(list: string[], path: string): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, OPEN_FILE_RECENT_MAX);
}

/** Recent files from storage; anything malformed reads as none. */
export function parseRecent(raw: string | null): string[] {
  try {
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value)
      ? value.filter((p): p is string => typeof p === 'string').slice(0, OPEN_FILE_RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

export function loadRecent(): string[] {
  try {
    return parseRecent(localStorage.getItem(OPEN_FILE_RECENT_KEY));
  } catch {
    return [];
  }
}

export function saveRecent(list: string[]): void {
  try {
    localStorage.setItem(OPEN_FILE_RECENT_KEY, JSON.stringify(list));
  } catch {
    /* private window or blocked storage: recents just aren't kept */
  }
}
