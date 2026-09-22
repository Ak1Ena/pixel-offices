/**
 * Antigravity CLI constants (provider `antigravity`, the `agy` command).
 * Verified against agy 1.2.8: hooks live in ~/.gemini/config/hooks.json as
 * NAMED hook specs (`{"<name>": {"PostToolUse": [...], "Stop": [...]}}`),
 * `timeout` is in SECONDS, and every hook gets the payload on stdin with
 * camelCase keys and NO event name or session id field — the command line
 * names the event, `conversationId` is the session.
 */

/** Output filename after esbuild compiles antigravity-hook.ts. */
export const ANTIGRAVITY_HOOK_SCRIPT_NAME = 'antigravity-hook.js';

/** agy's config root under HOME (shared with Gemini CLI's ~/.gemini). */
export const ANTIGRAVITY_CONFIG_DIR = '.gemini';

/** The CLI's own state dir; its presence means agy is installed. */
export const ANTIGRAVITY_CLI_DIR = 'antigravity-cli';

/** hooks.json lives here, relative to the config root. */
export const ANTIGRAVITY_HOOKS_FILE = 'config/hooks.json';

/** Our named hook spec inside hooks.json. */
export const ANTIGRAVITY_HOOK_SPEC_NAME = 'pixel-agents';

/**
 * Events we install. PreToolUse is deliberately NOT installed: agy reads a
 * hook's reply there as a permission decision — `{}` DENIES the tool and
 * `"allow"` would skip the user's own prompts — so no reply is safe.
 */
export const ANTIGRAVITY_HOOK_EVENTS = ['PreInvocation', 'PostToolUse', 'Stop'] as const;

/** Seconds agy gives our hook (it only POSTs and exits; hooks block agy's loop). */
export const ANTIGRAVITY_HOOK_TIMEOUT_S = 5;

/** What every hook prints: agy requires a JSON reply, and `{}` means "no opinion". */
export const ANTIGRAVITY_HOOK_REPLY = '{}';

/** Terminal name prefix for an agy session in a VS Code terminal. */
export const ANTIGRAVITY_TERMINAL_NAME_PREFIX = 'Antigravity';
