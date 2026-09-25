// ── JSONL File Watching ─────────────────────────────────────
export const JSONL_POLL_INTERVAL_MS = 1000;
export const FILE_WATCHER_POLL_INTERVAL_MS = 500;
export const PROJECT_SCAN_INTERVAL_MS = 1000;

// ── Heuristic Agent Status Detection ────────────────────────
// These timers are the fallback when CLI hooks are not active
// (hookDelivered = false). When hooks are working, these are
// suppressed and the server receives instant events instead.
/** Delay before sending agentToolDone (prevents UI flicker on rapid tool transitions) */
export const TOOL_DONE_DELAY_MS = 300;
/** Heuristic: time after a non-exempt tool starts before showing permission bubble.
 *  Not used for teammates -- false positives on slow tools (WebFetch/WebSearch).
 *  Teammates rely on the lead's routed Notification(permission_prompt) hook. */
export const PERMISSION_TIMER_DELAY_MS = 7000;
/** Heuristic: silence duration before marking a text-only turn as complete */
export const TEXT_IDLE_DELAY_MS = 5000;
/** Heuristic: idle threshold for per-agent /clear detection (content check prevents stealing) */
export const CLEAR_IDLE_THRESHOLD_MS = 2000;

// ── External Session Detection ──────────────────────────────
export const EXTERNAL_SCAN_INTERVAL_MS = 3000;
/** Only adopt JSONL files modified within this window */
export const EXTERNAL_ACTIVE_THRESHOLD_MS = 120_000; // 2 minutes
/** Remove external agents after this much inactivity */
// export const EXTERNAL_STALE_TIMEOUT_MS = 300_000; // 5 minutes - deprecated
export const EXTERNAL_STALE_CHECK_INTERVAL_MS = 30_000;
/** Cooldown after user closes an agent via X. Must be > EXTERNAL_ACTIVE_THRESHOLD_MS
 *  so the file's mtime becomes stale before the dismissal expires. */
export const DISMISSED_COOLDOWN_MS = 180_000; // 3 minutes

// ── Context Window Usage ────────────────────────────────────
/** Window size assumed until a transcript proves otherwise. Transcripts never
 *  state the model's context limit, so this is the floor, not the truth. */
export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
/** Known window sizes, ascending. The smallest tier that fits the largest
 *  context observed so far wins; beyond the last tier we round up to a whole
 *  multiple of it, so an unknown future window still reads under 100%. */
export const CONTEXT_WINDOW_TIERS = [200_000, 1_000_000] as const;
/** How much of a transcript's tail to read when seeding an agent's context on
 *  adoption or restore. Comfortably more than one turn's worth of records. */
export const CONTEXT_SEED_TAIL_BYTES = 256 * 1024;

// ── Session Chat ────────────────────────────────────────────
/** Entries kept per agent (oldest dropped first). */
export const CHAT_HISTORY_LIMIT = 200;
/** Longest text one chat entry carries; longer text is cut with an ellipsis. */
export const CHAT_ENTRY_MAX_CHARS = 4_000;
/** A tool row's edit (what the change removes + adds), across all its hunks.
 *  The whole history rides the handshake, so edits are bounded like text. */
export const CHAT_EDIT_MAX_CHARS = 6_000;
/** How much transcript before the read offset to replay into a restored agent's chat. */
export const CHAT_SEED_TAIL_BYTES = 512 * 1024;
/** How often a hooks-only CLI's own transcript is re-read for new chat (agy). */
export const HOOK_CHAT_POLL_MS = 1000;
/** Longest message the office will type into a terminal. */
export const CHAT_SEND_MAX_CHARS = 16_000;
/** Office messages waiting for one agent's turn to end. */
export const CHAT_QUEUE_LIMIT = 10;

// ── `pixel-agents claude` launcher ─────────────────────────
/** Route prefix the launcher polls for office input. */
export const LAUNCHER_API_PREFIX = '/api/launcher';
/** How long one launcher poll waits for input before returning empty. */
export const LAUNCHER_POLL_TIMEOUT_MS = 25_000;
/** A launched session stays "connected" this long after its last poll. */
export const LAUNCHER_LEASE_MS = 40_000;
/** Launcher inbox entry meaning "press Esc" (the office's Stop). Office chat
 *  text never equals it: ChatSender strips control characters, and a launcher
 *  too old to know it types nothing for it (typePrompt strips them too). */
export const LAUNCHER_INTERRUPT = '\x1b';
/** Session ids the launcher route accepts (Claude uses UUIDs). */
export const LAUNCHER_SESSION_ID_PATTERN = '^[A-Za-z0-9_-]{1,64}$';
/** Launcher retry pause after a failed poll (server gone, restarting). */
export const LAUNCHER_RETRY_MS = 3_000;
/** How often the launcher re-reads the server registry for new offices. */
export const LAUNCHER_DISCOVERY_INTERVAL_MS = 10_000;

// ── Typing office messages into a terminal (terminalTyping.ts) ──
/** Characters per keystroke chunk. Small, so Claude Code never reads the burst as a paste. */
export const PROMPT_TYPING_CHUNK_CHARS = 8;
/** Pause between keystroke chunks. */
export const PROMPT_TYPING_CHUNK_DELAY_MS = 4;
/** Pause after the last chunk before pressing Enter, so the TUI has caught up. */
export const PROMPT_SUBMIT_DELAY_MS = 80;

// ── Token usage (tokenUsage.ts) ─────────────────────────────
/** Window the burn rate (new tokens per minute) is measured over. */
export const TOKEN_BURN_WINDOW_MS = 5 * 60_000;
/** Recent message ids remembered for counting each request once. */
export const TOKEN_DEDUPE_MESSAGES = 64;
/** Most transcript read back to total a session's usage on adoption/restore. */
export const TOKEN_SEED_MAX_BYTES = 32 * 1024 * 1024;
/** How often decaying burn rates are re-sent. */
export const TOKEN_BURN_TICK_MS = 5_000;
/** Longest user-given character name. */
export const AGENT_NAME_MAX_CHARS = 32;

// ── Agents the office runs itself (officeSessions.ts) ──────
/** How long a CLI's model picker may take to open (or close) after its command. */
export const MODEL_PICKER_WAIT_MS = 8_000;
export const MODEL_PICKER_POLL_MS = 150;
/** Polls in a row with an unchanged screen before the picker counts as drawn. */
export const MODEL_PICKER_SETTLE_POLLS = 3;
/** Gap between keys pressed into the picker; a burst of arrows can be dropped. */
export const MODEL_PICKER_KEY_GAP_MS = 120;
/** The last options each provider's picker showed, for start forms. */
export const MODEL_OPTIONS_FILE_NAME = 'model-options.json';
export const MODEL_LABEL_MAX_CHARS = 80;
export const MODEL_DETAIL_MAX_CHARS = 160;
/** How long the CLI may take to report its slash commands (it runs its SessionStart hooks first). */
export const SLASH_COMMANDS_TIMEOUT_MS = 30_000;
/** A folder's slash-command list is asked for again after this long. */
export const SLASH_COMMANDS_CACHE_MS = 10 * 60_000;
export const SLASH_COMMANDS_MAX = 400;
/** Earlier sessions offered by + Agent → Resume, per folder. */
export const PAST_SESSIONS_MAX = 40;
/** How much of each transcript's head and tail is read for its title. */
export const PAST_SESSIONS_READ_BYTES = 64 * 1024;
export const PAST_SESSION_TITLE_MAX_CHARS = 160;
/** Set on CLI runs the office starts only to ask the CLI something: hook scripts stay silent for them. */
export const HOOK_PROBE_ENV = 'PIXEL_AGENTS_PROBE';
/** Most agents the office will run at once. */
export const OFFICE_SESSION_LIMIT = 8;
/** Terminal size given to an office-run agent (its screen is shown as text). */
export const OFFICE_SESSION_SCREEN_COLS = 100;
export const OFFICE_SESSION_SCREEN_ROWS = 30;
/** An office-run agent takes typed messages only once its screen has been still this long
 *  with no question on it — keys sent while Claude starts up or redraws are dropped. */
export const OFFICE_SESSION_SETTLE_MS = 1_500;
/** Screen updates are sent at most this often. */
export const OFFICE_SESSION_SCREEN_MS = 700;
/** Pause between keys when answering an on-screen question for the user. */
export const OFFICE_SESSION_KEY_GAP_MS = 40;
/** Bounds on a question read off an office-run agent's screen. */
export const SCREEN_QUESTION_MAX_OPTIONS = 9;
export const SCREEN_QUESTION_PROMPT_LINES = 12;
export const SCREEN_QUESTION_PROMPT_CHARS = 240;
/** Seconds to keep trying to adopt a just-started agent's session. */
export const OFFICE_SESSION_ADOPT_TRIES = 600;
/** Recent project folders remembered for the + Agent dialog. */
export const OFFICE_RECENT_FOLDERS = 6;

// ── Agent-to-agent @mention relay (mentionRelay.ts) ────────
/** Window the relay limits are counted over. */
export const RELAY_WINDOW_MS = 10 * 60_000;
/** Passes allowed from one agent to one other agent per window. */
export const RELAY_PAIR_LIMIT = 4;
/** Passes allowed across the whole office per window. */
export const RELAY_TOTAL_LIMIT = 20;
/** Longest reply passed along. Below CHAT_SEND_MAX_CHARS, which is what the
 *  terminal itself accepts: a pass is a paid turn for the receiver, so a
 *  runaway reply is still capped — but not so low that ordinary hand-offs
 *  (a spec, a diff summary) are cut. A cut is announced, never silent. */
export const RELAY_MAX_CHARS = 8_000;
/** Human-readable index of the whiteboard that agents can read. */
export const BOARD_INDEX_FILE_NAME = 'board.md';
/** Agents (any harness) read and post whiteboard pins here (httpServer.ts, boardCli.ts). */
export const BOARD_PINS_API_PATH = '/api/board/pins';
/** DELETE answer for an unknown pin id — tells the CLI the route exists (vs. Fastify's own 404). */
export const BOARD_NO_SUCH_PIN_ERROR = 'No such pin.';
/** How agents are told to post to the whiteboard (board.md header). */
export const BOARD_CLI_COMMAND = 'pixel-office board';
/** How agents are told to point the user at part of a file (board.md header). */
export const SHOW_CLI_COMMAND = 'pixel-office show';
/** Longest wait for a live server to answer `pixel-office board`. */
export const BOARD_CLI_REQUEST_TIMEOUT_MS = 3_000;

// ── "Show me" requests (focusRequests.ts, showCli.ts) ──
/** Agents point the user at part of a file here. */
export const FOCUS_API_PATH = '/api/focus';
/** One long-poll for an answer; `show --wait` polls again until FOCUS_WAIT_MS. */
export const FOCUS_POLL_MS = 25_000;
/** How long `pixel-office show --wait` waits for the user before giving up. */
export const FOCUS_WAIT_MS = 10 * 60_000;
/** An unanswered request expires after this; an answered one is kept this long for late polls. */
export const FOCUS_REQUEST_MAX_AGE_MS = 24 * 60 * 60_000;
export const FOCUS_ANSWERED_KEEP_MS = 60 * 60_000;
/** Bounds on what a request carries. */
export const FOCUS_MAX_REQUESTS = 50;
export const FOCUS_WHY_MAX_CHARS = 280;
export const FOCUS_REPLY_MAX_CHARS = 2_000;
export const FOCUS_CELL_MAX_CHARS = 64;
/** `--find` reads at most this much of a text file to turn a phrase into a line. */
export const FOCUS_FIND_MAX_BYTES = 8 * 1024 * 1024;

// ── Workflows (workflowStore.ts, workflowRuns.ts, workflowCli.ts) ──
/** Saved workflows live here, one markdown file each. */
export const WORKFLOW_DIR_NAME = 'workflows';
/** How agents are told to report workflow steps (the message typed on attach). */
export const WORKFLOW_CLI_COMMAND = 'pixel-office workflow';
/** Agents report steps and wait at gates here. */
export const WORKFLOWS_API_PATH = '/api/workflows';
/** One long-poll at a gate; `workflow gate` polls again until it is answered. */
export const WORKFLOW_GATE_POLL_MS = 25_000;
/** Bounds on a workflow and on the office's run history. */
export const WORKFLOW_MAX_WORKFLOWS = 100;
export const WORKFLOW_MAX_STEPS = 40;
export const WORKFLOW_TITLE_MAX_CHARS = 80;
export const WORKFLOW_STEP_MAX_CHARS = 400;
export const WORKFLOW_REF_MAX_CHARS = 300;
export const WORKFLOW_MAX_RUNS = 50;

// ── Team presets (teamStore.ts, teamRuns.ts) and AI drafts (aiDraft.ts) ──
export const TEAM_DIR_NAME = 'teams';
export const TEAM_MAX_TEAMS = 100;
export const TEAM_MAX_MEMBERS = 8;
export const TEAM_NAME_MAX_CHARS = 32;
export const TEAM_TEXT_MAX_CHARS = 2_000;
export const TEAM_COMMAND_MAX_CHARS = 300;
/** How long a started team waits for each member's session to be adopted. */
export const TEAM_ADOPT_WAIT_MS = 10 * 60_000;
/** A called-in teammate's first prompt carries at most this much of the lead's reply. */
export const TEAM_CALL_MAX_CHARS = 4_000;
export const TEAM_MAX_RUNS = 20;
/** Command and model the AI drafter runs (`claude -p`, non-interactive). */
export const AI_DRAFT_COMMAND = 'claude';
export const AI_DRAFT_MODEL = 'claude-sonnet-5';
/** A draft that takes longer than this is abandoned. */
export const AI_DRAFT_TIMEOUT_MS = 4 * 60_000;
export const AI_DRAFT_MAX_OUTPUT_BYTES = 1024 * 1024;

// ── Review changes (proposals.ts, proposeCli.ts) ──
export const PROPOSALS_API_PATH = '/api/proposals';
/** How agents are told to suggest a change instead of writing it. */
export const PROPOSE_CLI_COMMAND = 'pixel-office propose';
/** Text files up to this size can be reviewed line by line. */
export const PROPOSAL_MAX_BYTES = 1024 * 1024;
export const PROPOSAL_MAX_OPEN = 30;
export const PROPOSAL_REASON_MAX_CHARS = 300;
/** One long-poll for the user's decision; `propose --wait` polls again until PROPOSAL_WAIT_MS. */
export const PROPOSAL_POLL_MS = 25_000;
export const PROPOSAL_WAIT_MS = 15 * 60_000;
/** Copies of files as they were before an Apply, for Undo. */
export const PROPOSAL_BACKUP_DIR = 'backups';
/** Office document edits: `pixel-office doc edit` (Bearer, no browsers). */
export const DOCS_API_PATH = '/api/docs';
export const DOC_CLI_COMMAND = 'pixel-office doc';
/** Edits accepted in one call (human save or agent batch). */
export const DOC_EDITS_MAX_PER_CALL = 50;
/** Recent document edits kept for notices and Undo. */
export const DOC_EDITS_KEPT = 20;
/** A change line in a notice ("¶3: before → after") clips each side to this. */
export const DOC_EDIT_CHANGE_MAX_CHARS = 60;
/** A text file saved from the viewer. */
export const DOC_EDIT_TEXT_MAX_BYTES = 1_000_000;
/** Files the office opened (Files → Recent): ~/.pixel-agents/files.json, newest first. */
export const OFFICE_FILES_FILE_NAME = 'files.json';
export const OFFICE_FILES_MAX = 100;
/** Pending document / file suggestions, kept across restarts. */
export const SUGGESTIONS_FILE_NAME = 'suggestions.json';
/** The viewer fetches files the office opened here, by file id (not by pin). */
export const OFFICE_FILE_API_PREFIX = '/api/docs/files';
/** Backups kept per file (newest first), and for how long. */
export const BACKUPS_KEEP_PER_FILE = 5;
export const BACKUPS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Transcripts of agents that ended with the office (not re-adopted by the next one). */
export const ENDED_SESSIONS_FILE_NAME = 'ended-sessions.json';
export const ENDED_SESSIONS_MAX = 50;

// ── Permission prompts answered from the office (permissionBroker.ts) ──
/** How long a hook holds a permission prompt for an answer from the office before
 *  letting it show in the agent's own terminal. */
export const PERMISSION_WAIT_MS = 5 * 60_000;
/** One long-poll for a decision; the hook script polls again until PERMISSION_WAIT_MS. */
export const PERMISSION_POLL_MS = 25_000;
/** Seconds Claude Code gives the PermissionRequest hook (wait + slack for the POSTs). */
export const PERMISSION_HOOK_TIMEOUT_S = Math.ceil(PERMISSION_WAIT_MS / 1000) + 30;
/** A decided ask is remembered this long so a late poll still gets its answer. */
export const PERMISSION_DECIDED_TTL_MS = 60_000;
/** Longest tool detail shown with an ask. */
export const PERMISSION_DETAIL_MAX_CHARS = 400;
/** Path segment under the hook route that the hook script polls for a decision. */
export const PERMISSION_POLL_SEGMENT = 'permission';

// ── Whiteboard ──────────────────────────────────────────────
export const BOARD_FILE_NAME = 'board.json';
export const BOARD_MAX_PINS = 200;
export const BOARD_PIN_TITLE_MAX_CHARS = 200;
export const BOARD_PIN_VALUE_MAX_CHARS = 8_000;
/** Longest detail (notes about a pin). */
export const BOARD_PIN_DETAIL_MAX_CHARS = 4_000;
/** Largest pinned file the document viewer is sent. */
export const BOARD_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** Folder under ~/.pixel-agents where files uploaded to the whiteboard are kept. */
export const BOARD_UPLOAD_DIR = 'files';
/** Route the document viewer fetches pinned files from. */
export const BOARD_FILE_API_PREFIX = '/api/board/files';
/** Longest stored name (after the unique prefix) kept from an uploaded file's name. */
export const UPLOAD_NAME_MAX_CHARS = 120;
/** Route the office chat uploads files for agents to (stored, not pinned). */
export const CHAT_FILE_API_PREFIX = '/api/files';
/** Prefix of the unique id in front of a chat-uploaded file's stored name. */
export const CHAT_FILE_ID_PREFIX = 'chat_';
/** Stored names the chat image route accepts (a bare file name, no separators). */
export const CHAT_FILE_NAME_PATTERN = '^[A-Za-z0-9._-]{1,200}$';

// ── Global Session Scanning ─────────────────────────────────
/** Only adopt global JSONL files larger than this (filters out empty/init-only sessions) */
export const GLOBAL_SCAN_ACTIVE_MIN_SIZE = 3_072; // 3KB
/** Only adopt global JSONL files modified within this window */
export const GLOBAL_SCAN_ACTIVE_MAX_AGE_MS = 600_000; // 10 minutes

// ── Display Truncation + Pixel Agents Server paths ──────────
// Centralized in core/src/constants.ts; re-exported here for back-compat.
export {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  HOOK_API_PREFIX,
  HOOK_SCRIPTS_DIR,
  SERVER_JSON_DIR,
  SERVER_JSON_NAME,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../../core/src/constants.js';

// ── Multi-Server Discovery ──────────────────────────────────
/** Subdirectory (under SERVER_JSON_DIR) holding one registry entry per live
 *  server, so a hook event can fan out to every running instance instead of
 *  only the single legacy server.json pointer. See server/src/server.ts. */
export const SERVERS_DIR = 'servers';
/** Valid explicit TCP port range. Port 0 remains an internal-only signal for
 *  OS-assigned ephemeral binding and is never accepted from persisted records
 *  or the CLI's --port option. */
export const MIN_PORT = 1;
export const MAX_PORT = 65_535;
/** Format version stamped on every registry entry (both the per-server records
 *  and the legacy server.json). Bump on breaking field changes; additive
 *  fields (servesSpa, protocol itself) don't require a bump -- readers already
 *  tolerate unknown/missing fields (see ServerConfig.debugLog precedent). */
export const SERVER_REGISTRY_PROTOCOL_VERSION = 1;

// ── WebSocket close codes (application range 4000-4999) ────
/** Embedded mode: Bearer token missing or wrong. */
export const WS_CLOSE_UNAUTHORIZED = 4001;
/** Standalone mode: the handshake's Origin is not this server's own origin.
 *  WebSocket connects bypass CORS, so this is the only thing standing between
 *  a drive-by web page and the privileged client-message channel. */
export const WS_CLOSE_FORBIDDEN_ORIGIN = 4003;

export const HOOK_EVENT_BUFFER_MS = 5_000;
/** Grace period after SessionEnd(reason=clear/resume) before triggering onSessionEnd.
 *  /clear and /resume fire SessionEnd then SessionStart within ms. This timeout is a
 *  safety net: if SessionStart never arrives (e.g. the CLI crashes mid-transition),
 *  the agent is cleaned up instead of staying as a zombie with pendingClear forever. */
export const SESSION_END_GRACE_MS = 2000;
export const MAX_HOOK_BODY_SIZE = 65_536; // 64KB

// ── Layout/Config Persistence ──────────────────────────────
export const LAYOUT_FILE_DIR = '.pixel-agents';
export const LAYOUT_FILE_NAME = 'layout.json';
export const LAYOUT_FILE_POLL_INTERVAL_MS = 2000;
export const LAYOUT_REVISION_KEY = 'layoutRevision';
export const CONFIG_FILE_NAME = 'config.json';

// ── Avatar Customization ────────────────────────────────────
/** Number of pre-colored bundled character palettes (char_0.png–char_5.png).
 *  Mirrors `PALETTE_COUNT` in webview-ui/src/constants.ts; kept separate
 *  because the server has no DOM/sprite access and cannot import the webview
 *  constant. The two values must stay in sync. */
export const PALETTE_COUNT = 6;
/** Inclusive upper bound for a valid agent hue shift, in degrees. Used by
 *  clientMessageHandler to guard saveAgentSeats payloads from a remote or
 *  hand-edited source corrupting the stored values with out-of-range values. */
export const HUE_SHIFT_MAX_DEG = 360;

// ── Folder Browser (+ Agent dialog) ─────────────────────────
/** Most sub-folders one `listFolder` reply carries; the rest are dropped (sorted first). */
export const FOLDER_LIST_MAX_ENTRIES = 500;
/** Folder names never listed: dependency trees nobody starts an agent in. */
export const FOLDER_LIST_SKIP_NAMES: readonly string[] = ['node_modules'];
/** A folder holding any of these is marked `isProject` in the listing. */
export const FOLDER_PROJECT_MARKERS: readonly string[] = [
  '.git',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
];
/** How long the machine's own folder dialog may stay open before `pickFolder`
 *  gives up. Long: a human is browsing their disk, not a machine answering. */
export const FOLDER_DIALOG_TIMEOUT_MS = 120_000;

// ── Task desk ────────────────────────────────────────────────
/** Bytes read from a transcript's tail (then head) to learn the session's working folder. */
export const AGENT_CWD_SEED_BYTES = 64 * 1024;
/** `git rev-parse` must answer within this, or the folder counts as not-a-project. */
export const GIT_ROOT_TIMEOUT_MS = 2_000;
/** How long a folder's resolved git root + branch is trusted. */
export const GIT_ROOT_CACHE_MS = 5_000;
export const TASK_DESK_FILE_NAME = 'tasks.json';
export const TASK_DESK_INDEX_FILE_NAME = 'tasks.md';
export const TASK_DESK_MAX_TASKS = 200;
export const TASK_TITLE_MAX_CHARS = 120;
export const TASK_BODY_MAX_CHARS = 4_000;
export const TASK_NOTE_MAX_CHARS = 2_000;
export const TASK_BRIEF_TEXT_MAX_CHARS = 4_000;
export const TASK_BRIEF_SHORT_MAX_CHARS = 200;
export const TASK_MAX_BRIEFS = 8;
export const TASK_MAX_SUBTASKS = 20;
export const TASK_MAX_FILES = 40;
export const TASK_MAX_QUESTIONS = 10;
export const TASK_MAX_LOG = 60;
/** Files the human can attach to one card. */
export const TASK_MAX_ATTACHMENTS = 20;
/** Looks that may end without a brief before the card goes to the human anyway. */
export const TASK_MAX_LOOK_ATTEMPTS = 2;
/** How often the desk re-checks who is free (store events cover the fast path). */
export const TASK_DESK_TICK_MS = 3_000;
/** What agents are told to run. The installed bin, not `npx <package>`: the package is
 *  installed from a release tarball, and npx would look for it on the npm registry. */
export const TASK_CLI_COMMAND = 'pixel-office task';
export const TASKS_API_PATH = '/api/tasks';
/** How long one `task gate` poll waits for the human before the CLI asks again. */
export const TASK_GATE_POLL_MS = 25_000;
/** Every agent in the office, for `pixel-office agents` (Bearer, no browsers). */
export const AGENTS_API_PATH = '/api/agents';
/** How agents are told to list who is in the office. */
export const AGENTS_CLI_COMMAND = 'pixel-office agents';
/** An agent asks for its own context to be cleared (`pixel-office clear`; Bearer, no browsers). */
export const CLEAR_API_PATH = '/api/agents/clear';
/** How agents are told to ask for a clear. */
export const CLEAR_CLI_COMMAND = 'pixel-office clear';
/** Longest reason an agent may give with a clear request. */
export const CLEAR_REASON_MAX_CHARS = 300;
export const TASK_NO_SUCH_CARD_ERROR = 'No such card.';

// ── Office documents (Word / PowerPoint / Excel; officeDocs.ts, docCli.ts) ──
/** Rows of each sheet read into a DocModel before it is marked `truncated`. */
export const DOC_MAX_ROWS = 2_000;
/** Largest .docx/.pptx/.xlsx the office will open or edit. */
export const DOC_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Edits accepted in one batch. */
export const DOC_MAX_EDITS = 500;
/** Longest text one paragraph or shape edit may carry. */
export const DOC_EDIT_TEXT_MAX_CHARS = 200_000;
/** Excel's own limit on the characters in one cell. */
export const DOC_CELL_MAX_CHARS = 32_767;
/** `pixel-office doc outline`: characters shown per paragraph / shape line. */
export const DOC_OUTLINE_TEXT_CHARS = 100;
/** `pixel-office doc outline`: first rows shown per sheet, and cells per row. */
export const DOC_OUTLINE_ROWS = 5;
export const DOC_OUTLINE_CELLS = 8;

// ── Electron shell (adapters/electron/) ─────────────────────────
/** How often the Electron shell polls GET /api/health of a server it
 *  attached to (rather than owning). Two misses in a row -> "server stopped". */
export const ELECTRON_HEALTH_POLL_MS = 5_000;

/** "Send now" (sendChatMessage.interrupt): how long a message waits for the
 *  stopped turn to end before it is typed anyway. */
export const CHAT_INTERRUPT_SEND_WAIT_MS = 6_000;
