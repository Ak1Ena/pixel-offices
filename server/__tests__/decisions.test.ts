import { afterEach, describe, expect, it, vi } from 'vitest';

import { addressedPartsWithDecisions } from '../src/addressedDecisions.js';
import { addressedParts } from '../src/addressedParts.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  DECISION_THRESHOLDS,
  TEXT_IDLE_CONTINUING_DELAY_MS,
  TEXT_IDLE_DELAY_MS,
} from '../src/constants.js';
import {
  confidentChoice,
  confidentYes,
  type Decider,
  decisionsConfig,
  parseDecisionsConfig,
  SystemOneClient,
  tailOf,
} from '../src/decisions.js';
import { MentionRelay } from '../src/mentionRelay.js';
import { judgeTextReply, setTextIdleDecider } from '../src/textIdleJudge.js';
import { startWaitingTimer } from '../src/timerManager.js';
import type { AgentState } from '../src/types.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('SystemOneClient', () => {
  it('posts state + questions to <url>/v1/systemone with the key, and returns the answers', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(
        JSON.stringify({
          answers: { ending: { choice: 'question', confidence: 0.9, probabilities: {} } },
          usage: { input_tokens: 12, output_tokens: 0 },
        }),
      );
    }) as unknown as typeof fetch;
    const client = new SystemOneClient({ url: 'http://127.0.0.1:8000/', apiKey: 'k' }, fetchImpl);
    const answers = await client.ask(
      { reply: 'hi' },
      { ending: { type: 'noul', instructions: 'q' } },
    );
    expect(answers).toEqual({ ending: { choice: 'question', confidence: 0.9 } });
    expect(calls[0][0]).toBe('http://127.0.0.1:8000/v1/systemone');
    expect((calls[0][1].headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(JSON.parse(String(calls[0][1].body))).toEqual({
      state: { reply: 'hi' },
      questions: { ending: { type: 'noul', instructions: 'q' } },
    });
  });

  it('returns null (never throws) on HTTP errors, junk replies and network failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const replies = [
      async () => new Response('nope', { status: 500 }),
      async () => new Response('{"other":1}'),
      async () => {
        throw new Error('ECONNREFUSED');
      },
    ];
    for (const reply of replies) {
      const client = new SystemOneClient({ url: 'http://x' }, reply as unknown as typeof fetch);
      expect(await client.ask({}, {})).toBeNull();
    }
    warn.mockRestore();
  });
});

describe('SystemOneClient model tag', () => {
  it('tags each answer with the checkpoint that answered', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ model: 'english', answers: { q: { choice: 'a', confidence: 0.4 } } }),
      )) as unknown as typeof fetch;
    const client = new SystemOneClient({ url: 'http://x' }, fetchImpl);
    const answers = await client.ask({}, { q: { type: 'noul', instructions: 'q' } });
    expect(answers?.q).toEqual({ choice: 'a', confidence: 0.4, model: 'english' });
  });
});

describe('confidence gates', () => {
  it('an unknown server (no model named) uses a choice only at or above 0.85', () => {
    expect(confidentChoice({ choice: 'a', confidence: 0.85 }, 'ending')).toBe('a');
    expect(confidentChoice({ choice: 'a', confidence: 0.84 }, 'ending')).toBeUndefined();
    expect(confidentChoice({ choice: 'a' }, 'ending')).toBeUndefined();
    expect(confidentChoice(undefined, 'ending')).toBeUndefined();
  });

  it('a known Laya checkpoint uses its calibrated threshold for that kind of question', () => {
    const t = DECISION_THRESHOLDS.english.ending;
    expect(confidentChoice({ choice: 'a', confidence: t, model: 'english' }, 'ending')).toBe('a');
    expect(
      confidentChoice({ choice: 'a', confidence: t - 0.01, model: 'english' }, 'ending'),
    ).toBeUndefined();
    // multilingual yes/no answers are never used.
    expect(confidentYes({ noul: 1, model: 'multilingual' }, 'addressed')).toBeUndefined();
    expect(confidentYes({ noul: 0.95, model: 'english' }, 'addressed')).toBe(true);
  });

  it('reads a yes/no only when it is clearly one side', () => {
    expect(confidentYes({ noul: 0.9 }, 'addressed')).toBe(true);
    expect(confidentYes({ noul: 0.1 }, 'addressed')).toBe(false);
    expect(confidentYes({ noul: 0.5 }, 'addressed')).toBeUndefined();
    expect(confidentYes({}, 'addressed')).toBeUndefined();
  });

  it('keeps the END of long text, where the question usually is', () => {
    expect(tailOf('abcdef', 3)).toBe('…def');
    expect(tailOf('abc', 3)).toBe('abc');
  });
});

describe('config', () => {
  afterEach(() => {
    delete process.env.PIXEL_AGENTS_DECISIONS_URL;
    delete process.env.PIXEL_AGENTS_DECISIONS_KEY;
  });

  it('accepts only an http(s) url from config.json', () => {
    expect(parseDecisionsConfig({ url: 'http://127.0.0.1:8000', apiKey: ' k ' })).toEqual({
      url: 'http://127.0.0.1:8000',
      apiKey: 'k',
    });
    expect(parseDecisionsConfig({ url: 'file:///etc/passwd' })).toBeUndefined();
    expect(parseDecisionsConfig('http://x')).toBeUndefined();
  });

  it('is off with nothing configured, and the environment wins over the file', () => {
    expect(decisionsConfig(undefined)).toBeNull();
    process.env.PIXEL_AGENTS_DECISIONS_URL = 'http://env:1';
    expect(decisionsConfig({ url: 'http://file:2', apiKey: 'f' })).toEqual({
      url: 'http://env:1',
      apiKey: 'f',
    });
  });
});

/** Says yes to every question about a paragraph containing `word`, no otherwise. */
function yesWhen(word: string): Decider & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ask: async (state, questions) => {
      asked.push(state.paragraph);
      const yes = state.paragraph.includes(word);
      return Object.fromEntries(
        Object.keys(questions).map((k) => [k, { noul: yes ? 0.95 : 0.05 }]),
      );
    },
  };
}

const SCOUT = [{ key: 'scout', aliases: ['scout'] }];

describe('addressedPartsWithDecisions', () => {
  it('addresses a mid-sentence mention the model reads as a request', async () => {
    const text = 'Can you check the API rate limits before I touch the client, @scout?';
    expect(addressedParts(text, SCOUT).size).toBe(0);
    const parts = await addressedPartsWithDecisions(text, SCOUT, yesWhen('check'), String);
    expect(parts.get('scout')).toBe(text);
  });

  it('leaves a passing mention alone when the model says no, and never asks about opened ones', async () => {
    const decider = yesWhen('check');
    const text = "@scout — look at the logs.\n\nOnce the tests pass I'll ask @scout to review.";
    const parts = await addressedPartsWithDecisions(text, SCOUT, decider, String);
    expect(parts.get('scout')).toBe('@scout — look at the logs.');
    expect(decider.asked).toEqual(["Once the tests pass I'll ask @scout to review."]);
  });

  it('is the rule alone without a model, or when the model fails', async () => {
    const text = 'Could you run the tests, @scout?';
    expect((await addressedPartsWithDecisions(text, SCOUT, null, String)).size).toBe(0);
    const failing: Decider = { ask: async () => null };
    expect((await addressedPartsWithDecisions(text, SCOUT, failing, String)).size).toBe(0);
  });

  it('asks about a bare name (no @), and never matches it inside another word', async () => {
    const decider = yesWhen('check');
    const text =
      'Scout, can you check the limits?\n\nThe scouting report and @scouts are unrelated.';
    const parts = await addressedPartsWithDecisions(text, SCOUT, decider, String);
    expect(parts.get('scout')).toBe('Scout, can you check the limits?');
    expect(decider.asked).toEqual(['Scout, can you check the limits?']);
  });

  it('never matches a bare name shorter than three letters', async () => {
    const decider = yesWhen('check');
    await addressedPartsWithDecisions(
      'qa, check this',
      [{ key: 'qa', aliases: ['qa'] }],
      decider,
      String,
    );
    expect(decider.asked).toEqual([]);
  });

  it('keeps a list that follows an addressed paragraph with it, like the rule does', async () => {
    const text = 'Can you check these for me, @scout:\n\n- a.ts\n- b.ts';
    const parts = await addressedPartsWithDecisions(text, SCOUT, yesWhen('check'), String);
    expect(parts.get('scout')).toBe(text);
  });
});

describe('MentionRelay with a decision model', () => {
  it('passes a mid-sentence request on once the model answers', async () => {
    const store = new AgentStateStore();
    store.set(1, { id: 1, displayName: 'lead' } as unknown as AgentState);
    store.set(2, { id: 2, displayName: 'scout' } as unknown as AgentState);
    const delivered: Array<[number, string]> = [];
    const relay = new MentionRelay(
      store,
      (id, text) => void delivered.push([id, text]),
      () => yesWhen('check'),
    );
    relay.enabled = true;
    relay.onReply(1, 'Can you check the limits, @scout?');
    expect(delivered).toHaveLength(0);
    await settle();
    expect(delivered).toHaveLength(1);
    expect(delivered[0][0]).toBe(2);
    expect(delivered[0][1]).toContain('Can you check the limits, @scout?');
  });
});

describe('judgeTextReply (hooks-off text-only turn end)', () => {
  afterEach(() => {
    setTextIdleDecider(() => null);
    vi.useRealTimers();
  });

  function setupTimer(choice: string, confidence = 0.95) {
    vi.useFakeTimers();
    const store = new AgentStateStore();
    store.set(1, { id: 1, isWaiting: false } as unknown as AgentState);
    const statuses: string[] = [];
    store.on('broadcast', (m: Record<string, unknown>) => {
      if (m.type === 'agentStatus') statuses.push(String(m.status));
    });
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    setTextIdleDecider(() => ({ ask: async () => ({ reply: { choice, confidence } }) }));
    startWaitingTimer(1, TEXT_IDLE_DELAY_MS, store, timers);
    return { store, statuses, timers };
  }

  it('"finished" idles at once instead of after the silence timer', async () => {
    const { store, statuses, timers } = setupTimer('finished');
    judgeTextReply(1, 'Yes, that constant is only used with hooks off.', store, timers);
    await vi.advanceTimersByTimeAsync(10);
    expect(statuses).toEqual(['waiting']);
  });

  it('"continuing" holds the idle for the longer delay', async () => {
    const { store, statuses, timers } = setupTimer('continuing');
    judgeTextReply(1, 'Let me look at the watcher first.', store, timers);
    await vi.advanceTimersByTimeAsync(TEXT_IDLE_DELAY_MS + 100);
    expect(statuses).toEqual([]);
    await vi.advanceTimersByTimeAsync(TEXT_IDLE_CONTINUING_DELAY_MS);
    expect(statuses).toEqual(['waiting']);
  });

  it('an unsure answer leaves the silence timer alone', async () => {
    const unsure = setupTimer('finished', 0.5);
    judgeTextReply(1, 'Hmm.', unsure.store, unsure.timers);
    await vi.advanceTimersByTimeAsync(10);
    expect(unsure.statuses).toEqual([]);
    await vi.advanceTimersByTimeAsync(TEXT_IDLE_DELAY_MS);
    expect(unsure.statuses).toEqual(['waiting']);
  });
});
