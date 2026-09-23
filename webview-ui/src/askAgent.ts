import type { ChatEntry } from '../../core/src/messages.js';
import { DOC_CHAT_AGENTS_KEY, DOC_CHAT_RECENT_ENTRIES } from './constants.js';
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

/**
 * A follow-up in a document chat: the text plus the places picked since the
 * last message. The first message to an agent about a file always names the
 * file (askMessage); later ones only add picks, the agent already knows it.
 */
export function followUpMessage(text: string, refs: DocRef[]): string {
  return withRefs(text.trim(), refs);
}

/** What a document chat shows: the newest entries (tool rows included, drawn compactly). */
export function recentEntries(
  entries: ChatEntry[],
  showAll: boolean,
): { shown: ChatEntry[]; hidden: number } {
  if (showAll || entries.length <= DOC_CHAT_RECENT_ENTRIES) return { shown: entries, hidden: 0 };
  return {
    shown: entries.slice(-DOC_CHAT_RECENT_ENTRIES),
    hidden: entries.length - DOC_CHAT_RECENT_ENTRIES,
  };
}

/** The agent a document's chat talks to, remembered per file path; malformed reads as none. */
export function parseDocChatAgents(raw: string | null): Record<string, number> {
  try {
    const value: unknown = raw ? JSON.parse(raw) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, number> = {};
    for (const [path, id] of Object.entries(value as Record<string, unknown>)) {
      if (Number.isInteger(id)) out[path] = id as number;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadDocChatAgent(path: string): number | undefined {
  try {
    return parseDocChatAgents(localStorage.getItem(DOC_CHAT_AGENTS_KEY))[path];
  } catch {
    return undefined;
  }
}

export function saveDocChatAgent(path: string, agentId: number): void {
  try {
    const all = parseDocChatAgents(localStorage.getItem(DOC_CHAT_AGENTS_KEY));
    all[path] = agentId;
    localStorage.setItem(DOC_CHAT_AGENTS_KEY, JSON.stringify(all));
  } catch {
    /* private window or blocked storage: the choice just isn't remembered */
  }
}

/** A newly started agent: the one id present now that wasn't before. */
export function newAgentId(before: number[], now: number[]): number | undefined {
  const known = new Set(before);
  const fresh = now.filter((id) => !known.has(id));
  return fresh.length === 1 ? fresh[0] : undefined;
}
