import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import {
  SETTINGS_BACKUP_SUFFIX,
  SETTINGS_FRESH_FILE_MODE,
  SETTINGS_TMP_SUFFIX,
} from '../constants.js';
import { copyHookScriptFile, isOurHookCommand } from '../hookSettingsInstaller.js';
import {
  ANTIGRAVITY_CLI_DIR,
  ANTIGRAVITY_CONFIG_DIR,
  ANTIGRAVITY_HOOK_EVENTS,
  ANTIGRAVITY_HOOK_SCRIPT_NAME,
  ANTIGRAVITY_HOOK_SPEC_NAME,
  ANTIGRAVITY_HOOK_TIMEOUT_S,
  ANTIGRAVITY_HOOKS_FILE,
} from './constants.js';

/**
 * Antigravity's hook install: ONE named spec, `"pixel-agents"`, in
 * ~/.gemini/config/hooks.json. agy's file is a map of named specs, so unlike
 * Claude/Codex/Gemini we never merge into shared event arrays — we own that
 * one key and leave every other key untouched. The shared installer's rules
 * still apply: an unparseable file or a non-object root is refused, never
 * rewritten; a `pixel-agents` key we did not write is refused; the first
 * write over someone else's content leaves a one-time backup; writes are
 * atomic and keep the file's mode.
 */

const SCRIPT_SUFFIX = `/${HOOK_SCRIPTS_DIR}/${ANTIGRAVITY_HOOK_SCRIPT_NAME}`.toLowerCase();
const DISPLAY_PATH = `~/${ANTIGRAVITY_CONFIG_DIR}/${ANTIGRAVITY_HOOKS_FILE}`;

/** Events agy wraps in `{matcher, hooks}` groups; the rest take handlers directly. */
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

interface Handler {
  type: 'command';
  command: string;
  timeout: number;
}

function getHome(): string {
  return os.homedir();
}

/** ~/.gemini/antigravity-cli — the dir whose presence means agy is installed. */
export function getAntigravityCliDir(): string {
  return path.join(getHome(), ANTIGRAVITY_CONFIG_DIR, ANTIGRAVITY_CLI_DIR);
}

function getHooksPath(): string {
  return path.join(getHome(), ANTIGRAVITY_CONFIG_DIR, ANTIGRAVITY_HOOKS_FILE);
}

/** ~/.pixel-agents/hooks/antigravity-hook.js */
function getHookScriptPath(): string {
  return path.join(getHome(), HOOK_SCRIPTS_DIR, ANTIGRAVITY_HOOK_SCRIPT_NAME);
}

function handler(event: string): Handler {
  return {
    type: 'command',
    command: `node "${getHookScriptPath()}" ${event}`,
    timeout: ANTIGRAVITY_HOOK_TIMEOUT_S,
  };
}

/** The spec we write under `pixel-agents`. */
export function makeHookSpec(): Record<string, unknown> {
  const spec: Record<string, unknown> = {};
  for (const event of ANTIGRAVITY_HOOK_EVENTS) {
    spec[event] = TOOL_EVENTS.has(event)
      ? [{ matcher: '*', hooks: [handler(event)] }]
      : [handler(event)];
  }
  return spec;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every command string anywhere in a spec (flat handlers and matcher groups). */
function commandsIn(spec: unknown): string[] {
  if (!isObject(spec)) return [];
  const out: string[] = [];
  for (const value of Object.values(spec)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!isObject(item)) continue;
      if (typeof item.command === 'string') out.push(item.command);
      if (Array.isArray(item.hooks)) {
        for (const h of item.hooks) {
          if (isObject(h) && typeof h.command === 'string') out.push(h.command);
        }
      }
    }
  }
  return out;
}

/** A spec is ours when it runs our script and nothing else. */
function isOurSpec(spec: unknown): boolean {
  const commands = commandsIn(spec);
  return commands.length > 0 && commands.every((c) => isOurHookCommand(c, [SCRIPT_SUFFIX]));
}

export const antigravityInstallerMessages = {
  unparseable: `Couldn't parse ${DISPLAY_PATH}, so no Antigravity hooks were added. Fix the file or add them by hand.`,
  notObject: `${DISPLAY_PATH} is not a JSON object, so no Antigravity hooks were added.`,
  foreignSpec: `${DISPLAY_PATH} already has a "${ANTIGRAVITY_HOOK_SPEC_NAME}" hook that Pixel Agents did not write; it was left alone.`,
};

/** Parsed hooks.json (empty when absent), plus the raw text it came from. */
function read(): { raw: string | null; hooks: Record<string, unknown> } {
  const file = getHooksPath();
  if (!fs.existsSync(file)) return { raw: null, hooks: {} };
  const raw = fs.readFileSync(file, 'utf-8');
  if (!raw.trim()) return { raw, hooks: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(antigravityInstallerMessages.unparseable, { cause: e });
  }
  if (!isObject(parsed)) throw new Error(antigravityInstallerMessages.notObject);
  return { raw, hooks: parsed };
}

function write(hooks: Record<string, unknown>, raw: string | null): void {
  const file = getHooksPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Back up what we replace, once, unless it held nothing but our own spec.
  const before = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  const othersBefore = Object.keys(before).some((k) => k !== ANTIGRAVITY_HOOK_SPEC_NAME);
  if (raw !== null && othersBefore) {
    try {
      fs.copyFileSync(file, file + SETTINGS_BACKUP_SUFFIX, fs.constants.COPYFILE_EXCL);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : SETTINGS_FRESH_FILE_MODE;
  const tmp = file + SETTINGS_TMP_SUFFIX;
  try {
    fs.writeFileSync(tmp, JSON.stringify(hooks, null, 2), {
      encoding: 'utf-8',
      mode: SETTINGS_FRESH_FILE_MODE,
    });
    fs.chmodSync(tmp, mode);
    // Someone else wrote meanwhile: give up rather than lose their change.
    const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
    if (now !== raw) throw new Error(`${DISPLAY_PATH} changed while Pixel Agents was writing it.`);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function areHooksInstalled(): boolean {
  try {
    return isOurSpec(read().hooks[ANTIGRAVITY_HOOK_SPEC_NAME]);
  } catch {
    return false;
  }
}

export async function installHooks(): Promise<void> {
  const { raw, hooks } = read();
  const existing = hooks[ANTIGRAVITY_HOOK_SPEC_NAME];
  if (existing !== undefined && !isOurSpec(existing)) {
    throw new Error(antigravityInstallerMessages.foreignSpec);
  }
  const desired = makeHookSpec();
  if (JSON.stringify(existing) === JSON.stringify(desired)) return;
  write({ ...hooks, [ANTIGRAVITY_HOOK_SPEC_NAME]: desired }, raw);
}

export async function uninstallHooks(): Promise<void> {
  const { raw, hooks } = read();
  const existing = hooks[ANTIGRAVITY_HOOK_SPEC_NAME];
  if (existing === undefined || !isOurSpec(existing)) return;
  const rest = { ...hooks };
  delete rest[ANTIGRAVITY_HOOK_SPEC_NAME];
  write(rest, raw);
}

/** Copy the shipped antigravity-hook.js to ~/.pixel-agents/hooks/. */
export function copyHookScript(packageRoot: string): boolean {
  return copyHookScriptFile(packageRoot, ANTIGRAVITY_HOOK_SCRIPT_NAME, getHookScriptPath());
}
