import { describe, expect, it } from 'vitest';

import { runAgentsCommand } from '../src/agentsCli.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { describeRoster, officeRoster } from '../src/officeRoster.js';
import type { AgentState } from '../src/types.js';

function agent(id: number, fields: Partial<AgentState>): AgentState {
  return {
    id,
    sessionId: `s${id}`,
    activeToolStatuses: new Map(),
    isWaiting: true,
    permissionSent: false,
    jsonlFile: '',
    ...fields,
  } as unknown as AgentState;
}

describe('who is in the office', () => {
  it('lists every agent by its office name, any CLI, and marks the caller', () => {
    const store = new AgentStateStore();
    store.set(
      1,
      agent(1, { displayName: 'lead', cwd: '/repo', jsonlFile: '/p/claude-sess.jsonl' }),
    );
    store.set(
      2,
      agent(2, {
        providerId: 'antigravity',
        folderName: 'repo',
        isWaiting: false,
        activeToolStatuses: new Map([['t', 'Running: npm test']]),
        launchKey: 'agy-k',
        sessionId: 'conv-1',
      }),
    );
    store.set(3, agent(3, { agentName: 'scout', leadAgentId: 1, permissionSent: true }));

    const roster = officeRoster(store, 'claude-sess');
    expect(roster).toMatchObject([
      { id: 1, name: 'lead', provider: 'claude', status: 'idle', you: true, folder: '/repo' },
      {
        id: 2,
        name: 'repo #2',
        provider: 'antigravity',
        status: 'working',
        doing: 'Running: npm test',
      },
      { id: 3, name: 'scout', status: 'asking', lead: 'lead' },
    ]);
    expect(roster[1].you).toBeUndefined();
    expect(officeRoster(store, 'agy-k')[1].you).toBe(true);
    expect(describeRoster(roster)).toContain('#1 lead (you) (claude) — idle · /repo');
  });

  it('says so when no office is running', async () => {
    const out: string[] = [];
    expect(await runAgentsCommand([], { servers: () => [], out: (s) => out.push(s) })).toBe(1);
    expect(out[0]).toMatch(/No Pixel Office is running/);
  });
});
