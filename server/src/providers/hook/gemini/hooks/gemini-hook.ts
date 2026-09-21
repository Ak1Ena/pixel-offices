/**
 * Google Gemini CLI hook script (bundled to dist/hooks/gemini-hook.js, copied
 * to ~/.pixel-agents/hooks/). Fire-and-forget: Gemini's permission prompt
 * arrives as a Notification that a hook cannot answer, so nothing is held.
 */
import { runHookScript } from '../../hookScript.js';

runHookScript({ providerId: 'gemini' });
