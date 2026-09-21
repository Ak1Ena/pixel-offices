import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { AGENT_NAME_MAX_CHARS, BASH_COMMAND_DISPLAY_MAX_LENGTH } from '../../../constants.js';

/**
 * The Generic HTTP provider (`generic`): a documented, tool-neutral event shape
 * any script can POST to `/api/hooks/generic` with the server's Bearer token
 * (docs/providers.md). Nothing is installed anywhere — the integrating tool
 * owns its own hook — so installHooks is a no-op, areHooksInstalled is always
 * false, and the provider is never part of the consent loop.
 *
 * Canonical payload:
 *   { session_id, hook_event_name, cwd?, tool_name?, tool_input?, tool_use_id?, agent_name? }
 * hook_event_name ∈ SessionStart | PreToolUse | PostToolUse | Stop |
 *                   PermissionRequest | SessionEnd
 */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = asRecord(input);
  const command = typeof inp.command === 'string' ? inp.command : '';
  if (command) {
    const cmd =
      command.length > BASH_COMMAND_DISPLAY_MAX_LENGTH
        ? command.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '…'
        : command;
    return `Running: ${cmd}`;
  }
  const file = typeof inp.file_path === 'string' ? inp.file_path : inp.path;
  if (typeof file === 'string' && file) return `${toolName} ${path.basename(file)}`;
  return `Using ${toolName}`;
}

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string' || !sessionId) return null;
  const toolUseId = typeof raw.tool_use_id === 'string' && raw.tool_use_id ? raw.tool_use_id : '';

  switch (eventName) {
    case 'SessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.source === 'string' ? raw.source : undefined,
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
      const toolName = typeof raw.tool_name === 'string' && raw.tool_name ? raw.tool_name : 'tool';
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: toolUseId ? `generic-${toolUseId}` : `generic-${toolName}-${Date.now()}`,
          toolName,
          input: asRecord(raw.tool_input),
        },
      };
    }
    case 'PostToolUse':
      return {
        sessionId,
        event: { kind: 'toolEnd', toolId: toolUseId ? `generic-${toolUseId}` : 'current' },
      };
    case 'Stop':
      return { sessionId, event: { kind: 'turnEnd' } };
    case 'PermissionRequest':
      return { sessionId, event: { kind: 'permissionRequest' } };
    default:
      return null;
  }
}

/** The optional `agent_name` field: the character's label when it has none yet. */
function agentNameFromEvent(raw: Record<string, unknown>): string | undefined {
  const name = raw.agent_name;
  if (typeof name !== 'string') return undefined;
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, AGENT_NAME_MAX_CHARS);
  return cleaned || undefined;
}

export const genericProvider: HookProvider = {
  kind: 'hook',
  id: 'generic',
  displayName: 'Generic HTTP',
  protocolVersion: 1,

  normalizeHookEvent,
  agentNameFromEvent,

  // Nothing to install: the integrating tool POSTs on its own.
  async installHooks(): Promise<void> {},
  async uninstallHooks(): Promise<void> {},
  areHooksInstalled(): Promise<boolean> {
    return Promise.resolve(false);
  },
  consentDisclosure() {
    return {
      headline: 'Generic HTTP events',
      disclosure: 'Nothing is installed: tools POST their own events to /api/hooks/generic.',
    };
  },

  formatToolStatus,
  permissionExemptTools: new Set<string>(),
  subagentToolNames: new Set<string>(),
  readingTools: new Set(['Read', 'read', 'read_file', 'search', 'grep', 'glob', 'fetch']),
};
