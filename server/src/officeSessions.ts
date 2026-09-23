import { Terminal } from '@xterm/headless';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentKey, ScreenQuestion } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { TerminalWriter } from './chatSender.js';
import {
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
import { areHooksInstalled as antigravityHooksInstalled } from './providers/hook/antigravity/antigravityHookInstaller.js';
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
}

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

  constructor(
    private readonly store: AgentStateStore,
    private readonly host: OfficeSessionHost,
  ) {}

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
      if (firstMessage) command.args.push(firstMessage);
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

  get writer(): TerminalWriter {
    return {
      canWrite: (agent) => this.sessionOf(agent) !== null,
      ready: (agent) => this.sessionOf(agent)?.inputReady === true,
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
    const parsed = parseScreenQuestion(lines);
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
    const asking = looksLikeQuestion(lines);
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
