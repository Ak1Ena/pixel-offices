/**
 * Claude Code hook script (bundled to dist/hooks/claude-hook.js, copied to
 * ~/.pixel-agents/hooks/). The shared body lives in ../../hookScript.ts; Claude
 * Code takes a PermissionRequest decision from our stdout, so that event is
 * held open until an office answers it.
 */
import { runHookScript } from '../../hookScript.js';

runHookScript({ providerId: 'claude', permissionEvent: 'PermissionRequest' });
