import * as fs from 'fs';

import type { ChatEntry } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { CHAT_ENTRY_MAX_CHARS, CHAT_HISTORY_LIMIT, CHAT_SEED_TAIL_BYTES } from './constants.js';
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

/** Fields of a transcript record the chat reads. */
interface ChatRecord {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { content?: unknown };
  content?: unknown;
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
        delta.entries.push({
          ...base,
          entryId: block.id,
          role: 'tool',
          text: clip(formatToolStatus(block.name ?? '', block.input ?? {})),
          toolDone: false,
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

/** Fold one parsed transcript record into the agent's chat and broadcast the changes. */
export function recordChat(
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
  record: unknown,
  formatToolStatus: FormatToolStatus,
): void {
  if (!record || typeof record !== 'object') return;
  const chatRecord = record as ChatRecord;
  if (chatRecord.type !== 'user' && chatRecord.type !== 'assistant') return;
  if (!belongsToAgent(agent, chatRecord)) return;
  const delta = extractChatDelta(chatRecord, formatToolStatus);
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
    applyDelta(agent, extractChatDelta(record, formatToolStatus), () => {});
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
