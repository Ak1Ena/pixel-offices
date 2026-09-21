import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { BoardStore, sanitizePin } from '../src/boardStore.js';
import { extractChatDelta, recordChat, seedChatHistory, userPromptText } from '../src/chatLog.js';
import { ChatSender } from '../src/chatSender.js';
import type { AgentState } from '../src/types.js';

const fmt = (name: string, input: Record<string, unknown>) =>
  `${name} ${typeof input.file_path === 'string' ? input.file_path : ''}`.trim();

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    terminalRef: undefined,
    isExternal: false,
    projectDir: '/test',
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

function collect(store: AgentStateStore): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  store.on('broadcast', (m) => out.push(m));
  return out;
}

describe('chat log', () => {
  it('shows typed prompts and hides harness-written text', () => {
    expect(userPromptText('  fix the bug ')).toBe('fix the bug');
    expect(userPromptText('<local-command-stdout>ok</local-command-stdout>')).toBeNull();
    expect(userPromptText('<system-reminder>x</system-reminder>')).toBeNull();
    expect(
      userPromptText('<command-name>/review</command-name><command-args>42</command-args>'),
    ).toBe('/review 42');
  });

  it('turns assistant records into a reply plus tool rows, text first', () => {
    const delta = extractChatDelta(
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
            { type: 'text', text: 'Reading first.' },
          ],
        },
      },
      fmt,
    );
    expect(delta.entries.map((e) => [e.role, e.entryId, e.text])).toEqual([
      ['assistant', 'a1', 'Reading first.'],
      ['tool', 't1', 'Read a.ts'],
    ]);
  });

  it('marks a tool row done when its result lands, as an upsert', () => {
    const store = new AgentStateStore();
    const agent = createTestAgent();
    store.set(1, agent);
    const sent = collect(store);
    recordChat(
      1,
      agent,
      store,
      {
        type: 'assistant',
        uuid: 'a1',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
      },
      fmt,
    );
    recordChat(
      1,
      agent,
      store,
      {
        type: 'user',
        uuid: 'u2',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] },
      },
      fmt,
    );
    const chat = sent.filter((m) => m.type === 'agentChatEntry');
    expect(chat).toHaveLength(2);
    expect(chat[1].entry).toMatchObject({ entryId: 't1', toolDone: true });
    expect(agent.chatLog).toHaveLength(1);
  });

  it("keeps a lead's sidechain records (its sub-agents) out of its chat", () => {
    const store = new AgentStateStore();
    const agent = createTestAgent();
    store.set(1, agent);
    recordChat(1, agent, store, { type: 'user', uuid: 'u1', message: { content: 'go' } }, fmt);
    recordChat(
      1,
      agent,
      store,
      { type: 'assistant', uuid: 'a1', isSidechain: true, message: { content: 'sub talk' } },
      fmt,
    );
    expect(agent.chatLog?.map((e) => e.text)).toEqual(['go']);
  });

  it('tags a prompt typed from the office by matching its text', () => {
    const store = new AgentStateStore();
    const agent = createTestAgent({ pendingOfficeTexts: ['ship it'] });
    store.set(1, agent);
    recordChat(1, agent, store, { type: 'user', uuid: 'u1', message: { content: 'ship it' } }, fmt);
    recordChat(1, agent, store, { type: 'user', uuid: 'u2', message: { content: 'ship it' } }, fmt);
    expect(agent.chatLog?.map((e) => e.source)).toEqual(['office', 'terminal']);
  });

  it('seeds only the transcript before the read offset, once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-chat-'));
    const file = path.join(dir, 's.jsonl');
    const before =
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'old prompt' } }) + '\n';
    const after =
      JSON.stringify({ type: 'user', uuid: 'u2', message: { content: 'new prompt' } }) + '\n';
    fs.writeFileSync(file, before + after);
    const store = new AgentStateStore();
    const agent = createTestAgent({ jsonlFile: file, fileOffset: Buffer.byteLength(before) });
    store.set(1, agent);
    const sent = collect(store);
    seedChatHistory(1, store, fmt);
    seedChatHistory(1, store, fmt);
    expect(agent.chatLog?.map((e) => e.text)).toEqual(['old prompt']);
    expect(sent.filter((m) => m.type === 'agentChatHistory')).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('ChatSender', () => {
  let store: AgentStateStore;
  let sender: ChatSender;
  let written: string[];

  beforeEach(() => {
    store = new AgentStateStore();
    sender = new ChatSender(store);
    written = [];
    sender.setWriter({ canWrite: (a) => !a.isExternal, write: (_a, text) => written.push(text) });
  });

  afterEach(() => sender.dispose());

  it('types straight in when the agent is idle and remembers it came from the office', () => {
    const agent = createTestAgent();
    store.set(1, agent);
    sender.send(1, 'hello\u001b[201~ there');
    expect(written).toEqual(['hello[201~ there']);
    expect(agent.pendingOfficeTexts).toEqual(['hello[201~ there']);
  });

  it('holds messages during a turn and a permission prompt, then sends one per turn end', () => {
    store.set(1, createTestAgent());
    store.broadcast({ type: 'agentStatus', id: 1, status: 'active' });
    sender.send(1, 'first');
    sender.send(1, 'second');
    expect(written).toEqual([]);
    store.get(1)!.permissionSent = true;
    store.broadcast({ type: 'agentStatus', id: 1, status: 'waiting' });
    expect(written).toEqual([]);
    store.get(1)!.permissionSent = false;
    store.broadcast({ type: 'agentToolPermissionClear', id: 1 });
    expect(written).toEqual(['first']);
    store.broadcast({ type: 'agentStatus', id: 1, status: 'waiting' });
    expect(written).toEqual(['first', 'second']);
  });

  it('cancels a queued message', () => {
    store.set(1, createTestAgent());
    store.broadcast({ type: 'agentStatus', id: 1, status: 'active' });
    const sent = collect(store);
    sender.send(1, 'later');
    const queueId = (sender.snapshot()[0].queued[0] as { queueId: string }).queueId;
    sender.cancel(1, queueId);
    store.broadcast({ type: 'agentStatus', id: 1, status: 'waiting' });
    expect(written).toEqual([]);
    expect(sent.at(-2)).toMatchObject({ type: 'agentChatQueue', id: 1, queued: [] });
  });

  it('refuses agents without an office terminal, with a reason', () => {
    store.set(1, createTestAgent({ isExternal: true }));
    const sent = collect(store);
    sender.send(1, 'hi');
    expect(written).toEqual([]);
    expect(sent[0]).toMatchObject({ type: 'agentChatQueue', id: 1, queued: [] });
    expect(sent[0].error).toBeTruthy();
  });
});

describe('BoardStore', () => {
  let dir: string;
  let file: string;
  let boards: BoardStore[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-board-'));
    file = path.join(dir, 'board.json');
    boards = [];
  });

  afterEach(() => {
    for (const b of boards) b.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function board(onChange = vi.fn()): BoardStore {
    const b = new BoardStore(onChange, file);
    boards.push(b);
    return b;
  }

  const pin = {
    id: 'p1',
    kind: 'link',
    title: 'Spec',
    value: 'https://x.dev',
    scope: [],
    createdAt: 'now',
  };

  it('rejects malformed pins and bounds the rest', () => {
    expect(sanitizePin({ ...pin, kind: 'script' })).toBeNull();
    expect(sanitizePin({ ...pin, id: '../etc' })).toBeNull();
    expect(sanitizePin({ ...pin, title: '   ' })).toBeNull();
    expect(sanitizePin({ ...pin, scope: [1, 1, 'x', 2.5, 3] })?.scope).toEqual([1, 3]);
  });

  it('saves, replaces and removes pins, persisting and announcing each change', () => {
    const onChange = vi.fn();
    const b = board(onChange);
    expect(b.savePin(pin)).toBe(true);
    expect(b.savePin({ ...pin, title: 'Spec v2' })).toBe(true);
    expect(b.getPins().map((p) => p.title)).toEqual(['Spec v2']);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).pins).toHaveLength(1);
    expect(b.removePin('p1')).toBe(true);
    expect(b.removePin('p1')).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange.mock.lastCall?.[0]).toEqual([]);
  });

  it("reads another window's board file on load", () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, pins: [pin, { id: 'bad' }] }));
    expect(
      board()
        .getPins()
        .map((p) => p.id),
    ).toEqual(['p1']);
  });
});
