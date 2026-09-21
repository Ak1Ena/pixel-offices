import type { TerminalWriter } from './chatSender.js';
import { LAUNCHER_LEASE_MS } from './constants.js';
import type { AgentState } from './types.js';

/**
 * Sessions started through `pixel-agents claude` (server/src/launcher.ts).
 *
 * The launcher owns the pty Claude runs in and long-polls this server for
 * text to type into it. Each launched session is an inbox keyed by its
 * session id: office messages queue here until the launcher's next poll
 * picks them up. A session counts as connected while a poll is waiting or
 * one arrived within LAUNCHER_LEASE_MS.
 */

/** Delivers texts to a waiting poll. Returns false when the poll's
 *  connection is already gone, so the texts stay queued. */
type Waiter = (texts: string[]) => boolean;

interface LaunchedSession {
  queue: string[];
  waiter: Waiter | null;
  lastSeen: number;
}

export class LauncherHub {
  private readonly sessions = new Map<string, LaunchedSession>();

  /** @param onChange a session connected or ended (sendable state may have moved). */
  constructor(private readonly onChange: (sessionId: string) => void = () => {}) {}

  /**
   * A launcher asks for input. Resolves with queued texts right away, or
   * waits up to `timeoutMs` for some. `isOpen` reports whether the poll's
   * connection is still there when texts arrive.
   */
  poll(sessionId: string, timeoutMs: number, isOpen: () => boolean): Promise<string[]> {
    let session = this.sessions.get(sessionId);
    const isNew = !session || !this.isLive(session);
    if (!session) {
      session = { queue: [], waiter: null, lastSeen: Date.now() };
      this.sessions.set(sessionId, session);
    }
    session.lastSeen = Date.now();
    // A newer poll supersedes an older one still hanging for this session.
    session.waiter?.([]);
    session.waiter = null;
    if (isNew) this.onChange(sessionId);

    if (session.queue.length > 0) {
      const texts = session.queue.splice(0);
      return Promise.resolve(texts);
    }

    const current = session;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (current.waiter === waiter) current.waiter = null;
        current.lastSeen = Date.now();
        resolve([]);
      }, timeoutMs);
      const waiter: Waiter = (texts) => {
        clearTimeout(timer);
        if (current.waiter === waiter) current.waiter = null;
        current.lastSeen = Date.now();
        if (texts.length > 0 && !isOpen()) return false;
        resolve(texts);
        return true;
      };
      current.waiter = waiter;
    });
  }

  /** Queue `text` for the session's launcher. Returns false when no launcher is connected. */
  write(sessionId: string, text: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !this.isLive(session)) return false;
    if (session.waiter?.([text])) return true;
    session.queue.push(text);
    return true;
  }

  isConnected(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && this.isLive(session);
  }

  /** The launcher exited (or said goodbye): drop its inbox. */
  end(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.waiter?.([]);
    this.sessions.delete(sessionId);
    this.onChange(sessionId);
  }

  /** A TerminalWriter for ChatSender: agents whose session a launcher owns. */
  get writer(): TerminalWriter {
    return {
      canWrite: (agent: AgentState) => this.isConnected(agent.sessionId),
      write: (agent: AgentState, text: string) => {
        if (!this.write(agent.sessionId, text)) {
          throw new Error(`launcher for session ${agent.sessionId} is gone`);
        }
      },
    };
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.waiter?.([]);
    this.sessions.clear();
  }

  private isLive(session: LaunchedSession): boolean {
    return session.waiter !== null || Date.now() - session.lastSeen < LAUNCHER_LEASE_MS;
  }
}
