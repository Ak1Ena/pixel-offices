import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { BoardStore, sanitizePin } from '../src/boardStore.js';
import {
  clipEdit,
  extractChatDelta,
  recordChat,
  seedChatHistory,
  userPromptText,
} from '../src/chatLog.js';
import { ChatSender } from '../src/chatSender.js';
import { CHAT_EDIT_MAX_CHARS, CHAT_INTERRUPT_SEND_WAIT_MS } from '../src/constants.js';
import { describeEdit } from '../src/providers/hook/claude/claude.js';
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
    sender.addWriter({ canWrite: (a) => !a.isExternal, write: (_a, text) => written.push(text) });
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

  it("types the human's own message mid-turn but still holds the office's own", () => {
    store.set(1, createTestAgent());
    store.broadcast({ type: 'agentStatus', id: 1, status: 'active' });
    sender.send(1, 'card prompt');
    sender.send(1, 'read this too', { midTurn: true });
    expect(written).toEqual([]); // the card prompt is first in line and waits
    store.broadcast({ type: 'agentStatus', id: 1, status: 'waiting' });
    // The card prompt goes first, then the human's message rides along.
    expect(written).toEqual(['card prompt', 'read this too']);
    store.broadcast({ type: 'agentStatus', id: 1, status: 'active' });
    sender.send(1, 'and this', { midTurn: true });
    sender.send(1, 'and one more', { midTurn: true });
    expect(written).toEqual(['card prompt', 'read this too', 'and this', 'and one more']);
  });

  it('still holds a mid-turn message on a permission prompt', () => {
    store.set(1, createTestAgent());
    store.get(1)!.permissionSent = true;
    sender.send(1, 'answer later', { midTurn: true });
    expect(written).toEqual([]);
    store.get(1)!.permissionSent = false;
    store.broadcast({ type: 'agentToolPermissionClear', id: 1 });
    expect(written).toEqual(['answer later']);
  });

  it('holds while the terminal is not ready, then delivers on retry', () => {
    let ready = false;
    sender.addWriter({
      canWrite: (a) => a.id === 7,
      write: (_a, text) => written.push(`7:${text}`),
      ready: () => ready,
    });
    store.set(7, createTestAgent({ id: 7, isExternal: true }));
    sender.send(7, 'hello');
    expect(written).toEqual([]);
    ready = true;
    sender.retry(7);
    expect(written).toEqual(['7:hello']);
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

describe('ChatSender.interrupt (Stop)', () => {
  let store: AgentStateStore;
  let sender: ChatSender;
  let pressed: number[];

  beforeEach(() => {
    store = new AgentStateStore();
    sender = new ChatSender(store);
    pressed = [];
    sender.addWriter({
      canWrite: (a) => !a.isExternal,
      write: () => {},
      interrupt: (a) => pressed.push(a.id),
    });
  });

  afterEach(() => sender.dispose());

  it('presses Esc while the agent is mid-turn', () => {
    store.set(1, createTestAgent({ isWaiting: false }));
    expect(sender.interrupt(1)).toBe(true);
    expect(pressed).toEqual([1]);
  });

  it('presses Esc on a permission prompt even though the agent reads as waiting', () => {
    store.set(1, createTestAgent({ isWaiting: true, permissionSent: true }));
    expect(sender.interrupt(1)).toBe(true);
    expect(pressed).toEqual([1]);
  });

  it('refuses at an idle prompt, where Esc would open the rewind menu', () => {
    store.set(1, createTestAgent({ isWaiting: true }));
    expect(sender.interrupt(1)).toBe(false);
    expect(pressed).toEqual([]);
  });

  it('refuses sessions no writer reaches, and unknown agents', () => {
    store.set(1, createTestAgent({ isExternal: true }));
    expect(sender.interrupt(1)).toBe(false);
    expect(sender.interrupt(99)).toBe(false);
    expect(pressed).toEqual([]);
  });
});

describe('ChatSender "Send now" (sendChatMessage.interrupt)', () => {
  let store: AgentStateStore;
  let sender: ChatSender;
  let pressed: number[];
  let written: string[];

  beforeEach(() => {
    store = new AgentStateStore();
    sender = new ChatSender(store);
    pressed = [];
    written = [];
    sender.addWriter({
      canWrite: (a) => !a.isExternal,
      write: (_a, text) => written.push(text),
      interrupt: (a) => pressed.push(a.id),
    });
  });

  afterEach(() => {
    sender.dispose();
    vi.useRealTimers();
  });

  it('stops the turn, then types the message once the stopped turn has ended', () => {
    store.set(1, createTestAgent({ isWaiting: false }));
    store.broadcast({ type: 'agentStatus', id: 1, status: 'active' });
    sender.send(1, 'do this instead', { midTurn: true, interrupt: true });
    expect(pressed).toEqual([1]);
    expect(written).toEqual([]);
    store.get(1)!.isWaiting = true;
    store.broadcast({ type: 'agentStatus', id: 1, status: 'waiting' });
    expect(written).toEqual(['do this instead']);
  });

  it('goes ahead of messages already waiting in the queue', () => {
    store.set(1, createTestAgent({ isWaiting: false, permissionSent: true }));
    sender.send(1, 'queued earlier', { midTurn: true });
    sender.send(1, 'urgent', { midTurn: true, interrupt: true });
    expect(pressed).toEqual([1]);
    store.get(1)!.permissionSent = false;
    store.get(1)!.isWaiting = true;
    store.broadcast({ type: 'agentStatus', id: 1, status: 'waiting' });
    expect(written).toEqual(['urgent', 'queued earlier']);
  });

  it('types it anyway when the stopped turn never reports its end', () => {
    // The queue's backstop tick must run on the fake clock: start a fresh sender under it.
    sender.dispose();
    vi.useFakeTimers();
    sender = new ChatSender(store);
    sender.addWriter({
      canWrite: (a) => !a.isExternal,
      write: (_a, text) => written.push(text),
      interrupt: (a) => pressed.push(a.id),
    });
    store.set(1, createTestAgent({ isWaiting: false }));
    store.broadcast({ type: 'agentStatus', id: 1, status: 'active' });
    sender.send(1, 'hello', { midTurn: true, interrupt: true });
    expect(written).toEqual([]);
    vi.advanceTimersByTime(CHAT_INTERRUPT_SEND_WAIT_MS + 2_500);
    expect(written).toEqual(['hello']);
  });

  it('just sends to an idle agent (nothing to stop; Esc would open the rewind menu)', () => {
    store.set(1, createTestAgent({ isWaiting: true }));
    sender.send(1, 'hi', { midTurn: true, interrupt: true });
    expect(pressed).toEqual([]);
    expect(written).toEqual(['hi']);
  });
});

describe('chat edits (Messenger diff cards)', () => {
  it('Claude describes Edit, MultiEdit and Write as the change they make', () => {
    expect(
      describeEdit('Edit', { file_path: '/r/a.ts', old_string: 'x', new_string: 'y' }),
    ).toEqual({ path: '/r/a.ts', kind: 'edit', hunks: [{ removed: 'x', added: 'y' }] });
    expect(
      describeEdit('MultiEdit', {
        file_path: '/r/a.ts',
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd' },
        ],
      })?.hunks,
    ).toHaveLength(2);
    expect(describeEdit('Write', { file_path: '/r/n.ts', content: 'hi' })).toEqual({
      path: '/r/n.ts',
      kind: 'write',
      hunks: [{ removed: '', added: 'hi' }],
    });
    expect(describeEdit('Read', { file_path: '/r/a.ts' })).toBeNull();
    expect(describeEdit('Edit', {})).toBeNull();
  });

  it('attaches the edit to its tool row', () => {
    const delta = extractChatDelta(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Edit',
              input: { file_path: '/r/a.ts', old_string: 'x', new_string: 'y' },
            },
          ],
        },
      },
      fmt,
      describeEdit,
    );
    expect(delta.entries[0]).toMatchObject({
      entryId: 'toolu_1',
      role: 'tool',
      edit: { path: '/r/a.ts', kind: 'edit' },
    });
  });

  it('shows files a Bash command changed as their own diff rows', () => {
    const delta = extractChatDelta(
      {
        type: 'user',
        timestamp: '2026-09-22T06:26:00Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b' }] },
        toolUseResult: {
          stdout: '',
          bashEditDiff: {
            files: [
              {
                filePath: '/r/new.test.ts',
                hunks: [
                  { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] },
                ],
              },
              {
                filePath: '/r/old.ts',
                hunks: [
                  {
                    oldStart: 4,
                    oldLines: 5,
                    newStart: 4,
                    newLines: 5,
                    lines: [' one', '-two', '+TWO', ' three', ' four', '-five', '+FIVE'],
                  },
                ],
              },
            ],
          },
        },
      },
      fmt,
    );
    expect(delta.doneToolIds).toEqual(['toolu_b']);
    expect(delta.entries).toEqual([
      {
        timestamp: '2026-09-22T06:26:00Z',
        entryId: 'toolu_b:file:0',
        role: 'tool',
        text: 'Created new.test.ts',
        toolDone: true,
        edit: { path: '/r/new.test.ts', kind: 'write', hunks: [{ removed: '', added: 'a\nb' }] },
      },
      {
        timestamp: '2026-09-22T06:26:00Z',
        entryId: 'toolu_b:file:1',
        role: 'tool',
        text: 'Changed old.ts',
        toolDone: true,
        edit: {
          path: '/r/old.ts',
          kind: 'edit',
          hunks: [
            { removed: 'one\ntwo\nthree', added: 'one\nTWO\nthree' },
            { removed: 'four\nfive', added: 'four\nFIVE' },
          ],
        },
      },
    ]);
  });

  it('bounds an edit across all its hunks and says it was cut', () => {
    const big = 'x'.repeat(CHAT_EDIT_MAX_CHARS);
    const clipped = clipEdit({
      path: '/r/a.ts',
      kind: 'edit',
      hunks: [
        { removed: 'old', added: big },
        { removed: 'more', added: 'y' },
      ],
    })!;
    const total = clipped.hunks.reduce((n, h) => n + h.removed.length + h.added.length, 0);
    expect(total).toBe(CHAT_EDIT_MAX_CHARS);
    expect(clipped.clipped).toBe(true);
    expect(clipEdit({ path: '/r/a.ts', kind: 'edit', hunks: [{ removed: '', added: '' }] })).toBe(
      undefined,
    );
  });
});
