/**
 * Codex's first-run consent copy, shipped verbatim in `hooksConsentRequest`
 * (see claude/consentCopy.ts for the headline/disclosure split). Codex-only
 * fact: hooks do nothing until the user trusts them with `/hooks` in Codex.
 */

import { PERMISSION_WAIT_MS } from '../../../constants.js';
import { SETTINGS_BACKUP_SUFFIX } from '../constants.js';
import { CODEX_HOOK_EVENTS, CODEX_HOOKS_FILE } from './constants.js';

const HOOKS_FILE = `~/.codex/${CODEX_HOOKS_FILE}`;

export const CODEX_CONSENT_HEADLINE = 'Codex hooks, too?';

export const CODEX_CONSENT_DISCLOSURE = [
  `Pixel Agents can show your Codex sessions in the office by adding hooks for ` +
    `${CODEX_HOOK_EVENTS.length} Codex events to ${HOOKS_FILE}. Your existing hooks are kept, and a ` +
    `one-time backup is saved as ${CODEX_HOOKS_FILE}${SETTINGS_BACKUP_SUFFIX}.`,
  'Codex will send those events - including tool names and tool inputs - to a Pixel Agents server ' +
    'on this machine. Everything stays local - the server listens only on 127.0.0.1 - unless you ' +
    'explicitly start it with --host. While the office is open, Codex approval prompts wait there ' +
    `for your Allow or Deny (up to ${PERMISSION_WAIT_MS / 60_000} minutes) before showing in the terminal.`,
  'Codex skips new hooks until you trust them: after installing, run /hooks inside Codex and trust ' +
    'the Pixel Agents entries.',
  `To undo, remove the entries that run codex-hook.js from ${HOOKS_FILE} (or disable them in /hooks).`,
].join('\n\n');
