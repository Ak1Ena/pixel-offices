import { describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { RELAY_PAIR_LIMIT } from '../src/constants.js';
import { mentionedAgents, MentionRelay } from '../src/mentionRelay.js';
import type { AgentState } from '../src/types.js';

function setup() {
  const store = new AgentStateStore();
  const add = (id: number, displayName?: string) =>
    store.set(id, { id, displayName } as unknown as AgentState);
  add(1, 'Backend Bob');
  add(2, 'Pat');
  add(3, 'Patrick');
  add(4);
  const sent: Array<[number, string]> = [];
  const relay = new MentionRelay(store, (id, text) => sent.push([id, text]));
  return { store, relay, sent };
}

describe('agent-to-agent mentions', () => {
  it('matches whole names only, never the sender', () => {
    const { store } = setup();
    expect(mentionedAgents('@pat amounts are in cents', 1, store)).toEqual([2]);
    expect(mentionedAgents('@Patrick and @Backend Bob, see this', 1, store)).toEqual([3]);
    expect(mentionedAgents('no mention here', 1, store)).toEqual([]);
  });

  it('takes a spaced name written as one word', () => {
    const { store } = setup();
    expect(mentionedAgents('@backend-bob see this', 2, store)).toEqual([1]);
  });

  it('reaches unnamed agents by the label the office shows', () => {
    const { store } = setup();
    store.set(5, { id: 5, folderName: 'api' } as unknown as AgentState);
    expect(mentionedAgents('@Agent #4 please check', 1, store)).toEqual([4]);
    expect(mentionedAgents('@agent4 please check', 1, store)).toEqual([4]);
    expect(mentionedAgents('@api #5 ping', 1, store)).toEqual([5]);
    expect(mentionedAgents('@Agent #41 is not agent 4', 1, store)).toEqual([]);
  });

  it('is off by default and says who the message is from when on', () => {
    const { relay, sent } = setup();
    relay.onReply(1, '@Pat use amount_cents');
    expect(sent).toEqual([]);
    relay.setEnabled(true);
    relay.onReply(1, '@Pat use amount_cents');
    expect(sent).toEqual([
      [
        2,
        'Message from Backend Bob (teammate, via the office): @Pat use amount_cents\n(To answer, write @Backend Bob in your reply.)',
      ],
    ]);
  });

  it('stops a back-and-forth at the per-pair limit', () => {
    const { relay, sent } = setup();
    relay.setEnabled(true);
    for (let i = 0; i < RELAY_PAIR_LIMIT + 3; i++) relay.onReply(1, '@Pat again');
    expect(sent).toHaveLength(RELAY_PAIR_LIMIT);
  });
});
