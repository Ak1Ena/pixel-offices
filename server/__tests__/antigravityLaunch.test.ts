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
