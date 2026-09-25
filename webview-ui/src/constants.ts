import type { ColorValue } from './components/ui/types.js';

// ── Grid & Layout ────────────────────────────────────────────
export const TILE_SIZE = 16;
export const DEFAULT_COLS = 20;
export const DEFAULT_ROWS = 11;
export const MAX_COLS = 64;
export const MAX_ROWS = 64;

// ── Character Animation ─────────────────────────────────────
export const WALK_SPEED_PX_PER_SEC = 48;
export const WALK_FRAME_DURATION_SEC = 0.15;
export const TYPE_FRAME_DURATION_SEC = 0.3;
export const WANDER_PAUSE_MIN_SEC = 2.0;
export const WANDER_PAUSE_MAX_SEC = 20.0;
export const WANDER_MOVES_BEFORE_REST_MIN = 3;
export const WANDER_MOVES_BEFORE_REST_MAX = 6;
export const SEAT_REST_MIN_SEC = 120.0;
export const SEAT_REST_MAX_SEC = 240.0;

// ── Matrix Effect ────────────────────────────────────────────
export const MATRIX_EFFECT_DURATION_SEC = 0.3;
export const MATRIX_TRAIL_LENGTH = 6;
export const MATRIX_SPRITE_COLS = 16;
export const MATRIX_SPRITE_ROWS = 24;
export const MATRIX_FLICKER_FPS = 30;
export const MATRIX_FLICKER_VISIBILITY_THRESHOLD = 180;
export const MATRIX_COLUMN_STAGGER_RANGE = 0.3;
export const MATRIX_HEAD_COLOR = '#ccffcc';
export const matrixGreenBright = (a: number): string => `rgba(0, 255, 65, ${a})`;
export const matrixGreenMid = (a: number): string => `rgba(0, 170, 40, ${a})`;
export const matrixGreenDim = (a: number): string => `rgba(0, 85, 20, ${a})`;
export const MATRIX_TRAIL_OVERLAY_ALPHA = 0.6;
export const MATRIX_TRAIL_EMPTY_ALPHA = 0.5;
export const MATRIX_TRAIL_MID_THRESHOLD = 0.33;
export const MATRIX_TRAIL_DIM_THRESHOLD = 0.66;

// ── Rendering ────────────────────────────────────────────────
export const CHARACTER_SITTING_OFFSET_PX = 6;
export const CHARACTER_Z_SORT_OFFSET = 0.5;
export const OUTLINE_Z_SORT_OFFSET = 0.001;
export const SELECTED_OUTLINE_ALPHA = 1.0;
export const HOVERED_OUTLINE_ALPHA = 0.5;
/** Headless agents (adopted, no terminal to focus) render slightly translucent. */
export const HEADLESS_CHARACTER_ALPHA = 0.5;
export const GHOST_PREVIEW_SPRITE_ALPHA = 0.5;
export const GHOST_PREVIEW_TINT_ALPHA = 0.25;
export const SELECTION_DASH_PATTERN: [number, number] = [4, 3];
export const BUTTON_MIN_RADIUS = 6;
export const BUTTON_RADIUS_ZOOM_FACTOR = 3;
export const BUTTON_ICON_SIZE_FACTOR = 0.45;
export const BUTTON_LINE_WIDTH_MIN = 1.5;
export const BUTTON_LINE_WIDTH_ZOOM_FACTOR = 0.5;
export const BUBBLE_FADE_DURATION_SEC = 0.5;
export const BUBBLE_SITTING_OFFSET_PX = 10;
export const BUBBLE_VERTICAL_OFFSET_PX = 24;

// ── Token burn ("on fire") ──────────────────────────────────
/** New tokens per minute at which an agent starts smoking. */
export const BURN_WARM_PER_MIN = 20_000;
/** New tokens per minute at which an agent catches fire. */
export const BURN_FIRE_PER_MIN = 60_000;
/** Typing-animation speed multiplier per burn level (idle/working, warm, on fire). */
export const BURN_TYPING_SPEED = [1, 1.5, 3] as const;
/** How long each flame/smoke frame shows (ms). */
export const BURN_FRAME_MS = 140;
/** How far above the character's feet the flame's base sits (world px). */
export const BURN_EFFECT_OFFSET_PX = 20;
/** Warm glow drawn behind a burning character. */
export const FIRE_GLOW_COLOR = 'rgba(255, 120, 40, 0.18)';
export const FALLBACK_FLOOR_COLOR = '#808080';

// ── Rendering - Overlay Colors (canvas, not CSS) ─────────────
export const SEAT_OWN_COLOR = 'rgba(0, 127, 212, 0.35)';
export const SEAT_AVAILABLE_COLOR = 'rgba(0, 200, 80, 0.35)';
export const SEAT_BUSY_COLOR = 'rgba(220, 50, 50, 0.35)';
export const GRID_LINE_COLOR = 'rgba(255,255,255,0.12)';
export const VOID_TILE_OUTLINE_COLOR = 'rgba(255,255,255,0.08)';
export const VOID_TILE_DASH_PATTERN: [number, number] = [2, 2];
export const GHOST_BORDER_HOVER_FILL = 'rgba(60, 130, 220, 0.25)';
export const GHOST_BORDER_HOVER_STROKE = 'rgba(60, 130, 220, 0.5)';
export const GHOST_BORDER_STROKE = 'rgba(255, 255, 255, 0.06)';
export const GHOST_VALID_TINT = '#00ff00';
export const GHOST_INVALID_TINT = '#ff0000';
export const SELECTION_HIGHLIGHT_COLOR = '#007fd4';
export const DELETE_BUTTON_BG = 'rgba(200, 50, 50, 0.85)';
export const ROTATE_BUTTON_BG = 'rgba(50, 120, 200, 0.85)';
export const BUTTON_ICON_COLOR = '#fff';
export const CANVAS_FALLBACK_TILE_COLOR = '#444';
export const CANVAS_ERROR_TILE_COLOR = '#FF00FF';
export const WALL_COLOR = '#3A3A5C';

// ── Camera ───────────────────────────────────────────────────
export const CAMERA_FOLLOW_LERP = 0.1;
export const CAMERA_FOLLOW_SNAP_THRESHOLD = 0.5;

// ── Zoom ─────────────────────────────────────────────────────
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 10;
export const ZOOM_DEFAULT_DPR_FACTOR = 2;
export const ZOOM_LEVEL_FADE_DELAY_MS = 1500;
export const ZOOM_LEVEL_HIDE_DELAY_MS = 2000;
export const ZOOM_LEVEL_FADE_DURATION_SEC = 0.5;
export const ZOOM_SCROLL_THRESHOLD = 50;
export const PAN_MARGIN_FRACTION = 0.25;

// ── Editor ───────────────────────────────────────────────────
export const UNDO_STACK_MAX_SIZE = 50;
export const LAYOUT_SAVE_DEBOUNCE_MS = 500;

// ── Layout Import/Export (browser-native, standalone) ────────
/** Suggested filename when exporting the office layout from the standalone browser. */
export const LAYOUT_EXPORT_FILENAME = 'pixel-agents-layout.json';
/** MIME type for the exported layout Blob. */
export const LAYOUT_EXPORT_MIME = 'application/json';
export const DEFAULT_FLOOR_COLOR: ColorValue = { h: 35, s: 30, b: 15, c: 0 };
export const DEFAULT_WALL_COLOR: ColorValue = { h: 240, s: 25, b: 0, c: 0 };
export const DEFAULT_NEUTRAL_COLOR: ColorValue = { h: 0, s: 0, b: 0, c: 0 };

// ── Carpets ──────────────────────────────────────────────────
/** Main (lowest-luminance) color applied to carpets when no per-tile override is set. */
export const CARPET_DEFAULT_COLOR: ColorValue = { h: 0, s: 71, b: -32, c: 0, colorize: true };
/** Accent (highest-luminance) color applied to carpets when no per-tile override is set. */
export const CARPET_DEFAULT_ACCENT_COLOR: ColorValue = {
  h: 34,
  s: 64,
  b: 21,
  c: 0,
  colorize: true,
};
/** Keyboard key that switches from CARPET_PAINT to CARPET_PICK while editing. */
export const KEY_CARPET_PICK = 'p';

// ── Areas (named, colored workspace-folder zones) ────────────
/** Color palette assigned to new Areas in rotation (cycles when more areas exist). */
export const AREA_DEFAULT_COLORS: readonly string[] = [
  '#ff6b6b',
  '#feca57',
  '#48dbfb',
  '#1dd1a1',
  '#5f27cd',
  '#ff9ff3',
  '#54a0ff',
  '#ffa502',
] as const;
/** Translucent overlay alpha for area tile fills. */
export const AREA_OVERLAY_ALPHA = 0.25;
/** Alpha multiplier applied to the actively-selected area's overlay. */
export const AREA_ACTIVE_ALPHA_MULTIPLIER = 1.6;
/** Base font size (pixel-pre-zoom) for area centroid labels. */
export const AREA_LABEL_FONT_SIZE_PX = 14;
/** Minimum on-screen label size to keep labels legible at low zoom. */
export const AREA_LABEL_MIN_FONT_SIZE_PX = 12;
/** Alpha of the area label text. */
export const AREA_LABEL_ALPHA = 1.0;
/** Fallback label color when an area has no color set (shouldn't happen in practice). */
export const AREA_LABEL_FALLBACK_COLOR = '#ffffff';
/** Drop-shadow color behind area labels for legibility on light backgrounds. */
export const AREA_LABEL_SHADOW_COLOR = '#000000';
/** Drop-shadow alpha behind area labels. */
export const AREA_LABEL_SHADOW_ALPHA = 0.6;

// ── VisualColorPicker (HSV wheel + brightness for carpets) ───
export const VISUAL_COLOR_PICKER_SV_SIZE_PX = 180;
export const VISUAL_COLOR_PICKER_HUE_WIDTH_PX = 20;
export const VISUAL_COLOR_PICKER_MARKER_RADIUS_PX = 6;
/**
 * The hue bar gradient is intrinsic to the color-picking interaction, not a
 * theme color — it must span the full hue circle. Centralized here so the
 * component body stays free of inline color literals. (The saturation/brightness
 * square is painted to a canvas from the carpet HSL model, not a CSS gradient.)
 */
export const VISUAL_COLOR_PICKER_HUE_GRADIENT =
  'linear-gradient(to bottom, ' +
  '#ff0000 0%, #ffff00 16.7%, #00ff00 33.3%, ' +
  '#00ffff 50%, #0000ff 66.7%, #ff00ff 83.3%, #ff0000 100%)';
export const VISUAL_COLOR_PICKER_MARKER_BORDER = '2px solid #fff';
export const VISUAL_COLOR_PICKER_MARKER_SHADOW = '0 0 0 1px rgba(0,0,0,0.6)';
/** Width of the collapsed swatch + hex trigger row (compact mode). */
export const VISUAL_COLOR_PICKER_COMPACT_WIDTH_PX = 160;
/** Swatch square size shown in the collapsed trigger. */
export const VISUAL_COLOR_PICKER_SWATCH_PX = 22;
/** Gap (px) between the collapsed trigger and the expanded popup panel. */
export const VISUAL_COLOR_PICKER_POPUP_GAP_PX = 6;

// ── Notification Sound (done: ascending chime) ─────────────
export const NOTIFICATION_NOTE_1_HZ = 659.25; // E5
export const NOTIFICATION_NOTE_2_HZ = 1318.51; // E6 (octave up)
export const NOTIFICATION_NOTE_1_START_SEC = 0;
export const NOTIFICATION_NOTE_2_START_SEC = 0.1;
export const NOTIFICATION_NOTE_DURATION_SEC = 0.18;
export const NOTIFICATION_VOLUME = 0.14;

// ── Permission Sound (attention: descending double tap) ────
export const PERMISSION_NOTE_1_HZ = 880; // A5
export const PERMISSION_NOTE_2_HZ = 659.25; // E5 (down a fourth)
export const PERMISSION_NOTE_1_START_SEC = 0;
export const PERMISSION_NOTE_2_START_SEC = 0.12;
export const PERMISSION_NOTE_DURATION_SEC = 0.15;
export const PERMISSION_VOLUME = 0.12;

// ── Furniture Animation ─────────────────────────────────────
export const FURNITURE_ANIM_INTERVAL_SEC = 0.2;

// ── Version Notice ──────────────────────────────────────────
export const WHATS_NEW_AUTO_CLOSE_MS = 20000;
export const WHATS_NEW_FADE_MS = 1000;

// ── Game Logic ───────────────────────────────────────────────
export const MAX_DELTA_TIME_SEC = 0.1;
export const WAITING_BUBBLE_DURATION_SEC = 2.0;
export const DISMISS_BUBBLE_FAST_FADE_SEC = 0.3;
export const INACTIVE_SEAT_TIMER_MIN_SEC = 3.0;
export const INACTIVE_SEAT_TIMER_RANGE_SEC = 2.0;
/** Default/fallback palette count (bundled characters). Actual count comes from getLoadedCharacterCount(). */
export const PALETTE_COUNT = 6;
export const AUTO_ON_FACING_DEPTH = 3;
export const AUTO_ON_SIDE_DEPTH = 2;
export const CHARACTER_HIT_HALF_WIDTH = 8;
export const CHARACTER_HIT_HEIGHT = 24;
export const TOOL_OVERLAY_VERTICAL_OFFSET = 32;

// ── Greeter + Intro bubble ──────────────────────────────────
/** Reserved character id for the Intro's greeter. Far outside both real agent
 *  ids (positive) and sub-agent ids (small negatives from -1 down). */
export const GREETER_ID = -1_000_000_000;
/** Stacking order for the Intro's bubble. Deliberately BELOW the modal stack
 *  (ui/Modal defaults to 50, ChangelogModal 51, the migration notice z-100): the
 *  Intro is diegetic furniture over the office, not a modal, so a modal opened
 *  on top of it must cover it rather than slide underneath. */
export const INTRO_BUBBLE_Z_INDEX = 45;
/** The greeter stands this many tiles in from the office's bottom-left corner
 *  (target tile (margin, rows-1-margin); nearest walkable tile if blocked). */
export const GREETER_TILE_MARGIN = 3;
/** World px above the greeter's anchor (feet) where the bubble's bottom sits.
 *  Kept well above the head target (INTRO_TAIL_TARGET_RISE_WORLD) so the
 *  tail squares have a visible run between bubble and head. */
export const INTRO_BUBBLE_ANCHOR_RISE_WORLD = 44;
/** World px right of the greeter's center where the bubble's left edge starts —
 *  just clear of the sprite so the tail points down-left at the head. */
export const INTRO_BUBBLE_OFFSET_X_WORLD = 10;
/** Bubble width cap (CSS px) and the margin kept from the container edges.
 *  Wide on purpose: the disclosure reads as three short paragraphs instead of
 *  a tall column (still clamped to the container on narrow panels). */
export const INTRO_BUBBLE_MAX_WIDTH_PX = 560;
export const INTRO_BUBBLE_EDGE_MARGIN_PX = 4;
/** Where the Intro's Claude Code step sends people who don't have it yet. */
export const CLAUDE_CODE_URL = 'https://claude.com/claude-code';
export const CLAUDE_CODE_INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code';
/** Speech-tail squares: placed at fraction `t` along the segment from the
 *  bubble's nearest edge point to the greeter's head, shrinking toward the
 *  speaker. Recomputed every frame so the tail stays connected no matter where
 *  edge-clamping or panning puts the bubble relative to the character. */
export const INTRO_TAIL_STEPS = [
  { t: 0.25, size: 12 },
  { t: 0.55, size: 9 },
  { t: 0.82, size: 6 },
] as const;
/** World px above the greeter's anchor (feet) the tail points at — the head. */
export const INTRO_TAIL_TARGET_RISE_WORLD = 26;
/** Camera-offset caps while centering character + bubble. The ideal composition
 *  assumes the bubble fits beside/above the character; when it can't (narrow or
 *  short viewports clamp the bubble to the screen), uncapped offsets shove the
 *  greeter to the viewport edge. Horizontal offset is capped to this fraction
 *  of the viewport; vertical offset always keeps this many world px of the
 *  character visible above the bottom edge. */
export const INTRO_CAMERA_MAX_X_OFFSET_VIEWPORT_FRACTION = 0.25;
export const INTRO_CAMERA_MIN_CHAR_VISIBLE_WORLD = 48;
/** Extra downward camera shift (CSS px) so the character+bubble composition
 *  sits a bit above the vertical center instead of dead-centered. */
export const INTRO_CAMERA_DOWN_SHIFT_PX = 50;

// ── Context Fuel Gauge ──────────────────────────────────────
/** Window assumed before the runtime reports one (it always does for agents
 *  that have taken a turn; this only covers characters created ahead of it). */
export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
export const CONTEXT_WARN_THRESHOLD = 0.6;
export const CONTEXT_DANGER_THRESHOLD = 0.8;
export const CONTEXT_CRITICAL_THRESHOLD = 0.95;
export const CONTEXT_GAUGE_WIDTH_PX = 40;
export const CONTEXT_GAUGE_HEIGHT_PX = 4;
export const CONTEXT_GAUGE_COLOR_OK = '#44cc44';
export const CONTEXT_GAUGE_COLOR_WARN = '#ffcc00';
export const CONTEXT_GAUGE_COLOR_DANGER = '#ff8800';
export const CONTEXT_GAUGE_COLOR_CRITICAL = '#ff2222';
export const CONTEXT_GAUGE_BG = '#222';

// ── Agent Teams ─────────────────────────────────────────────
export const TEAM_LEAD_COLOR = '#ffd700';
export const TEAM_ROLE_COLOR = '#66aaff';

// ── Pets ────────────────────────────────────────────────────────
/** Walking speed in world pixels per second (matches character walk speed visually but slower). */
export const PET_WALK_SPEED_PX_PER_SEC = 32;
/** Time per WALK animation cycle step (4 cycle steps × 0.15s = 0.6s per loop). */
export const PET_WALK_FRAME_DURATION_SEC = 0.15;
/** Time per IDLE animation cycle step (4 cycle steps × 0.3s = 1.2s per loop). */
export const PET_IDLE_FRAME_DURATION_SEC = 0.3;
/** Walk cycle: 4-step lookup into the 3-frame walkDown/walkUp/walkRight arrays. */
export const PET_WALK_SEQUENCE = [0, 1, 0, 2] as const;
/** Idle cycle: 4-step lookup into the 3-frame idleDown/idleUp arrays. */
export const PET_IDLE_SEQUENCE = [0, 1, 2, 1] as const;
/** Minimum seconds the pet stays in IDLE before making a new decision. */
export const PET_WANDER_PAUSE_MIN_SEC = 3.0;
/** Maximum seconds the pet stays in IDLE before making a new decision. */
export const PET_WANDER_PAUSE_MAX_SEC = 15.0;
/** Seconds between FOLLOW path re-computations. */
export const PET_FOLLOW_RECALC_INTERVAL_SEC = 1.0;
/** Probability that a pet enters FOLLOW (instead of WALK) when wanderTimer expires. */
export const PET_FOLLOW_CHANCE = 0.3;
/** Maximum Manhattan distance (tiles) at which a character can become a follow target. */
export const PET_FOLLOW_RADIUS_TILES = 3;
/** Minimum seconds a FOLLOW episode lasts before timing out. */
export const PET_FOLLOW_DURATION_MIN_SEC = 5.0;
/** Maximum seconds a FOLLOW episode lasts before timing out. */
export const PET_FOLLOW_DURATION_MAX_SEC = 15.0;
/** Hit-box half-width (world px) for pet click detection. */
export const PET_HIT_HALF_WIDTH = 8;
/** Hit-box height (world px) measured upward from the bottom-center anchor. */
export const PET_HIT_HEIGHT = 16;
/** Zoom factor used to draw pet thumbnails in the EditorToolbar Pets tab. */
export const PET_THUMB_ZOOM = 2;
/** Scale margin so the pet thumbnail fills the ItemSelect cell without touching the edges. */
export const PET_THUMB_SCALE_MARGIN = 0.85;
/** Fallback background fill for sprite-less thumbnail (used while pet sprites are loading). */
export const EMPTY_SPRITE_THUMBNAIL_BG = '#333';
/** Maximum string length for a PlacedPet.id (defends against pathologically-long layout entries). */
export const MAX_PET_ID_LENGTH = 128;

// ── Office chat + whiteboard ────────────────────────────────
/** Width of the chat card anchored next to a character (CSS px). */
export const CHAT_CARD_WIDTH_PX = 440;
/** Height of the chat card (CSS px). */
export const CHAT_CARD_HEIGHT_PX = 520;
/** Horizontal gap between the character and the chat card's tail (CSS px). */
export const CHAT_CARD_GAP_PX = 36;
/** Margin the chat card keeps from the panel edges (CSS px). */
export const CHAT_CARD_EDGE_MARGIN_PX = 8;
/** Width of the open whiteboard rail (CSS px). */
export const WHITEBOARD_RAIL_WIDTH_PX = 320;
/** Longest pin detail (server: BOARD_PIN_DETAIL_MAX_CHARS). */
export const BOARD_PIN_DETAIL_MAX_CHARS = 4_000;
/** A pin's detail is folded to this many characters until expanded. */
export const BOARD_PIN_DETAIL_PREVIEW_CHARS = 160;
/** How far above the character's feet a message preview bubble sits (world px). */
export const CHAT_PEEK_VERTICAL_OFFSET = 44;
/** Longest preview shown in a message bubble above a character. */
export const CHAT_PEEK_MAX_CHARS = 80;
/** Entries kept per agent in the webview (matches the server's history cap). */
export const CHAT_CLIENT_HISTORY_LIMIT = 200;
/** DataTransfer type carrying a whiteboard pin id while it is dragged. */
export const PIN_DRAG_MIME = 'application/x-pixel-agents-pin';
/** A workflow card dragged from the Workflows rail onto a character. */
export const WORKFLOW_DRAG_MIME = 'application/x-pixel-agents-workflow';
/** A task desk card being dragged (onto a board column or a character). */
export const DESK_CARD_DRAG_MIME = 'application/x-pixel-agents-desk-card';
/** Steps a workflow card lists on the full Workflows page before "+N more". */
export const WORKFLOW_PREVIEW_STEPS = 6;
/** Longest character name the rename box accepts (the server caps it too). */
export const AGENT_NAME_INPUT_MAX_CHARS = 32;

// ── Touch + small screens ───────────────────────────────────
/** Below this panel width the chat card becomes a bottom sheet and the whiteboard goes full width. */
export const MOBILE_BREAKPOINT_PX = 640;
/** Share of the panel height the chat bottom sheet takes on small screens. */
export const CHAT_SHEET_HEIGHT_FRACTION = 0.72;
/** A touch that moves less than this (CSS px) is a tap, not a pan. */
export const TOUCH_TAP_SLOP_PX = 8;

// ── Document viewer ─────────────────────────────────────────
/** Route pinned files are fetched from (server: BOARD_FILE_API_PREFIX). */
export const BOARD_FILE_API = '/api/board/files';
/** Files the office opened, fetched by file id (server: OFFICE_FILE_API_PREFIX). */
export const OFFICE_FILE_API = '/api/docs/files';
/** Command agents run to post a note to the whiteboard (server: BOARD_CLI_COMMAND). */
export const BOARD_POST_COMMAND = 'pixel-office board add --note';
/** How agents list everyone in the office (any CLI), told in the group-chat note. */
export const AGENTS_LIST_COMMAND = 'pixel-office agents';
/** Most table rows the viewer draws for a sheet or CSV. */
export const DOC_TABLE_MAX_ROWS = 2_000;
/** Largest upload the office accepts (server enforces the same). */
export const DOC_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
/** Route the chat uploads files for agents to (server: CHAT_FILE_API_PREFIX). */
export const CHAT_FILE_API = '/api/files';
/** Uploaded files the chat shows inline as images (server serves only these). */
export const CHAT_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const;
/** Folder (under the home directory) uploaded chat files are stored in. */
export const CHAT_UPLOAD_DIR_SUFFIX = '.pixel-agents/files';
/** Stored chat uploads are named `chat_<id>-<name>` (server/src/boardFiles.ts). */
export const CHAT_FILE_ID_PREFIX = 'chat_';
/** Most files attached to one chat message. */
export const CHAT_FILE_MAX_COUNT = 10;
/** Around the rendered Word pages (docx-preview) inside the sandboxed frame, plus the
 *  ¶ numbers in the margin and the picked / marked paragraph highlights. */
export const DOCX_FRAME_CSS =
  'html,body{margin:0;background:#e8e9ec}' +
  '.docx-wrapper{background:#e8e9ec!important;padding:24px 0!important}' +
  '.docx-wrapper>section.docx{box-shadow:0 1px 4px rgba(0,0,0,.25);margin-bottom:24px!important}' +
  '[data-para]{position:relative;cursor:pointer}' +
  '[data-para]:hover{outline:1px dashed #9aa4b2;outline-offset:2px}' +
  '[data-para]::before{content:"¶" attr(data-para);position:absolute;left:-46px;top:0;width:40px;' +
  'text-align:right;font:10px/1.6 ui-monospace,Menlo,monospace;color:#9aa4b2;pointer-events:none}' +
  '.pa-mark{background:rgba(255,213,79,.35)!important;box-shadow:-6px 0 0 #d9a400}' +
  '.pa-pick{background:rgba(90,168,255,.28)!important;box-shadow:-6px 0 0 #2f7fd8}' +
  // An agent's suggested change, placed in the page (DocSuggestions / WordDocumentView).
  // Deleted text: red, struck through (also over the document's own run colours).
  '.pa-sugg-old,.pa-sugg-old *{color:#b3261e!important;text-decoration:line-through!important;' +
  'text-decoration-color:#b3261e!important}' +
  '.pa-sugg-old{background:rgba(179,38,30,.08)}' +
  // Suggested text: green.
  '.pa-sugg{margin:4px 0 10px;padding:6px 8px;border:1px dashed #1e7a3c;background:#eaf7ee;' +
  'color:#1e7a3c;white-space:pre-wrap}' +
  '.pa-sugg[data-state="accepted"]{border-style:solid;background:#d6f0de}' +
  '.pa-sugg[data-state="rejected"]{opacity:.45;color:#5d6470;border-color:#9aa4b2;background:#f4f5f7}' +
  '.pa-sugg-actions{display:flex;gap:6px;align-items:center;margin-top:6px;font:12px system-ui,sans-serif;color:#5d6470;white-space:normal}' +
  '.pa-sugg-actions span{flex:1}' +
  '.pa-sugg button{font:12px system-ui,sans-serif;padding:2px 10px;border:1px solid #9aa4b2;background:#fff;color:#1f242b;cursor:pointer}' +
  '.pa-sugg button[data-decision="accepted"]{background:#1e7a3c;border-color:#1e7a3c;color:#fff}';

// ── Team rooms ──────────────────────────────────────────────
export const TEAM_ROOM_GLASS = '#3f7fa8';
export const TEAM_ROOM_TINT = 'rgba(190, 215, 235, 0.16)';
export const TEAM_ROOM_LABEL_COLOR = '#ffffff';
/** Glass wall thickness and name-tab text size, in sprite pixels. */
export const TEAM_ROOM_WALL_PX = 1;
export const TEAM_ROOM_LABEL_PX = 5;
/** Color given to a new team room's area (its editing overlay). */
export const TEAM_ROOM_AREA_COLOR = '#3f7fa8';

/** Width of the group chat panel docked on the right (CSS px). */
export const GROUP_CHAT_WIDTH_PX = 480;
/** Permission prompts answered from the office (PermissionPrompts.tsx). */
export const PERMISSION_PROMPTS_WIDTH_PX = 420;
export const PERMISSION_PROMPTS_MAX_SHOWN = 3;
/** Above every modal (they top out at 54 + 1): an agent is blocked until it's answered. */
export const PERMISSION_PROMPTS_Z_INDEX = 60;
/** A screen-question click that didn't move the screen on can be retried after this. */
export const SCREEN_QUESTION_RETRY_MS = 4_000;
/** Text files up to this many lines get line numbers in the viewer (a bigger one
 *  shows a window around the lines an agent pointed at). */
export const DOC_NUMBERED_MAX_LINES = 20_000;
/** "Show me" notices shown at once; more wait in the viewer's list. */
export const FOCUS_NOTICES_MAX_SHOWN = 3;
/** localStorage key for the Messenger's reading settings (per viewer). */
/** Whether the viewer folded away workflow steps in the chat card and Messages (localStorage). */
/** Commands the chat's `/` menu shows at once (it scrolls). */
export const SLASH_MENU_MAX_ITEMS = 60;
export const WORKFLOW_STEPS_HIDDEN_KEY = 'pixel-agents.workflowStepsHidden';
export const MESSENGER_PREFS_KEY = 'pixel-office:messenger-prefs';
/** Files opened with Open file, newest first (per viewer). */
export const OPEN_FILE_RECENT_KEY = 'pixel-office:open-file-recent';
export const OPEN_FILE_RECENT_MAX = 8;
/** Above the document viewer (z-60), which it can be opened from. */
export const OPEN_FILE_Z_INDEX = 70;
/** How often the Files rail refreshes its "5 min ago" labels. */
export const FILES_CLOCK_TICK_MS = 30_000;
/** Which agent each document's chat talks to (per viewer): path → agent id. */
export const DOC_CHAT_AGENTS_KEY = 'pixel-office:doc-chat-agents';
/** Messages a document chat shows before "Show earlier". */
export const DOC_CHAT_RECENT_ENTRIES = 30;
/** localStorage key for the viewer's text settings: size + faces (textPrefs.ts). */
export const TEXT_PREFS_KEY = 'pixel-office:text-prefs';
/** localStorage key for Settings → Advanced overrides (tunables.ts); only non-defaults are stored. */
export const TUNABLES_KEY = 'pixel-office:tunables';
/** Settings → Text size: the multiplier on every text token in index.css. */
export const TEXT_SIZE_SCALES = {
  small: 0.875,
  normal: 1,
  large: 1.125,
  xlarge: 1.25,
} as const;
/** Set once the welcome tour has shown itself; Settings can still replay it. */
export const INTRO_SEEN_KEY = 'pixel-office:intro-seen';
/** Docked Messenger: width the user dragged it to (per viewer), and its bounds. */
export const MESSENGER_DOCK_WIDTH_KEY = 'pixel-office:messenger-dock-width';
export const MESSENGER_DOCK_DEFAULT_PX = 440;
export const MESSENGER_DOCK_MIN_PX = 320;
/** Office left visible beside the widest dock. */
export const MESSENGER_DOCK_OFFICE_MIN_PX = 160;
/** Arrow-key step on the dock's resize handle. */
export const MESSENGER_DOCK_KEY_STEP_PX = 32;
/** Diff rows an edit card shows before "Show all". */
export const MESSENGER_EDIT_PREVIEW_ROWS = 24;
/** How far above a character's feet its workflow progress pips sit (sprite px). */
export const WORKFLOW_BADGE_VERTICAL_OFFSET = 30;
/** How long the flash lasts when a character steps through a portal. */
export const WARP_FLASH_SEC = 0.5;
/** Portal ring colors (canvas) and how fast it pulses. */
export const PORTAL_RING_COLOR = '#6ef0ff';
export const PORTAL_CORE_COLOR = '#1b3350';
export const PORTAL_GLOW_COLOR = 'rgba(110, 240, 255, 0.35)';
export const PORTAL_PULSE_SEC = 1.2;
/** Team-room door (canvas): wood frame, and the red wash on a room with no door (edit mode). */
export const ROOM_DOOR_COLOR = '#8b5e3c';
export const ROOM_DOOR_EDGE_COLOR = '#4a2f1c';
export const ROOM_NO_DOOR_TINT = 'rgba(209, 66, 73, 0.18)';
export const WARP_SPARK_COLOR = '#c8f8ff';

// ── Task desk ────────────────────────────────────────────────
export const TASK_DESK_WIDTH_PX = 420;
/** Narrowest a column of the full board gets before the board scrolls sideways. */
export const TASK_DESK_COLUMN_MIN_PX = 230;
export const TASK_TITLE_MAX_CHARS = 120;
export const TASK_BODY_MAX_CHARS = 4000;
/** Lines the card form's details box shows; longer text scrolls inside it. */
export const TASK_DETAILS_ROWS = 12;
/** Lines it shows after Expand. */
export const TASK_DETAILS_EXPANDED_ROWS = 28;
export const TASK_NOTE_MAX_CHARS = 2000;
export const TASK_SUBTASK_MAX_CHARS = 200;
/** A step's ref: a path plus place flags. */
export const TASK_STEP_REF_MAX_CHARS = 300;
/** Added under Word / PowerPoint / Excel refs in a message: how the agent reads those places. */
export const DOC_READ_HINT =
  '(Read these places with: pixel-office doc read <file> --para A-B | --slide N | --cell RANGE)';
/** localStorage key: the command the desk last started an agent with (`claude`, or an alias of it). */
export const TASK_DESK_COMMAND_KEY = 'pixel-agents.deskLaunchCommand';
/** The first prompt of an agent the desk starts. It needs one: the office only
 *  sees a session once its transcript exists, and that starts with a prompt. */
export const TASK_DESK_FIRST_MESSAGE =
  'You were started by the Pixel Office task desk. A card will follow. Reply with just: ready';

// ── 3D office (Soft Dollhouse view) ─────────────────────────────
/** localStorage key: which office view this viewer uses ('pixel' | '3d'). */
export const OFFICE_VIEW_KEY = 'pixel-agents.officeView';
/** World px per metre: one tile is one metre in the 3D view. */
export const OFFICE3D_PX_PER_M = 16;
export const OFFICE3D_WALL_HEIGHT_M = 1.4;
export const OFFICE3D_DESK_HEIGHT_M = 0.74;
export const OFFICE3D_SEAT_HEIGHT_M = 0.47;
/** Grass border around the office island, in tiles. */
export const OFFICE3D_LAND_MARGIN = 3;
/** Camera: field of view (deg), tilt limits (rad), zoom limits. */
export const OFFICE3D_FOV = 30;
export const OFFICE3D_TILT_MIN = 0.45;
export const OFFICE3D_TILT_MAX = 1.35;
export const OFFICE3D_ZOOM_MIN = 0.35;
export const OFFICE3D_ZOOM_MAX = 2.5;
/** Pointer travel (px) that turns a click into a drag. */
export const OFFICE3D_DRAG_SLOP_PX = 4;
/** Sub-agents are drawn smaller than their lead. */
export const OFFICE3D_SUBAGENT_SCALE = 0.72;
export const OFFICE3D_WALK_SWING = 0.6;
export const OFFICE3D_COLORS = {
  sky: '#F1E7DC',
  floorA: '#F3E4CE',
  floorB: '#EAD6BA',
  wall: '#EFC9BC',
  wallCap: '#FFF6EA',
  base: '#C39A72',
  grass: '#A3CC86',
  hemiSky: '#FFFFFF',
  hemiGround: '#C9A77F',
  sun: '#FFF1DC',
  deskTop: '#FFF5E6',
  deskLeg: '#E3B57A',
  chair: '#86B8BE',
  chairBack: '#6A9FA6',
  screen: '#4A4560',
  screenOn: '#8FD3FF',
  pot: '#E8927C',
  leaf: '#7CC67A',
  eyes: '#2A2638',
  cheek: '#F2A0A0',
  shoes: '#4A4560',
  select: '#E8927C',
  frames: '#22252B',
  lens: '#CFE8F2',
  cup: '#E8927C',
  collar: '#F4F1EA',
  tie: '#C23B3B',
  tieKnot: '#A12F2F',
  exitSign: '#2FB36B',
  mat: '#B98A5E',
  glass: '#BFD9E8',
  tagBg: '#FFF6EA',
  tagInk: '#2A2638',
  skyNight: '#221F37',
  hemiNight: '#6A6590',
  sunNight: '#9DB4FF',
  lamp: '#FFC978',
  smoke: '#9A9AA6',
  flame: '#FF8A2A',
  flameCore: '#FFD34D',
  talk: '#FFFFFF',
  carpet: '#C98F7A',
  ghostOk: '#4ADE80',
  ghostBad: '#F87171',
  gridLine: '#1B1D22',
  edgeLine: '#6030FF',
} as const;
/** The six character palettes, in the same order as char_0..char_5.png. */
export const OFFICE3D_PALETTES: ReadonlyArray<{
  shirt: string;
  pants: string;
  skin: string;
  hair: string;
}> = [
  { shirt: '#3B6EA8', pants: '#2B2F3A', skin: '#E8B98F', hair: '#2B1D14' },
  { shirt: '#D2573F', pants: '#3A3F4B', skin: '#8D5A3B', hair: '#1A1412' },
  { shirt: '#3F8F6B', pants: '#4B3F35', skin: '#F2CBA5', hair: '#C98A3D' },
  { shirt: '#8C5BB5', pants: '#2E3040', skin: '#C68A5E', hair: '#101010' },
  { shirt: '#E0A43A', pants: '#35495E', skin: '#FFD9B8', hair: '#7A3E22' },
  { shirt: '#5E6B78', pants: '#22252B', skin: '#A86E48', hair: '#3C3C3C' },
];
/** Overlay rise (world px above the feet, as the pixel view counts it) → metres:
 *  32 px is the top of a standing sprite, the top of a 3D head is ~1.3 m. */
export const OFFICE3D_RISE_M_PER_PX = 1.3 / 32;
/** Light strength (three.js physical units) and how far the camera starts from the office. */
export const OFFICE3D_HEMI_INTENSITY = 2.6;
export const OFFICE3D_SUN_INTENSITY = 2.4;
export const OFFICE3D_CAMERA_SPAN_K = 1.2;
/** Character studio colour choices. */
export const OFFICE3D_SWATCHES = {
  skin: ['#ffe0c7', '#f2cba5', '#e8b98f', '#c68a5e', '#a86e48', '#8d5a3b', '#6b4230'],
  hairColor: [
    '#101010',
    '#2b1d14',
    '#5a3825',
    '#8a4b2a',
    '#c98a3d',
    '#d9b26f',
    '#b8b8b8',
    '#e86f8f',
    '#4f6db8',
  ],
  shirt: [
    '#3b6ea8',
    '#2f9c95',
    '#3f8f6b',
    '#7a9a3b',
    '#e0a43a',
    '#e07a3f',
    '#d2573f',
    '#c45baa',
    '#8c5bb5',
    '#5e6b78',
    '#f4f1ea',
    '#2b2f3a',
  ],
  pants: ['#2b2f3a', '#35495e', '#4b3f35', '#3a3f4b', '#6b7a8f', '#c9b79c'],
} as const;
/** Studio preview backdrop. */
export const OFFICE3D_STUDIO_BG = '#2A2E36';
/** 3D meetings: how often, how long, how long each speaker talks, and how long
 *  a whole team must be free before it gathers. */
export const OFFICE3D_MEET_EVERY_SEC = 180;
export const OFFICE3D_MEET_LENGTH_SEC = 35;
export const OFFICE3D_MEET_SPEAK_SEC = 4;
export const OFFICE3D_TEAM_MEET_AFTER_SEC = 20;
/** localStorage key: the 3D office's day/night choice ('day' | 'night' | 'auto'). */
export const OFFICE3D_NIGHT_KEY = 'pixel-agents.office3dNight';
/** 'auto' night hours (local time). */
export const OFFICE3D_NIGHT_FROM_HOUR = 19;
export const OFFICE3D_NIGHT_TO_HOUR = 7;
/** Tiles added per click on a 3D edit-mode "+" edge button. */
export const OFFICE3D_GROW_STEP = 4;
