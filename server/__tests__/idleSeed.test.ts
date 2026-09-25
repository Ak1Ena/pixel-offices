import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { seedIdleState, transcriptTailState } from '../src/idleSeed.js';
import type { AgentState } from '../src/types.js';

const line = (r: unknown) => JSON.stringify(r);

describe('transcriptTailState', () => {
  it('no transcript yet = at its prompt', () => {
    expect(transcriptTailState(null, 0)).toBe('idle');
  });
  it('a finished turn is idle, a pending tool or a new prompt is busy', () => {
    expect(transcriptTailState(line({ type: 'system', subtype: 'turn_duration' }), 0)).toBe('idle');
    const tool = line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' }] } });
    expect(transcriptTailState(tool, 60_000)).toBe('busy');
    const prompt = line({ type: 'user', message: { content: 'hi' } });
    expect(transcriptTailState(prompt, 0)).toBe('busy');
  });
  it('an interrupt note and a local command end the turn', () => {
    const esc = line({ type: 'user', message: { content: '[Request interrupted by user]' } });
    expect(transcriptTailState(esc, 0)).toBe('idle');
    const cmd = line({ type: 'user', message: { content: '<command-name>/model</command-name>' } });
    expect(transcriptTailState(cmd, 0)).toBe('idle');
  });
  it('a text-only reply is idle once quiet; later bookkeeping records are skipped', () => {
    const text =
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }) +
      '\n' +
      line({ type: 'file-history-snapshot' });
    expect(transcriptTailState(text, 60_000)).toBe('idle');
    expect(transcriptTailState(text, 0)).toBeNull();
  });
});

describe('seedIdleState', () => {
  const agentWith = (jsonlFile: string) =>
    ({
      id: 1,
      jsonlFile,
      isWaiting: false,
      permissionSent: false,
      activeToolIds: new Set(),
    }) as unknown as AgentState;

  it('an office-started session with no transcript is marked waiting, quietly', () => {
    const store = new AgentStateStore();
    const sent: unknown[] = [];
    store.on('broadcast', (m) => sent.push(m));
    const agent = agentWith(path.join(os.tmpdir(), `missing-${Date.now()}.jsonl`));
    store.set(1, agent);
    seedIdleState(1, store);
    expect(agent.isWaiting).toBe(true);
    expect(sent).toEqual([{ type: 'agentStatus', id: 1, status: 'waiting', seeded: true }]);
  });

  it('a session mid-tool stays working', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-seed-'));
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(
      file,
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' }] } }) + '\n',
    );
    const store = new AgentStateStore();
    const agent = agentWith(file);
    store.set(1, agent);
    seedIdleState(1, store);
    expect(agent.isWaiting).toBe(false);
  });
});
