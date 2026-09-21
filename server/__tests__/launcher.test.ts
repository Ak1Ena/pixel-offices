import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { ChatSender } from '../src/chatSender.js';
import { LAUNCHER_LEASE_MS } from '../src/constants.js';
import { createHttpServer } from '../src/httpServer.js';
import { planLaunch, readLiveServers } from '../src/launcher.js';
import { LauncherHub } from '../src/launcherHub.js';
import type { AgentState } from '../src/types.js';

const open = () => true;

function agent(overrides: Partial<AgentState>): AgentState {
  return {
    id: 1,
    sessionId: 's1',
    isExternal: true,
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

describe('planLaunch', () => {
  const id = () => 'minted';

  it('mints a session id for a fresh session so the office can address it', () => {
    expect(planLaunch(['--model', 'opus'], id)).toEqual({
      claudeArgs: ['--session-id', 'minted', '--model', 'opus'],
      sessionId: 'minted',
      interactive: true,
    });
  });

  it('uses an explicit --session-id or --resume <id> as given', () => {
    expect(planLaunch(['--session-id', 'abc'], id).sessionId).toBe('abc');
    expect(planLaunch(['--session-id=abc'], id).sessionId).toBe('abc');
    expect(planLaunch(['-r', 'abc'], id)).toMatchObject({
      sessionId: 'abc',
      claudeArgs: ['-r', 'abc'],
    });
  });

  it('cannot address --continue, the resume picker, or print mode', () => {
    expect(planLaunch(['-c'], id).sessionId).toBeNull();
    expect(planLaunch(['--resume'], id).sessionId).toBeNull();
    expect(planLaunch(['-p', 'hi'], id)).toMatchObject({ sessionId: null, interactive: false });
  });
});

describe('readLiveServers', () => {
  it('keeps only well-formed entries whose process is alive', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-reg-'));
    const base = { port: 4000, token: 't', startedAt: 1, servesSpa: true, protocol: 1 };
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ ...base, pid: process.pid }));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ ...base, pid: 2 ** 30 }));
    fs.writeFileSync(path.join(dir, 'c.json'), '{not json');
    expect(readLiveServers(dir).map((s) => s.pid)).toEqual([process.pid]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('LauncherHub', () => {
  afterEach(() => vi.useRealTimers());

  it('hands text to a waiting poll, or queues it for the next one', async () => {
    const hub = new LauncherHub();
    const first = hub.poll('s1', 10_000, open);
    expect(hub.write('s1', 'hello')).toBe(true);
    expect(await first).toEqual(['hello']);
    expect(hub.write('s1', 'later')).toBe(true);
    expect(await hub.poll('s1', 10_000, open)).toEqual(['later']);
    hub.dispose();
  });

  it('keeps text queued when the waiting poll has already hung up', async () => {
    const hub = new LauncherHub();
    let alive = true;
    void hub.poll('s1', 10_000, () => alive);
    alive = false;
    hub.write('s1', 'kept');
    expect(await hub.poll('s1', 10_000, open)).toEqual(['kept']);
    hub.dispose();
  });

  it('refuses sessions nobody launched, and forgets ended or lapsed ones', async () => {
    vi.useFakeTimers();
    const changes: string[] = [];
    const hub = new LauncherHub((id) => changes.push(id));
    expect(hub.write('nobody', 'x')).toBe(false);
    const poll = hub.poll('s1', 1_000, open);
    vi.advanceTimersByTime(1_000);
    expect(await poll).toEqual([]);
    expect(hub.isConnected('s1')).toBe(true);
    vi.advanceTimersByTime(LAUNCHER_LEASE_MS);
    expect(hub.isConnected('s1')).toBe(false);
    void hub.poll('s2', 1_000, open);
    hub.end('s2');
    expect(hub.isConnected('s2')).toBe(false);
    expect(changes).toEqual(['s1', 's2', 's2']);
    hub.dispose();
  });
});

describe('sendable reach', () => {
  it('broadcasts agentChatSendable when a launcher connects and leaves', async () => {
    const store = new AgentStateStore();
    const sender = new ChatSender(store);
    const hub = new LauncherHub(() => sender.refreshSendable());
    sender.addWriter(hub.writer);
    const sent: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => sent.push(m));
    store.set(1, agent({ id: 1, sessionId: 's1' }));
    void hub.poll('s1', 10_000, open);
    hub.end('s1');
    expect(sent.filter((m) => m.type === 'agentChatSendable')).toEqual([
      { type: 'agentChatSendable', id: 1, sendable: false },
      { type: 'agentChatSendable', id: 1, sendable: true },
      { type: 'agentChatSendable', id: 1, sendable: false },
    ]);
    sender.dispose();
    hub.dispose();
  });

  it('types an office message into the launched session', async () => {
    const store = new AgentStateStore();
    const sender = new ChatSender(store);
    const hub = new LauncherHub(() => sender.refreshSendable());
    sender.addWriter(hub.writer);
    store.set(1, agent({ id: 1, sessionId: 's1' }));
    const poll = hub.poll('s1', 10_000, open);
    sender.send(1, 'run the tests');
    expect(await poll).toEqual(['run the tests']);
    sender.dispose();
    hub.dispose();
  });
});

describe('launcher HTTP route', () => {
  let close: () => Promise<void>;
  let port: number;
  let hub: LauncherHub;
  const polled: Array<[string, string]> = [];

  beforeEach(async () => {
    hub = new LauncherHub();
    const handle = await createHttpServer({
      embedded: true,
      token: 'secret',
      store: new AgentStateStore(),
      launchers: hub,
      onLauncherPoll: (sessionId, cwd) => polled.push([sessionId, cwd]),
    });
    port = handle.port;
    close = () => handle.app.close();
  });

  afterEach(async () => {
    hub.dispose();
    await close();
  });

  const url = (sessionId: string) =>
    `http://127.0.0.1:${port}/api/launcher/${sessionId}/input?cwd=%2Fwork`;

  it('delivers office text to an authenticated long-poll', async () => {
    const response = fetch(url('abc-123'), { headers: { Authorization: 'Bearer secret' } });
    await vi.waitFor(() => expect(hub.isConnected('abc-123')).toBe(true));
    hub.write('abc-123', 'hi from the office');
    const res = await response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ texts: ['hi from the office'] });
    expect(polled).toContainEqual(['abc-123', '/work']);
  });

  it('refuses a wrong token, a browser, and a malformed session id', async () => {
    const wrong = await fetch(url('abc'), { headers: { Authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
    const browser = await fetch(url('abc'), {
      headers: { Authorization: 'Bearer secret', Origin: 'http://evil.example' },
    });
    expect(browser.status).toBe(403);
    const badId = await fetch(url('..%2Fetc'), { headers: { Authorization: 'Bearer secret' } });
    expect(badId.status).toBe(400);
    expect(hub.isConnected('abc')).toBe(false);
  });
});
