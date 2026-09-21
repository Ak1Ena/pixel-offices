/**
 * Gemini's first-run consent copy, shipped verbatim in `hooksConsentRequest`
 * (see claude/consentCopy.ts for the headline/disclosure split). Gemini-only
 * fact: its permission prompt cannot be answered from a hook, so the office
 * only SHOWS that Gemini is waiting; the answer is given in the terminal.
 */

import { SETTINGS_BACKUP_SUFFIX } from '../constants.js';
import { GEMINI_HOOK_EVENTS, GEMINI_SETTINGS_FILE } from './constants.js';

const SETTINGS_FILE = `~/.gemini/${GEMINI_SETTINGS_FILE}`;

export const GEMINI_CONSENT_HEADLINE = 'Gemini hooks, too?';

export const GEMINI_CONSENT_DISCLOSURE = [
  `Pixel Agents can show your Gemini CLI sessions in the office by adding hooks for ` +
    `${GEMINI_HOOK_EVENTS.length} Gemini events to ${SETTINGS_FILE}. Your existing settings are kept, ` +
    `and a one-time backup is saved as ${GEMINI_SETTINGS_FILE}${SETTINGS_BACKUP_SUFFIX}.`,
  'Gemini CLI will send those events - including tool names and tool inputs - to a Pixel Agents ' +
    'server on this machine. Everything stays local - the server listens only on 127.0.0.1 - unless ' +
    'you explicitly start it with --host. Gemini permission prompts show as a bubble in the office, ' +
    'but are answered in the terminal.',
  `To undo, remove the "pixel-agents" entries from ${SETTINGS_FILE} (or disable them with /hooks in Gemini).`,
].join('\n\n');
