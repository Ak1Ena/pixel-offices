/**
 * Settings → Advanced: the user-facing webview tunables. Each entry's default IS
 * the constant in constants.ts, so the constants stay the single source of
 * default values and this registry only adds a label, a group and safe bounds.
 *
 * Pure (DOM-free): parsing and clamping live here and run under the Node test
 * runner. `tunableStore.ts` keeps the live values; `hooks/useTunables.ts` is the
 * React side.
 *
 * Only values a viewer could reasonably want different belong here — how much
 * of something shows, how big a panel is, how the characters pace themselves,
 * when an agent looks "on fire". Grid/sprite sizes, rendering internals,
 * protocol and storage keys, colors and z-indexes stay constants.
 */

import {
  BOARD_PIN_DETAIL_PREVIEW_CHARS,
  BURN_FIRE_PER_MIN,
  BURN_TYPING_SPEED,
  BURN_WARM_PER_MIN,
  CAMERA_FOLLOW_LERP,
  CHAT_CARD_HEIGHT_PX,
  CHAT_CARD_WIDTH_PX,
  CHAT_PEEK_MAX_CHARS,
  CHAT_SHEET_HEIGHT_FRACTION,
  CONTEXT_CRITICAL_THRESHOLD,
  CONTEXT_DANGER_THRESHOLD,
  CONTEXT_WARN_THRESHOLD,
  DOC_NUMBERED_MAX_LINES,
  DOC_TABLE_MAX_ROWS,
  FOCUS_NOTICES_MAX_SHOWN,
  GROUP_CHAT_WIDTH_PX,
  HEADLESS_CHARACTER_ALPHA,
  INACTIVE_SEAT_TIMER_MIN_SEC,
  MESSENGER_DOCK_DEFAULT_PX,
  MESSENGER_DOCK_MIN_PX,
  MESSENGER_EDIT_PREVIEW_ROWS,
  NOTIFICATION_VOLUME,
  PERMISSION_PROMPTS_MAX_SHOWN,
  PERMISSION_PROMPTS_WIDTH_PX,
  PERMISSION_VOLUME,
  PET_FOLLOW_CHANCE,
  PET_WALK_SPEED_PX_PER_SEC,
  SEAT_REST_MAX_SEC,
  SEAT_REST_MIN_SEC,
  TASK_DESK_COLUMN_MIN_PX,
  TASK_DESK_WIDTH_PX,
  UNDO_STACK_MAX_SIZE,
  WAITING_BUBBLE_DURATION_SEC,
  WALK_SPEED_PX_PER_SEC,
  WANDER_MOVES_BEFORE_REST_MAX,
  WANDER_MOVES_BEFORE_REST_MIN,
  WANDER_PAUSE_MAX_SEC,
  WANDER_PAUSE_MIN_SEC,
  WHATS_NEW_AUTO_CLOSE_MS,
  WHITEBOARD_RAIL_WIDTH_PX,
  WORKFLOW_PREVIEW_STEPS,
  ZOOM_DEFAULT_DPR_FACTOR,
} from './constants.js';

export const TUNABLE_GROUPS = [
  { id: 'chat', label: 'Prompts & chat' },
  { id: 'office', label: 'Office & characters' },
  { id: 'activity', label: 'Activity & burn' },
  { id: 'documents', label: 'Documents' },
  { id: 'notices', label: 'Sound & notices' },
  { id: 'editor', label: 'Layout editor' },
] as const;

export type TunableGroup = (typeof TUNABLE_GROUPS)[number]['id'];

export interface TunableDef {
  group: TunableGroup;
  label: string;
  description: string;
  default: number;
  min: number;
  max: number;
  step: number;
  /** Shown after the number ('px', 's', …). */
  unit: string;
  /** Whole numbers only (counts, rows, px). */
  int?: boolean;
  /** Stored as a 0..1 fraction, shown and edited as a percentage. */
  percent?: boolean;
}

const px = (
  group: TunableGroup,
  label: string,
  description: string,
  def: number,
  min: number,
  max: number,
): TunableDef => ({
  group,
  label,
  description,
  default: def,
  min,
  max,
  step: 10,
  unit: 'px',
  int: true,
});

const count = (
  group: TunableGroup,
  label: string,
  description: string,
  def: number,
  min: number,
  max: number,
  unit: string,
  step = 1,
): TunableDef => ({ group, label, description, default: def, min, max, step, unit, int: true });

const fraction = (
  group: TunableGroup,
  label: string,
  description: string,
  def: number,
  min: number,
  max: number,
): TunableDef => ({
  group,
  label,
  description,
  default: def,
  min,
  max,
  step: 0.01,
  unit: '%',
  percent: true,
});

const seconds = (
  group: TunableGroup,
  label: string,
  description: string,
  def: number,
  min: number,
  max: number,
  step = 0.5,
): TunableDef => ({ group, label, description, default: def, min, max, step, unit: 's' });

const factor = (
  group: TunableGroup,
  label: string,
  description: string,
  def: number,
  min: number,
  max: number,
): TunableDef => ({ group, label, description, default: def, min, max, step: 0.1, unit: '×' });

export const TUNABLES = {
  // ── Prompts & chat ──
  permissionPromptsMaxShown: count(
    'chat',
    'Prompts shown at once',
    'Permission asks, gates and questions stacked at the top; the rest wait.',
    PERMISSION_PROMPTS_MAX_SHOWN,
    1,
    10,
    '',
  ),
  permissionPromptsWidthPx: px(
    'chat',
    'Prompt width',
    'Width of the permission prompt stack.',
    PERMISSION_PROMPTS_WIDTH_PX,
    300,
    900,
  ),
  focusNoticesMaxShown: count(
    'chat',
    '"Show me" notices shown',
    'Notices shown at once; more wait in the viewer list.',
    FOCUS_NOTICES_MAX_SHOWN,
    1,
    10,
    '',
  ),
  chatCardWidthPx: px(
    'chat',
    'Chat card width',
    'Chat card beside a character.',
    CHAT_CARD_WIDTH_PX,
    320,
    1000,
  ),
  chatCardHeightPx: px(
    'chat',
    'Chat card height',
    'Chat card beside a character.',
    CHAT_CARD_HEIGHT_PX,
    320,
    1200,
  ),
  chatSheetHeightFraction: fraction(
    'chat',
    'Chat sheet height (small screens)',
    'Share of the screen the chat bottom sheet takes on phones.',
    CHAT_SHEET_HEIGHT_FRACTION,
    0.4,
    0.95,
  ),
  chatPeekMaxChars: count(
    'chat',
    'Reply preview length',
    'Longest preview in the bubble above a character.',
    CHAT_PEEK_MAX_CHARS,
    20,
    300,
    'chars',
    10,
  ),
  groupChatWidthPx: px(
    'chat',
    'Group chat width',
    'Group chat panel on the right.',
    GROUP_CHAT_WIDTH_PX,
    320,
    1000,
  ),
  messengerDockDefaultPx: px(
    'chat',
    'Docked Messages width',
    'Width the docked Messages panel starts at (double-click its edge to return to it).',
    MESSENGER_DOCK_DEFAULT_PX,
    MESSENGER_DOCK_MIN_PX,
    1400,
  ),
  messengerEditPreviewRows: count(
    'chat',
    'Diff rows before "Show all"',
    'Lines an edit card in Messages shows before folding.',
    MESSENGER_EDIT_PREVIEW_ROWS,
    4,
    400,
    'rows',
  ),
  whiteboardRailWidthPx: px(
    'chat',
    'Whiteboard width',
    'Width of the open whiteboard rail.',
    WHITEBOARD_RAIL_WIDTH_PX,
    240,
    800,
  ),
  taskDeskWidthPx: px(
    'chat',
    'Task desk width',
    'Width of the open task desk rail.',
    TASK_DESK_WIDTH_PX,
    280,
    900,
  ),
  taskDeskColumnMinPx: px(
    'chat',
    'Board column width',
    'Narrowest column on the full task board.',
    TASK_DESK_COLUMN_MIN_PX,
    160,
    480,
  ),
  boardPinDetailPreviewChars: count(
    'chat',
    'Pin note preview',
    'Characters of a pin note shown before "more".',
    BOARD_PIN_DETAIL_PREVIEW_CHARS,
    40,
    2000,
    'chars',
    20,
  ),
  workflowPreviewSteps: count(
    'chat',
    'Workflow steps previewed',
    'Steps a workflow card lists before "+N more".',
    WORKFLOW_PREVIEW_STEPS,
    1,
    50,
    'steps',
  ),

  // ── Office & characters ──
  walkSpeedPxPerSec: count(
    'office',
    'Walking speed',
    'How fast characters walk.',
    WALK_SPEED_PX_PER_SEC,
    8,
    192,
    'px/s',
    4,
  ),
  wanderPauseMinSec: seconds(
    'office',
    'Wander pause (shortest)',
    'Idle characters stand this long at least between strolls.',
    WANDER_PAUSE_MIN_SEC,
    0,
    120,
  ),
  wanderPauseMaxSec: seconds(
    'office',
    'Wander pause (longest)',
    'Idle characters stand at most this long between strolls.',
    WANDER_PAUSE_MAX_SEC,
    0,
    300,
  ),
  wanderMovesMin: count(
    'office',
    'Strolls before sitting (fewest)',
    'Moves an idle character makes before returning to its seat.',
    WANDER_MOVES_BEFORE_REST_MIN,
    0,
    30,
    'moves',
  ),
  wanderMovesMax: count(
    'office',
    'Strolls before sitting (most)',
    'Moves an idle character makes before returning to its seat.',
    WANDER_MOVES_BEFORE_REST_MAX,
    0,
    50,
    'moves',
  ),
  seatRestMinSec: seconds(
    'office',
    'Rest at seat (shortest)',
    'How long an idle character sits before wandering again.',
    SEAT_REST_MIN_SEC,
    0,
    1800,
    5,
  ),
  seatRestMaxSec: seconds(
    'office',
    'Rest at seat (longest)',
    'How long an idle character sits before wandering again.',
    SEAT_REST_MAX_SEC,
    0,
    3600,
    5,
  ),
  inactiveSeatSec: seconds(
    'office',
    'Stay seated after a turn',
    'Seconds an agent keeps sitting after it finishes (plus up to 2 s).',
    INACTIVE_SEAT_TIMER_MIN_SEC,
    0,
    120,
  ),
  waitingBubbleSec: seconds(
    'office',
    '"Done" bubble time',
    'How long the green check above a finished agent stays.',
    WAITING_BUBBLE_DURATION_SEC,
    0.5,
    30,
  ),
  headlessAlpha: fraction(
    'office',
    'Headless ghost opacity',
    'Opacity of headless agents when "Display Headless as Ghosts" is on.',
    HEADLESS_CHARACTER_ALPHA,
    0.1,
    1,
  ),
  cameraFollowLerp: fraction(
    'office',
    'Camera follow speed',
    'How much of the distance to the followed agent the camera covers per frame.',
    CAMERA_FOLLOW_LERP,
    0.02,
    1,
  ),
  defaultZoomDprFactor: count(
    'office',
    'Default zoom',
    'Starting zoom, per device pixel (applies next time the office opens).',
    ZOOM_DEFAULT_DPR_FACTOR,
    1,
    6,
    '× DPR',
  ),
  petWalkSpeedPxPerSec: count(
    'office',
    'Pet walking speed',
    'How fast pets walk.',
    PET_WALK_SPEED_PX_PER_SEC,
    8,
    160,
    'px/s',
    4,
  ),
  petFollowChance: fraction(
    'office',
    'Pet follow chance',
    'Chance a pet follows a nearby character instead of wandering.',
    PET_FOLLOW_CHANCE,
    0,
    1,
  ),

  // ── Activity & burn ──
  burnWarmPerMin: count(
    'activity',
    'Smoking at',
    'New tokens per minute at which an agent starts smoking.',
    BURN_WARM_PER_MIN,
    1_000,
    1_000_000,
    'tok/min',
    1_000,
  ),
  burnFirePerMin: count(
    'activity',
    'On fire at',
    'New tokens per minute at which an agent catches fire.',
    BURN_FIRE_PER_MIN,
    1_000,
    2_000_000,
    'tok/min',
    1_000,
  ),
  burnWarmTypingSpeed: factor(
    'activity',
    'Typing speed when smoking',
    'Typing animation speed-up while an agent is smoking.',
    BURN_TYPING_SPEED[1],
    1,
    6,
  ),
  burnFireTypingSpeed: factor(
    'activity',
    'Typing speed when on fire',
    'Typing animation speed-up while an agent is on fire.',
    BURN_TYPING_SPEED[2],
    1,
    10,
  ),
  contextWarnThreshold: fraction(
    'activity',
    'Context gauge: yellow at',
    'How full the context window is when the gauge turns yellow.',
    CONTEXT_WARN_THRESHOLD,
    0.1,
    1,
  ),
  contextDangerThreshold: fraction(
    'activity',
    'Context gauge: orange at',
    'How full the context window is when the gauge turns orange.',
    CONTEXT_DANGER_THRESHOLD,
    0.1,
    1,
  ),
  contextCriticalThreshold: fraction(
    'activity',
    'Context gauge: red at',
    'How full the context window is when the gauge turns red.',
    CONTEXT_CRITICAL_THRESHOLD,
    0.1,
    1,
  ),

  // ── Documents ──
  docTableMaxRows: count(
    'documents',
    'Table rows drawn',
    'Most rows the viewer draws for a spreadsheet or CSV.',
    DOC_TABLE_MAX_ROWS,
    100,
    50_000,
    'rows',
    100,
  ),
  docNumberedMaxLines: count(
    'documents',
    'Numbered lines',
    'Text files up to this many lines get line numbers; bigger ones show a window.',
    DOC_NUMBERED_MAX_LINES,
    1_000,
    200_000,
    'lines',
    1_000,
  ),

  // ── Sound & notices ──
  doneChimeVolume: fraction(
    'notices',
    '"Done" chime volume',
    'Volume of the chime when an agent finishes (Sound Notifications on).',
    NOTIFICATION_VOLUME,
    0,
    0.5,
  ),
  permissionChimeVolume: fraction(
    'notices',
    'Permission chime volume',
    'Volume of the double tap when an agent needs permission.',
    PERMISSION_VOLUME,
    0,
    0.5,
  ),
  whatsNewAutoCloseSec: seconds(
    'notices',
    '"What\'s new" closes after',
    'How long the version notice stays before it fades.',
    WHATS_NEW_AUTO_CLOSE_MS / 1000,
    3,
    300,
    1,
  ),

  // ── Layout editor ──
  undoStackMax: count(
    'editor',
    'Undo steps',
    'How many layout edits Undo can step back through.',
    UNDO_STACK_MAX_SIZE,
    5,
    500,
    'steps',
  ),
} satisfies Record<string, TunableDef>;

export type TunableKey = keyof typeof TUNABLES;
export type TunableValues = Record<TunableKey, number>;

export const TUNABLE_KEYS = Object.keys(TUNABLES) as TunableKey[];

export function defaultTunables(): TunableValues {
  const out = {} as TunableValues;
  for (const k of TUNABLE_KEYS) out[k] = TUNABLES[k].default;
  return out;
}

/** A value brought inside its entry's bounds (whole when the entry counts things). */
export function clampTunable(def: TunableDef, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return def.default;
  const v = Math.min(def.max, Math.max(def.min, value));
  return def.int ? Math.round(v) : v;
}

function isKey(k: string): k is TunableKey {
  return Object.prototype.hasOwnProperty.call(TUNABLES, k);
}

/**
 * Stored overrides → every value. Unknown keys are dropped, out-of-range values
 * clamped, anything that isn't a finite number falls back to the default.
 */
export function readTunables(raw: string | null): TunableValues {
  const values = defaultTunables();
  if (!raw) return values;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return values;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return values;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (isKey(k)) values[k] = clampTunable(TUNABLES[k], v);
  }
  return values;
}

/** Only the values that differ from their defaults: what gets stored. */
export function tunableOverrides(values: TunableValues): Partial<TunableValues> {
  const out: Partial<TunableValues> = {};
  for (const k of TUNABLE_KEYS) if (values[k] !== TUNABLES[k].default) out[k] = values[k];
  return out;
}

/** A random pick between a user-set "shortest" and "longest" that may be crossed. */
export function orderedRange(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}
