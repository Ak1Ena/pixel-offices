import type { AgentStateStore } from './agentStateStore.js';
import {
  RELAY_MAX_CHARS,
  RELAY_PAIR_LIMIT,
  RELAY_TOTAL_LIMIT,
  RELAY_WINDOW_MS,
} from './constants.js';
import type { AgentState } from './types.js';

/**
 * Agent-to-agent messages: when an agent's reply mentions another agent as
 * `@Name`, the reply is passed to that agent as a prompt.
 *
 * Every pass starts a turn (and spends tokens) in the receiving session, and
 * two agents can answer each other forever, so this is OFF by default and
 * rate-limited when on: a few passes per sender→receiver pair and a ceiling
 * for the whole office, per window. Messages the relay itself delivered are
 * never relayed onward as new mentions of the original sender's text.
 */

/** Name an agent is addressed by. */
export function agentHandle(agent: AgentState): string | null {
  return agent.displayName ?? agent.agentName ?? null;
}

/** Agents (other than the sender) whose handle appears as `@Handle` in `text`. */
export function mentionedAgents(
  text: string,
  senderId: number,
  agents: Iterable<[number, AgentState]>,
): number[] {
  const lower = text.toLowerCase();
  const found: number[] = [];
  for (const [id, agent] of agents) {
    if (id === senderId) continue;
    const handle = agentHandle(agent);
    if (!handle) continue;
    const at = lower.indexOf(`@${handle.toLowerCase()}`);
    if (at === -1) continue;
    // Must end at a word boundary: "@Pat" does not match "@Patrick".
    const next = lower[at + 1 + handle.length];
    if (next === undefined || !/[a-z0-9_-]/.test(next)) found.push(id);
  }
  return found;
}

export class MentionRelay {
  enabled = false;
  private readonly passes: Array<{ at: number; pair: string }> = [];

  constructor(
    private readonly store: AgentStateStore,
    private readonly deliver: (agentId: number, text: string) => void,
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.store.broadcast({ type: 'agentRelayState', enabled });
  }

  /** Called for every NEW assistant reply. */
  onReply(senderId: number, text: string, now = Date.now()): void {
    if (!this.enabled) return;
    const sender = this.store.get(senderId);
    if (!sender) return;
    const from = agentHandle(sender) ?? `Agent #${senderId}`;
    while (this.passes.length > 0 && this.passes[0].at < now - RELAY_WINDOW_MS) this.passes.shift();

    for (const targetId of mentionedAgents(text, senderId, this.store)) {
      const pair = `${senderId}>${targetId}`;
      if (this.passes.length >= RELAY_TOTAL_LIMIT) return;
      if (this.passes.filter((p) => p.pair === pair).length >= RELAY_PAIR_LIMIT) continue;
      this.passes.push({ at: now, pair });
      const body = text.length > RELAY_MAX_CHARS ? `${text.slice(0, RELAY_MAX_CHARS)}…` : text;
      this.deliver(targetId, `Message from ${from} (teammate, via the office): ${body}`);
    }
  }
}
