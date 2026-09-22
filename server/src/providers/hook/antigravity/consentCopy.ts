/**
 * Antigravity's first-run consent copy, shipped verbatim in
 * `hooksConsentRequest` (see claude/consentCopy.ts for the headline/disclosure
 * split). Antigravity-only facts: we own one named spec in its hooks.json,
 * and its permission prompts stay in the terminal (PreToolUse is not
 * installed — any reply there would decide the prompt).
 */

import { SETTINGS_BACKUP_SUFFIX } from '../constants.js';
import {
  ANTIGRAVITY_HOOK_EVENTS,
  ANTIGRAVITY_HOOK_SPEC_NAME,
  ANTIGRAVITY_HOOKS_FILE,
} from './constants.js';

const HOOKS_FILE = `~/.gemini/${ANTIGRAVITY_HOOKS_FILE}`;

export const ANTIGRAVITY_CONSENT_HEADLINE = 'Antigravity (agy) hooks, too?';

export const ANTIGRAVITY_CONSENT_DISCLOSURE = [
  `Pixel Agents can show your Antigravity CLI (agy) sessions in the office by adding a ` +
    `"${ANTIGRAVITY_HOOK_SPEC_NAME}" hook for ${ANTIGRAVITY_HOOK_EVENTS.length} agy events to ${HOOKS_FILE}. ` +
    `Your other hooks are kept, and a one-time backup is saved as hooks.json${SETTINGS_BACKUP_SUFFIX}.`,
  'agy will send those events - including tool names and tool inputs - to a Pixel Agents server on ' +
    'this machine. Everything stays local - the server listens only on 127.0.0.1 - unless you ' +
    'explicitly start it with --host. agy permission prompts are answered in the terminal.',
  `To undo, remove the "${ANTIGRAVITY_HOOK_SPEC_NAME}" entry from ${HOOKS_FILE}.`,
].join('\n\n');
