import * as fs from 'fs';
import * as path from 'path';

import type { PastSession } from '../../core/src/messages.js';
import {
  PAST_SESSION_TITLE_MAX_CHARS,
  PAST_SESSIONS_MAX,
  PAST_SESSIONS_READ_BYTES,
} from './constants.js';

/**
 * A folder's earlier Claude sessions, newest first, for "+ Agent → Resume".
 * Each transcript is read only at its head and tail: the title Claude gave
 * the session (`ai-title`, or the name the user set, `agent-name`) sits near
 * the end, the first prompt near the start.
 */
const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
/** Harness-written user text (command output, reminders): never a session's first prompt. */
const HARNESS_TEXT_RE = /^\s*(<[a-z-]+>|Caveat:)/;

function readChunk(file: string, from: 'head' | 'tail', size: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const length = fs.fstatSync(fd).size;
    const start = from === 'head' ? 0 : Math.max(0, length - size);
    const buffer = Buffer.alloc(Math.min(size, length - start));
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function records(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue; // a chunk's cut first line
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* partial line */
    }
  }
  return out;
}

function promptText(record: Record<string, unknown>): string {
  if (record.type !== 'user' || record.isSidechain === true || record.isMeta === true) return '';
  const content = (record.message as { content?: unknown } | undefined)?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((b: { type?: unknown; text?: unknown }) =>
              b?.type === 'text' && typeof b.text === 'string' ? b.text : '',
            )
            .join(' ')
        : '';
  return HARNESS_TEXT_RE.test(text) ? '' : text.replace(/\s+/g, ' ').trim();
}

/** One transcript's summary, or null when it holds no conversation. */
export function describeSession(file: string): PastSession | null {
  const name = path.basename(file);
  if (!SESSION_FILE_RE.test(name)) return null;
  let mtime: Date;
  try {
    mtime = fs.statSync(file).mtime;
  } catch {
    return null;
  }
  const head = records(readChunk(file, 'head', PAST_SESSIONS_READ_BYTES));
  const tail = records(readChunk(file, 'tail', PAST_SESSIONS_READ_BYTES));
  const firstPrompt = head.map(promptText).find(Boolean) ?? tail.map(promptText).find(Boolean);
  if (!firstPrompt) return null;
  let title = '';
  for (const r of [...head, ...tail]) {
    if (r.type === 'agent-name' && typeof r.agentName === 'string') title = r.agentName;
    else if (r.type === 'ai-title' && typeof r.aiTitle === 'string' && !title) title = r.aiTitle;
  }
  // The newest ai-title wins over older ones (a user-set name always wins).
  const named = [...head, ...tail].some((r) => r.type === 'agent-name');
  if (!named) {
    for (const r of tail) {
      if (r.type === 'ai-title' && typeof r.aiTitle === 'string') title = r.aiTitle;
    }
  }
  return {
    sessionId: name.slice(0, -'.jsonl'.length),
    title: (title || firstPrompt).slice(0, PAST_SESSION_TITLE_MAX_CHARS),
    ...(title ? { firstPrompt: firstPrompt.slice(0, PAST_SESSION_TITLE_MAX_CHARS) } : {}),
    updatedAt: mtime.toISOString(),
  };
}

/** The sessions in these transcript folders, newest first. */
export function listPastSessions(dirs: string[], openIds: ReadonlySet<string>): PastSession[] {
  const files: Array<{ file: string; mtime: number }> = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!SESSION_FILE_RE.test(name)) continue;
      const file = path.join(dir, name);
      try {
        files.push({ file, mtime: fs.statSync(file).mtimeMs });
      } catch {
        /* gone */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: PastSession[] = [];
  for (const { file } of files) {
    const session = describeSession(file);
    if (!session) continue;
    out.push(openIds.has(session.sessionId) ? { ...session, open: true } : session);
    if (out.length >= PAST_SESSIONS_MAX) break;
  }
  return out;
}
