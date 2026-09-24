import { describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { RELAY_MAX_CHARS, RELAY_PAIR_LIMIT } from '../src/constants.js';
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
        'Message from Backend Bob (teammate, via the office): @Pat use amount_cents\n(To answer, start a paragraph with @Backend Bob.)',
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

describe('relay sends one conversation per pair', () => {
  it('passes each agent only its part', () => {
    const { relay, sent } = setup();
    relay.setEnabled(true);
    relay.onReply(
      1,
      '@Pat use cents.\n\nUser: shall I go on? @Patrick is idle.\n\n@Patrick write tests.',
    );
    expect(sent.map(([id, text]) => [id, text.split('\n')[0]])).toEqual([
      [2, 'Message from Backend Bob (teammate, via the office): @Pat use cents.'],
      [3, 'Message from Backend Bob (teammate, via the office): @Patrick write tests.'],
    ]);
  });
});

describe('an over-long pass is cut out loud, never silently', () => {
  it('says it cut, how long the message was, and how to get the rest', () => {
    const { relay, sent } = setup();
    relay.setEnabled(true);
    const long = 'x'.repeat(RELAY_MAX_CHARS + 500);
    relay.onReply(1, `@Pat ${long}`);
    const [[, text]] = sent;
    expect(text).toContain('The office cut this message here');
    expect(text).toContain(`the limit is ${RELAY_MAX_CHARS}`);
    // The sender is named, so the receiver knows who to ask for the rest.
    expect(text).toContain('Ask Backend Bob for the rest');
    // The cut notice must survive: it comes after the body, not before it.
    expect(text.indexOf('The office cut this message here')).toBeGreaterThan(RELAY_MAX_CHARS);
  });

  it('leaves a message inside the limit untouched — no notice, no ellipsis', () => {
    const { relay, sent } = setup();
    relay.setEnabled(true);
    relay.onReply(1, '@Pat a short hand-off');
    const [[, text]] = sent;
    expect(text).not.toContain('The office cut this message here');
    expect(text).toContain('@Pat a short hand-off');
  });
});
