import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { antigravityProvider } from '../src/providers/hook/antigravity/antigravity.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';

/**
 * agy the office started: its character exists before agy says anything,
 * and takes over agy's conversation when the first hook names the office's
 * terminal pid among its ancestors — whatever Watch All Sessions says.
 */
describe('agy runs the office started', () => {
  let store: AgentStateStore;
  let runtime: AgentRuntime;

  beforeEach(() => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, [antigravityProvider]);
    runtime.watchAllSessions.current = false;
  });
  afterEach(() => runtime.dispose());

  it('shows the agent at once, then moves it onto the conversation its pid reports', () => {
    runtime.followLaunchedPid(4242, 'agy-k1', '/work/app');
    runtime.adoptLaunchedHooksSession('agy-k1', '/work/app', 'antigravity');
    runtime.adoptLaunchedHooksSession('agy-k1', '/work/app', 'antigravity'); // idempotent
    expect(store.size).toBe(1);
    const [agent] = [...store.values()];
    expect(agent).toMatchObject({ sessionId: 'agy-k1', launchKey: 'agy-k1', hooksOnly: true });

    // First hook: no cwd (Windows), ancestors include the terminal's pid.
    runtime.handleHookEvent('antigravity', {
      hook_event_name: 'SessionStart',
      session_id: 'conv-1',
      cli_pids: [99, 4242],
    });
    runtime.handleHookEvent('antigravity', {
      hook_event_name: 'PostToolUse',
      session_id: 'conv-1',
      toolCall: { name: 'run_command', args: { CommandLine: 'ls' } },
    });
    expect(store.size).toBe(1);
    expect(agent.sessionId).toBe('conv-1');
    expect(agent.launchKey).toBe('agy-k1');
    expect(agent.activeToolNames.size).toBe(1);

    runtime.endLaunched('agy-k1');
    expect(store.size).toBe(0);
  });

  it('leaves an agy conversation from an unrelated pid alone (Watch All off)', () => {
    runtime.followLaunchedPid(4242, 'agy-k1', '/work/app');
    runtime.handleHookEvent('antigravity', {
      hook_event_name: 'SessionStart',
      session_id: 'conv-2',
      cwd: '/elsewhere',
      cli_pids: [77],
    });
    runtime.handleHookEvent('antigravity', { hook_event_name: 'Stop', session_id: 'conv-2' });
    expect(store.size).toBe(0);
  });
});

describe('agy chat from its own transcript', () => {
  it('reads prompts, replies and tool rows, and marks tools done on their result', async () => {
    const { createAgyChatReader } =
      await import('../src/providers/hook/antigravity/agyTranscript.js');
    const read = createAgyChatReader(antigravityProvider.formatToolStatus);
    const line = (o: object) => JSON.stringify(o);
    expect(
      read(
        line({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          created_at: 't0',
          content:
            '<USER_REQUEST>\nhi?\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nx\n</ADDITIONAL_METADATA>',
        }),
      ).entries,
    ).toEqual([{ entryId: 'agy-0', role: 'user', text: 'hi?', timestamp: 't0' }]);
    const tool = read(
      line({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'cat note.txt' } }],
      }),
    );
    expect(tool.entries).toMatchObject([
      { entryId: 'agy-1-t0', role: 'tool', text: 'Running: cat note.txt' },
    ]);
    expect(read(line({ step_index: 2, type: 'GENERIC', status: 'DONE' })).doneToolIds).toEqual([
      'agy-1-t0',
    ]);
    expect(
      read(line({ step_index: 3, type: 'PLANNER_RESPONSE', content: 'hello' })).entries,
    ).toMatchObject([{ entryId: 'agy-3', role: 'assistant', text: 'hello' }]);
    expect(read(line({ step_index: 4, type: 'SYSTEM_MESSAGE', content: 'x' })).entries).toEqual([]);
    expect(read('not json').entries).toEqual([]);
  });

  it('tails the transcript into the agent chat, history first, then new lines', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-agy-chat-'));
    const file = path.join(dir, 'transcript_full.jsonl');
    const step = (o: object) => JSON.stringify(o) + '\n';
    fs.writeFileSync(
      file,
      step({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        content: '<USER_REQUEST>hi</USER_REQUEST>',
      }),
    );
    const store = new AgentStateStore();
    const sent: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => sent.push(m));
    const runtime = new AgentRuntime(store, claudeProvider, [antigravityProvider]);
    runtime.watchAllSessions.current = true;
    try {
      const base = { session_id: 'conv-9', cwd: dir, transcriptPath: file };
      runtime.handleHookEvent('antigravity', { ...base, hook_event_name: 'SessionStart' });
      runtime.handleHookEvent('antigravity', { ...base, hook_event_name: 'Stop' });
      const [agent] = [...store.values()];
      expect(agent.chatLog?.map((e) => e.text)).toEqual(['hi']);

      fs.appendFileSync(
        file,
        step({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'hello there' }),
      );
      runtime.handleHookEvent('antigravity', { ...base, hook_event_name: 'Stop' });
      expect(agent.chatLog?.map((e) => e.text)).toEqual(['hi', 'hello there']);
      expect(sent).toContainEqual(
        expect.objectContaining({ type: 'agentChatEntry', id: agent.id }),
      );
    } finally {
      runtime.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
