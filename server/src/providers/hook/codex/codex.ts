import * as fs from 'fs';
import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { BASH_COMMAND_DISPLAY_MAX_LENGTH } from '../../../constants.js';
import {
  areHooksInstalled as installerAreHooksInstalled,
  getCodexHome,
  installHooks as installerInstallHooks,
  uninstallHooks as installerUninstallHooks,
} from './codexHookInstaller.js';
import { CODEX_CONSENT_DISCLOSURE, CODEX_CONSENT_HEADLINE } from './consentCopy.js';
import { CODEX_TERMINAL_NAME_PREFIX } from './constants.js';

/**
 * OpenAI Codex CLI provider. Hooks-only: Codex writes rollout transcripts, but
 * their format is not Claude's JSONL, so this provider never reports a
 * transcript path and its agents are driven entirely by hook events (the
 * runtime's `hooksOnly` agents). Every raw Codex field is read HERE.
 */

function truncate(text: string, max = BASH_COMMAND_DISPLAY_MAX_LENGTH): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A shell command from a Codex tool input: `command` / `cmd`, a string or an argv array. */
function commandText(input: Record<string, unknown>): string {
  for (const key of ['command', 'cmd']) {
    const value = input[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const argv = value.filter((v): v is string => typeof v === 'string');
      // ["bash", "-lc", "<script>"] — the script is what the user recognizes.
      if (argv.length >= 3 && /(^|\/)(ba|z)?sh$/.test(argv[0]) && argv[1].startsWith('-')) {
        return argv.slice(2).join(' ');
      }
      return argv.join(' ');
    }
  }
  return '';
}

/** First file an apply_patch touches (`*** Update File: path`), if any. */
function patchTarget(input: Record<string, unknown>): string {
  const patch =
    typeof input.input === 'string'
      ? input.input
      : typeof input.patch === 'string'
        ? input.patch
        : commandText(input);
  const match = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(patch);
  return match ? path.basename(match[1].trim()) : '';
}

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = asRecord(input);
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    case 'Bash':
    case 'shell':
    case 'local_shell':
    case 'exec_command':
    case 'unified_exec':
      return `Running: ${truncate(commandText(inp))}`;
    case 'apply_patch': {
      const target = patchTarget(inp);
      return target ? `Editing ${target}` : 'Applying patch';
    }
    case 'Read':
      return `Reading ${base(inp.file_path)}`;
    case 'Edit':
      return `Editing ${base(inp.file_path)}`;
    case 'Write':
      return `Writing ${base(inp.file_path)}`;
    case 'view_image':
      return `Viewing ${base(inp.path)}`;
    case 'web_search':
    case 'WebSearch':
      return 'Searching the web';
    case 'update_plan':
      return 'Planning';
    case 'write_stdin':
      return 'Typing into a process';
    default: {
      // mcp__<server>__<tool>
      const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
      if (mcp) return `Using ${mcp[1]}: ${mcp[2]}`;
      return `Using ${toolName}`;
    }
  }
}

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string' || !sessionId) return null;

  switch (eventName) {
    case 'SessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.source === 'string' ? raw.source : undefined,
          // transcript_path deliberately NOT forwarded: it is a Codex rollout,
          // and a transcript path would make the runtime tail it with the
          // Claude JSONL parser. Without it the agent is hooks-only.
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        },
      };

    case 'SessionEnd':
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: typeof raw.reason === 'string' ? raw.reason : undefined,
        },
      };

    case 'PreToolUse': {
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : 'tool';
      const toolUseId = typeof raw.tool_use_id === 'string' ? raw.tool_use_id : '';
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: toolUseId ? `codex-${toolUseId}` : `codex-${toolName}-${Date.now()}`,
          toolName,
          input: asRecord(raw.tool_input),
        },
      };
    }

    case 'PostToolUse': {
      const toolUseId = typeof raw.tool_use_id === 'string' ? raw.tool_use_id : '';
      return {
        sessionId,
        event: { kind: 'toolEnd', toolId: toolUseId ? `codex-${toolUseId}` : 'current' },
      };
    }

    case 'PermissionRequest':
      return { sessionId, event: { kind: 'permissionRequest' } };

    case 'Stop':
      return { sessionId, event: { kind: 'turnEnd' } };

    case 'Interrupt':
      // The user interrupted the turn (Esc): Codex is back at its prompt.
      return { sessionId, event: { kind: 'turnEnd', awaitingInput: true } };

    case 'SubagentStart':
    case 'SubagentStop': {
      const agentId = typeof raw.agent_id === 'string' ? raw.agent_id : '';
      if (!agentId) return null;
      const parentToolId = `codex-sub-${agentId}`;
      if (eventName === 'SubagentStop') {
        return { sessionId, event: { kind: 'subagentEnd', parentToolId, toolId: parentToolId } };
      }
      const agentType = typeof raw.agent_type === 'string' ? raw.agent_type : 'subagent';
      return {
        sessionId,
        event: { kind: 'subagentStart', parentToolId, toolId: parentToolId, toolName: agentType },
      };
    }

    // UserPromptSubmit, PreCompact, PostCompact: not installed, nothing consumes them.
    default:
      return null;
  }
}

/**
 * A PermissionRequest the codex-hook script is holding open (tagged with
 * `pixel_request_id`). Codex takes an allow/deny from the hook's stdout in the
 * same shape as Claude Code, so the office can answer it.
 */
export function describePermissionRequest(
  raw: Record<string, unknown>,
): { toolName: string; detail?: string } | null {
  if (raw.hook_event_name !== 'PermissionRequest') return null;
  if (typeof raw.pixel_request_id !== 'string') return null;
  const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : 'Tool';
  const input = asRecord(raw.tool_input);
  const command = commandText(input).trim();
  if (command) return { toolName, detail: command };
  const target = patchTarget(input);
  if (target) return { toolName, detail: target };
  for (const key of ['file_path', 'path', 'url', 'query']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return { toolName, detail: value.trim() };
  }
  let detail: string | undefined;
  try {
    const json = JSON.stringify(input);
    detail = json === '{}' ? undefined : json;
  } catch {
    detail = undefined;
  }
  return { toolName, detail };
}

/** Whether Codex looks installed for this user (its config dir exists). The
 *  consent gate and startup install only consider Codex when it does, so a
 *  user without Codex is never asked about it. */
export function isCodexPresent(): boolean {
  try {
    return fs.statSync(getCodexHome()).isDirectory();
  } catch {
    return false;
  }
}

export const codexProvider: HookProvider = {
  kind: 'hook',
  id: 'codex',
  displayName: 'Codex',
  protocolVersion: 1,

  normalizeHookEvent,

  async installHooks(_serverUrl: string, _authToken: string): Promise<void> {
    await installerInstallHooks();
  },
  async uninstallHooks(): Promise<void> {
    await installerUninstallHooks();
  },
  areHooksInstalled(): Promise<boolean> {
    return Promise.resolve(installerAreHooksInstalled());
  },
  consentDisclosure() {
    return { headline: CODEX_CONSENT_HEADLINE, disclosure: CODEX_CONSENT_DISCLOSURE };
  },

  formatToolStatus,
  describePermissionRequest,
  permissionExemptTools: new Set(['update_plan']),
  // Codex sub-agents arrive as SubagentStart/SubagentStop, never as a tool.
  subagentToolNames: new Set<string>(),
  readingTools: new Set(['Read', 'view_image', 'web_search', 'WebSearch']),
  terminalNamePrefix: CODEX_TERMINAL_NAME_PREFIX,
};
