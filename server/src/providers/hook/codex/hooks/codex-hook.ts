/**
 * OpenAI Codex CLI hook script (bundled to dist/hooks/codex-hook.js, copied to
 * ~/.pixel-agents/hooks/). Codex takes a PermissionRequest decision from our
 * stdout in the same shape as Claude Code, so that event is held open until an
 * office answers it.
 */
import { runHookScript } from '../../hookScript.js';

runHookScript({ providerId: 'codex', permissionEvent: 'PermissionRequest' });
