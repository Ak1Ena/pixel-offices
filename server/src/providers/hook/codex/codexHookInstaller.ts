import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR, PERMISSION_HOOK_TIMEOUT_S } from '../../../constants.js';
import type { HookEntry } from '../hookSettingsInstaller.js';
import { copyHookScriptFile, createHookSettingsInstaller } from '../hookSettingsInstaller.js';
import {
  CODEX_CONFIG_DIR,
  CODEX_HOOK_EVENTS,
  CODEX_HOOK_SCRIPT_NAME,
  CODEX_HOOK_TIMEOUT_S,
  CODEX_HOOKS_FILE,
  CODEX_SESSION_END_TIMEOUT_S,
} from './constants.js';

/**
 * Codex's hook install: entries in ~/.codex/hooks.json. Same safety rules as
 * Claude's (they are the shared hookSettingsInstaller). One Codex-specific
 * fact the user must hear about: Codex SKIPS hooks it has not been told to
 * trust, so after an install nothing fires until the user runs `/hooks` in
 * Codex and trusts the Pixel Agents entries (see consentCopy.ts).
 */

/** Codex's config dir: $CODEX_HOME when set, else ~/.codex. */
export function getCodexHome(): string {
  const override = process.env['CODEX_HOME'];
  return override && override.trim() ? override : path.join(os.homedir(), CODEX_CONFIG_DIR);
}

function getHooksPath(): string {
  return path.join(getCodexHome(), CODEX_HOOKS_FILE);
}

/** ~/.pixel-agents/hooks/codex-hook.js */
function getHookScriptPath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, CODEX_HOOK_SCRIPT_NAME);
}

/** Seconds Codex gives our hook for one event. PermissionRequest holds the
 *  prompt while the office decides, so it gets the whole wait. */
function hookTimeoutFor(event?: string): number {
  if (event === 'PermissionRequest') return PERMISSION_HOOK_TIMEOUT_S;
  if (event === 'SessionEnd') return CODEX_SESSION_END_TIMEOUT_S;
  return CODEX_HOOK_TIMEOUT_S;
}

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
  settingsPath: getHooksPath,
  displayPath: `~/${CODEX_CONFIG_DIR}/${CODEX_HOOKS_FILE}`,
  backupLabel: 'Codex hooks',
  scriptSuffixes: [`/${HOOK_SCRIPTS_DIR}/${CODEX_HOOK_SCRIPT_NAME}`],
  events: CODEX_HOOK_EVENTS,
  makeHookEntry,
});

export const codexInstallerMessages = installer.messages;

export function areHooksInstalled(): boolean {
  return installer.areHooksInstalled();
}

export async function installHooks(): Promise<void> {
  await installer.installHooks();
  // Codex runs a new or changed hook only after the user trusts it.
  console.log(
    '[Pixel Agents] Codex: run /hooks inside Codex and trust the Pixel Agents entries — Codex skips untrusted hooks.',
  );
}

export function uninstallHooks(): Promise<void> {
  return installer.uninstallHooks();
}

/** Copy the shipped codex-hook.js to ~/.pixel-agents/hooks/. */
export function copyHookScript(packageRoot: string): boolean {
  return copyHookScriptFile(packageRoot, CODEX_HOOK_SCRIPT_NAME, getHookScriptPath());
}
