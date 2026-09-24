import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { listPastSessions } from '../src/pastSessions.js';
import { isLocalCommandRecord } from '../src/transcriptParser.js';

let dir: string | null = null;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

function write(name: string, records: unknown[], mtime: number): void {
  const file = path.join(dir!, name);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.utimesSync(file, mtime, mtime);
}

describe('past sessions', () => {
  it('lists sessions newest first, titled like Claude titles them', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-past-'));
    write(
      `${ID_A}.jsonl`,
      [
        { type: 'user', message: { content: '<local-command-caveat>Caveat: …' } },
        { type: 'user', message: { content: 'Fix the login bug' } },
        { type: 'ai-title', aiTitle: 'Old title' },
        { type: 'ai-title', aiTitle: 'Login bug fix' },
      ],
      1_000,
    );
    write(
      `${ID_B}.jsonl`,
      [
        { type: 'user', message: { content: [{ type: 'text', text: 'Write docs' }] } },
        { type: 'agent-name', agentName: 'Docs' },
        { type: 'ai-title', aiTitle: 'Documentation' },
      ],
      2_000,
    );
    // No conversation: never offered.
    write(`${ID_C}.jsonl`, [{ type: 'mode', mode: 'normal' }], 3_000);
    write('notes.jsonl', [{ type: 'user', message: { content: 'x' } }], 4_000);

    const sessions = listPastSessions([dir], new Set([ID_B]));
    expect(sessions.map((s) => s.sessionId)).toEqual([ID_B, ID_A]);
    expect(sessions[0]).toMatchObject({ title: 'Docs', open: true, firstPrompt: 'Write docs' });
    expect(sessions[1]).toMatchObject({ title: 'Login bug fix', firstPrompt: 'Fix the login bug' });
    expect(sessions[1].open).toBeUndefined();
  });
});

describe('local slash commands are not turns', () => {
  it('recognizes the records a local command writes', () => {
    expect(isLocalCommandRecord('<command-name>/model</command-name>')).toBe(true);
    expect(isLocalCommandRecord('<local-command-stdout>Set model</local-command-stdout>')).toBe(
      true,
    );
    expect(isLocalCommandRecord([{ type: 'text', text: '<local-command-caveat>…' }])).toBe(true);
    expect(isLocalCommandRecord('please run /model')).toBe(false);
    expect(isLocalCommandRecord([{ type: 'text', text: 'hello' }])).toBe(false);
  });
});
