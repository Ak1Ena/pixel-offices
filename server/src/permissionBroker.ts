import type { PermissionDecision } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  PERMISSION_DECIDED_TTL_MS,
  PERMISSION_DETAIL_MAX_CHARS,
  PERMISSION_WAIT_MS,
} from './constants.js';

/**
 * Permission prompts answered from the office.
 *
 * A provider's hook script can hold a permission prompt open (Claude's
 * PermissionRequest hook blocks the dialog until it exits): it POSTs the event
 * with a `pixel_request_id`, and when some server says it will wait, it
 * long-polls that server for the decision. The broker is that server-side
 * half: it opens an ask (broadcast `agentPermissionAsk`), takes the answer
 * (`answerPermission`), and hands it to the waiting poll.
 *
 * An ask is only opened while someone can answer it (a privileged client is
 * connected — `addDecider`), so nobody's terminal is held for a page that is
 * not open. It closes on an answer, on its deadline (the prompt then shows in
 * the terminal, as without the office), when the agent moves on (any later
 * hook event from its session — another server answered, or the user answered
 * in the terminal after the wait), or when the agent goes away.
 */

export type PollResult = PermissionDecision | 'pending';

interface Ask {
  requestId: string;
  agentId: number;
  toolName: string;
  detail?: string;
  providerId: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  waiters: Set<(decision: PermissionDecision) => void>;
}

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function isPermissionRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_RE.test(value);
}

export class PermissionBroker {
  private readonly asks = new Map<string, Ask>();
  /** Recently decided asks, so a poll that arrives after the answer still gets it. */
  private readonly decided = new Map<string, { decision: PermissionDecision; at: number }>();
  private deciders = 0;

  constructor(
    private readonly store: AgentStateStore,
    private readonly waitMs = PERMISSION_WAIT_MS,
  ) {
    store.on('agentRemoved', this.onAgentRemoved);
  }

  /** A client that can answer asks is connected. Call the returned function when it goes. */
  addDecider(): () => void {
    this.deciders++;
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.deciders--;
    };
  }

  get canDecide(): boolean {
    return this.deciders > 0;
  }

  /**
   * Open an ask. Returns true when the hook should wait for an answer from this
   * server, false when nobody here can answer (the prompt shows in the terminal).
   */
  open(ask: {
    requestId: string;
    agentId: number;
    toolName: string;
    detail?: string;
    providerId: string;
  }): boolean {
    if (!isPermissionRequestId(ask.requestId)) return false;
    if (this.asks.has(ask.requestId)) return true;
    if (!this.canDecide) return false;
    const detail =
      ask.detail && ask.detail.length > PERMISSION_DETAIL_MAX_CHARS
        ? `${ask.detail.slice(0, PERMISSION_DETAIL_MAX_CHARS)}…`
        : ask.detail;
    const expiresAt = Date.now() + this.waitMs;
    const entry: Ask = {
      ...ask,
      detail: detail || undefined,
      expiresAt,
      timer: setTimeout(() => this.close(ask.requestId, 'terminal'), this.waitMs),
      waiters: new Set(),
    };
    entry.timer.unref?.();
    this.asks.set(ask.requestId, entry);
    this.store.broadcast(this.askMessage(entry));
    return true;
  }

  /** Answer an ask from the office. Returns false when there is no such open ask for that agent. */
  answer(agentId: unknown, requestId: unknown, decision: unknown): boolean {
    if (typeof requestId !== 'string') return false;
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'terminal') return false;
    const ask = this.asks.get(requestId);
    if (!ask || ask.agentId !== agentId) return false;
    this.close(requestId, decision);
    return true;
  }

  /** Wait up to `ms` for the decision on `requestId`. */
  wait(requestId: string, ms: number): Promise<PollResult> {
    const done = this.decided.get(requestId);
    if (done) return Promise.resolve(done.decision);
    const ask = this.asks.get(requestId);
    // Unknown (never opened here, or long gone): stop waiting on us.
    if (!ask) return Promise.resolve('terminal');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        ask.waiters.delete(waiter);
        resolve('pending');
      }, ms);
      timer.unref?.();
      const waiter = (decision: PermissionDecision) => {
        clearTimeout(timer);
        resolve(decision);
      };
      ask.waiters.add(waiter);
    });
  }

  /** The agent moved on (a later hook event from its session): its open asks are moot. */
  closeForAgent(agentId: number): void {
    for (const ask of [...this.asks.values()]) {
      if (ask.agentId === agentId) this.close(ask.requestId, 'terminal');
    }
  }

  /** Open asks, for a connecting client. */
  snapshot(): Array<Record<string, unknown>> {
    return [...this.asks.values()].map((ask) => this.askMessage(ask));
  }

  dispose(): void {
    this.store.off('agentRemoved', this.onAgentRemoved);
    for (const ask of this.asks.values()) {
      clearTimeout(ask.timer);
      for (const waiter of ask.waiters) waiter('terminal');
    }
    this.asks.clear();
    this.decided.clear();
  }

  private readonly onAgentRemoved = (id: number) => this.closeForAgent(id);

  private close(requestId: string, decision: PermissionDecision): void {
    const ask = this.asks.get(requestId);
    if (!ask) return;
    this.asks.delete(requestId);
    clearTimeout(ask.timer);
    const now = Date.now();
    for (const [id, d] of this.decided) {
      if (d.at < now - PERMISSION_DECIDED_TTL_MS) this.decided.delete(id);
    }
    this.decided.set(requestId, { decision, at: now });
    for (const waiter of ask.waiters) waiter(decision);
    this.store.broadcast({
      type: 'agentPermissionAnswered',
      id: ask.agentId,
      requestId,
      decision,
    });
  }

  private askMessage(ask: Ask): Record<string, unknown> {
    return {
      type: 'agentPermissionAsk',
      id: ask.agentId,
      requestId: ask.requestId,
      toolName: ask.toolName,
      detail: ask.detail,
      providerId: ask.providerId,
      expiresAt: ask.expiresAt,
    };
  }
}
