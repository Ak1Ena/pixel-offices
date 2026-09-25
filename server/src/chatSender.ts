import { randomUUID } from 'node:crypto';

import type { QueuedChatMessage } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { CHAT_INTERRUPT_SEND_WAIT_MS, CHAT_QUEUE_LIMIT, CHAT_SEND_MAX_CHARS } from './constants.js';
import type { AgentState } from './types.js';

/**
 * Seam for typing into an agent's terminal. VS Code provides one for the
 * terminals it owns; the launcher hub provides one for sessions started with
 * `pixel-agents claude`. An agent no writer can reach is read-only.
 */
export interface TerminalWriter {
  canWrite(agent: AgentState): boolean;
  write(agent: AgentState, text: string): void;
  /** Whether the terminal can take typed input right now (absent = always).
   *  False holds the queue; the writer calls ChatSender.retry when it clears. */
  ready?(agent: AgentState): boolean;
  /** Press Esc in the terminal: Claude's interrupt (absent = can't). */
  interrupt?(agent: AgentState): void;
}

const QUEUE_TICK_MS = 2_000;
/** Control characters other than tab and newline. Stripped so a message can't
 *  end the bracketed paste early or send keystrokes of its own. */
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const PENDING_OFFICE_TEXTS_LIMIT = 20;

/** A queued message plus how it may be delivered. `midTurn` messages are the
 *  human's own words from the office chat: they go in while the agent is still
 *  working, because Claude takes typed input as queued input and reads it at
 *  the next prompt -- waiting for the turn to end is what made the office feel
 *  stuck. Everything the OFFICE writes (card prompts, `/clear`, a workflow's
 *  intro, a relayed mention) keeps the idle-only rule, so a card prompt can
 *  never land in the same turn as the human's text. A permission prompt holds
 *  both: the Enter would answer the prompt. */
type PendingMessage = QueuedChatMessage & {
  midTurn?: boolean;
  /** "Send now": the turn was stopped for this message; it waits for that
   *  turn to end, but never past this time (ms since epoch). */
  afterInterruptUntil?: number;
};

/**
 * Messages sent from the office chat. The human's own messages (`midTurn`) are
 * typed as soon as the terminal can take them, even mid-turn; messages the
 * office itself writes wait for the turn to end. A permission prompt ALWAYS
 * holds the queue: the Enter that submits a message would answer the prompt.
 */
export class ChatSender {
  private readonly writers: TerminalWriter[] = [];
  /** Last sendable state broadcast per agent (agentChatSendable). */
  private readonly sendable = new Map<number, boolean>();
  private readonly queues = new Map<number, PendingMessage[]>();
  /** Agents seen mid-turn (last activity broadcast said so). */
  private readonly busy = new Set<number>();
  private readonly tick: ReturnType<typeof setInterval>;

  constructor(private readonly store: AgentStateStore) {
    store.on('broadcast', this.onBroadcast);
    store.on('agentRemoved', this.onAgentRemoved);
    store.on('agentAdded', this.onAgentAdded);
    // Backstop for turns that end without a status broadcast (interrupts), and
    // for writers whose reach changes silently (a launcher's lease running out).
    this.tick = setInterval(() => {
      for (const id of this.queues.keys()) {
        if (this.store.get(id)?.isWaiting) this.busy.delete(id);
        this.flush(id);
      }
      this.refreshSendable();
    }, QUEUE_TICK_MS);
    this.tick.unref?.();
  }

  addWriter(writer: TerminalWriter): void {
    this.writers.push(writer);
    this.refreshSendable();
  }

  /** Whether any writer can type into the agent's terminal right now. */
  canSend(agentId: number): boolean {
    const agent = this.store.get(agentId);
    return !!agent && this.writerFor(agent) !== null;
  }

  /**
   * Broadcast `agentChatSendable` for every agent whose reach changed. Hosts
   * call it when a writer's reach moves (a launcher connects or leaves); the
   * tick catches the rest.
   */
  refreshSendable(): void {
    for (const [id, agent] of this.store) {
      const sendable = this.writerFor(agent) !== null;
      if (this.sendable.get(id) === sendable) continue;
      this.sendable.set(id, sendable);
      this.store.broadcast({ type: 'agentChatSendable', id, sendable });
    }
  }

  /** Nothing queued and no turn running: a message sent now is typed at once. */
  isIdle(agentId: number): boolean {
    return !this.busy.has(agentId) && !this.queues.has(agentId);
  }

  /** Agents the office can type into, for a connecting client. */
  sendableSnapshot(): number[] {
    return [...this.store.keys()].filter((id) => this.canSend(id));
  }

  send(agentId: number, rawText: unknown, opts?: { midTurn?: boolean; interrupt?: boolean }): void {
    const agent = this.store.get(agentId);
    const text = typeof rawText === 'string' ? rawText.replace(CONTROL_CHARS_RE, '').trim() : '';
    if (!agent) return;
    if (!text) return;
    if (text.length > CHAT_SEND_MAX_CHARS) {
      this.report(agentId, `Message too long (max ${CHAT_SEND_MAX_CHARS} characters).`);
      return;
    }
    if (!this.writerFor(agent)) {
      this.report(
        agentId,
        'This session has no office terminal. Start it with `pixel-office claude` to chat from here.',
      );
      return;
    }
    const queue = this.queues.get(agentId) ?? [];
    if (queue.length >= CHAT_QUEUE_LIMIT) {
      this.report(agentId, 'Too many queued messages. Wait for the agent to finish.');
      return;
    }
    // "Send now": stop what the agent is doing, then this message goes first.
    // An idle agent has nothing to stop (and Esc at an idle prompt opens
    // Claude's rewind menu), so it is simply sent.
    const working = !agent.isWaiting || agent.permissionSent;
    if (opts?.interrupt && working) {
      if (this.interrupt(agentId)) {
        queue.unshift({
          queueId: randomUUID(),
          text,
          afterInterruptUntil: Date.now() + CHAT_INTERRUPT_SEND_WAIT_MS,
        });
        this.busy.add(agentId);
        this.queues.set(agentId, queue);
        this.report(agentId);
        return;
      }
      this.report(
        agentId,
        "Couldn't stop this agent from here, so the message was queued instead.",
      );
    }
    queue.push({ queueId: randomUUID(), text, ...(opts?.midTurn ? { midTurn: true } : {}) });
    this.queues.set(agentId, queue);
    if (!this.flush(agentId)) this.report(agentId);
  }

  /**
   * Stop the agent's current turn: Esc in its terminal. Refused while it is
   * idle, where Esc does something else (clears the prompt, a second one opens
   * Claude's rewind menu). Queued messages stay queued and go out once the
   * interrupted turn has ended.
   */
  interrupt(agentId: number): boolean {
    const agent = this.store.get(agentId);
    if (!agent || (agent.isWaiting && !agent.permissionSent)) return false;
    const writer = this.writerFor(agent);
    if (!writer?.interrupt) return false;
    try {
      writer.interrupt(agent);
      return true;
    } catch (err) {
      console.warn(`[Pixel Agents] Agent ${agentId}: interrupt failed:`, err);
      return false;
    }
  }

  cancel(agentId: number, queueId: unknown): void {
    const queue = this.queues.get(agentId);
    if (!queue) return;
    const next = queue.filter((m) => m.queueId !== queueId);
    if (next.length === queue.length) return;
    this.setQueue(agentId, next);
    this.report(agentId);
  }

  /** Show an error in the agent's chat (with its current queue). */
  notice(agentId: number, error: string): void {
    if (this.store.get(agentId)) this.report(agentId, error);
  }

  /** Try to deliver now (a writer just became able to take input). */
  retry(agentId: number): void {
    this.flush(agentId);
  }

  /** Current queues, for a connecting client. */
  snapshot(): Array<{ id: number; queued: QueuedChatMessage[] }> {
    return [...this.queues].map(([id, queued]) => ({
      id,
      queued: queued.map((m) => ({ queueId: m.queueId, text: m.text })),
    }));
  }

  dispose(): void {
    clearInterval(this.tick);
    this.store.off('broadcast', this.onBroadcast);
    this.store.off('agentRemoved', this.onAgentRemoved);
    this.store.off('agentAdded', this.onAgentAdded);
    this.queues.clear();
  }

  private writerFor(agent: AgentState): TerminalWriter | null {
    return this.writers.find((w) => w.canWrite(agent)) ?? null;
  }

  /** Type queued messages in while the agent can take them. Returns true if anything was sent. */
  private flush(agentId: number): boolean {
    let sent = false;
    for (;;) {
      const queue = this.queues.get(agentId);
      const agent = this.store.get(agentId);
      if (!queue || queue.length === 0 || !agent) break;
      if (agent.permissionSent) break;
      // The human's own words go in mid-turn, one after another; an office
      // message starts a turn of its own and the next one waits for its end.
      const head = queue[0];
      if (head.afterInterruptUntil !== undefined) {
        // Wait for the stopped turn to end — but not forever: an interrupt
        // that ends with no status change would hold the message otherwise.
        const ended = !this.busy.has(agentId) || agent.isWaiting;
        if (!ended && Date.now() < head.afterInterruptUntil) break;
      } else if ((sent || this.busy.has(agentId)) && !head.midTurn) break;
      const writer = this.writerFor(agent);
      if (!writer) break;
      if (writer.ready && !writer.ready(agent)) break;
      const message = queue.shift()!;
      this.setQueue(agentId, queue);
      const pending = (agent.pendingOfficeTexts ??= []);
      pending.push(message.text);
      if (pending.length > PENDING_OFFICE_TEXTS_LIMIT) pending.shift();
      try {
        writer.write(agent, message.text);
        this.busy.add(agentId);
        this.report(agentId);
      } catch (err) {
        console.error(`[Pixel Agents] Chat: typing into agent ${agentId}'s terminal failed:`, err);
        this.report(agentId, 'Could not type into the terminal.');
        return sent;
      }
      sent = true;
    }
    return sent;
  }

  private setQueue(agentId: number, queue: PendingMessage[]): void {
    if (queue.length === 0) this.queues.delete(agentId);
    else this.queues.set(agentId, queue);
  }

  private report(agentId: number, error?: string): void {
    this.store.broadcast({
      type: 'agentChatQueue',
      id: agentId,
      // `midTurn` is ours, not part of the protocol: send the declared fields only.
      queued: (this.queues.get(agentId) ?? []).map((m) => ({ queueId: m.queueId, text: m.text })),
      ...(error ? { error } : {}),
    });
  }

  private readonly onBroadcast = (message: Record<string, unknown>): void => {
    const id = message.id;
    if (typeof id !== 'number') return;
    switch (message.type) {
      case 'agentStatus':
        if (message.status === 'active') this.busy.add(id);
        else if (message.status === 'waiting') {
          this.busy.delete(id);
          this.flush(id);
        }
        break;
      case 'agentToolStart':
        this.busy.add(id);
        break;
      case 'agentToolPermissionClear':
        this.flush(id);
        break;
    }
  };

  private readonly onAgentRemoved = (id: number): void => {
    this.queues.delete(id);
    this.busy.delete(id);
    this.sendable.delete(id);
  };

  private readonly onAgentAdded = (): void => {
    this.refreshSendable();
  };
}
