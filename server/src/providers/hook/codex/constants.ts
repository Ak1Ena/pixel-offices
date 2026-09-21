/**
 * OpenAI Codex CLI constants (provider `codex`). Verified against Codex 0.154's
 * hooks engine: hooks live in `$CODEX_HOME/hooks.json` (default ~/.codex), in
 * the same `{"hooks":{"<Event>":[{"matcher","hooks":[…]}]}}` shape as Claude
 * Code, with `timeout` in SECONDS.
 */

/** Output filename after esbuild compiles codex-hook.ts (source is .ts). */
export const CODEX_HOOK_SCRIPT_NAME = 'codex-hook.js';

/** Codex's config dir name under HOME (overridable with $CODEX_HOME). */
export const CODEX_CONFIG_DIR = '.codex';

/** Codex's hook file inside its config dir. */
export const CODEX_HOOKS_FILE = 'hooks.json';

/** Hook events to install in ~/.codex/hooks.json — the whole data-collection
 *  surface, so only what the runtime acts on. Deliberately NOT installed:
 *  UserPromptSubmit (prompt text, consumed by nothing) and Pre/PostCompact. */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'Interrupt',
  'SubagentStart',
  'SubagentStop',
] as const;

/** Seconds Codex gives our hook for an ordinary event (it only POSTs and exits). */
export const CODEX_HOOK_TIMEOUT_S = 5;
/** Codex caps SessionEnd hooks at 3 s; asking for more is ignored. */
export const CODEX_SESSION_END_TIMEOUT_S = 3;

/** Terminal name prefix used when a Codex session runs in a VS Code terminal. */
export const CODEX_TERMINAL_NAME_PREFIX = 'Codex';
