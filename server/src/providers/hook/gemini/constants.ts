/**
 * Google Gemini CLI constants (provider `gemini`). Verified against Gemini CLI
 * 0.46: hooks live under the `hooks` key of ~/.gemini/settings.json (HOME is
 * overridable with $GEMINI_CLI_HOME), `timeout` is in MILLISECONDS, and the
 * hooks system is enabled by default (`hooksConfig.enabled`).
 */

/** Output filename after esbuild compiles gemini-hook.ts (source is .ts). */
export const GEMINI_HOOK_SCRIPT_NAME = 'gemini-hook.js';

/** Gemini's config dir name under its home. */
export const GEMINI_CONFIG_DIR = '.gemini';

/** Gemini's settings file inside its config dir (it holds MANY other settings). */
export const GEMINI_SETTINGS_FILE = 'settings.json';

/** Hook events to install. Deliberately NOT installed: BeforeAgent (prompt
 *  text, consumed by nothing), BeforeModel/AfterModel/BeforeToolSelection/
 *  PreCompress (high-volume, nothing consumes them). */
export const GEMINI_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'BeforeTool',
  'AfterTool',
  'AfterAgent',
  'Notification',
] as const;

/** Milliseconds Gemini gives our hook (it only POSTs and exits). */
export const GEMINI_HOOK_TIMEOUT_MS = 5000;

/** Gemini's notification_type for a tool confirmation prompt. */
export const GEMINI_TOOL_PERMISSION_NOTIFICATION = 'ToolPermission';

/** Terminal name prefix used when a Gemini session runs in a VS Code terminal. */
export const GEMINI_TERMINAL_NAME_PREFIX = 'Gemini';
