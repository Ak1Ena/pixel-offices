import { addressedPartsWithDecisions } from './addressedDecisions.js';
import { addressedParts } from './addressedParts.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  RELAY_MAX_CHARS,
  RELAY_PAIR_LIMIT,
  RELAY_TOTAL_LIMIT,
  RELAY_WINDOW_MS,
} from './constants.js';
import type { Decider } from './decisions.js';
import type { AgentState } from './types.js';

/**
 * Agent-to-agent messages: when a paragraph of an agent's reply opens with
 * `@Name`, that part (not the whole reply) is passed to that agent as a
 * prompt — one conversation per pair (see addressedParts.ts).
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
  // The office writes a spaced name as one word (`@Frontend-Dev`), so accept that too.
  for (const name of [...aliases]) {
    const dashed = name.trim().replace(/\s+/g, '-');
    if (dashed !== name) aliases.push(dashed);
  }
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
    /** Second reader for mentions the opening-@ rule skips; null = the rule alone. */
    private readonly decider: () => Decider | null = () => null,
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

    const others = [...this.store]
      .filter(([id]) => id !== senderId)
      .map(([id, agent]) => ({ key: id, aliases: agentAliases(id, agent) }));
    const decider = this.decider();
    if (!decider) {
      this.pass(senderId, from, addressedParts(text, others), now);
      return;
    }
    const names = new Map(others.map((o) => [o.key, o.aliases[0]]));
    void addressedPartsWithDecisions(text, others, decider, (id) => names.get(id) ?? `#${id}`).then(
      (parts) => {
        // Turned off, or the sender left, while the model was reading.
        if (this.enabled && this.store.get(senderId)) this.pass(senderId, from, parts, now);
      },
    );
  }

  private pass(senderId: number, from: string, parts: Map<number, string>, now: number): void {
    for (const [targetId, part] of parts) {
      const pair = `${senderId}>${targetId}`;
      if (this.passes.length >= RELAY_TOTAL_LIMIT) return;
      if (this.passes.filter((p) => p.pair === pair).length >= RELAY_PAIR_LIMIT) continue;
      this.passes.push({ at: now, pair });
      // A silent cut is worse than a short message: the receiver reads a
      // half sentence as the whole one and the sender never learns. Say it.
      const cut = part.length > RELAY_MAX_CHARS;
      const body = cut
        ? `${part.slice(0, RELAY_MAX_CHARS)}\n[The office cut this message here: it was ${part.length} characters, the limit is ${RELAY_MAX_CHARS}. Ask ${from} for the rest, or ask them to put it in a file and send the path.]`
        : part;
      this.deliver(
        targetId,
        `Message from ${from} (teammate, via the office): ${body}\n(To answer, start a paragraph with @${from}.)`,
      );
    }
  }
}
