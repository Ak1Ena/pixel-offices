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

/**
 * Every name `@` may address an agent by. Matches what the office shows as its
 * label (webview App.tsx agentLabel): the user-given name, the teammate name,
 * else "<folder> #<id>" / "Agent #<id>" — unnamed agents were unreachable
 * before, because only the first two counted. Space-free forms (`@agent3`,
 * `@agent-3`, `@#3`) are accepted too, since models tend to drop the space.
 */
export function agentAliases(id: number, agent: AgentState): string[] {
  const aliases = [agent.displayName, agent.agentName].filter(
    (name): name is string => typeof name === 'string' && name.trim().length > 0,
  );
  if (agent.folderName) aliases.push(`${agent.folderName} #${id}`, `${agent.folderName}#${id}`);
  aliases.push(`Agent #${id}`, `Agent#${id}`, `agent${id}`, `agent-${id}`, `#${id}`);
  return aliases;
}

/** Whether `lower` (lower-cased text) has `@alias` ending at a word boundary. */
function mentions(lower: string, alias: string): boolean {
  const needle = `@${alias.toLowerCase()}`;
  let at = lower.indexOf(needle);
  while (at !== -1) {
    // Must end at a word boundary: "@Pat" does not match "@Patrick", "@#3" not "@#31".
    const next = lower[at + needle.length];
    if (next === undefined || !/[a-z0-9_-]/.test(next)) return true;
    at = lower.indexOf(needle, at + 1);
  }
  return false;
}

/** Agents (other than the sender) addressed as `@Name` in `text`. */
export function mentionedAgents(
  text: string,
  senderId: number,
  agents: Iterable<[number, AgentState]>,
): number[] {
  const lower = text.toLowerCase();
  const found: number[] = [];
  for (const [id, agent] of agents) {
    if (id === senderId) continue;
    if (agentAliases(id, agent).some((alias) => mentions(lower, alias))) found.push(id);
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
    const from = agentAliases(senderId, sender)[0];
    while (this.passes.length > 0 && this.passes[0].at < now - RELAY_WINDOW_MS) this.passes.shift();

    for (const targetId of mentionedAgents(text, senderId, this.store)) {
      const pair = `${senderId}>${targetId}`;
      if (this.passes.length >= RELAY_TOTAL_LIMIT) return;
      if (this.passes.filter((p) => p.pair === pair).length >= RELAY_PAIR_LIMIT) continue;
      this.passes.push({ at: now, pair });
      const body = text.length > RELAY_MAX_CHARS ? `${text.slice(0, RELAY_MAX_CHARS)}…` : text;
      this.deliver(
        targetId,
        `Message from ${from} (teammate, via the office): ${body}\n(To answer, write @${from} in your reply.)`,
      );
    }
  }
}
