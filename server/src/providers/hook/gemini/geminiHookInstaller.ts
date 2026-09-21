import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import { PIXEL_AGENTS_HOOK_NAME } from '../constants.js';
import type { HookEntry } from '../hookSettingsInstaller.js';
import { copyHookScriptFile, createHookSettingsInstaller } from '../hookSettingsInstaller.js';
import {
  GEMINI_CONFIG_DIR,
  GEMINI_HOOK_EVENTS,
  GEMINI_HOOK_SCRIPT_NAME,
  GEMINI_HOOK_TIMEOUT_MS,
  GEMINI_SETTINGS_FILE,
} from './constants.js';

/**
 * Gemini's hook install: entries under `hooks` in ~/.gemini/settings.json.
 * That file holds all of the user's other Gemini settings, so the shared
 * installer's merge-safe rules matter most here. Gemini accepts comments in
 * settings.json; a file with comments does not parse as JSON and is refused
 * (never rewritten) — the user then sees "Couldn't parse".
 */

/** Gemini's home: $GEMINI_CLI_HOME when set (Gemini's own override), else HOME. */
function getGeminiHome(): string {
  const override = process.env['GEMINI_CLI_HOME'];
  return override && override.trim() ? override : os.homedir();
}

/** ~/.gemini — the dir whose presence means the user has Gemini CLI. */
export function getGeminiConfigDir(): string {
  return path.join(getGeminiHome(), GEMINI_CONFIG_DIR);
}

function getSettingsPath(): string {
  return path.join(getGeminiConfigDir(), GEMINI_SETTINGS_FILE);
}

/** ~/.pixel-agents/hooks/gemini-hook.js */
function getHookScriptPath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, GEMINI_HOOK_SCRIPT_NAME);
}

function makeHookEntry(): HookEntry {
  return {
    matcher: '',
    hooks: [
      {
        type: 'command',
        name: PIXEL_AGENTS_HOOK_NAME,
        command: `node "${getHookScriptPath()}"`,
        timeout: GEMINI_HOOK_TIMEOUT_MS,
      },
    ],
  };
}

const installer = createHookSettingsInstaller({
  settingsPath: getSettingsPath,
  displayPath: `~/${GEMINI_CONFIG_DIR}/${GEMINI_SETTINGS_FILE}`,
  backupLabel: 'Gemini settings',
  scriptSuffixes: [`/${HOOK_SCRIPTS_DIR}/${GEMINI_HOOK_SCRIPT_NAME}`],
  events: GEMINI_HOOK_EVENTS,
  makeHookEntry,
});

export const geminiInstallerMessages = installer.messages;

export function areHooksInstalled(): boolean {
  return installer.areHooksInstalled();
}

export function installHooks(): Promise<void> {
  return installer.installHooks();
}

export function uninstallHooks(): Promise<void> {
  return installer.uninstallHooks();
}

/** Copy the shipped gemini-hook.js to ~/.pixel-agents/hooks/. */
export function copyHookScript(packageRoot: string): boolean {
  return copyHookScriptFile(packageRoot, GEMINI_HOOK_SCRIPT_NAME, getHookScriptPath());
}
