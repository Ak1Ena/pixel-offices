import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ENDED_SESSIONS_FILE_NAME, ENDED_SESSIONS_MAX, LAYOUT_FILE_DIR } from './constants.js';

/**
 * Sessions that ended WITH the office: agents the office ran itself (in its
 * own ptys) die when it stops, but their transcripts are only seconds old, so
 * the next office's external scanner (it adopts any transcript written in the
 * last couple of minutes) would bring them straight back as read-only ghosts.
 * The office writes their transcript paths here when it stops; the next one
 * dismisses them (the usual user-close cooldown), so they come back only if
 * the session is really resumed and written to again.
 */

export interface EndedSession {
  file: string;
  at: number;
}

export function endedSessionsPath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, ENDED_SESSIONS_FILE_NAME);
}

export function readEndedSessions(filePath = endedSessionsPath()): EndedSession[] {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { sessions?: unknown };
    if (!Array.isArray(raw.sessions)) return [];
    return raw.sessions
      .filter(
        (s): s is EndedSession =>
          !!s &&
          typeof (s as EndedSession).file === 'string' &&
          path.isAbsolute((s as EndedSession).file) &&
          Number.isFinite((s as EndedSession).at),
      )
      .slice(-ENDED_SESSIONS_MAX);
  } catch {
    return [];
  }
}

/** Add transcripts that just ended with the office (newest kept, bounded). */
export function recordEndedSessions(
  files: string[],
  now = Date.now(),
  filePath = endedSessionsPath(),
): void {
  if (files.length === 0) return;
  const fresh = new Set(files);
  const sessions = [
    ...readEndedSessions(filePath).filter((s) => !fresh.has(s.file)),
    ...files.map((file) => ({ file, at: now })),
  ].slice(-ENDED_SESSIONS_MAX);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions }), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    console.error('[Pixel Agents] Failed to record ended sessions:', err);
  }
}
