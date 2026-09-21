import { Terminal } from '@xterm/headless';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentKey } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { TerminalWriter } from './chatSender.js';
import {
  OFFICE_RECENT_FOLDERS,
  OFFICE_SESSION_ADOPT_TRIES,
  OFFICE_SESSION_LIMIT,
  OFFICE_SESSION_SCREEN_COLS,
  OFFICE_SESSION_SCREEN_MS,
  OFFICE_SESSION_SCREEN_ROWS,
} from './constants.js';
import type { Pty } from './launcher.js';
import { expandAlias, loadPty, planLaunch, splitShellWords } from './launcher.js';
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
  renameAgent(agentId: number, name: string): void;
  removeAgent(agentId: number): void;
  refreshSendable(): void;
}

interface OwnedSession {
  sessionId: string;
  cwd: string;
  pty: Pty;
  screen: Terminal;
  lastScreen: string;
  screenTimer: ReturnType<typeof setTimeout> | null;
  adoptTimer: ReturnType<typeof setInterval> | null;
  name?: string;
  /** True while WE flagged the agent as waiting on a question seen on its screen. */
  askingByScreen: boolean;
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

/** A numbered choice on screen ("1. Yes  2. No"): Claude is waiting for an answer. */
export function looksLikeQuestion(lines: string[]): boolean {
  const option = (n: number) => new RegExp(`^\\s*(?:[❯>›]\\s*)?${n}[.)]\\s+\\S`);
  return lines.some((l) => option(1).test(l)) && lines.some((l) => option(2).test(l));
}

/**
 * The ids a session can be known by. Team discovery adopts a teammate's
 * transcript on its own and may give the agent a different `sessionId`, but
 * the transcript file is always named after Claude's session id.
 */
function sessionKeys(agent: AgentState): string[] {
  const fromFile = agent.jsonlFile ? path.basename(agent.jsonlFile, '.jsonl') : '';
  return fromFile && fromFile !== agent.sessionId ? [agent.sessionId, fromFile] : [agent.sessionId];
}

function expandHome(p: string): string {
  const t = p.trim();
  return t === '~' || t.startsWith('~/') ? path.join(os.homedir(), t.slice(1)) : t;
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

  start(req: StartAgentRequest): { ok: true } | { ok: false; error: string } {
    if (!this.pty)
      return { ok: false, error: 'node-pty is not installed, so the office cannot start agents.' };
    if (this.sessions.size >= OFFICE_SESSION_LIMIT) {
      return {
        ok: false,
        error: `The office runs at most ${OFFICE_SESSION_LIMIT} agents of its own.`,
      };
    }
    const cwd = expandHome(typeof req.cwd === 'string' ? req.cwd : '');
    try {
      if (!path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('not a dir');
    } catch {
      return { ok: false, error: 'That project folder does not exist on this computer.' };
    }

    const words = splitShellWords((req.command ?? '').trim() || 'claude');
    const alias = expandAlias(words[0], words.slice(1));
    const command = alias ?? { program: words[0], args: words.slice(1) };
    if (req.skipPermissions) command.args.push('--dangerously-skip-permissions');
    // The first message rides the command line (`claude "<prompt>"`), never the
    // keyboard: typed input would land in — and its Enter would answer —
    // whatever Claude asks first (trust this folder?).
    const firstMessage = req.firstMessage?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (firstMessage) command.args.push(firstMessage);
    const plan = planLaunch(command.program, command.args);
    if (!plan.tracksClaude || !plan.sessionId || !plan.interactive) {
      return {
        ok: false,
        error:
          'The start command must run Claude as a new interactive session (for example: claude, or an alias of it).',
      };
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
    };
    this.sessions.set(sessionId, session);
    this.recent.splice(0, this.recent.length, cwd, ...this.recent.filter((f) => f !== cwd));
    this.recent.length = Math.min(this.recent.length, OFFICE_RECENT_FOLDERS);
    pty.onData((data) => {
      session.screen.write(data);
      this.scheduleScreen(session);
    });
    pty.onExit(() => this.ended(sessionId));

    // The transcript (and its project dir) appears with Claude's first record,
    // so adoption is retried until the agent exists.
    let tries = 0;
    session.adoptTimer = setInterval(() => {
      const agent = this.agentFor(sessionId);
      if (agent || ++tries > OFFICE_SESSION_ADOPT_TRIES) {
        if (session.adoptTimer) clearInterval(session.adoptTimer);
        session.adoptTimer = null;
        if (agent) this.adopted(session, agent);
        return;
      }
      this.host.adoptLaunchedSession(sessionId, cwd);
    }, 1_000);
    return { ok: true };
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
      write: (agent, text) => {
        const session = this.sessionOf(agent);
        if (!session) throw new Error('session ended');
        void typePrompt(
          (data) => session.pty.write(data),
          text,
          () => !this.sessions.has(session.sessionId),
        );
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
      try {
        session.pty.kill();
      } catch {
        /* already gone */
      }
    }
    this.sessions.clear();
  }

  private adopted(session: OwnedSession, agent: AgentState): void {
    if (session.name) this.host.renameAgent(agent.id, session.name);
    this.host.refreshSendable();
    this.broadcastScreen(session);
  }

  private ended(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.adoptTimer) clearInterval(session.adoptTimer);
    if (session.screenTimer) clearTimeout(session.screenTimer);
    session.screen.dispose();
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
    this.store.broadcast({ type: 'agentScreen', id: agent.id, lines });

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
