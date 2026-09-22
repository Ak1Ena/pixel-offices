import * as fs from 'fs';

import type { ChatEdit, ChatEntry } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  CHAT_EDIT_MAX_CHARS,
  CHAT_ENTRY_MAX_CHARS,
  CHAT_HISTORY_LIMIT,
  CHAT_SEED_TAIL_BYTES,
} from './constants.js';
import { usageOf } from './tokenUsage.js';
import type { AgentState } from './types.js';

/**
 * Session chat — the conversation shown in the office's chat card.
 *
 * Built from the transcript the runtime already reads in both modes, so no
 * extra hook (and no prompt text over HTTP) is needed. Each agent keeps a
 * bounded log; every change is broadcast as an upserting `agentChatEntry`.
 */

type FormatToolStatus = (toolName: string, input: Record<string, unknown>) => string;
/** The provider's describeEdit: what a file-editing tool call changes. */
export type DescribeEdit = (toolName: string, input: Record<string, unknown>) => ChatEdit | null;

/** Fields of a transcript record the chat reads. */
interface ChatRecord {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { content?: unknown };
  content?: unknown;
  /** Claude Code's structured tool result; `bashEditDiff` lists files a Bash command changed. */
  toolUseResult?: unknown;
}

interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
}

/** What one record contributes: new entries, and tool rows that finished. */
export interface ChatDelta {
  entries: ChatEntry[];
  doneToolIds: string[];
}

const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
/** Harness-injected user text that the person never typed. */
const HIDDEN_USER_TEXT_PREFIXES = [
  '<local-command-',
  '<system-reminder>',
  '<bash-',
  '<task-notification>',
  'Caveat: ',
];

function clip(text: string): string {
  return text.length > CHAT_ENTRY_MAX_CHARS ? `${text.slice(0, CHAT_ENTRY_MAX_CHARS)}…` : text;
}

/**
 * Bound an edit for the wire: CHAT_EDIT_MAX_CHARS shared by every hunk side,
 * in order, so a huge Write can't crowd the log. Empty edits are dropped.
 */
export function clipEdit(edit: ChatEdit | null | undefined): ChatEdit | undefined {
  if (!edit || edit.hunks.every((h) => !h.removed && !h.added)) return undefined;
  let budget = CHAT_EDIT_MAX_CHARS;
  let clipped = false;
  const take = (text: string): string => {
    if (text.length <= budget) {
      budget -= text.length;
      return text;
    }
    clipped = true;
    const kept = text.slice(0, Math.max(0, budget));
    budget = 0;
    return kept;
  };
  const hunks = edit.hunks.map((h) => ({ removed: take(h.removed), added: take(h.added) }));
  return { path: edit.path, kind: edit.kind, hunks, ...(clipped ? { clipped: true } : {}) };
}

/** Visible text of a typed prompt, or null when the harness wrote it. */
export function userPromptText(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const command = COMMAND_NAME_RE.exec(text);
  if (command) {
    const args = COMMAND_ARGS_RE.exec(text)?.[1]?.trim();
    return args ? `${command[1].trim()} ${args}` : command[1].trim();
  }
  if (HIDDEN_USER_TEXT_PREFIXES.some((prefix) => text.startsWith(prefix))) return null;
  return text;
}

/**
 * Chat content of one transcript record. Pure: the caller decides whether the
 * record belongs to this agent (sidechain rule) and where entries go.
 */
export function extractChatDelta(
  record: ChatRecord,
  formatToolStatus: FormatToolStatus,
  describeEdit?: DescribeEdit,
): ChatDelta {
  const delta: ChatDelta = { entries: [], doneToolIds: [] };
  if (record.isMeta) return delta;
  const content = record.message?.content ?? record.content;
  const base = { timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined };

  if (record.type === 'user') {
    if (typeof content === 'string') {
      const text = userPromptText(content);
      if (text && record.uuid) {
        delta.entries.push({ ...base, entryId: record.uuid, role: 'user', text: clip(text) });
      }
      return delta;
    }
    if (!Array.isArray(content)) return delta;
    const blocks = content as ContentBlock[];
    const parts: string[] = [];
    for (const block of blocks) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        delta.doneToolIds.push(block.tool_use_id);
      } else if (block.type === 'text' && typeof block.text === 'string') {
        const text = userPromptText(block.text);
        if (text) parts.push(text);
      } else if (block.type === 'image') {
        parts.push('[image]');
      }
    }
    delta.entries.push(...bashEditEntries(record, base, delta.doneToolIds[0]));
    if (parts.length > 0 && record.uuid && delta.doneToolIds.length === 0) {
      delta.entries.push({
        ...base,
        entryId: record.uuid,
        role: 'user',
        text: clip(parts.join('\n')),
      });
    }
    return delta;
  }

  if (record.type === 'assistant') {
    if (typeof content === 'string') {
      if (content.trim() && record.uuid) {
        delta.entries.push({
          ...base,
          entryId: record.uuid,
          role: 'assistant',
          text: clip(content.trim()),
        });
      }
      return delta;
    }
    if (!Array.isArray(content)) return delta;
    const texts: string[] = [];
    for (const block of content as ContentBlock[]) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        texts.push(block.text.trim());
      } else if (block.type === 'tool_use' && block.id) {
        const edit = clipEdit(describeEdit?.(block.name ?? '', block.input ?? {}));
        delta.entries.push({
          ...base,
          entryId: block.id,
          role: 'tool',
          text: clip(formatToolStatus(block.name ?? '', block.input ?? {})),
          toolDone: false,
          ...(edit ? { edit } : {}),
        });
      }
    }
    if (texts.length > 0 && record.uuid) {
      // Text first: the model writes its sentence before calling the tool.
      const usage = usageOf(record);
      delta.entries.unshift({
        ...base,
        entryId: record.uuid,
        role: 'assistant',
        text: clip(texts.join('\n\n')),
        ...(usage ? { usage } : {}),
      });
    }
  }
  return delta;
}

interface UnifiedHunk {
  oldLines?: number;
  lines?: unknown;
}

/**
 * Files a Bash command changed (`sed -i`, a heredoc, a script), which Claude
 * Code diffs and records as `toolUseResult.bashEditDiff` — the terminal shows
 * them as "Created x (+37 -0)". Each file becomes its own tool row carrying an
 * edit, right after the command's row, so Messages draws the same diff card
 * as for Edit/Write. Each run of changed lines is one hunk, with the context
 * line on either side.
 */
function bashEditEntries(
  record: ChatRecord,
  base: { timestamp?: string },
  toolId: string | undefined,
): ChatEntry[] {
  const result = record.toolUseResult as { bashEditDiff?: { files?: unknown } } | undefined;
  const files = result?.bashEditDiff?.files;
  if (!toolId || !Array.isArray(files)) return [];
  const entries: ChatEntry[] = [];
  files.forEach((raw, index) => {
    const file = raw as { filePath?: unknown; hunks?: unknown };
    if (typeof file.filePath !== 'string' || !Array.isArray(file.hunks)) return;
    const hunks: ChatEdit['hunks'] = [];
    let created = file.hunks.length > 0;
    for (const h of file.hunks as UnifiedHunk[]) {
      if (h.oldLines !== 0) created = false;
      const lines = Array.isArray(h.lines) ? h.lines.filter((l) => typeof l === 'string') : [];
      let i = 0;
      while (i < lines.length) {
        if (!/^[-+]/.test(lines[i])) {
          i++;
          continue;
        }
        const before = i > 0 && lines[i - 1].startsWith(' ') ? [lines[i - 1].slice(1)] : [];
        const removed: string[] = [];
        const added: string[] = [];
        while (i < lines.length && /^[-+]/.test(lines[i])) {
          (lines[i][0] === '-' ? removed : added).push(lines[i].slice(1));
          i++;
        }
        const after = i < lines.length && lines[i].startsWith(' ') ? [lines[i].slice(1)] : [];
        hunks.push({
          removed: [...before, ...removed, ...after].join('\n'),
          added: [...before, ...added, ...after].join('\n'),
        });
      }
    }
    const edit = clipEdit({ path: file.filePath, kind: created ? 'write' : 'edit', hunks });
    if (!edit) return;
    const name = file.filePath.split(/[\\/]/).pop() ?? file.filePath;
    entries.push({
      ...base,
      entryId: `${toolId}:file:${index}`,
      role: 'tool',
      text: `${created ? 'Created' : 'Changed'} ${name}`,
      toolDone: true,
      edit,
    });
  });
  return entries;
}

/**
 * Sidechain rule (same shape as the context gauge's): a lead's sidechain
 * records are its sub-agents talking and stay out of its chat; a teammate's
 * own transcript is sidechain top to bottom and must still show. Latch on the
 * first main-chain record.
 */
function belongsToAgent(agent: AgentState, record: ChatRecord): boolean {
  if (record.isSidechain !== true) {
    agent.sawMainChainChat = true;
    return true;
  }
  return !agent.sawMainChainChat;
}

/** Office-typed prompts come back through the transcript; tag them by text. */
function sourceFor(agent: AgentState, text: string): 'office' | 'terminal' {
  const pending = agent.pendingOfficeTexts;
  if (pending) {
    const index = pending.indexOf(text.trim());
    if (index !== -1) {
      pending.splice(index, 1);
      return 'office';
    }
  }
  return 'terminal';
}

/** Called with every NEW assistant reply streamed from a transcript (not seeded history). */
let replyListener: ((agentId: number, text: string) => void) | null = null;

export function setReplyListener(listener: typeof replyListener): void {
  replyListener = listener;
}

function applyDelta(
  agent: AgentState,
  delta: ChatDelta,
  onChange: (entry: ChatEntry) => void,
  live = false,
): void {
  const log = (agent.chatLog ??= []);
  for (const entry of delta.entries) {
    if (entry.role === 'user') entry.source = sourceFor(agent, entry.text);
    const existing = log.findIndex((e) => e.entryId === entry.entryId);
    if (existing !== -1) {
      log[existing] = entry;
    } else {
      if (live && entry.role === 'assistant') replyListener?.(agent.id, entry.text);
      log.push(entry);
      if (log.length > CHAT_HISTORY_LIMIT) log.splice(0, log.length - CHAT_HISTORY_LIMIT);
    }
    onChange(entry);
  }
  for (const toolId of delta.doneToolIds) {
    const entry = log.find((e) => e.entryId === toolId && e.role === 'tool');
    if (entry && !entry.toolDone) {
      entry.toolDone = true;
      onChange(entry);
    }
  }
}

/**
 * Fold chat that a provider read from its OWN transcript (a hooks-only CLI,
 * see HookProvider.chatTranscript) into the agent's chat and broadcast the
 * changes. `live` = newly written, so the @mention relay may pass it on.
 */
export function applyChatDelta(
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
  delta: ChatDelta,
  live: boolean,
): void {
  applyDelta(
    agent,
    delta,
    (entry) => agents.broadcast({ type: 'agentChatEntry', id: agentId, entry: { ...entry } }),
    live,
  );
}

/** Fold one parsed transcript record into the agent's chat and broadcast the changes. */
export function recordChat(
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
  record: unknown,
  formatToolStatus: FormatToolStatus,
  describeEdit?: DescribeEdit,
): void {
  if (!record || typeof record !== 'object') return;
  const chatRecord = record as ChatRecord;
  if (chatRecord.type !== 'user' && chatRecord.type !== 'assistant') return;
  if (!belongsToAgent(agent, chatRecord)) return;
  const delta = extractChatDelta(chatRecord, formatToolStatus, describeEdit);
  applyDelta(
    agent,
    delta,
    (entry) => {
      agents.broadcast({ type: 'agentChatEntry', id: agentId, entry: { ...entry } });
    },
    true,
  );
}

/**
 * Give an agent adopted or restored mid-session its recent chat. Reads the
 * transcript tail BEFORE `fileOffset` only — everything after it streams
 * through `recordChat` — so nothing is shown twice. Runs once per agent.
 */
export function seedChatHistory(
  agentId: number,
  agents: AgentStateStore,
  formatToolStatus: FormatToolStatus,
  describeEdit?: DescribeEdit,
): void {
  const agent = agents.get(agentId);
  if (!agent || agent.chatLog || !agent.jsonlFile) return;
  agent.chatLog = [];
  const end = agent.fileOffset;
  if (end <= 0) return;

  let text: string;
  try {
    const start = Math.max(0, end - CHAT_SEED_TAIL_BYTES);
    const fd = fs.openSync(agent.jsonlFile, 'r');
    try {
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    // A mid-file start lands inside a record; drop that fragment.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch {
    return; // unreadable transcript -- the chat fills from the next turn
  }

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: ChatRecord;
    try {
      record = JSON.parse(line) as ChatRecord;
    } catch {
      continue;
    }
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    if (!belongsToAgent(agent, record)) continue;
    applyDelta(agent, extractChatDelta(record, formatToolStatus, describeEdit), () => {});
  }
  // A seeded tool row with no result in the tail is from an earlier turn, not live.
  for (const entry of agent.chatLog) {
    if (entry.role === 'tool' && !entry.toolDone && !agent.activeToolIds.has(entry.entryId)) {
      entry.toolDone = true;
    }
  }
  if (agent.chatLog.length > 0) {
    agents.broadcast({
      type: 'agentChatHistory',
      id: agentId,
      entries: agent.chatLog.map((e) => ({ ...e })),
    });
  }
}
