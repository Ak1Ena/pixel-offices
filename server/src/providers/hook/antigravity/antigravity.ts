import * as fs from 'fs';
import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { BASH_COMMAND_DISPLAY_MAX_LENGTH } from '../../../constants.js';
import { createAgyChatReader } from './agyTranscript.js';
import {
  areHooksInstalled as installerAreHooksInstalled,
  getAntigravityCliDir,
  installHooks as installerInstallHooks,
  uninstallHooks as installerUninstallHooks,
} from './antigravityHookInstaller.js';
import { ANTIGRAVITY_CONSENT_DISCLOSURE, ANTIGRAVITY_CONSENT_HEADLINE } from './consentCopy.js';
import { ANTIGRAVITY_TERMINAL_NAME_PREFIX } from './constants.js';

/**
 * Antigravity CLI provider (`agy`). Hooks-only: agy's transcript is not
 * Claude JSONL, so none is ever reported. The hook script (hooks/) already
 * turned agy's payload into `hook_event_name` + `session_id` (+ `cwd`) and
 * synthesized `SessionStart` on each model call. What is left here:
 *
 * - agy has no hook before a tool that is safe to install (see constants),
 *   so a tool shows when `PostToolUse` reports it and ends at the next model
 *   call (`PreInvocation`) or at `Stop`. One open tool per session.
 * - normalizeHookEvent runs more than once for the same payload (buffered or
 *   just-confirmed events are re-normalized), so results are memoized per
 *   payload object; a second call must not open or close a tool again.
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
  const str = (key: string) => (typeof inp[key] === 'string' ? (inp[key] as string) : '');
  const base = (key: string) => (str(key) ? path.basename(str(key)) : '');
  switch (toolName) {
    case 'run_command':
      return `Running: ${truncate(str('CommandLine'))}`;
    case 'view_file':
    case 'view_file_outline':
    case 'view_code_item':
      return `Reading ${base('AbsolutePath') || base('File') || 'file'}`;
    case 'write_to_file':
      return `Writing ${base('TargetFile') || 'file'}`;
    case 'replace_file_content':
    case 'multi_replace_file_content':
      return `Editing ${base('TargetFile') || 'file'}`;
    case 'list_dir':
      return `Listing ${base('DirectoryPath') || 'directory'}`;
    case 'grep_search':
    case 'codebase_search':
    case 'find_by_name':
      return 'Searching code';
    case 'read_url_content':
      return 'Fetching web content';
    case 'search_web':
      return 'Searching the web';
    case 'invoke_subagent':
      return 'Running subagent';
    default:
      // agy describes most calls itself ("Reading note file").
      return str('toolAction') || `Using ${toolName}`;
  }
}

type Normalized = { sessionId: string; event: AgentEvent } | null;

/** Per session: the tool shown now (reported by PostToolUse, not yet ended). */
const openTool = new Map<string, string>();
const memo = new WeakMap<object, Normalized>();
let toolCounter = 0;

function normalizeUncached(raw: Record<string, unknown>): Normalized {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string' || !sessionId) return null;

  switch (eventName) {
    case 'SessionStart':
      return {
        sessionId,
        event: { kind: 'sessionStart', cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined },
      };

    case 'PostToolUse': {
      const call = asRecord(raw.toolCall);
      const toolName = typeof call.name === 'string' ? call.name : 'tool';
      const toolId = `agy-${++toolCounter}`;
      openTool.set(sessionId, toolId);
      return {
        sessionId,
        event: { kind: 'toolStart', toolId, toolName, input: asRecord(call.args) },
      };
    }

    case 'PreInvocation': {
      const toolId = openTool.get(sessionId);
      if (!toolId) return null;
      openTool.delete(sessionId);
      return { sessionId, event: { kind: 'toolEnd', toolId } };
    }

    case 'Stop':
      openTool.delete(sessionId);
      return { sessionId, event: { kind: 'turnEnd' } };

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

/** Whether agy looks installed for this user (~/.gemini/antigravity-cli exists). */
export function isAntigravityPresent(): boolean {
  try {
    return fs.statSync(getAntigravityCliDir()).isDirectory();
  } catch {
    return false;
  }
}

export const antigravityProvider: HookProvider = {
  kind: 'hook',
  id: 'antigravity',
  displayName: 'Antigravity CLI',
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
    return { headline: ANTIGRAVITY_CONSENT_HEADLINE, disclosure: ANTIGRAVITY_CONSENT_DISCLOSURE };
  },

  formatToolStatus,
  chatTranscript: {
    pathFromEvent: (raw) =>
      typeof raw.transcriptPath === 'string' && raw.transcriptPath.endsWith('.jsonl')
        ? raw.transcriptPath
        : undefined,
    createReader: () => createAgyChatReader(formatToolStatus),
  },
  // No describePermissionRequest: agy's prompt is answered in the terminal.
  permissionExemptTools: new Set<string>(),
  subagentToolNames: new Set<string>(),
  readingTools: new Set([
    'view_file',
    'view_file_outline',
    'view_code_item',
    'list_dir',
    'grep_search',
    'codebase_search',
    'find_by_name',
    'read_url_content',
    'search_web',
  ]),
  terminalNamePrefix: ANTIGRAVITY_TERMINAL_NAME_PREFIX,
};
