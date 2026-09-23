import type { DocRef } from './docViewer.js';
import { withRefs } from './docViewer.js';

/**
 * Pure helpers for "Ask an agent" in the document viewer (DOM-free).
 */

export interface AskAgent {
  id: number;
  label: string;
  /** Mid-turn: a question is queued until its turn ends. */
  busy: boolean;
  /** The agent works in (a folder above) the file's folder. */
  inFolder: boolean;
}

/** The folder a file is in ("" for a bare name). */
export function fileFolder(filePath: string): string {
  const trimmed = filePath.trim().replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut > 0 ? trimmed.slice(0, cut) : '';
}

/** Whether `filePath` sits inside `root` (both absolute, as the server resolves them). */
export function isInFolder(filePath: string, root: string | undefined): boolean {
  if (!root) return false;
  const base = root.replace(/[\\/]+$/, '');
  return filePath === base || filePath.startsWith(`${base}/`) || filePath.startsWith(`${base}\\`);
}

/** Who to offer first: agents in the file's folder, then idle ones, then by name. */
export function rankAgents(agents: AskAgent[]): AskAgent[] {
  return [...agents].sort(
    (a, b) =>
      Number(b.inFolder) - Number(a.inFolder) ||
      Number(a.busy) - Number(b.busy) ||
      a.label.localeCompare(b.label),
  );
}

/**
 * The message an agent gets: the question and references to the picked places
 * — or to the whole file when nothing was picked. Never the document's text.
 */
export function askMessage(question: string, refs: DocRef[], filePath: string): string {
  const places = refs.length > 0 ? refs : [{ path: filePath }];
  const text = question.trim() || 'Can you help me with this?';
  return withRefs(text, places);
}
