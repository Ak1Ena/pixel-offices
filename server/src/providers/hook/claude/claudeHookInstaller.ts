import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR, PERMISSION_HOOK_TIMEOUT_S } from '../../../constants.js';
import type { HookEntry } from '../hookSettingsInstaller.js';
import { copyHookScriptFile, createHookSettingsInstaller } from '../hookSettingsInstaller.js';
import {
  CLAUDE_HOOK_EVENTS,
  CLAUDE_HOOK_SCRIPT_NAME,
  LEGACY_HOOK_SCRIPT_NAME,
} from './constants.js';

/**
 * Claude Code's hook install: entries in ~/.claude/settings.json. Every safety
 * rule (never rewrite an unparseable file or a shape we did not author,
 * one-time backup, atomic verified write, anchored hook identity) lives in the
 * shared hookSettingsInstaller.ts; this module only states Claude's specifics.
 */

/** Returns the absolute path to ~/.claude/settings.json. */
function getClaudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/** Returns the destination path for the hook script (~/.pixel-agents/hooks/claude-hook.js). */
function getHookScriptPath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, CLAUDE_HOOK_SCRIPT_NAME);
}

/** Seconds Claude Code gives our hook for one event. PermissionRequest holds
 *  the prompt while the office decides (claude-hook.ts), so it gets the whole
 *  wait; every other event only POSTs and exits. */
function hookTimeoutFor(event?: string): number {
  return event === 'PermissionRequest' ? PERMISSION_HOOK_TIMEOUT_S : 5;
}

/** Create a hook entry object for Claude's settings.json. Matcher is empty (catch-all). */
function makeHookEntry(event?: string): HookEntry {
  return {
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: `node "${getHookScriptPath()}"`,
        timeout: hookTimeoutFor(event),
      },
    ],
  };
}

const installer = createHookSettingsInstaller({
  settingsPath: getClaudeSettingsPath,
  displayPath: '~/.claude/settings.json',
  backupLabel: 'Claude settings',
  // `/.pixel-agents/hooks/claude-hook.js`, plus the pre-rename script name so a
  // very old install can still be migrated or removed.
  scriptSuffixes: [
    `/${HOOK_SCRIPTS_DIR}/${CLAUDE_HOOK_SCRIPT_NAME}`,
    `/${LEGACY_HOOK_SCRIPT_NAME}`,
  ],
  events: CLAUDE_HOOK_EVENTS,
  makeHookEntry,
});

/** Surfaced to the user when settings.json exists but cannot be parsed. */
export const SETTINGS_UNPARSEABLE_MESSAGE = installer.messages.unparseable;
/** Surfaced when settings.json keeps changing under us across all retry attempts. */
export const SETTINGS_CONCURRENT_WRITE_MESSAGE = installer.messages.concurrentWrite;
/** Surfaced when `hooks` itself is not an object. */
export const SETTINGS_HOOKS_NOT_OBJECT_MESSAGE = installer.messages.hooksNotObject;
/** Surfaced when a `hooks.<Event>` field holds something other than an array. */
export const settingsNonArrayEventMessage = installer.messages.nonArrayEvent;
/** Surfaced when the backup path is occupied by something that is not a copy. */
export const settingsUnusableBackupMessage = installer.messages.unusableBackup;

/** Whether ANY Pixel Agents hook command is present in ~/.claude/settings.json. */
export function areHooksInstalled(): boolean {
  return installer.areHooksInstalled();
}

/** Install (idempotently) our entries for every CLAUDE_HOOK_EVENTS event. */
export function installHooks(): Promise<void> {
  return installer.installHooks();
}

/** Remove all Pixel Agents hook entries from ~/.claude/settings.json. */
export function uninstallHooks(): Promise<void> {
  return installer.uninstallHooks();
}

/** Copy the shipped hook script from the extension to ~/.pixel-agents/hooks/. */
export function copyHookScript(extensionPath: string): boolean {
  return copyHookScriptFile(extensionPath, CLAUDE_HOOK_SCRIPT_NAME, getHookScriptPath());
}
