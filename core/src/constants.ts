/**
 * Shared constants used across server, extension, and webview.
 * Only constants needed by core interfaces live here.
 * Server-specific timing constants stay in server/src/constants.ts.
 * Webview-specific rendering constants stay in webview-ui/src/constants.ts.
 * Provider-specific constants stay in their provider directory.
 */

// ── Hook API ─────────────────────────────────────────────────

export const HOOK_API_PREFIX = '/api/hooks';
export const SERVER_JSON_DIR = '.pixel-agents';
export const SERVER_JSON_NAME = 'server.json';
export const HOOK_SCRIPTS_DIR = '.pixel-agents/hooks';

// ── Display ──────────────────────────────────────────────────

export const BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
export const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;

// ── Transport ────────────────────────────────────────────────
// Connection-state names for the MessageTransport state machine.

export const TRANSPORT_STATE_CONNECTING = 'connecting';
export const TRANSPORT_STATE_CONNECTED = 'connected';
export const TRANSPORT_STATE_RECONNECTING = 'reconnecting';
export const TRANSPORT_STATE_DISCONNECTED = 'disconnected';

/** Colours a 3D character look falls back to when a field is missing or invalid. */
export const DEFAULT_LOOK_COLORS = {
  skin: '#e8b98f',
  hairColor: '#2b1d14',
  shirt: '#3b6ea8',
  pants: '#2b2f3a',
} as const;
