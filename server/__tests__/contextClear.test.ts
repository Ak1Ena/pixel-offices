import * as http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { parseClearArgs, runClearCommand } from '../src/clearCli.js';
import { ContextClear, prefsMessage, sessionMatches } from '../src/contextClear.js';
import { handleContextClearMessage } from '../src/contextClearMessages.js';
import type { AgentState } from '../src/types.js';

function agent(id: number, fields: Partial<AgentState> = {}): AgentState {
  return {
    id,
    sessionId: `s${id}`,
    activeToolStatuses: new Map(),
    isWaiting: true,
    permissionSent: false,
    jsonlFile: `/p/s${id}.jsonl`,
    ...fields,
  } as unknown as AgentState;
}

function setup(reachable = true) {
  const store = new AgentStateStore();
  const typed: Array<[number, string]> = [];
  const broadcasts: Array<Record<string, unknown>> = [];
  store.on('broadcast', (m: Record<string, unknown>) => broadcasts.push(m));
  const clear = new ContextClear(store, {
    canSend: () => reachable,
    send: (id, text) => void typed.push([id, text as string]),
  });
  store.set(1, agent(1));
  return { store, clear, typed, broadcasts };
}

describe('clearing an agent from the office', () => {
  it('types /clear (or /compact) and nothing after it', () => {
    const { clear, typed } = setup();
    expect(clear.clear(1, 'clear')).toBeNull();
    expect(clear.clear(1, 'compact')).toBeNull();
    expect(typed).toEqual([
      [1, '/clear'],
      [1, '/compact'],
    ]);
  });

  it('refuses agents the office cannot type into, unknown agents and unknown modes', () => {
    expect(setup(false).clear.clear(1)).toMatch(/cannot type/);
    const { clear, typed } = setup();
    expect(clear.clear(9)).toBe('No such agent.');
    expect(clear.clear(1, 'reset')).toBe('Unknown clear mode.');
    expect(typed).toEqual([]);
  });
});

describe('an agent asking to clear itself', () => {
  it('waits for the human by default, and clears only when allowed', () => {
    const { clear, typed, broadcasts } = setup();
    expect(clear.requestFromAgent('s1', 'done\u0007 exploring')).toEqual({
      ok: true,
      status: 'asked',
      agentId: 1,
    });
    expect(typed).toEqual([]);
    expect(clear.snapshot().requests).toMatchObject([{ agentId: 1, reason: 'done  exploring' }]);
    expect(broadcasts.at(-1)?.type).toBe('agentClearRequests');

    clear.answer(1, true);
    expect(typed).toEqual([[1, '/clear']]);
    expect(clear.snapshot().requests).toEqual([]);
  });

  it('a turned-down request types nothing', () => {
    const { clear, typed } = setup();
    clear.requestFromAgent('s1', undefined);
    clear.answer(1, false);
    expect(typed).toEqual([]);
    expect(clear.snapshot().requests).toEqual([]);
  });

  it('follows the per-agent policy: allow clears at once, never refuses', () => {
    const { store, clear, typed } = setup();
    clear.setPrefs(1, 'allow', undefined);
    expect(clear.requestFromAgent('s1', '')).toMatchObject({ status: 'scheduled' });
    expect(typed).toEqual([[1, '/clear']]);

    clear.setPrefs(1, 'never', undefined);
    expect(clear.requestFromAgent('s1', '')).toMatchObject({ ok: false, status: 'refused' });
    expect(store.get(1)?.clearPolicy).toBe('never');
  });

  it('turning self-clearing off drops a waiting request', () => {
    const { clear } = setup();
    clear.requestFromAgent('s1', '');
    clear.setPrefs(1, 'never', undefined);
    expect(clear.snapshot().requests).toEqual([]);
  });

  it('finds the agent by the id its terminal was started with after an earlier /clear', () => {
    const { store, clear } = setup();
    store.set(2, agent(2, { sessionId: 'new', launchKey: 'launched', jsonlFile: '/p/new.jsonl' }));
    expect(clear.requestFromAgent('launched', '')).toMatchObject({ agentId: 2 });
    expect(clear.requestFromAgent('nobody', '')).toMatchObject({ ok: false, status: 'unknown' });
  });

  it('says so when the office cannot type into the agent', () => {
    expect(setup(false).clear.requestFromAgent('s1', '')).toMatchObject({
      ok: false,
      status: 'unreachable',
    });
  });

  it('drops the request when the agent leaves', () => {
    const { store, clear } = setup();
    clear.requestFromAgent('s1', '');
    store.delete(1);
    expect(clear.snapshot().requests).toEqual([]);
  });
});

describe('per-agent prefs', () => {
  it('ignores values it does not know and broadcasts what changed', () => {
    const { store, clear, broadcasts } = setup();
    clear.setPrefs(1, 'sometimes', 'maybe');
    expect(broadcasts.filter((m) => m.type === 'agentPrefs')).toEqual([]);
    clear.setPrefs(1, undefined, 'auto');
    expect(store.get(1)?.docEditMode).toBe('auto');
    expect(broadcasts.at(-1)).toEqual({
      type: 'agentPrefs',
      id: 1,
      clearPolicy: 'ask',
      docEditMode: 'auto',
    });
  });

  it('fills in the default policy', () => {
    expect(prefsMessage(3, {})).toEqual({ type: 'agentPrefs', id: 3, clearPolicy: 'ask' });
  });

  it('matches a session by id, launch key or transcript name', () => {
    const a = agent(1, { sessionId: 'a', launchKey: 'k', jsonlFile: '/x/t.jsonl' });
    expect(sessionMatches(a, 'a')).toBe(true);
    expect(sessionMatches(a, 'k')).toBe(true);
    expect(sessionMatches(a, 't')).toBe(true);
    expect(sessionMatches(a, '')).toBe(false);
  });
});

describe('client messages', () => {
  it('need a privileged connection', () => {
    const { clear, typed } = setup();
    const runtime = {
      contextClear: clear,
      chatSender: { notice: () => {} },
    } as unknown as AgentRuntime;
    expect(
      handleContextClearMessage({ type: 'clearAgentContext', id: 1 }, () => {}, runtime, false),
    ).toBe(true);
    expect(typed).toEqual([]);
    handleContextClearMessage({ type: 'clearAgentContext', id: 1 }, () => {}, runtime, true);
    expect(typed).toEqual([[1, '/clear']]);
    expect(handleContextClearMessage({ type: 'renameAgent' }, () => {}, runtime, true)).toBe(false);
  });

  it('shows why a clear was refused in the agent’s chat', () => {
    const { clear } = setup(false);
    const notices: string[] = [];
    const runtime = {
      contextClear: clear,
      chatSender: { notice: (_id: number, error: string) => notices.push(error) },
    } as unknown as AgentRuntime;
    handleContextClearMessage({ type: 'clearAgentContext', id: 1 }, () => {}, runtime, true);
    expect(notices[0]).toMatch(/cannot type/);
  });
});

describe('pixel-office clear', () => {
  const servers: http.Server[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));

  function office(status: number, body: Record<string, unknown>): Promise<number> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        let text = '';
        req.on('data', (c) => (text += c));
        req.on('end', () => {
          expect(req.headers.authorization).toBe('Bearer tok');
          expect(JSON.parse(text)).toMatchObject({ session: 'sess' });
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        });
      });
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
  }

  const run = async (ports: number[], argv: string[] = []) => {
    const out: string[] = [];
    const code = await runClearCommand(argv, {
      session: 'sess',
      servers: () => ports.map((port) => ({ port, token: 'tok' }) as never),
      out: (s) => out.push(s),
    });
    return { code, out: out.join('\n') };
  };

  it('skips offices that do not know the session', async () => {
    const other = await office(404, { status: 'unknown', error: 'x' });
    const mine = await office(200, { status: 'asked' });
    expect(await run([other, mine])).toMatchObject({
      code: 0,
      out: expect.stringMatching(/Asked/),
    });
  });

  it('reports a refusal', async () => {
    const port = await office(403, { status: 'refused', error: 'turned off' });
    expect(await run([port])).toEqual({ code: 1, out: 'turned off' });
  });

  it('says when nothing was cleared', async () => {
    expect((await run([])).out).toMatch(/nothing was cleared/);
  });

  it('parses --reason', () => {
    expect(parseClearArgs(['--reason', 'long'])).toEqual({ reason: 'long' });
    expect(parseClearArgs(['--reason'])).toEqual({});
    expect(parseClearArgs(['-h'])).toEqual({ help: true });
  });
});
