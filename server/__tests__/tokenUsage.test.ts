import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { TOKEN_BURN_WINDOW_MS } from '../src/constants.js';
import { claudeProvider } from '../src/providers/index.js';
import {
  burnPerMinute,
  foldUsage,
  newTokenMeter,
  seedTokenUsage,
  tickTokenBurn,
  usageOf,
} from '../src/tokenUsage.js';
import type { AgentState } from '../src/types.js';

const NOW = Date.parse('2026-09-21T10:00:00Z');

function rec(id: string, usage: Record<string, number>, at = NOW) {
  return {
    type: 'assistant',
    uuid: `u-${id}-${Math.random()}`,
    timestamp: new Date(at).toISOString(),
    message: { id, usage },
  };
}

function agent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 's1',
    isExternal: false,
    projectDir: '/p',
    jsonlFile: '',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

describe('token usage', () => {
  it('ignores all-zero usage from synthetic records', () => {
    expect(usageOf(rec('m', { input_tokens: 0, output_tokens: 0 }))).toBeNull();
  });

  it('counts a request once across the records it is split into', () => {
    const meter = newTokenMeter();
    const u = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 };
    foldUsage(meter, rec('m1', { ...u, output_tokens: 5 }), NOW);
    foldUsage(meter, rec('m1', { ...u, output_tokens: 5 }), NOW); // repeated block
    foldUsage(meter, rec('m1', { ...u, output_tokens: 40 }), NOW); // output grew while streaming
    foldUsage(meter, rec('m2', { input_tokens: 5, output_tokens: 5 }), NOW);
    expect(meter.requests).toBe(2);
    expect(meter.outputTokens).toBe(45);
    expect(meter.totalTokens).toBe(10 + 1000 + 50 + 40 + 10);
    expect(meter.cacheReadTokens).toBe(1000);
  });

  it('burns only new tokens inside the window, and decays to zero', () => {
    const meter = newTokenMeter();
    foldUsage(meter, rec('old', { input_tokens: 99_000 }, NOW - TOKEN_BURN_WINDOW_MS - 1), NOW);
    foldUsage(
      meter,
      rec('new', {
        input_tokens: 1_000,
        cache_creation_input_tokens: 2_000,
        output_tokens: 2_000,
        cache_read_input_tokens: 500_000,
      }),
      NOW,
    );
    expect(burnPerMinute(meter, NOW)).toBe(5_000 / (TOKEN_BURN_WINDOW_MS / 60_000));
    expect(burnPerMinute(meter, NOW + TOKEN_BURN_WINDOW_MS + 1)).toBe(0);
  });

  it('re-sends an agent whose burn decayed', () => {
    const store = new AgentStateStore();
    const a = agent();
    store.set(1, a);
    a.tokenMeter = newTokenMeter();
    foldUsage(a.tokenMeter, rec('m', { output_tokens: 10_000 }, Date.now()));
    a.tokenMeter.lastBurn = 2_000;
    const sent: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => sent.push(m));
    tickTokenBurn(store, Date.now() + TOKEN_BURN_WINDOW_MS + 1);
    expect(sent).toEqual([
      expect.objectContaining({ type: 'agentTokenUsage', id: 1, burnPerMinute: 0 }),
    ]);
  });

  it('totals the transcript before the read offset when an agent is adopted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-usage-'));
    const file = path.join(dir, 's.jsonl');
    const line = (id: string) =>
      JSON.stringify(rec(id, { input_tokens: 100, output_tokens: 20 })) + '\n';
    fs.writeFileSync(file, line('a') + line('a') + line('b'));
    const store = new AgentStateStore();
    store.set(1, agent({ jsonlFile: file, fileOffset: fs.statSync(file).size }));
    seedTokenUsage(1, store);
    expect(store.get(1)?.tokenMeter).toMatchObject({
      requests: 2,
      totalTokens: 240,
      partial: false,
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('renaming a character', () => {
  it('cleans the name, persists it, broadcasts it, and clears on empty', () => {
    const store = new AgentStateStore();
    const saved: unknown[] = [];
    store.setAdapter({
      loadAgents: () => [],
      saveAgents: (a) => saved.push(a),
      loadSeats: () => ({}),
      saveSeats: () => {},
      getSetting: <T>(_k: string, d: T) => d,
      setSetting: () => {},
    });
    const runtime = new AgentRuntime(store, claudeProvider);
    store.set(1, agent());
    const sent: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => sent.push(m));
    runtime.renameAgent(1, '  Backend\u0007 Bob with a very long name indeed  ');
    expect(store.get(1)?.displayName).toBe('Backend Bob with a very long nam');
    expect(sent.at(-1)).toEqual({
      type: 'agentRenamed',
      id: 1,
      name: 'Backend Bob with a very long nam',
    });
    expect(JSON.stringify(saved.at(-1))).toContain('Backend Bob');
    runtime.renameAgent(1, '   ');
    expect(store.get(1)?.displayName).toBeUndefined();
    runtime.renameAgent(99, 'nobody');
    runtime.renameAgent('1', 'bad id');
    expect(sent.filter((m) => m.type === 'agentRenamed')).toHaveLength(2);
    runtime.dispose();
  });
});
