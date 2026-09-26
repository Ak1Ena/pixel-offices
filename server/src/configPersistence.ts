import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  AUTOPILOT_DEFAULT_COMMAND,
  AUTOPILOT_DEFAULT_IDLE_MINUTES,
  AUTOPILOT_DEFAULT_MAX_AGENTS,
  AUTOPILOT_IDLE_MINUTES_MAX,
  AUTOPILOT_MAX_AGENTS_LIMIT,
  CONFIG_FILE_NAME,
  LAYOUT_FILE_DIR,
} from './constants.js';
import { type DecisionsConfig, parseDecisionsConfig } from './decisions.js';

export interface AdapterSettings {
  soundEnabled: boolean;
  lastSeenVersion: string;
  alwaysShowLabels: boolean;
  ghostHeadlessAgents: boolean;
  watchAllSessions: boolean;
  hooksInfoShown: boolean;
  showAreas: boolean;
  areaMappings: Record<string, string[]>;
}

/** All keys in AdapterSettings. Used by adapters to map `pixel-agents.foo` → `foo`.
 *  The hooks preference is NOT here: it is per-provider and machine-global
 *  (the hooks it governs live in one home-directory file per provider), so it
 *  lives beside `hooksConsent` at the config top level, not per namespace. */
export const ADAPTER_SETTING_KEYS = [
  'soundEnabled',
  'lastSeenVersion',
  'alwaysShowLabels',
  'ghostHeadlessAgents',
  'watchAllSessions',
  'hooksInfoShown',
  'showAreas',
  'areaMappings',
] as const;

export type AdapterSettingKey = (typeof ADAPTER_SETTING_KEYS)[number];

/** Namespaces = adapter identities sharing the same config.json file. */
export type ConfigNamespace = 'vscode' | 'standalone';

/** What the user answered a provider's consent ask with, durably. `granted` is recorded BEFORE the install writes, so
 *  it can exist with nothing on disk; `declined` means the ANSWER itself turned hooks off, the provenance a revised
 *  "Not Now" needs to know the preference is its to take back (a Settings toggle never records consent). Absent =
 *  unanswered, the ask is still open. */
export type HooksConsentState = 'granted' | 'declined';

export interface PixelAgentsConfig {
  vscode: AdapterSettings;
  standalone: AdapterSettings;
  externalAssetDirectories: string[];
  /** Per-provider consent to modify that provider's settings file (Claude:
   *  ~/.claude/settings.json). Shared across surfaces — consent is per-human
   *  per-provider, not per-adapter. A provider absent from the map has never
   *  been answered. */
  hooksConsent: Record<string, HooksConsentState>;
  /** Per-provider hooks preference, machine-global for the same reason as the
   *  consent above. A provider absent from the map takes the default (true). */
  hooksEnabled: Record<string, boolean>;
  /** What an agent's document edits do unless the agent has its own setting.
   *  Machine-global: it guards the user's files whichever surface is open. */
  docEditDefault: DocEditModeSetting;
  /** Optional decision model endpoint (decisions.ts). Absent = every rule works alone. Set by hand. */
  decisions?: DecisionsConfig;
  /** Laya run by the office itself (layaManager.ts), turned on from Settings. Absent = never asked. */
  laya?: { enabled: boolean; model?: LayaModelSetting };
  /** Desk autopilot (deskAutopilot.ts). Absent = off. */
  autopilot?: AutopilotSettings;
}

export type DocEditModeSetting = 'ask' | 'auto' | 'off';

/** Settings → Autopilot. Machine-global: the desk and tasks.json are. */
export interface AutopilotSettings {
  enabled: boolean;
  /** Agents autopilot may run at once (its own; agents you started never count or get closed). */
  maxAgents: number;
  /** An agent autopilot started is closed after this long idle with no card. */
  idleMinutes: number;
  /** What it runs to start an agent (an alias works when it runs Claude). */
  command: string;
  /** A brief's questions the decision model reads as safe: the agent picks the answer itself. */
  agentAnswers: boolean;
  /** Gate steps the decision model reads as routine are passed without the human. */
  passGates: boolean;
}

/** Laya checkpoint choice: one language model, or both with Laya's router picking. */
export type LayaModelSetting = 'english' | 'multilingual' | 'auto';
const LAYA_MODEL_SETTINGS: readonly string[] = ['english', 'multilingual', 'auto'];
const DOC_EDIT_DEFAULT: DocEditModeSetting = 'ask';

function parseDocEditMode(raw: unknown): DocEditModeSetting {
  return raw === 'ask' || raw === 'auto' || raw === 'off' ? raw : DOC_EDIT_DEFAULT;
}

const DEFAULT_ADAPTER_SETTINGS: AdapterSettings = {
  soundEnabled: true,
  lastSeenVersion: '',
  alwaysShowLabels: false,
  ghostHeadlessAgents: false,
  watchAllSessions: false,
  hooksInfoShown: false,
  showAreas: false,
  areaMappings: {},
};

function getConfigFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, CONFIG_FILE_NAME);
}

/** Coerce a loose object into the per-provider consent map, dropping entries whose value is not exactly 'granted' or
 *  'declined'. */
function parseHooksConsent(raw: unknown): Record<string, HooksConsentState> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, HooksConsentState> = {};
  for (const [providerId, state] of Object.entries(raw as Record<string, unknown>)) {
    if (state === 'granted' || state === 'declined') out[providerId] = state;
  }
  return out;
}

/** Coerce a loose object into the per-provider hooks-preference map, dropping non-boolean values. */
function parseHooksEnabled(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [providerId, enabled] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof enabled === 'boolean') out[providerId] = enabled;
  }
  return out;
}

/**
 * Coerce a loose object into `Record<string, string[]>`, dropping any entries whose value is not an array of strings.
 * Returns `{}` if the input isn't an object. Used to defensively load folder→area mappings from config.json, which
 * may have been hand-edited or written by an older build.
 */
export function parseAreaMappings(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const [folder, labels] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof folder !== 'string') {
      continue;
    }
    if (!Array.isArray(labels)) {
      continue;
    }
    const filtered = labels.filter((l): l is string => typeof l === 'string');
    out[folder] = filtered;
  }
  return out;
}

/** Coerce a loose object into a valid AdapterSettings with defaults for missing/wrong-typed fields. */
function parseAdapterSettings(raw: unknown): AdapterSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<AdapterSettings>;
  return {
    soundEnabled:
      typeof obj.soundEnabled === 'boolean'
        ? obj.soundEnabled
        : DEFAULT_ADAPTER_SETTINGS.soundEnabled,
    lastSeenVersion:
      typeof obj.lastSeenVersion === 'string'
        ? obj.lastSeenVersion
        : DEFAULT_ADAPTER_SETTINGS.lastSeenVersion,
    alwaysShowLabels:
      typeof obj.alwaysShowLabels === 'boolean'
        ? obj.alwaysShowLabels
        : DEFAULT_ADAPTER_SETTINGS.alwaysShowLabels,
    ghostHeadlessAgents:
      typeof obj.ghostHeadlessAgents === 'boolean'
        ? obj.ghostHeadlessAgents
        : DEFAULT_ADAPTER_SETTINGS.ghostHeadlessAgents,
    watchAllSessions:
      typeof obj.watchAllSessions === 'boolean'
        ? obj.watchAllSessions
        : DEFAULT_ADAPTER_SETTINGS.watchAllSessions,
    hooksInfoShown:
      typeof obj.hooksInfoShown === 'boolean'
        ? obj.hooksInfoShown
        : DEFAULT_ADAPTER_SETTINGS.hooksInfoShown,
    showAreas:
      typeof obj.showAreas === 'boolean' ? obj.showAreas : DEFAULT_ADAPTER_SETTINGS.showAreas,
    areaMappings: parseAreaMappings(obj.areaMappings),
  };
}

export function readConfig(): PixelAgentsConfig {
  const filePath = getConfigFilePath();
  try {
    if (!fs.existsSync(filePath)) {
      return {
        vscode: { ...DEFAULT_ADAPTER_SETTINGS },
        standalone: { ...DEFAULT_ADAPTER_SETTINGS },
        externalAssetDirectories: [],
        hooksConsent: {},
        hooksEnabled: {},
        docEditDefault: DOC_EDIT_DEFAULT,
      };
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PixelAgentsConfig>;
    const decisions = parseDecisionsConfig(parsed.decisions);
    const laya = parseLayaConfig(parsed.laya);
    const autopilot = parsed.autopilot ? parseAutopilot(parsed.autopilot) : undefined;
    return {
      vscode: parseAdapterSettings(parsed.vscode),
      standalone: parseAdapterSettings(parsed.standalone),
      externalAssetDirectories: Array.isArray(parsed.externalAssetDirectories)
        ? parsed.externalAssetDirectories.filter((d): d is string => typeof d === 'string')
        : [],
      hooksConsent: parseHooksConsent(parsed.hooksConsent),
      hooksEnabled: parseHooksEnabled(parsed.hooksEnabled),
      docEditDefault: parseDocEditMode(parsed.docEditDefault),
      ...(decisions ? { decisions } : {}),
      ...(laya ? { laya } : {}),
      ...(autopilot ? { autopilot } : {}),
    };
  } catch (err) {
    console.error('[Pixel Agents] Failed to read config file:', err);
    return {
      vscode: { ...DEFAULT_ADAPTER_SETTINGS },
      standalone: { ...DEFAULT_ADAPTER_SETTINGS },
      externalAssetDirectories: [],
      hooksConsent: {},
      hooksEnabled: {},
      docEditDefault: DOC_EDIT_DEFAULT,
    };
  }
}

// ── Per-provider hooks consent + preference ─────────────────
// The provider id keys these maps (HookProvider.id — 'claude' today). All
// writers go through readConfig→writeConfig, so a hand-edited or older file
// degrades to "unanswered"/default rather than crashing.

/** What the user durably answered this provider's ask with, or 'unanswered'. */
export function getHooksConsent(providerId: string): HooksConsentState | 'unanswered' {
  return readConfig().hooksConsent[providerId] ?? 'unanswered';
}

/** Persist the one-time approval for modifying this provider's settings file. A grant REPLACING a decline also
 *  deletes that decline's hooks-off remnant in the same write: without it, an install that then FAILS leaves a grant
 *  beside the retracted hooks-off, and a later "Not Now" (which leaves the preference alone, since the grant never
 *  wrote it) ends at unanswered + hooks-off — an ask that never returns. A successful install persists hooks-on
 *  anyway, so this only changes the failure path. */
export function grantHooksConsent(providerId: string): void {
  const cfg = readConfig();
  if (cfg.hooksConsent[providerId] !== 'granted') {
    const replacingDecline = cfg.hooksConsent[providerId] === 'declined';
    cfg.hooksConsent[providerId] = 'granted';
    if (replacingDecline) delete cfg.hooksEnabled[providerId];
    writeConfig(cfg);
  }
}

/** Record a durable decline ("Don't Ask Again"): consent 'declined' AND hooks-off, in ONE readConfig→writeConfig
 *  cycle. They are one logical answer — split across two writes, a failed second leaves a state the answer disavows
 *  (a decline with the default-on preference, or a hooks-off with no provenance). */
export function recordHooksDecline(providerId: string): void {
  const cfg = readConfig();
  if (cfg.hooksConsent[providerId] !== 'declined' || cfg.hooksEnabled[providerId] !== false) {
    cfg.hooksConsent[providerId] = 'declined';
    cfg.hooksEnabled[providerId] = false;
    writeConfig(cfg);
  }
}

/** Un-record an answer AND restore the preference default in ONE cycle — the revised-notNow revert over a decline.
 *  Both keys go together so "never answered" and "answered and reverted" are indistinguishable on disk, and no
 *  partial-write order can leave a half-reverted answer. */
export function clearHooksAnswer(providerId: string): void {
  const cfg = readConfig();
  if (providerId in cfg.hooksConsent || providerId in cfg.hooksEnabled) {
    delete cfg.hooksConsent[providerId];
    delete cfg.hooksEnabled[providerId];
    writeConfig(cfg);
  }
}

/** Un-record an answer entirely, so the ask genuinely returns. Used when the
 *  user walks the Intro back from its closing step and revises an earlier
 *  answer down to "Not Now": whatever that answer left (a grant, a decline)
 *  must go, or the consent gate reads it as asked-and-answered forever.
 *  Callers only clear a grant after any uninstall verifiably landed. */
export function clearHooksConsent(providerId: string): void {
  const cfg = readConfig();
  if (providerId in cfg.hooksConsent) {
    delete cfg.hooksConsent[providerId];
    writeConfig(cfg);
  }
}

/** The per-provider hooks preference. Absent = the default, true. */
export function getHooksEnabled(providerId: string): boolean {
  return readConfig().hooksEnabled[providerId] ?? true;
}

export function setHooksEnabled(providerId: string, enabled: boolean): void {
  const cfg = readConfig();
  if (cfg.hooksEnabled[providerId] !== enabled) {
    cfg.hooksEnabled[providerId] = enabled;
    writeConfig(cfg);
  }
}

/** Restore the provider's preference to its default (true) by REMOVING the key. Deleting rather than writing `true`
 *  keeps "never answered" and "answered and reverted" indistinguishable on disk. */
export function clearHooksEnabled(providerId: string): void {
  const cfg = readConfig();
  if (providerId in cfg.hooksEnabled) {
    delete cfg.hooksEnabled[providerId];
    writeConfig(cfg);
  }
}

/** Called on extension uninstall: return every hooks-related choice to factory state — all providers' consent and
 *  preferences cleared, hooksInfoShown back to default in both namespaces. Those choices belonged to an installation
 *  that no longer exists, so a future install starts from the first-run experience rather than inheriting a stale
 *  hooks-off that would skip the ask forever. */
export function resetHooksConfig(): void {
  const cfg = readConfig();
  cfg.hooksConsent = {};
  cfg.hooksEnabled = {};
  for (const ns of ['vscode', 'standalone'] as const) {
    cfg[ns].hooksInfoShown = DEFAULT_ADAPTER_SETTINGS.hooksInfoShown;
  }
  writeConfig(cfg);
}

export function writeConfig(config: PixelAgentsConfig): void {
  const filePath = getConfigFilePath();
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const json = JSON.stringify(config, null, 2);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error('[Pixel Agents] Failed to write config file:', err);
  }
}

// ── Documents ───────────────────────────────────────────────

/** The office-wide default for agents' document edits. */
export function getDocEditDefault(): DocEditModeSetting {
  return readConfig().docEditDefault;
}

export function setDocEditDefault(mode: DocEditModeSetting): void {
  const cfg = readConfig();
  if (cfg.docEditDefault === mode) return;
  cfg.docEditDefault = mode;
  writeConfig(cfg);
}

// ── Laya (layaManager.ts) ───────────────────────────────────

/** Whether the office should run its own Laya. Machine-global, like the hooks preference. */
export function getLayaEnabled(): boolean {
  return readConfig().laya?.enabled === true;
}

export function setLayaEnabled(enabled: boolean): void {
  const cfg = readConfig();
  if (cfg.laya?.enabled === enabled) return;
  cfg.laya = { ...cfg.laya, enabled };
  writeConfig(cfg);
}

export function getLayaModel(): LayaModelSetting | undefined {
  return readConfig().laya?.model;
}

export function setLayaModel(model: LayaModelSetting): void {
  const cfg = readConfig();
  if (cfg.laya?.model === model) return;
  cfg.laya = { enabled: cfg.laya?.enabled ?? false, model };
  writeConfig(cfg);
}

export function isLayaModelSetting(value: unknown): value is LayaModelSetting {
  return typeof value === 'string' && LAYA_MODEL_SETTINGS.includes(value);
}

function parseLayaConfig(raw: unknown): PixelAgentsConfig['laya'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean') return undefined;
  return { enabled: r.enabled, ...(isLayaModelSetting(r.model) ? { model: r.model } : {}) };
}

// ── Desk autopilot (deskAutopilot.ts) ───────────────────────

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(max, Math.max(min, Math.round(raw)))
    : fallback;
}

/** Any stored or requested value → valid settings (missing fields take the defaults). */
export function parseAutopilot(raw: unknown, base?: AutopilotSettings): AutopilotSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const b = base ?? {
    enabled: false,
    maxAgents: AUTOPILOT_DEFAULT_MAX_AGENTS,
    idleMinutes: AUTOPILOT_DEFAULT_IDLE_MINUTES,
    command: AUTOPILOT_DEFAULT_COMMAND,
    agentAnswers: true,
    passGates: true,
  };
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const command =
    typeof r.command === 'string' ? r.command.replace(/[\x00-\x1f\x7f]/g, '').trim() : '';
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : b.enabled,
    maxAgents: clampInt(r.maxAgents, 1, AUTOPILOT_MAX_AGENTS_LIMIT, b.maxAgents),
    idleMinutes: clampInt(r.idleMinutes, 1, AUTOPILOT_IDLE_MINUTES_MAX, b.idleMinutes),
    command: command.slice(0, 200) || b.command,
    agentAnswers: bool(r.agentAnswers, b.agentAnswers),
    passGates: bool(r.passGates, b.passGates),
  };
}

export function getAutopilot(): AutopilotSettings {
  return readConfig().autopilot ?? parseAutopilot(undefined);
}

/** Merge a change into the stored settings; returns the result. */
export function setAutopilot(change: unknown): AutopilotSettings {
  const cfg = readConfig();
  const next = parseAutopilot(change, cfg.autopilot ?? parseAutopilot(undefined));
  cfg.autopilot = next;
  writeConfig(cfg);
  return next;
}
