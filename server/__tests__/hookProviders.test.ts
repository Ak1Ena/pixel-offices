import { describe, expect, it } from 'vitest';

import { codexProvider } from '../src/providers/hook/codex/codex.js';
import { geminiProvider } from '../src/providers/hook/gemini/gemini.js';
import { genericProvider } from '../src/providers/hook/generic/generic.js';

/**
 * normalizeHookEvent for the non-Claude providers: every raw CLI field is read
 * by the provider, and the runtime only ever sees the AgentEvent union. None
 * of them may report a transcript path — their agents are hooks-only.
 */

describe('codexProvider.normalizeHookEvent', () => {
  const base = { session_id: 'codex-s1', turn_id: 't1', cwd: '/w', model: 'gpt-5' };

  it('SessionStart -> sessionStart with cwd and source, never a transcript path', () => {
    const n = codexProvider.normalizeHookEvent({
      ...base,
      hook_event_name: 'SessionStart',
      source: 'startup',
      transcript_path: '/home/u/.codex/sessions/rollout.jsonl',
    });
    expect(n).toEqual({
      sessionId: 'codex-s1',
      event: { kind: 'sessionStart', source: 'startup', cwd: '/w' },
    });
  });

  it('PreToolUse / PostToolUse pair on tool_use_id', () => {
    const start = codexProvider.normalizeHookEvent({
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_use_id: 'call_1',
    });
    expect(start?.event).toEqual({
      kind: 'toolStart',
      toolId: 'codex-call_1',
      toolName: 'Bash',
      input: { command: 'npm test' },
    });
    const end = codexProvider.normalizeHookEvent({
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_response: 'ok',
      tool_use_id: 'call_1',
    });
    expect(end?.event).toEqual({ kind: 'toolEnd', toolId: 'codex-call_1' });
  });

  it('maps the rest of the lifecycle', () => {
    const kind = (raw: Record<string, unknown>) =>
      codexProvider.normalizeHookEvent({ ...base, ...raw })?.event;
    expect(kind({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' })).toEqual({
      kind: 'permissionRequest',
    });
    expect(kind({ hook_event_name: 'Stop', last_assistant_message: 'done' })).toEqual({
      kind: 'turnEnd',
    });
    expect(kind({ hook_event_name: 'Interrupt' })).toEqual({
      kind: 'turnEnd',
      awaitingInput: true,
    });
    expect(kind({ hook_event_name: 'SessionEnd', reason: 'exit' })).toEqual({
      kind: 'sessionEnd',
      reason: 'exit',
    });
    expect(
      kind({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'explorer' }),
    ).toEqual({
      kind: 'subagentStart',
      parentToolId: 'codex-sub-a1',
      toolId: 'codex-sub-a1',
      toolName: 'explorer',
    });
    expect(kind({ hook_event_name: 'SubagentStop', agent_id: 'a1' })).toEqual({
      kind: 'subagentEnd',
      parentToolId: 'codex-sub-a1',
      toolId: 'codex-sub-a1',
    });
  });

  it('drops prompt text, compaction and malformed payloads', () => {
    expect(
      codexProvider.normalizeHookEvent({
        ...base,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'x',
      }),
    ).toBeNull();
    expect(codexProvider.normalizeHookEvent({ ...base, hook_event_name: 'PreCompact' })).toBeNull();
    expect(codexProvider.normalizeHookEvent({ hook_event_name: 'Stop' })).toBeNull();
  });

  it('formats Codex tool statuses', () => {
    expect(codexProvider.formatToolStatus('Bash', { command: 'ls -la' })).toBe('Running: ls -la');
    expect(
      codexProvider.formatToolStatus('exec_command', { cmd: ['bash', '-lc', 'git status'] }),
    ).toBe('Running: git status');
    expect(
      codexProvider.formatToolStatus('apply_patch', {
        input: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n',
      }),
    ).toBe('Editing app.ts');
    expect(codexProvider.formatToolStatus('mcp__github__create_issue', {})).toBe(
      'Using github: create_issue',
    );
  });

  it('describes a held PermissionRequest (and only a held one)', () => {
    const raw = {
      ...base,
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' },
    };
    expect(codexProvider.describePermissionRequest?.(raw)).toBeNull();
    expect(codexProvider.describePermissionRequest?.({ ...raw, pixel_request_id: 'r1' })).toEqual({
      toolName: 'Bash',
      detail: 'rm -rf build',
    });
  });
});

describe('geminiProvider.normalizeHookEvent', () => {
  const base = { session_id: 'gem-s1', cwd: '/w', timestamp: '2026-01-01T00:00:00Z' };

  it('pairs BeforeTool/AfterTool FIFO per tool name (no tool id in the payload)', () => {
    const before = (tool: string) =>
      geminiProvider.normalizeHookEvent({
        ...base,
        hook_event_name: 'BeforeTool',
        tool_name: tool,
        tool_input: {},
      })?.event as { kind: string; toolId: string };
    const after = (tool: string) =>
      geminiProvider.normalizeHookEvent({
        ...base,
        hook_event_name: 'AfterTool',
        tool_name: tool,
        tool_input: {},
        tool_response: {},
      })?.event as { kind: string; toolId: string };

    const readA = before('read_file');
    const readB = before('read_file');
    const shell = before('run_shell_command');
    expect(readA.kind).toBe('toolStart');
    expect(new Set([readA.toolId, readB.toolId, shell.toolId]).size).toBe(3);
    expect(after('run_shell_command')).toEqual({ kind: 'toolEnd', toolId: shell.toolId });
    expect(after('read_file')).toEqual({ kind: 'toolEnd', toolId: readA.toolId });
    expect(after('read_file')).toEqual({ kind: 'toolEnd', toolId: readB.toolId });
    // Nothing open: falls back to the handler's current tool.
    expect(after('read_file')).toEqual({ kind: 'toolEnd', toolId: 'current' });
  });

  it('re-normalizing the same payload returns the same result (no double push/pop)', () => {
    const raw = { ...base, hook_event_name: 'BeforeTool', tool_name: 'glob', tool_input: {} };
    const first = geminiProvider.normalizeHookEvent(raw);
    const second = geminiProvider.normalizeHookEvent(raw);
    expect(second).toBe(first);
    const end = { ...base, hook_event_name: 'AfterTool', tool_name: 'glob' };
    const closed = geminiProvider.normalizeHookEvent(end);
    expect(geminiProvider.normalizeHookEvent(end)).toBe(closed);
    expect(closed?.event).toEqual({
      kind: 'toolEnd',
      toolId: (first?.event as { toolId: string }).toolId,
    });
  });

  it('maps session, turn and permission events; no transcript path', () => {
    const n = (raw: Record<string, unknown>) =>
      geminiProvider.normalizeHookEvent({ ...base, ...raw })?.event ?? null;
    expect(
      n({ hook_event_name: 'SessionStart', source: 'startup', transcript_path: '/t.json' }),
    ).toEqual({
      kind: 'sessionStart',
      source: 'startup',
      cwd: '/w',
    });
    expect(n({ hook_event_name: 'AfterAgent', prompt_response: 'hi' })).toEqual({
      kind: 'turnEnd',
    });
    expect(
      n({ hook_event_name: 'Notification', notification_type: 'ToolPermission', message: 'm' }),
    ).toEqual({ kind: 'permissionRequest' });
    expect(n({ hook_event_name: 'Notification', notification_type: 'Other' })).toBeNull();
    expect(n({ hook_event_name: 'BeforeAgent', prompt: 'secret' })).toBeNull();
    expect(n({ hook_event_name: 'SessionEnd', reason: 'exit' })).toEqual({
      kind: 'sessionEnd',
      reason: 'exit',
    });
  });

  it('cannot answer permission prompts from a hook', () => {
    expect(geminiProvider.describePermissionRequest).toBeUndefined();
  });

  it('formats Gemini tool statuses and classifies reading tools', () => {
    expect(geminiProvider.formatToolStatus('run_shell_command', { command: 'npm run build' })).toBe(
      'Running: npm run build',
    );
    expect(geminiProvider.formatToolStatus('read_file', { absolute_path: '/a/b/c.ts' })).toBe(
      'Reading c.ts',
    );
    expect(geminiProvider.formatToolStatus('replace', { file_path: '/a/x.md' })).toBe(
      'Editing x.md',
    );
    expect(geminiProvider.readingTools.has('grep_search')).toBe(true);
    expect(geminiProvider.readingTools.has('write_file')).toBe(false);
  });
});

describe('genericProvider', () => {
  it('normalizes the documented canonical payload', () => {
    const n = (raw: Record<string, unknown>) =>
      genericProvider.normalizeHookEvent({ session_id: 'g1', ...raw })?.event ?? null;
    expect(n({ hook_event_name: 'SessionStart', cwd: '/w' })).toEqual({
      kind: 'sessionStart',
      source: undefined,
      cwd: '/w',
    });
    expect(n({ hook_event_name: 'PreToolUse', tool_name: 'deploy', tool_use_id: 'x' })).toEqual({
      kind: 'toolStart',
      toolId: 'generic-x',
      toolName: 'deploy',
      input: {},
    });
    expect(n({ hook_event_name: 'PostToolUse', tool_use_id: 'x' })).toEqual({
      kind: 'toolEnd',
      toolId: 'generic-x',
    });
    expect(n({ hook_event_name: 'Stop' })).toEqual({ kind: 'turnEnd' });
    expect(n({ hook_event_name: 'PermissionRequest' })).toEqual({ kind: 'permissionRequest' });
    expect(n({ hook_event_name: 'SessionEnd' })).toEqual({ kind: 'sessionEnd', reason: undefined });
    expect(n({ hook_event_name: 'Whatever' })).toBeNull();
  });

  it('installs nothing and reads agent_name', async () => {
    expect(await genericProvider.areHooksInstalled()).toBe(false);
    expect(genericProvider.agentNameFromEvent?.({ agent_name: '  Deploy bot\n' })).toBe(
      'Deploy bot',
    );
    expect(genericProvider.agentNameFromEvent?.({})).toBeUndefined();
  });
});
