import { describe, expect, it } from 'vitest';

import { sanitizeAgentLook } from '../../core/src/agentLook.js';
import { DEFAULT_LOOK_COLORS } from '../../core/src/constants.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/index.js';
import type { AgentState } from '../src/types.js';

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

const LOOK = {
  hair: 'bun',
  top: 'hoodie',
  height: 'tall',
  extras: ['glasses', 'cap'],
  // Upper-cased on purpose: the sanitizer lower-cases colours.
  skin: DEFAULT_LOOK_COLORS.skin.toUpperCase(),
  hairColor: DEFAULT_LOOK_COLORS.hairColor,
  shirt: DEFAULT_LOOK_COLORS.shirt,
  pants: DEFAULT_LOOK_COLORS.pants,
};

describe('sanitizeAgentLook', () => {
  it('keeps a valid look and lower-cases its colours', () => {
    expect(sanitizeAgentLook(LOOK)).toEqual({ ...LOOK, skin: DEFAULT_LOOK_COLORS.skin });
  });

  it('rebuilds unknown values from defaults and drops junk', () => {
    const out = sanitizeAgentLook({
      hair: 'mohawk',
      top: 42,
      extras: ['glasses', 'jetpack', 'glasses', 'cap', 'beanie'],
      skin: 'red',
      extra: 'field',
    });
    expect(out?.hair).toBe('short');
    expect(out?.top).toBe('tee');
    expect(out?.height).toBe('average');
    // duplicates and unknown extras go; only one hat stays
    expect(out?.extras).toEqual(['glasses', 'beanie']);
    expect(out?.skin).toMatch(/^#[0-9a-f]{6}$/);
    expect(out).not.toHaveProperty('extra');
  });

  it('is undefined for anything that is not an object', () => {
    expect(sanitizeAgentLook(undefined)).toBeUndefined();
    expect(sanitizeAgentLook('bun')).toBeUndefined();
    expect(sanitizeAgentLook([LOOK])).toBeUndefined();
  });
});

describe('setAgentLook', () => {
  it('stores, persists and broadcasts the look; clearing sends no look', () => {
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

    runtime.setAgentLook(1, LOOK);
    expect(store.get(1)?.look?.hair).toBe('bun');
    expect(sent.at(-1)).toMatchObject({ type: 'agentLook', id: 1, look: { hair: 'bun' } });
    expect(JSON.stringify(saved.at(-1))).toContain('"hair":"bun"');

    // the same look again changes nothing
    runtime.setAgentLook(1, LOOK);
    expect(sent.filter((m) => m.type === 'agentLook')).toHaveLength(1);

    runtime.setAgentLook(1, undefined);
    expect(store.get(1)?.look).toBeUndefined();
    expect(sent.at(-1)).toEqual({ type: 'agentLook', id: 1, look: undefined });

    runtime.setAgentLook(99, LOOK);
    runtime.setAgentLook('1', LOOK);
    expect(sent.filter((m) => m.type === 'agentLook')).toHaveLength(2);
    runtime.dispose();
  });
});
