import { afterEach, describe, expect, it } from 'vitest';

import type { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { createHttpServer } from '../src/httpServer.js';
import { PermissionBroker } from '../src/permissionBroker.js';
import { describePermissionRequest } from '../src/providers/hook/claude/claude.js';
import type { AgentState } from '../src/types.js';

const REQ = 'req_0123456789abcdef';

function setup(waitMs = 60_000) {
  const store = new AgentStateStore();
  store.set(1, { id: 1 } as unknown as AgentState);
  const sent: Array<Record<string, unknown>> = [];
  store.on('broadcast', (m: Record<string, unknown>) => sent.push(m));
  const broker = new PermissionBroker(store, waitMs);
  return { store, broker, sent };
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

describe('PermissionBroker', () => {
  it('does not hold a prompt when nobody can answer it', () => {
    const { broker, sent } = setup();
    cleanups.push(() => broker.dispose());
    expect(
      broker.open({ requestId: REQ, agentId: 1, toolName: 'Bash', providerId: 'claude' }),
    ).toBe(false);
    expect(sent).toEqual([]);
  });

  it('opens an ask, hands the answer to the waiting poll, and closes it everywhere', async () => {
    const { broker, sent } = setup();
    cleanups.push(() => broker.dispose());
    broker.addDecider();
    expect(
      broker.open({
        requestId: REQ,
        agentId: 1,
        toolName: 'Bash',
        detail: 'rm -rf build',
        providerId: 'claude',
      }),
    ).toBe(true);
    expect(sent[0]).toMatchObject({
      type: 'agentPermissionAsk',
      id: 1,
      requestId: REQ,
      toolName: 'Bash',
      detail: 'rm -rf build',
    });
    expect(broker.snapshot()).toHaveLength(1);

    const poll = broker.wait(REQ, 5_000);
    expect(broker.answer(2, REQ, 'allow')).toBe(false); // wrong agent
    expect(broker.answer(1, REQ, 'maybe')).toBe(false); // not a decision
    expect(broker.answer(1, REQ, 'allow')).toBe(true);
    await expect(poll).resolves.toBe('allow');
    // A late poll still gets the decision.
    await expect(broker.wait(REQ, 10)).resolves.toBe('allow');
    expect(sent.at(-1)).toMatchObject({ type: 'agentPermissionAnswered', requestId: REQ });
    expect(broker.snapshot()).toEqual([]);
  });

  it('reports pending while undecided and lets go when the wait runs out', async () => {
    const { broker } = setup(30);
    cleanups.push(() => broker.dispose());
    broker.addDecider();
    broker.open({ requestId: REQ, agentId: 1, toolName: 'Edit', providerId: 'claude' });
    await expect(broker.wait(REQ, 5)).resolves.toBe('pending');
    await new Promise((r) => setTimeout(r, 50));
    await expect(broker.wait(REQ, 5)).resolves.toBe('terminal');
  });

  it('closes an agent’s asks when it leaves', async () => {
    const { store, broker } = setup();
    cleanups.push(() => broker.dispose());
    broker.addDecider();
    broker.open({ requestId: REQ, agentId: 1, toolName: 'Bash', providerId: 'claude' });
    const poll = broker.wait(REQ, 5_000);
    store.delete(1);
    await expect(poll).resolves.toBe('terminal');
  });

  it('rejects malformed request ids', () => {
    const { broker } = setup();
    cleanups.push(() => broker.dispose());
    broker.addDecider();
    expect(
      broker.open({ requestId: '../x', agentId: 1, toolName: 'Bash', providerId: 'claude' }),
    ).toBe(false);
  });
});

describe('Claude describePermissionRequest', () => {
  it('only describes a held PermissionRequest', () => {
    expect(describePermissionRequest({ hook_event_name: 'PermissionRequest' })).toBeNull();
    expect(
      describePermissionRequest({
        hook_event_name: 'PreToolUse',
        pixel_request_id: REQ,
      }),
    ).toBeNull();
    expect(
      describePermissionRequest({
        hook_event_name: 'PermissionRequest',
        pixel_request_id: REQ,
        tool_name: 'Bash',
        tool_input: { command: 'npm test', description: 'run tests' },
      }),
    ).toEqual({ toolName: 'Bash', detail: 'npm test' });
  });

  it('never holds AskUserQuestion: it is a question, Allow/Deny cannot answer it', () => {
    expect(
      describePermissionRequest({
        hook_event_name: 'PermissionRequest',
        pixel_request_id: REQ,
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Which one?', options: [] }] },
      }),
    ).toBeNull();
  });
});

describe('permission routes', () => {
  async function start() {
    const store = new AgentStateStore();
    store.set(1, { id: 1 } as unknown as AgentState);
    const broker = new PermissionBroker(store);
    broker.addDecider();
    const runtime = {
      permissions: broker,
      askPermission: (_provider: string, event: Record<string, unknown>) =>
        broker.open({
          requestId: String(event.pixel_request_id),
          agentId: 1,
          toolName: 'Bash',
          providerId: 'claude',
        }),
    } as unknown as AgentRuntime;
    const { app, port } = await createHttpServer({
      embedded: true,
      token: 'secret',
      store,
      runtime,
    });
    cleanups.push(async () => {
      broker.dispose();
      await app.close();
    });
    return { broker, base: `http://127.0.0.1:${port}/api/hooks/claude` };
  }

  const auth = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };

  it('tells the hook to wait, then serves the decision to its poll', async () => {
    const { broker, base } = await start();
    const post = await fetch(base, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        session_id: 's1',
        hook_event_name: 'PermissionRequest',
        pixel_request_id: REQ,
      }),
    });
    expect(await post.json()).toEqual({ await: true });

    const poll = fetch(`${base}/permission/${REQ}`, { headers: auth }).then((r) => r.json());
    setTimeout(() => broker.answer(1, REQ, 'deny'), 20);
    expect(await poll).toEqual({ decision: 'deny' });
  });

  it('refuses the poll without the token or from a browser', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/permission/${REQ}`)).status).toBe(401);
    const fromPage = await fetch(`${base}/permission/${REQ}`, {
      headers: { ...auth, Origin: 'http://evil.example' },
    });
    expect(fromPage.status).toBe(403);
  });

  it('keeps plain hook events unchanged', async () => {
    const { base } = await start();
    const res = await fetch(base, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' }),
    });
    expect(await res.text()).toBe('ok');
  });
});
