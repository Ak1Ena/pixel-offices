import * as fs from 'fs';
import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { BASH_COMMAND_DISPLAY_MAX_LENGTH } from '../../../constants.js';
import { GEMINI_CONSENT_DISCLOSURE, GEMINI_CONSENT_HEADLINE } from './consentCopy.js';
import { GEMINI_TERMINAL_NAME_PREFIX, GEMINI_TOOL_PERMISSION_NOTIFICATION } from './constants.js';
import {
  areHooksInstalled as installerAreHooksInstalled,
  getGeminiConfigDir,
  installHooks as installerInstallHooks,
  uninstallHooks as installerUninstallHooks,
} from './geminiHookInstaller.js';

/**
 * Google Gemini CLI provider. Hooks-only (Gemini's chat logs are not Claude
 * JSONL, so no transcript path is ever reported). Two Gemini-specific gaps are
 * bridged here:
 *
 * - BeforeTool/AfterTool carry NO tool-call id. Ids are synthesized per session
 *   and paired start→end FIFO by tool name. normalizeHookEvent is called more
 *   than once for the same payload (the runtime re-normalizes a buffered or
 *   just-confirmed event), so results are memoized per payload object — a
 *   second call must not push or pop the queue again.
 * - The permission prompt arrives as Notification(ToolPermission), which a hook
 *   cannot answer. It shows the bubble; there is deliberately no
 *   describePermissionRequest, so the office never offers Allow/Deny.
 */

function truncate(text: string, max = BASH_COMMAND_DISPLAY_MAX_LENGTH): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = asRecord(input);
  const base = (...keys: string[]) => {
    for (const key of keys) {
      if (typeof inp[key] === 'string') return path.basename(inp[key] as string);
    }
    return '';
  };
  switch (toolName) {
    case 'run_shell_command':
      return `Running: ${truncate(typeof inp.command === 'string' ? inp.command : '')}`;
    case 'read_file':
      return `Reading ${base('absolute_path', 'file_path', 'path')}`;
    case 'read_many_files':
      return 'Reading files';
    case 'write_file':
      return `Writing ${base('file_path', 'absolute_path', 'path')}`;
    case 'replace':
      return `Editing ${base('file_path', 'absolute_path', 'path')}`;
    case 'glob':
      return 'Searching files';
    case 'grep_search':
    case 'search_file_content':
      return 'Searching code';
    case 'list_directory':
      return `Listing ${base('dir_path', 'path') || 'directory'}`;
    case 'web_fetch':
      return 'Fetching web content';
    case 'google_web_search':
      return 'Searching the web';
    case 'invoke_agent':
      return 'Running subagent';
    case 'ask_user':
      return 'Waiting for your answer';
    case 'write_todos':
      return 'Planning';
    case 'save_memory':
      return 'Saving memory';
    default:
      return `Using ${toolName}`;
  }
}

type Normalized = { sessionId: string; event: AgentEvent } | null;

/** Per session: tool name → synthesized ids of calls started but not ended, oldest first. */
const openToolCalls = new Map<string, Map<string, string[]>>();
/** Results already computed for a payload object (see the module comment). */
const memo = new WeakMap<object, Normalized>();
let toolCallCounter = 0;

function startToolCall(sessionId: string, toolName: string): string {
  const id = `gemini-${++toolCallCounter}`;
  let byName = openToolCalls.get(sessionId);
  if (!byName) {
    byName = new Map();
    openToolCalls.set(sessionId, byName);
  }
  const queue = byName.get(toolName) ?? [];
  queue.push(id);
  byName.set(toolName, queue);
  return id;
}

function endToolCall(sessionId: string, toolName: string): string | undefined {
  const byName = openToolCalls.get(sessionId);
  const queue = byName?.get(toolName);
  const id = queue?.shift();
  if (queue && queue.length === 0) byName?.delete(toolName);
  return id;
}

function normalizeUncached(raw: Record<string, unknown>): Normalized {
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
          // transcript_path deliberately NOT forwarded (not Claude JSONL): the
          // agent is hooks-only.
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        },
      };

    case 'SessionEnd':
      openToolCalls.delete(sessionId);
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: typeof raw.reason === 'string' ? raw.reason : undefined,
        },
      };

    case 'BeforeTool': {
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : 'tool';
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: startToolCall(sessionId, toolName),
          toolName,
          input: asRecord(raw.tool_input),
        },
      };
    }

    case 'AfterTool': {
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : 'tool';
      return {
        sessionId,
        event: { kind: 'toolEnd', toolId: endToolCall(sessionId, toolName) ?? 'current' },
      };
    }

    case 'AfterAgent':
      // The turn is over: any call still open never got its AfterTool.
      openToolCalls.delete(sessionId);
      return { sessionId, event: { kind: 'turnEnd' } };

    case 'Notification':
      if (raw.notification_type === GEMINI_TOOL_PERMISSION_NOTIFICATION) {
        return { sessionId, event: { kind: 'permissionRequest' } };
      }
      return null;

    // BeforeAgent (prompt text), model/compress events: not installed.
    default:
      return null;
  }
}

function normalizeHookEvent(raw: Record<string, unknown>): Normalized {
  if (memo.has(raw)) return memo.get(raw) ?? null;
  const result = normalizeUncached(raw);
  memo.set(raw, result);
  return result;
}

/** Whether Gemini CLI looks installed for this user (~/.gemini exists). */
export function isGeminiPresent(): boolean {
  try {
    return fs.statSync(getGeminiConfigDir()).isDirectory();
  } catch {
    return false;
  }
}

export const geminiProvider: HookProvider = {
  kind: 'hook',
  id: 'gemini',
  displayName: 'Gemini CLI',
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
    return { headline: GEMINI_CONSENT_HEADLINE, disclosure: GEMINI_CONSENT_DISCLOSURE };
  },

  formatToolStatus,
  // No describePermissionRequest: Gemini's prompt cannot be answered by a hook.
  permissionExemptTools: new Set(['ask_user', 'write_todos']),
  subagentToolNames: new Set<string>(),
  readingTools: new Set([
    'read_file',
    'read_many_files',
    'glob',
    'grep_search',
    'search_file_content',
    'list_directory',
    'web_fetch',
    'google_web_search',
  ]),
  terminalNamePrefix: GEMINI_TERMINAL_NAME_PREFIX,
};
