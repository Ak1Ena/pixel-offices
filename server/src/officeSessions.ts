import { Terminal } from '@xterm/headless';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type {
  AgentKey,
  AgentModelsState,
  ModelOption,
  ScreenQuestion,
} from '../../core/src/messages.js';
import type { ModelPicker } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { TerminalWriter } from './chatSender.js';
import {
  MODEL_LABEL_MAX_CHARS,
  MODEL_PICKER_KEY_GAP_MS,
  MODEL_PICKER_POLL_MS,
  MODEL_PICKER_SETTLE_POLLS,
  MODEL_PICKER_WAIT_MS,
  OFFICE_RECENT_FOLDERS,
  OFFICE_SESSION_ADOPT_TRIES,
  OFFICE_SESSION_KEY_GAP_MS,
  OFFICE_SESSION_LIMIT,
  OFFICE_SESSION_SCREEN_COLS,
  OFFICE_SESSION_SCREEN_MS,
  OFFICE_SESSION_SCREEN_ROWS,
  OFFICE_SESSION_SETTLE_MS,
  SCREEN_QUESTION_MAX_OPTIONS,
  SCREEN_QUESTION_PROMPT_CHARS,
  SCREEN_QUESTION_PROMPT_LINES,
} from './constants.js';
import type { Pty } from './launcher.js';
import { expandAlias, loadPty, planAgyLaunch, planLaunch, splitShellWords } from './launcher.js';
import { ModelCatalog, parseModelOptions, sameModelLabel } from './modelOptions.js';
import { areHooksInstalled as antigravityHooksInstalled } from './providers/hook/antigravity/antigravityHookInstaller.js';
import { hookProviderById } from './providers/index.js';
import { typePrompt } from './terminalTyping.js';
import type { AgentState } from './types.js';

/**
 * Agents the office runs itself (+ Agent in the standalone office).
 *
 * Each is Claude in a pty this server owns, with no terminal window: the chat
 * card is its interface. Because Claude still asks things on screen (trust
 * this folder, permission prompts), the pty feeds a headless terminal whose
 * visible screen is broadcast as plain text (`agentScreen`) and keys can be
 * pressed into it (`sendAgentKeys`).
 */

export interface StartAgentRequest {
  cwd: string;
  name?: string;
  command?: string;
  firstMessage?: string;
  skipPermissions?: boolean;
  /** A label from the provider's model picker: chosen (this session only) before the first message. */
  model?: string;
}

/** What OfficeSessions needs from the runtime. */
export interface OfficeSessionHost {
  adoptLaunchedSession(sessionId: string, cwd: string): void;
  /** Link hook events from this pid to the session known as `key` (agy). */
  followPid?(pid: number, key: string, cwd: string): void;
  forgetPid?(pid: number): void;
  /** Show a pid-followed run (agy) now, as a hooks-only agent known by `key`. */
  adoptLaunchedHooksSession?(key: string, cwd: string, providerId: string): void;
  renameAgent(agentId: number, name: string): void;
  removeAgent(agentId: number): void;
  refreshSendable(): void;
  /** The agent can take typed input now: deliver anything queued for it. */
  inputReady(agentId: number): void;
}

interface OwnedSession {
  sessionId: string;
  /** agy: followed by process id; its agent appears through hooks, not a transcript. */
  followedPid?: number;
  cwd: string;
  pty: Pty;
  screen: Terminal;
  lastScreen: string;
  screenTimer: ReturnType<typeof setTimeout> | null;
  adoptTimer: ReturnType<typeof setInterval> | null;
  name?: string;
  /** True while WE flagged the agent as waiting on a question seen on its screen. */
  askingByScreen: boolean;
  /** Visible screen text as of the last change (redraws that change nothing don't count). */
  lastContent: string;
  settleTimer: ReturnType<typeof setTimeout> | null;
  /** Can take typed input: the screen has settled with no question on it.
   *  Starts false — Claude drops keys while it starts up. */
  inputReady: boolean;
  /** Which provider's CLI runs here (its model picker is used). */
  providerId: string;
  /** The office is driving the model picker: nothing else may type, and the
   *  picker is not shown to people as a question. */
  picking: boolean;
  /** Started with a model: pick it once the terminal is ready, then type the first message. */
  startModel?: { label: string; firstMessage?: string };
}

/** Where an agent's model list stands (sent as `agentModels`). */
interface ModelsView {
  options: ModelOption[];
  state: AgentModelsState;
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const KEY_BYTES: Record<AgentKey, string> = {
  enter: '\r',
  escape: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  tab: '\t',
  '1': '1',
  '2': '2',
  '3': '3',
  y: 'y',
  n: 'n',
};

/** Box-drawing borders and padding Claude draws around dialogs. */
const BORDER_RE = /^[\s│┃║|]+|[\s│┃║|]+$/g;
/** Just the border (and one space of padding), keeping the text's own indent. */
const BORDER_ONLY_RE = /^\s*[│┃║|] ?|\s*[│┃║|]\s*$/g;

const OPTION_RE = /^(?:([❯>›])\s*)?(\d)[.)]\s+(\S.*)$/;
/** An unnumbered menu line under the cursor: "❯ Yes, I trust this folder". */
const CURSOR_RE = /^(\s*)[❯›]\s+(\S.*)$/;
/** A dialog's own edge: a box corner or a horizontal rule. */
const EDGE_RE = /^\s*(?:[╭┌╰└]|[─━═]{3,})/;
/** How-to-answer hints under the options ("Enter to confirm · Esc to exit"). */
const HINT_RE = /\b(?:enter|esc|tab|ctrl|shift)\b.*\bto\b/i;
/** The hint that marks a live menu — the thing a cursor list must sit on. */
const MENU_HINT_RE = /enter to (?:confirm|select|continue)|esc to (?:cancel|exit|go back)/i;

/** A screen question plus which option the on-screen cursor is on (index). */
export interface ParsedScreenQuestion extends ScreenQuestion {
  selected: number;
}

interface FoundOptions {
  /** Screen row of the first option. */
  first: number;
  options: ScreenQuestion['options'];
  selected: number;
}

/**
 * A numbered choice ("❯ 1. Yes / 2. No"). The LAST "1." on screen starts it —
 * dialogs sit at the bottom, and a numbered list earlier in the conversation
 * must not be mistaken for one. It needs a cursor mark or an answer hint, so a
 * numbered list the agent just wrote is never read as a dialog. Wrapped labels
 * are joined back together.
 */
function findNumbered(lines: string[], bare: string[]): FoundOptions | null {
  let first = -1;
  for (let i = bare.length - 1; i >= 0; i--) {
    const m = OPTION_RE.exec(bare[i]);
    if (m && m[2] === '1') {
      first = i;
      break;
    }
  }
  if (first < 0) return null;

  const options: ScreenQuestion['options'] = [];
  let selected = 0;
  let cursor = false;
  let hinted = false;
  for (let i = first; i < bare.length; i++) {
    const line = bare[i];
    const m = OPTION_RE.exec(line);
    if (m && Number(m[2]) === options.length + 1) {
      if (options.length >= SCREEN_QUESTION_MAX_OPTIONS) break;
      if (m[1]) {
        selected = options.length;
        cursor = true;
      }
      options.push({ number: Number(m[2]), label: m[3].trim() });
      continue;
    }
    if (HINT_RE.test(line)) {
      hinted = true;
      break;
    }
    if (!line || EDGE_RE.test(lines[i])) break;
    const last = options[options.length - 1];
    last.label = `${last.label} ${line.trim()}`;
  }
  if (!hinted) hinted = bare.slice(first).some((l) => MENU_HINT_RE.test(l));
  // A live dialog puts its cursor on an option or says how to answer; a
  // numbered list in the agent's reply does neither and is not a question.
  if (!cursor && !hinted) return null;
  // Two options make a choice; a lone one must still say how to answer it.
  if (options.length < 2 && !hinted) return null;
  return { first, options, selected };
}

/**
 * A menu with no numbers: one line under the cursor ("❯ No, exit") and its
 * siblings indented to the same text column, right above a how-to-answer
 * hint. Claude's folder-trust dialog looks like this.
 */
function findCursorMenu(lines: string[]): FoundOptions | null {
  const kept = lines.map((l) => l.replace(BORDER_ONLY_RE, ''));
  let hint = -1;
  for (let i = kept.length - 1; i >= 0; i--) {
    if (MENU_HINT_RE.test(kept[i])) {
      hint = i;
      break;
    }
  }
  if (hint < 0) return null;
  let last = hint - 1;
  while (last >= 0 && !kept[last].trim()) last--;
  let first = last;
  while (first > 0 && kept[first - 1].trim() && !EDGE_RE.test(lines[first - 1])) first--;
  if (first < 0) return null;

  const block = kept.slice(first, last + 1);
  const cursorAt = block.findIndex((l) => CURSOR_RE.test(l));
  if (cursorAt < 0) return null;
  const m = CURSOR_RE.exec(block[cursorAt])!;
  const column = m[1].length + 2;
  // The menu is the run of lines at the cursor's text column; anything above
  // it that isn't indented like an option is the question, not a choice.
  let top = cursorAt;
  while (top > 0 && indentOf(block[top - 1]) >= column) top--;
  const options: ScreenQuestion['options'] = [];
  let selected = 0;
  for (let i = top; i < block.length; i++) {
    const line = block[i];
    const cursor = CURSOR_RE.exec(line);
    const indent = indentOf(line);
    if (cursor || indent === column) {
      if (options.length >= SCREEN_QUESTION_MAX_OPTIONS) break;
      if (cursor) selected = options.length;
      options.push({ number: options.length + 1, label: (cursor ? cursor[2] : line).trim() });
    } else if (indent > column && options.length > 0) {
      const prev = options[options.length - 1];
      prev.label = `${prev.label} ${line.trim()}`;
    } else {
      return null;
    }
  }
  if (options.length < 2) return null;
  return { first: first + top, options, selected };
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function findOptions(lines: string[]): FoundOptions | null {
  const bare = lines.map((l) => l.replace(BORDER_RE, ''));
  return findNumbered(lines, bare) ?? findCursorMenu(lines);
}

/**
 * Claude is waiting for an answer on screen: a numbered choice ("1. Yes /
 * 2. No") or a cursor menu over an "Enter to confirm" hint, usually inside a
 * bordered box — so borders are stripped before matching.
 */
export function looksLikeQuestion(lines: string[]): boolean {
  return findOptions(lines) !== null;
}

/** Read the question Claude is showing: the prompt above the options and each option's label. */
export function parseScreenQuestion(lines: string[]): ParsedScreenQuestion | null {
  const found = findOptions(lines);
  if (!found) return null;
  const bare = lines.map((l) => l.replace(BORDER_RE, ''));
  const prompt: string[] = [];
  for (let i = found.first - 1; i >= 0 && prompt.length < SCREEN_QUESTION_PROMPT_LINES; i--) {
    if (EDGE_RE.test(lines[i])) break;
    const text = bare[i].trim();
    if (text) prompt.unshift(text.slice(0, SCREEN_QUESTION_PROMPT_CHARS));
  }
  const { options, selected } = found;
  const key = crypto
    .createHash('sha1')
    .update(JSON.stringify([prompt, options]))
    .digest('hex')
    .slice(0, 16);
  return { key, prompt, options, selected };
}

/**
 * The ids a session can be known by. Team discovery adopts a teammate's
 * transcript on its own and may give the agent a different `sessionId`, but
 * the transcript file is always named after Claude's session id.
 */
function sessionKeys(agent: AgentState): string[] {
  const fromFile = agent.jsonlFile ? path.basename(agent.jsonlFile, '.jsonl') : '';
  const keys =
    fromFile && fromFile !== agent.sessionId ? [agent.sessionId, fromFile] : [agent.sessionId];
  // A run followed by pid (agy) is known by the key the office gave its terminal.
  return agent.launchKey ? [...keys, agent.launchKey] : keys;
}

function expandHome(p: string): string {
  const t = p.trim();
  return t === '~' || t.startsWith('~/') ? path.join(os.homedir(), t.slice(1)) : t;
}

/**
 * The folder an agent is started in, spelled the way Claude will see it: its
 * real path (no trailing slash, symlinks resolved — the pty's `process.cwd()`).
 * Claude names the transcript folder after that path, so `~/` kept as
 * `/Users/me/` pointed the office at `-Users-me-` while Claude wrote to
 * `-Users-me`: the office-run agent watched a file that never appeared and the
 * scanner adopted the real transcript as a second agent. Null when it is not an
 * existing absolute folder.
 */
export function resolveProjectFolder(raw: string): string | null {
  const expanded = expandHome(raw);
  if (!path.isAbsolute(expanded)) return null;
  try {
    const real = fs.realpathSync(expanded);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export class OfficeSessions {
  private readonly sessions = new Map<string, OwnedSession>();
  private readonly pty = loadPty();
  /** Folders agents were started in this run, newest first, plus where the office was started. */
  private readonly recent: string[] = [process.cwd()];
  /** agent id → its model picker's options, as last read. */
  private readonly models = new Map<number, ModelsView>();

  constructor(
    private readonly store: AgentStateStore,
    private readonly host: OfficeSessionHost,
    private readonly catalog: ModelCatalog = new ModelCatalog(),
  ) {
    store.on('agentRemoved', this.onAgentRemoved);
  }

  private readonly onAgentRemoved = (id: number): void => {
    this.models.delete(id);
  };

  /** Whether this server can run agents at all (needs node-pty). */
  get available(): boolean {
    return this.pty !== null;
  }

  start(req: StartAgentRequest): { ok: true; sessionId: string } | { ok: false; error: string } {
    if (!this.pty)
      return { ok: false, error: 'node-pty is not installed, so the office cannot start agents.' };
    if (this.sessions.size >= OFFICE_SESSION_LIMIT) {
      return {
        ok: false,
        error: `The office runs at most ${OFFICE_SESSION_LIMIT} agents of its own.`,
      };
    }
    const cwd = resolveProjectFolder(typeof req.cwd === 'string' ? req.cwd : '');
    if (!cwd) return { ok: false, error: 'That project folder does not exist on this computer.' };

    const words = splitShellWords((req.command ?? '').trim() || 'claude');
    const alias = expandAlias(words[0], words.slice(1));
    const command = alias ?? { program: words[0], args: words.slice(1) };
    const isAgy = planAgyLaunch(command.program, command.args) !== null;
    const providerId = isAgy ? 'antigravity' : 'claude';
    const model = req.model?.trim().slice(0, MODEL_LABEL_MAX_CHARS) || undefined;
    if (model && !hookProviderById(providerId)?.modelPicker) {
      return {
        ok: false,
        error:
          'The office cannot pick a model for this CLI. Put the model in the start command instead.',
      };
    }
    if (req.skipPermissions) command.args.push('--dangerously-skip-permissions');
    // The first message rides the command line (`claude "<prompt>"`, `agy -i
    // "<prompt>"`), never the keyboard: typed input would land in — and its
    // Enter would answer — whatever the CLI asks first (trust this folder?).
    const firstMessage = req.firstMessage?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    let plan: { program: string; args: string[]; sessionId: string };
    if (isAgy) {
      // The office follows agy through its hooks: without them it stays a blank character.
      if (!antigravityHooksInstalled()) {
        return {
          ok: false,
          error:
            'Turn on the Antigravity (agy) hooks first: the office sees agy only through them (Settings → Show Welcome Tour).',
        };
      }
      if (firstMessage) command.args.push('-i', firstMessage);
      const agy = planAgyLaunch(command.program, command.args)!;
      plan = { program: agy.program, args: agy.args, sessionId: agy.key };
    } else {
      // With a model to pick, the first message waits: it is typed once the
      // picker is done, so the very first turn already runs on that model.
      if (firstMessage && !model) command.args.push(firstMessage);
      const claude = planLaunch(command.program, command.args);
      if (!claude.tracksClaude || !claude.sessionId || !claude.interactive) {
        return {
          ok: false,
          error:
            'The start command must run Claude or agy as a new interactive session (for example: claude, agy, or an alias of either).',
        };
      }
      plan = { program: claude.program, args: claude.args, sessionId: claude.sessionId };
    }

    let pty: Pty;
    try {
      pty = this.pty.spawn(plan.program, plan.args, {
        name: 'xterm-256color',
        cols: OFFICE_SESSION_SCREEN_COLS,
        rows: OFFICE_SESSION_SCREEN_ROWS,
        cwd,
        env: process.env,
      });
    } catch (err) {
      return {
        ok: false,
        error: `Could not start ${plan.program}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const sessionId = plan.sessionId;
    const session: OwnedSession = {
      sessionId,
      cwd,
      pty,
      screen: new Terminal({
        cols: OFFICE_SESSION_SCREEN_COLS,
        rows: OFFICE_SESSION_SCREEN_ROWS,
        allowProposedApi: true,
      }),
      lastScreen: '',
      screenTimer: null,
      adoptTimer: null,
      name: req.name?.trim() || undefined,
      askingByScreen: false,
      lastContent: '',
      settleTimer: null,
      inputReady: false,
      providerId,
      picking: false,
      ...(model ? { startModel: { label: model, firstMessage } } : {}),
    };
    if (isAgy) {
      session.followedPid = pty.pid;
      this.host.followPid?.(pty.pid, sessionId, cwd);
      this.host.adoptLaunchedHooksSession?.(sessionId, cwd, 'antigravity');
    }
    this.sessions.set(sessionId, session);
    this.recent.splice(0, this.recent.length, cwd, ...this.recent.filter((f) => f !== cwd));
    this.recent.length = Math.min(this.recent.length, OFFICE_RECENT_FOLDERS);
    pty.onData((data) => {
      session.screen.write(data, () => this.screenWritten(session));
      this.scheduleScreen(session);
    });
    pty.onExit(() => this.ended(sessionId));

    // The transcript (and its project dir) appears with Claude's first record,
    // so adoption is retried until the agent exists.
    let tries = 0;
    session.adoptTimer = setInterval(() => {
      const agent = this.agentFor(sessionId);
      // agy's character is created at once (adoptLaunchedHooksSession): no cap needed.
      if (agent || (!isAgy && ++tries > OFFICE_SESSION_ADOPT_TRIES)) {
        if (session.adoptTimer) clearInterval(session.adoptTimer);
        session.adoptTimer = null;
        if (agent) this.adopted(session, agent);
        return;
      }
      if (!isAgy) this.host.adoptLaunchedSession(sessionId, cwd);
    }, 1_000);
    return { ok: true, sessionId };
  }

  recentFolders(): string[] {
    return [...this.recent];
  }

  /** Press keys into an owned agent's terminal. */
  keys(agentId: unknown, keys: unknown): void {
    const session = this.sessionForAgent(agentId);
    if (!session || !Array.isArray(keys)) return;
    for (const key of keys.slice(0, 8)) {
      const bytes = KEY_BYTES[key as AgentKey];
      if (bytes) session.pty.write(bytes);
    }
  }

  /**
   * Answer the question on an owned agent's screen with one of its options:
   * move the cursor there and press Enter. Refused unless the screen still
   * shows the very question the client saw (`key`) — it may have been
   * answered in the meantime, or replaced by a different one.
   */
  answerQuestion(agentId: unknown, key: unknown, option: unknown): boolean {
    const session = this.sessionForAgent(agentId);
    if (!session || typeof key !== 'string' || !Number.isInteger(option)) return false;
    const question = parseScreenQuestion(this.readScreen(session));
    if (!question || question.key !== key) return false;
    const target = question.options.findIndex((o) => o.number === option);
    if (target < 0) return false;
    const move = target > question.selected ? KEY_BYTES.down : KEY_BYTES.up;
    const presses = [
      ...Array<string>(Math.abs(target - question.selected)).fill(move),
      KEY_BYTES.enter,
    ];
    // One key at a time: a burst of escape sequences can be read as one.
    presses.forEach((bytes, i) => {
      setTimeout(() => {
        if (this.sessions.get(session.sessionId) === session) session.pty.write(bytes);
      }, i * OFFICE_SESSION_KEY_GAP_MS);
    });
    return true;
  }

  /** The agent adopted for a session this office started, once it exists. */
  agentIdFor(sessionId: string): number | undefined {
    return this.agentFor(sessionId)?.id;
  }

  /** Stop a session by id — also one whose agent was never adopted. */
  stopSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.pty.kill();
    return true;
  }

  owns(agentId: number): boolean {
    return this.sessionForAgent(agentId) !== null;
  }

  /** Stop an owned agent's Claude. Returns false when the office doesn't run this agent. */
  stop(agentId: number): boolean {
    const session = this.sessionForAgent(agentId);
    if (!session) return false;
    session.pty.kill();
    return true;
  }

  // ── Models, through the CLI's own picker ──

  /** `modelOptions` for every provider whose picker has been read, for a connecting client. */
  modelOptionMessages(): Array<Record<string, unknown>> {
    return this.catalog.messages();
  }

  /** Read an agent's model picker (opened and closed again) and broadcast its options. */
  async loadModels(agentId: unknown): Promise<void> {
    await this.withPicker(agentId, 'loading');
  }

  /** Switch an agent to the picker option labelled `label`, for this session only. */
  async setModel(agentId: unknown, label: unknown): Promise<void> {
    if (typeof label !== 'string' || !label.trim()) return;
    await this.withPicker(agentId, 'switching', label.trim().slice(0, MODEL_LABEL_MAX_CHARS));
  }

  private async withPicker(
    agentId: unknown,
    state: AgentModelsState,
    choose?: string,
  ): Promise<void> {
    if (typeof agentId !== 'number') return;
    const session = this.sessionForAgent(agentId);
    const agent = this.store.get(agentId);
    const view = this.models.get(agentId) ?? { options: [], state: 'idle' as const };
    const fail = (error: string) => this.publishModels(agentId, { ...view, state: 'idle', error });
    if (!session || !agent) {
      return fail(
        'Only agents the office runs can switch models here (their terminal is read for the choices).',
      );
    }
    const picker = hookProviderById(session.providerId)?.modelPicker;
    if (!picker) return fail('The office does not know how to switch this CLI’s model.');
    if (session.picking || view.state !== 'idle') return fail('The model picker is already open.');
    if (!session.inputReady || agent.permissionSent || !agent.isWaiting) {
      return fail('Wait until the agent has finished its turn, then try again.');
    }
    this.publishModels(agentId, { ...view, state, error: undefined });
    const result = await this.pick(session, picker, choose);
    this.publishModels(
      agentId,
      result.ok
        ? { options: result.options, state: 'idle' }
        : { ...view, state: 'idle', error: result.error },
    );
  }

  private publishModels(agentId: number, view: ModelsView): void {
    if (!this.store.get(agentId)) return;
    this.models.set(agentId, view);
    this.store.broadcast({
      type: 'agentModels',
      id: agentId,
      options: view.options,
      state: view.state,
      ...(view.error ? { error: view.error } : {}),
    });
  }

  /**
   * Open the CLI's model picker, read its options, and either choose `choose`
   * (with the session-only key when the CLI has one) or close it again (Esc).
   * Every step reads a SETTLED screen: the picker draws over the slash-command
   * list, and acting on a half-drawn frame moved the cursor from the wrong row.
   * A switch is confirmed by opening the picker once more and reading its mark.
   * The options on screen are remembered per provider for start forms.
   */
  private async pick(
    session: OwnedSession,
    picker: ModelPicker,
    choose?: string,
  ): Promise<{ ok: true; options: ModelOption[] } | { ok: false; error: string }> {
    if (session.picking) return { ok: false, error: 'The model picker is already open.' };
    session.picking = true;
    try {
      const first = await this.openPicker(session, picker);
      if (!first) return { ok: false, error: `${picker.command} did not show a list of models.` };
      const options = parseModelOptions(first);
      this.rememberOptions(session.providerId, options);
      if (choose === undefined) {
        await this.closePicker(session, first.key);
        return { ok: true, options };
      }
      const target = options.findIndex((o) => sameModelLabel(o.label, choose));
      if (target < 0) {
        await this.closePicker(session, first.key);
        return { ok: false, error: `"${choose}" is not in the model picker any more.` };
      }

      // Move the cursor, checking where it landed after each move.
      let at: ParsedScreenQuestion | null = first;
      for (
        let tries = 0;
        at && at.key === first.key && at.selected !== target && tries < 5;
        tries++
      ) {
        const steps = target - at.selected;
        await this.pressKeys(
          session,
          Array<string>(Math.abs(steps)).fill(steps > 0 ? KEY_BYTES.down : KEY_BYTES.up),
        );
        at = await this.settledQuestion(session);
      }
      if (!at || at.key !== first.key || at.selected !== target) {
        if (at?.key === first.key) await this.closePicker(session, first.key);
        return { ok: false, error: `Could not move the picker to "${choose}".` };
      }
      await this.pressKeys(session, [picker.sessionKey ?? KEY_BYTES.enter]);
      if (!(await this.waitClosed(session, first.key))) {
        return { ok: false, error: 'The model picker did not close.' };
      }

      // Confirm: the picker marks the model this session now runs on.
      const check = await this.openPicker(session, picker);
      if (!check)
        return { ok: false, error: 'Could not re-open the picker to confirm the switch.' };
      await this.closePicker(session, check.key);
      const after = parseModelOptions(check);
      const now = after.find((o) => o.current);
      if (!now || !sameModelLabel(now.label, options[target].label)) {
        return {
          ok: false,
          error: `The switch to "${choose}" did not take${now ? `: still on ${now.label}` : ''}.`,
        };
      }
      return { ok: true, options: after };
    } finally {
      session.picking = false;
      const agent = this.agentFor(session.sessionId);
      if (agent && session.inputReady) this.host.inputReady(agent.id);
    }
  }

  /** Type the picker's command and wait for its settled dialog. */
  private async openPicker(
    session: OwnedSession,
    picker: ModelPicker,
  ): Promise<ParsedScreenQuestion | null> {
    await typePrompt(
      (data) => session.pty.write(data),
      picker.command,
      () => this.sessions.get(session.sessionId) !== session,
    );
    return this.settledQuestion(session);
  }

  /** Esc, then wait for the dialog to go. */
  private async closePicker(session: OwnedSession, key: string): Promise<void> {
    await this.pressKeys(session, [KEY_BYTES.escape]);
    await this.waitClosed(session, key);
  }

  private waitClosed(session: OwnedSession, key: string): Promise<true | null> {
    return this.waitFor(session, () =>
      parseScreenQuestion(this.readScreen(session))?.key === key ? null : true,
    );
  }

  /** The question on screen once the screen has stopped changing (a few polls in a row). */
  private async settledQuestion(session: OwnedSession): Promise<ParsedScreenQuestion | null> {
    let last = '';
    let same = 0;
    return this.waitFor(session, () => {
      const lines = this.readScreen(session);
      const text = lines.join('\n');
      same = text === last ? same + 1 : 0;
      last = text;
      return same >= MODEL_PICKER_SETTLE_POLLS ? parseScreenQuestion(lines) : null;
    });
  }

  private async pressKeys(session: OwnedSession, keys: string[]): Promise<void> {
    for (const bytes of keys) {
      if (this.sessions.get(session.sessionId) !== session) return;
      session.pty.write(bytes);
      await sleep(MODEL_PICKER_KEY_GAP_MS);
    }
  }

  private rememberOptions(providerId: string, options: ModelOption[]): void {
    if (!options.some((o) => o.label)) return;
    const known = options.map(({ number, label, detail }) => ({
      number,
      label,
      ...(detail ? { detail } : {}),
    }));
    if (this.catalog.set(providerId, known)) {
      for (const message of this.catalog.messages()) this.store.broadcast(message);
    }
  }

  /** Poll the screen until `check` returns something, or give up (null). */
  private async waitFor<T>(session: OwnedSession, check: () => T | null): Promise<T | null> {
    const until = Date.now() + MODEL_PICKER_WAIT_MS;
    while (Date.now() < until && this.sessions.get(session.sessionId) === session) {
      const found = check();
      if (found) return found;
      await sleep(MODEL_PICKER_POLL_MS);
    }
    return null;
  }

  /** A session started with a model: pick it, then type the first message it was held for. */
  private async applyStartModel(session: OwnedSession): Promise<void> {
    const start = session.startModel;
    const picker = hookProviderById(session.providerId)?.modelPicker;
    session.startModel = undefined;
    if (!start || !picker) return;
    const result = await this.pick(session, picker, start.label);
    if (!result.ok) console.warn(`[Pixel Agents] Model not picked: ${result.error}`);
    if (!start.firstMessage) return;
    // Let the screen settle after the picker closes before typing.
    const ready = await this.waitFor(session, () =>
      session.inputReady && !session.picking ? true : null,
    );
    if (!ready) console.warn('[Pixel Agents] Typing the first message before the screen settled.');
    await typePrompt(
      (data) => session.pty.write(data),
      start.firstMessage,
      () => !this.sessions.has(session.sessionId),
    );
  }

  get writer(): TerminalWriter {
    return {
      canWrite: (agent) => this.sessionOf(agent) !== null,
      ready: (agent) => {
        const session = this.sessionOf(agent);
        return session?.inputReady === true && !session.picking;
      },
      write: (agent, text) => {
        const session = this.sessionOf(agent);
        if (!session) throw new Error('session ended');
        void typePrompt(
          (data) => session.pty.write(data),
          text,
          () => !this.sessions.has(session.sessionId),
        );
      },
      interrupt: (agent) => {
        const session = this.sessionOf(agent);
        if (!session) throw new Error('session ended');
        session.pty.write(KEY_BYTES.escape);
      },
    };
  }

  /** Current screens, for a connecting client. */
  screens(): Array<{ id: number; lines: string[] }> {
    const out: Array<{ id: number; lines: string[] }> = [];
    for (const session of this.sessions.values()) {
      const agent = this.agentFor(session.sessionId);
      if (agent) out.push({ id: agent.id, lines: this.readScreen(session) });
    }
    return out;
  }

  dispose(): void {
    this.store.off('agentRemoved', this.onAgentRemoved);
    for (const session of this.sessions.values()) {
      if (session.adoptTimer) clearInterval(session.adoptTimer);
      if (session.screenTimer) clearTimeout(session.screenTimer);
      if (session.settleTimer) clearTimeout(session.settleTimer);
      try {
        session.pty.kill();
      } catch {
        /* already gone */
      }
    }
    this.sessions.clear();
  }

  /** Transcripts of the agents this office runs (they end when it stops). */
  ownedTranscripts(): string[] {
    const out: string[] = [];
    for (const session of this.sessions.values()) {
      const agent = this.agentFor(session.sessionId);
      if (agent?.jsonlFile) out.push(agent.jsonlFile);
    }
    return out;
  }

  private adopted(session: OwnedSession, agent: AgentState): void {
    // Dies with this office: never restored by the next one (see restoreExternalAgents).
    agent.officeRun = true;
    this.store.persist();
    if (session.name) this.host.renameAgent(agent.id, session.name);
    this.host.refreshSendable();
    this.broadcastScreen(session);
    // Anything queued while it was being adopted goes out once it is ready.
    if (session.inputReady) this.host.inputReady(agent.id);
  }

  /**
   * A changing screen means Claude is starting, redrawing or working: hold
   * typed input until it has been still for a moment. Only a change in what
   * is SHOWN counts, so an app that repaints an idle screen can't hold forever.
   */
  private screenWritten(session: OwnedSession): void {
    const content = this.readScreen(session).join('\n');
    if (content === session.lastContent) return;
    session.lastContent = content;
    this.setHold(session, true);
    if (session.settleTimer) clearTimeout(session.settleTimer);
    session.settleTimer = setTimeout(() => this.settled(session), OFFICE_SESSION_SETTLE_MS);
  }

  /** The screen has been still: it can take input unless it is asking something. */
  private settled(session: OwnedSession): void {
    session.settleTimer = null;
    this.broadcastScreen(session);
    const lines = this.readScreen(session);
    this.setHold(session, lines.length === 0 || looksLikeQuestion(lines));
  }

  private setHold(session: OwnedSession, hold: boolean): void {
    if (session.inputReady === !hold) return;
    session.inputReady = !hold;
    if (!hold && session.startModel && !session.picking) {
      void this.applyStartModel(session);
      return;
    }
    const agent = this.agentFor(session.sessionId);
    if (agent && !hold) this.host.inputReady(agent.id);
  }

  private ended(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.adoptTimer) clearInterval(session.adoptTimer);
    if (session.screenTimer) clearTimeout(session.screenTimer);
    if (session.settleTimer) clearTimeout(session.settleTimer);
    session.screen.dispose();
    if (session.followedPid) this.host.forgetPid?.(session.followedPid);
    const agent = this.agentFor(sessionId);
    this.sessions.delete(sessionId);
    if (agent) this.host.removeAgent(agent.id);
  }

  private agentFor(sessionId: string): AgentState | undefined {
    for (const agent of this.store.values()) {
      if (sessionKeys(agent).includes(sessionId)) return agent;
    }
    return undefined;
  }

  private sessionOf(agent: AgentState | undefined): OwnedSession | null {
    if (!agent) return null;
    for (const key of sessionKeys(agent)) {
      const session = this.sessions.get(key);
      if (session) return session;
    }
    return null;
  }

  private sessionForAgent(agentId: unknown): OwnedSession | null {
    return typeof agentId === 'number' ? this.sessionOf(this.store.get(agentId)) : null;
  }

  private readScreen(session: OwnedSession): string[] {
    const buffer = session.screen.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < session.screen.rows; y++) {
      lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '');
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  private scheduleScreen(session: OwnedSession): void {
    if (session.screenTimer) return;
    session.screenTimer = setTimeout(() => {
      session.screenTimer = null;
      this.broadcastScreen(session);
    }, OFFICE_SESSION_SCREEN_MS);
  }

  private broadcastScreen(session: OwnedSession): void {
    const agent = this.agentFor(session.sessionId);
    if (!agent) return;
    const lines = this.readScreen(session);
    const joined = lines.join('\n');
    if (joined === session.lastScreen) return;
    session.lastScreen = joined;
    // The office's own trip through the model picker is not a question for people.
    const parsed = session.picking ? null : parseScreenQuestion(lines);
    const question: ScreenQuestion | undefined = parsed
      ? { key: parsed.key, prompt: parsed.prompt, options: parsed.options }
      : undefined;
    this.store.broadcast({
      type: 'agentScreen',
      id: agent.id,
      lines,
      ...(question ? { question } : {}),
    });

    // A question on screen works like a permission prompt: the chat queue holds
    // (ChatSender never types while permissionSent — its Enter would answer the
    // question) and the character shows the "needs you" bubble. Only a flag WE
    // set is cleared here; hook-driven permission state is left alone.
    const asking = !session.picking && looksLikeQuestion(lines);
    if (asking && !agent.permissionSent) {
      agent.permissionSent = true;
      session.askingByScreen = true;
      this.store.broadcast({ type: 'agentToolPermission', id: agent.id });
    } else if (!asking && session.askingByScreen) {
      session.askingByScreen = false;
      agent.permissionSent = false;
      this.store.broadcast({ type: 'agentToolPermissionClear', id: agent.id });
    }
  }
}
