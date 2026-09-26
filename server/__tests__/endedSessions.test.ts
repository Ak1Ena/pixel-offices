import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENDED_SESSIONS_MAX } from '../src/constants.js';
import { readEndedSessions, recordEndedSessions, sessionsToDismiss } from '../src/endedSessions.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ended-'));
  file = path.join(dir, 'ended-sessions.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('sessions that ended with the office', () => {
  it('are recorded and read back; a session recorded again moves to the newest time', () => {
    recordEndedSessions(['/p/a.jsonl', '/p/b.jsonl'], 1000, file);
    recordEndedSessions(['/p/a.jsonl'], 2000, file);
    expect(readEndedSessions(file)).toEqual([
      { file: '/p/b.jsonl', at: 1000 },
      { file: '/p/a.jsonl', at: 2000 },
    ]);
  });

  it('stay bounded, ignore junk and a missing file, and record nothing for no sessions', () => {
    expect(readEndedSessions(file)).toEqual([]);
    recordEndedSessions([], 1, file);
    expect(fs.existsSync(file)).toBe(false);
    recordEndedSessions(
      Array.from({ length: ENDED_SESSIONS_MAX + 5 }, (_, i) => `/p/${i}.jsonl`),
      5,
      file,
    );
    expect(readEndedSessions(file)).toHaveLength(ENDED_SESSIONS_MAX);
    fs.writeFileSync(
      file,
      JSON.stringify({ sessions: [{ file: 'rel', at: 1 }, { file: '/ok', at: 2 }, 7] }),
    );
    expect(readEndedSessions(file)).toEqual([{ file: '/ok', at: 2 }]);
  });

  it('records a running session with its office pid; a clean stop replaces it', () => {
    const file = path.join(dir, 'ended.json');
    recordEndedSessions(['/p/a.jsonl'], 1, file, 4242);
    expect(readEndedSessions(file)).toEqual([{ file: '/p/a.jsonl', at: 1, pid: 4242 }]);
    recordEndedSessions(['/p/a.jsonl'], 2, file);
    expect(readEndedSessions(file)).toEqual([{ file: '/p/a.jsonl', at: 2 }]);
  });

  it("dismisses ended sessions and running ones whose office is gone, never a live office's", () => {
    const sessions = [
      { file: '/ended', at: 1 },
      { file: '/crashed', at: 1, pid: 10 },
      { file: '/other-office', at: 1, pid: 20 },
      { file: '/mine', at: 1, pid: 30 },
    ];
    const alive = (pid: number) => pid === 20 || pid === 30;
    expect(sessionsToDismiss(sessions, alive, 30).map((s) => s.file)).toEqual([
      '/ended',
      '/crashed',
    ]);
  });
});
