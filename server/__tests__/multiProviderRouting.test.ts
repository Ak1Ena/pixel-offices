import * as crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { codexProvider } from '../src/providers/hook/codex/codex.js';
import { geminiProvider } from '../src/providers/hook/gemini/gemini.js';
import { genericProvider } from '../src/providers/hook/generic/generic.js';

/**
 * Multi-provider routing: an event POSTed under /api/hooks/<id> is normalized
 * by THAT provider, creates a hooks-only agent that remembers it, and is
 * formatted by its rules. An unknown id is dropped.
 */
describe('AgentRuntime multi-provider routing', () => {
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let sent: Array<Record<string, unknown>>;

  beforeEach(() => {
    store = new AgentStateStore();
    sent = [];
    store.on('broadcast', (m) => sent.push(m));
    runtime = new AgentRuntime(store, claudeProvider, [
      codexProvider,
      geminiProvider,
      genericProvider,
    ]);
    runtime.watchAllSessions.current = true;
  });

  afterEach(() => runtime.dispose());

  const sid = () => `s-${crypto.randomUUID()}`;

  it('a Codex session becomes a hooks-only agent with Codex tool formatting', () => {
    const session = sid();
    runtime.handleHookEvent('codex', {
      hook_event_name: 'SessionStart',
      session_id: session,
      source: 'startup',
      cwd: '/tmp/codex-work',
      transcript_path: '/tmp/rollout.jsonl',
    });
    expect(store.size).toBe(0); // pending until a confirming event
    runtime.handleHookEvent('codex', {
      hook_event_name: 'PreToolUse',
      session_id: session,
      tool_name: 'exec_command',
      tool_input: { cmd: ['bash', '-lc', 'cargo test'] },
      tool_use_id: 'call_9',
    });
    expect(store.size).toBe(1);
    const [agent] = [...store.values()];
    expect(agent.hooksOnly).toBe(true);
    expect(agent.providerId).toBe('codex');
    expect(agent.jsonlFile).toBe('');
    expect(sent).toContainEqual({
      type: 'agentToolStart',
      id: agent.id,
      toolId: 'codex-call_9',
      status: 'Running: cargo test',
      toolName: 'exec_command',
    });

    runtime.handleHookEvent('codex', {
      hook_event_name: 'PostToolUse',
      session_id: session,
      tool_name: 'exec_command',
      tool_use_id: 'call_9',
    });
    expect(sent).toContainEqual({ type: 'agentToolDone', id: agent.id, toolId: 'codex-call_9' });
    expect(agent.activeToolIds.size).toBe(0);

    runtime.handleHookEvent('codex', { hook_event_name: 'Stop', session_id: session });
    expect(agent.isWaiting).toBe(true);

    runtime.handleHookEvent('codex', {
      hook_event_name: 'SessionEnd',
      session_id: session,
      reason: 'exit',
    });
    expect(store.size).toBe(0);
  });

  it('opens an office permission ask for Codex but never for Gemini', () => {
    const decider = runtime.permissions.addDecider();
    const codexSession = sid();
    runtime.handleHookEvent('codex', {
      hook_event_name: 'SessionStart',
      session_id: codexSession,
      cwd: '/tmp/w',
    });
    const ask = {
      hook_event_name: 'PermissionRequest',
      session_id: codexSession,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf dist' },
      pixel_request_id: crypto.randomUUID(),
    };
    runtime.handleHookEvent('codex', ask);
    expect(runtime.askPermission('codex', ask)).toBe(true);

    const geminiSession = sid();
    runtime.handleHookEvent('gemini', {
      hook_event_name: 'SessionStart',
      session_id: geminiSession,
      cwd: '/tmp/w',
    });
    const geminiAsk = {
      hook_event_name: 'Notification',
      notification_type: 'ToolPermission',
      session_id: geminiSession,
      pixel_request_id: crypto.randomUUID(),
    };
    runtime.handleHookEvent('gemini', geminiAsk);
    const geminiAgent = [...store.values()].find((a) => a.sessionId === geminiSession);
    expect(geminiAgent?.permissionSent).toBe(true);
    expect(runtime.askPermission('gemini', geminiAsk)).toBe(false);
    decider();
  });

  it('Gemini tools pair without ids and a finished tool clears the permission bubble', () => {
    const session = sid();
    runtime.handleHookEvent('gemini', {
      hook_event_name: 'SessionStart',
      session_id: session,
      cwd: '/w',
    });
    runtime.handleHookEvent('gemini', {
      hook_event_name: 'BeforeTool',
      session_id: session,
      tool_name: 'run_shell_command',
      tool_input: { command: 'make' },
    });
    const [agent] = [...store.values()];
    runtime.handleHookEvent('gemini', {
      hook_event_name: 'Notification',
      notification_type: 'ToolPermission',
      session_id: session,
    });
    expect(agent.permissionSent).toBe(true);
    runtime.handleHookEvent('gemini', {
      hook_event_name: 'AfterTool',
      session_id: session,
      tool_name: 'run_shell_command',
    });
    expect(agent.permissionSent).toBe(false);
    expect(sent).toContainEqual({ type: 'agentToolPermissionClear', id: agent.id });
    expect(agent.activeToolIds.size).toBe(0);
  });

  it('a Generic agent takes its agent_name as its label', () => {
    const session = sid();
    runtime.handleHookEvent('generic', {
      hook_event_name: 'SessionStart',
      session_id: session,
      cwd: '/w',
    });
    runtime.handleHookEvent('generic', {
      hook_event_name: 'PreToolUse',
      session_id: session,
      tool_name: 'deploy',
      agent_name: 'Deploy bot',
    });
    const [agent] = [...store.values()];
    expect(agent.displayName).toBe('Deploy bot');
    expect(agent.providerId).toBe('generic');
  });

  it('drops events for an unknown provider id', () => {
    const session = sid();
    runtime.handleHookEvent('nope', {
      hook_event_name: 'SessionStart',
      session_id: session,
      cwd: '/w',
    });
    runtime.handleHookEvent('nope', { hook_event_name: 'Stop', session_id: session });
    expect(store.size).toBe(0);
    expect(runtime.askPermission('nope', { session_id: session })).toBe(false);
  });

  it('does not adopt a hooks-only session outside tracked workspaces when Watch All is off', () => {
    runtime.watchAllSessions.current = false;
    const session = sid();
    runtime.handleHookEvent('codex', {
      hook_event_name: 'SessionStart',
      session_id: session,
      cwd: `/tmp/untracked-${crypto.randomUUID()}`,
    });
    runtime.handleHookEvent('codex', { hook_event_name: 'Stop', session_id: session });
    expect(store.size).toBe(0);
  });
});
