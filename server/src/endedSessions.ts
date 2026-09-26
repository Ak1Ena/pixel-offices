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
 * dismisses them, so they come back only if the session is really resumed
 * and written to again.
 *
 * An office that stops uncleanly (killed, crashed) never gets to write them,
 * so each one is also recorded the moment the office adopts it, with the
 * office's `pid`: the next office treats such an entry as ended once that
 * process is gone, and leaves it alone while it still runs.
 */

export interface EndedSession {
  file: string;
  at: number;
  /** Recorded while running: the office process that runs it. Absent = it ended with its office. */
  pid?: number;
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
      .map((s) => ({
        file: s.file,
        at: s.at,
        ...(typeof s.pid === 'number' && s.pid > 0 ? { pid: s.pid } : {}),
      }))
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
  /** Recording a session that still runs in this office process. */
  pid?: number,
): void {
  if (files.length === 0) return;
  const fresh = new Set(files);
  const sessions = [
    ...readEndedSessions(filePath).filter((s) => !fresh.has(s.file)),
    ...files.map((file) => ({ file, at: now, ...(pid ? { pid } : {}) })),
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

/** The entries a starting office should ignore: ended ones, and running ones whose office is gone. */
export function sessionsToDismiss(
  sessions: EndedSession[],
  isAlive: (pid: number) => boolean,
  selfPid = process.pid,
): EndedSession[] {
  return sessions.filter((s) => s.pid === undefined || (s.pid !== selfPid && !isAlive(s.pid)));
}
