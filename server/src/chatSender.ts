import { randomUUID } from 'node:crypto';

import type { QueuedChatMessage } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { CHAT_QUEUE_LIMIT, CHAT_SEND_MAX_CHARS } from './constants.js';
import type { AgentState } from './types.js';

/**
 * Host seam for typing into an agent's terminal. Only a host that owns
 * terminals (VS Code) provides one; the standalone server has none, so every
 * send there is refused with a reason.
 */
export interface TerminalWriter {
  canWrite(agent: AgentState): boolean;
  write(agent: AgentState, text: string): void;
}

const QUEUE_TICK_MS = 2_000;
/** Control characters other than tab and newline. Stripped so a message can't
 *  end the bracketed paste early or send keystrokes of its own. */
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const PENDING_OFFICE_TEXTS_LIMIT = 20;

/**
 * Messages sent from the office chat. Delivered straight away when the agent
 * is idle; otherwise held until its turn ends. A permission prompt ALWAYS
 * holds the queue: the Enter that submits a message would answer the prompt.
 */
export class ChatSender {
  private writer: TerminalWriter | null = null;
  private readonly queues = new Map<number, QueuedChatMessage[]>();
  /** Agents seen mid-turn (last activity broadcast said so). */
  private readonly busy = new Set<number>();
  private readonly tick: ReturnType<typeof setInterval>;

  constructor(private readonly store: AgentStateStore) {
    store.on('broadcast', this.onBroadcast);
    store.on('agentRemoved', this.onAgentRemoved);
    // Backstop for turns that end without a status broadcast (interrupts).
    this.tick = setInterval(() => {
      for (const id of this.queues.keys()) {
        if (this.store.get(id)?.isWaiting) this.busy.delete(id);
        this.flush(id);
      }
    }, QUEUE_TICK_MS);
    this.tick.unref?.();
  }

  setWriter(writer: TerminalWriter | null): void {
    this.writer = writer;
  }

  /** Whether this host can type into the agent's terminal at all. */
  canSend(agentId: number): boolean {
    const agent = this.store.get(agentId);
    return !!agent && !!this.writer?.canWrite(agent);
  }

  send(agentId: number, rawText: unknown): void {
    const agent = this.store.get(agentId);
    const text = typeof rawText === 'string' ? rawText.replace(CONTROL_CHARS_RE, '').trim() : '';
    if (!agent) return;
    if (!text) return;
    if (text.length > CHAT_SEND_MAX_CHARS) {
      this.report(agentId, `Message too long (max ${CHAT_SEND_MAX_CHARS} characters).`);
      return;
    }
    if (!this.writer?.canWrite(agent)) {
      this.report(
        agentId,
        'This session has no office terminal. Reply from the terminal where it started.',
      );
      return;
    }
    const queue = this.queues.get(agentId) ?? [];
    if (queue.length >= CHAT_QUEUE_LIMIT) {
      this.report(agentId, 'Too many queued messages. Wait for the agent to finish.');
      return;
    }
    queue.push({ queueId: randomUUID(), text });
    this.queues.set(agentId, queue);
    if (!this.flush(agentId)) this.report(agentId);
  }

  cancel(agentId: number, queueId: unknown): void {
    const queue = this.queues.get(agentId);
    if (!queue) return;
    const next = queue.filter((m) => m.queueId !== queueId);
    if (next.length === queue.length) return;
    this.setQueue(agentId, next);
    this.report(agentId);
  }

  /** Current queues, for a connecting client. */
  snapshot(): Array<{ id: number; queued: QueuedChatMessage[] }> {
    return [...this.queues].map(([id, queued]) => ({ id, queued: queued.map((m) => ({ ...m })) }));
  }

  dispose(): void {
    clearInterval(this.tick);
    this.store.off('broadcast', this.onBroadcast);
    this.store.off('agentRemoved', this.onAgentRemoved);
    this.queues.clear();
  }

  /** Type queued messages in while the agent can take them. Returns true if anything was sent. */
  private flush(agentId: number): boolean {
    const queue = this.queues.get(agentId);
    const agent = this.store.get(agentId);
    if (!queue || queue.length === 0 || !agent || !this.writer) return false;
    if (agent.permissionSent || this.busy.has(agentId)) return false;
    if (!this.writer.canWrite(agent)) return false;
    // One at a time: the message starts a turn, the next waits for it to end.
    const message = queue.shift()!;
    this.setQueue(agentId, queue);
    const pending = (agent.pendingOfficeTexts ??= []);
    pending.push(message.text);
    if (pending.length > PENDING_OFFICE_TEXTS_LIMIT) pending.shift();
    try {
      this.writer.write(agent, message.text);
      this.busy.add(agentId);
      this.report(agentId);
    } catch (err) {
      console.error(`[Pixel Agents] Chat: typing into agent ${agentId}'s terminal failed:`, err);
      this.report(agentId, 'Could not type into the terminal.');
    }
    return true;
  }

  private setQueue(agentId: number, queue: QueuedChatMessage[]): void {
    if (queue.length === 0) this.queues.delete(agentId);
    else this.queues.set(agentId, queue);
  }

  private report(agentId: number, error?: string): void {
    this.store.broadcast({
      type: 'agentChatQueue',
      id: agentId,
      queued: (this.queues.get(agentId) ?? []).map((m) => ({ ...m })),
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
  };
}
