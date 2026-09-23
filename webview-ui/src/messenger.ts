import type { ChatEntry } from '../../core/src/messages.js';

/**
 * Pure helpers for the Messenger (DOM-free, Node-testable): grouping tool rows
 * into one "N steps" line, a small markdown reader for replies, the chat's
 * outline, and the reader's own settings.
 */

export type MessengerBlock =
  | { kind: 'message'; entry: ChatEntry }
  | { kind: 'steps'; id: string; entries: ChatEntry[] }
  | { kind: 'edit'; entry: ChatEntry };

/** Runs of tool rows become one foldable "steps" block; a file edit stands on its own. */
export function groupEntries(entries: ChatEntry[]): MessengerBlock[] {
  const blocks: MessengerBlock[] = [];
  for (const entry of entries) {
    if (entry.role === 'tool' && entry.edit) {
      blocks.push({ kind: 'edit', entry });
    } else if (entry.role === 'tool') {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'steps') last.entries.push(entry);
      else blocks.push({ kind: 'steps', id: entry.entryId, entries: [entry] });
    } else {
      blocks.push({ kind: 'message', entry });
    }
  }
  return blocks;
}

/** "Read ×3 · Edit ×1": the tools in a steps block, by the first word of each row. */
export function stepCounts(entries: ChatEntry[]): Array<{ tool: string; count: number }> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const tool = /^[A-Za-z][\w-]*/.exec(e.text.trim())?.[0] ?? 'Tool';
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  return [...counts].map(([tool, count]) => ({ tool, count }));
}

export type MdInline =
  { kind: 'text'; text: string } | { kind: 'code'; text: string } | { kind: 'bold'; text: string };

export type MdBlock =
  | { kind: 'para'; lines: MdInline[][] }
  | { kind: 'heading'; level: number; inline: MdInline[] }
  | { kind: 'list'; ordered: boolean; items: MdInline[][] }
  | { kind: 'code'; lang: string; text: string };

/** `code` and **bold** inside a line; everything else is plain text. */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[1] });
    else out.push({ kind: 'bold', text: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/**
 * Just enough markdown for agent replies: fenced code, headings, bullet and
 * numbered lists, paragraphs. Never produces HTML — the Messenger renders
 * these blocks as React elements, so reply text can't inject markup.
 */
export function parseMarkdown(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  const flushPara = () => {
    if (para.length > 0) blocks.push({ kind: 'para', lines: para.map(parseInline) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      blocks.push({ kind: 'code', lang: fence[1], text: body.join('\n') });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ kind: 'heading', level: heading[1].length, inline: parseInline(heading[2]) });
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      const ordered = item[2] !== undefined;
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(parseInline(item[3]));
      else blocks.push({ kind: 'list', ordered, items: [parseInline(item[3])] });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    // A continuation line indented under a list item belongs to that item.
    const last = blocks[blocks.length - 1];
    if (para.length === 0 && last?.kind === 'list' && /^\s{2,}\S/.test(line)) {
      last.items[last.items.length - 1].push({ kind: 'text', text: ` ${line.trim()}` });
      continue;
    }
    para.push(line);
  }
  flushPara();
  return blocks;
}

/** The user's prompts, as an outline to jump through. */
export function chatOutline(
  entries: ChatEntry[],
  max = 12,
): Array<{ entryId: string; label: string; timestamp?: string }> {
  return entries
    .filter((e) => e.role === 'user' && e.text.trim())
    .slice(-max)
    .map((e) => ({
      entryId: e.entryId,
      label: e.text.trim().split('\n')[0].slice(0, 48),
      timestamp: e.timestamp,
    }));
}

/**
 * The Messenger's own reading settings. Its face and size used to live here too
 * ("Message font", "Text size"); they are the viewer-wide text settings now
 * (textPrefs.ts), which the Messenger's menu edits in place, so Settings and the
 * Messenger can't disagree. `readTextPrefs` reads the old fields once to seed them.
 */
export interface ReadingPrefs {
  foldSteps: boolean;
  timestamps: boolean;
}

export const DEFAULT_READING_PREFS: ReadingPrefs = {
  foldSteps: true,
  timestamps: true,
};

/** Stored prefs, with anything missing or malformed falling back to the default. */
export function readPrefs(raw: string | null): ReadingPrefs {
  if (!raw) return { ...DEFAULT_READING_PREFS };
  try {
    const p = JSON.parse(raw) as Partial<Record<keyof ReadingPrefs, unknown>> | null;
    return {
      foldSteps: typeof p?.foldSteps === 'boolean' ? p.foldSteps : true,
      timestamps: typeof p?.timestamps === 'boolean' ? p.timestamps : true,
    };
  } catch {
    return { ...DEFAULT_READING_PREFS };
  }
}

export type DiffRow = { kind: 'ctx' | 'del' | 'add'; text: string };

/**
 * One hunk as diff rows. Not a real diff: the lines both sides share at the
 * start and end are trimmed to one line of context, and what's left shows as
 * removed-then-added — Edit's old/new strings are already small and local.
 */
export function editRows(removed: string, added: string): DiffRow[] {
  const split = (t: string) => (t === '' ? [] : t.replace(/\r\n?/g, '\n').split('\n'));
  const del = split(removed);
  const add = split(added);
  let head = 0;
  while (head < del.length && head < add.length && del[head] === add[head]) head++;
  let tail = 0;
  while (
    tail < del.length - head &&
    tail < add.length - head &&
    del[del.length - 1 - tail] === add[add.length - 1 - tail]
  ) {
    tail++;
  }
  const rows: DiffRow[] = [];
  if (head > 0) rows.push({ kind: 'ctx', text: del[head - 1] });
  for (const text of del.slice(head, del.length - tail)) rows.push({ kind: 'del', text });
  for (const text of add.slice(head, add.length - tail)) rows.push({ kind: 'add', text });
  if (tail > 0) rows.push({ kind: 'ctx', text: del[del.length - tail] });
  return rows;
}

/** "+12 −3" for an edit's header. */
export function editCounts(hunks: Array<{ removed: string; added: string }>): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const row of editRows(h.removed, h.added)) {
      if (row.kind === 'add') added++;
      else if (row.kind === 'del') removed++;
    }
  }
  return { added, removed };
}
