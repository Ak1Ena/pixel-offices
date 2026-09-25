import * as fs from 'fs';

import type { AgentStateStore } from './agentStateStore.js';
import { CONTEXT_SEED_TAIL_BYTES, TEXT_IDLE_DELAY_MS } from './constants.js';
import { isInterruptRecord, isLocalCommandRecord } from './transcriptParser.js';

interface SeedRecord {
  type?: string;
  subtype?: string;
  isSidechain?: boolean;
  message?: { content?: unknown };
}

/**
 * Where the transcript's tail leaves the session: at its prompt ('idle'),
 * mid-turn ('busy'), or unknown (null — leave the agent as it is).
 *
 * `missing` = no transcript yet: a session the office started without a first
 * message sits at its prompt until someone types into it.
 */
export function transcriptTailState(text: string | null, ageMs: number): 'idle' | 'busy' | null {
  if (text === null) return 'idle';
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let record: SeedRecord;
    try {
      record = JSON.parse(line) as SeedRecord;
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object' || record.isSidechain === true) continue;
    if (record.type === 'system') {
      if (record.subtype === 'turn_duration') return 'idle';
      continue;
    }
    const content = record.message?.content;
    if (record.type === 'user') {
      if (isInterruptRecord(content) || isLocalCommandRecord(content)) return 'idle';
      return 'busy';
    }
    if (record.type === 'assistant') {
      const hasToolUse =
        Array.isArray(content) && content.some((b: { type?: unknown }) => b?.type === 'tool_use');
      if (hasToolUse) return 'busy';
      // A text-only reply ends its turn without a turn_duration record; the
      // live parser waits TEXT_IDLE_DELAY_MS of silence before calling it idle.
      return ageMs >= TEXT_IDLE_DELAY_MS ? 'idle' : null;
    }
    // Any other record type (snapshots, titles, queue operations) says nothing.
  }
  return null;
}

/**
 * Agents start "working" (isWaiting false, and the webview's characters start
 * active) and only a turn END marks them idle. An agent adopted or restored
 * while it sits at its prompt — or started by the office with no first message,
 * so it has no transcript at all — never has that turn end, and showed
 * "Thinking" for good. Read the transcript's tail once and say so.
 */
export function seedIdleState(agentId: number, agents: AgentStateStore): void {
  const agent = agents.get(agentId);
  if (!agent || agent.isWaiting || agent.permissionSent || agent.activeToolIds.size > 0) return;
  if (!agent.jsonlFile) return;

  let text: string | null = null;
  let ageMs = 0;
  try {
    const stat = fs.statSync(agent.jsonlFile);
    ageMs = Date.now() - stat.mtimeMs;
    const start = Math.max(0, stat.size - CONTEXT_SEED_TAIL_BYTES);
    const length = stat.size - start;
    if (length <= 0) {
      text = null;
    } else {
      const fd = fs.openSync(agent.jsonlFile, 'r');
      try {
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, start);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    }
  } catch (err) {
    // No transcript yet (a session that has had no prompt) = at its prompt.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return;
    text = null;
  }

  if (transcriptTailState(text, ageMs) !== 'idle') return;
  agent.isWaiting = true;
  agents.broadcast({ type: 'agentStatus', id: agentId, status: 'waiting', seeded: true });
}
