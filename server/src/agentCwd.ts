import * as fs from 'fs';

import type { AgentStateStore } from './agentStateStore.js';
import { AGENT_CWD_SEED_BYTES } from './constants.js';

/**
 * The folder an agent's session works in.
 *
 * `projectDir` can't answer this: it is the transcript folder, whose name is
 * the working folder with every separator turned into `-` (`my-app` and
 * `my/app` encode the same). The transcript itself can — Claude stamps `cwd`
 * on its records — and so can a hook event or the launcher, which set
 * `agent.cwd` where they adopt the session.
 */

/** `cwd` from one parsed transcript record, or undefined. */
export function cwdFromRecord(record: unknown): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const cwd = (record as { cwd?: unknown }).cwd;
  return typeof cwd === 'string' && cwd.length > 0 && cwd.length <= 4096 ? cwd : undefined;
}

function cwdFromChunk(text: string, newestFirst: boolean): string | undefined {
  const lines = text.split('\n');
  if (newestFirst) lines.reverse();
  for (const line of lines) {
    if (!line.includes('"cwd"')) continue;
    try {
      const cwd = cwdFromRecord(JSON.parse(line));
      if (cwd) return cwd;
    } catch {
      /* a fragment at the chunk's edge */
    }
  }
  return undefined;
}

function readChunk(file: string, start: number, length: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Seed `agent.cwd` when watching starts. Agents adopted or restored
 * mid-session begin at end-of-file, so without this their folder would stay
 * unknown until their next turn. Newest record wins (the tail), then the head.
 */
export function seedAgentCwd(agentId: number, agents: AgentStateStore): void {
  const agent = agents.get(agentId);
  if (!agent || agent.cwd || !agent.jsonlFile) return;
  try {
    const size = fs.statSync(agent.jsonlFile).size;
    if (size <= 0) return;
    const length = Math.min(size, AGENT_CWD_SEED_BYTES);
    agent.cwd =
      cwdFromChunk(readChunk(agent.jsonlFile, size - length, length), true) ??
      (size > length ? cwdFromChunk(readChunk(agent.jsonlFile, 0, length), false) : undefined);
  } catch {
    /* unreadable transcript: the stream sets it on the next record */
  }
}
