import { describe, expect, it } from 'vitest';

import type { ModelOption, TeamPreset, Workflow } from '../../core/src/messages.js';
import { suggestForCard } from '../src/cardRouting.js';
import type { Decider, DecisionAnswer, DecisionQuestion } from '../src/decisions.js';

const team = (id: string, title: string): TeamPreset => ({
  id,
  title,
  members: [
    { name: 'lead', role: 'plans', lead: true, instructions: '' },
    { name: 'dev', role: 'writes code', instructions: '' },
  ],
});
const workflow = (id: string, title: string): Workflow => ({
  id,
  title,
  steps: [{ kind: 'do', text: 'write a failing test' }],
});
const models: ModelOption[] = [
  { number: 1, label: 'Opus', detail: 'Most capable for complex work' },
  { number: 2, label: 'Haiku', detail: 'Fastest for quick answers' },
];

/** A decider that answers with a function of the questions it was given, and records them. */
function fake(
  answer: (questions: Record<string, DecisionQuestion>) => Record<string, DecisionAnswer> | null,
) {
  const seen: Array<{
    state: Record<string, string>;
    questions: Record<string, DecisionQuestion>;
  }> = [];
  const decider: Decider = {
    ask: async (state, questions) => {
      seen.push({ state, questions });
      return answer(questions);
    },
  };
  return { decider, seen };
}

const keyFor = (q: DecisionQuestion | undefined, text: string) =>
  q?.type === 'choice'
    ? Object.entries(q.criteria).find(([, d]) => d.includes(text))?.[0]
    : undefined;

describe('suggestForCard', () => {
  it('maps confident picks back to ids and labels', async () => {
    const { decider, seen } = fake((q) => ({
      team: { choice: keyFor(q.team, 'Frontend crew')!, confidence: 0.95 },
      workflow: { choice: keyFor(q.workflow, 'TDD')!, confidence: 0.9 },
      model: { choice: keyFor(q.model, 'Most capable')!, confidence: 0.99 },
    }));
    const pick = await suggestForCard(
      decider,
      { title: 'Redesign the login page', body: 'tests first', kind: 'feature' },
      {
        teams: [team('t-back', 'Backend crew'), team('t-front', 'Frontend crew')],
        workflows: [workflow('w-tdd', 'TDD')],
        models,
      },
    );
    expect(pick).toMatchObject({ teamId: 't-front', workflowId: 'w-tdd', model: 'Opus' });
    expect(seen[0].state.card).toBe('[feature] Redesign the login page');
  });

  it('turns the way-out options into null and drops unsure answers', async () => {
    const { decider } = fake(() => ({
      team: { choice: 'solo', confidence: 0.9 },
      workflow: { choice: 'freeform', confidence: 0.5 },
      model: { choice: 'default', confidence: 0.99 },
    }));
    const pick = await suggestForCard(
      decider,
      { title: 'Fix a typo', body: '' },
      { teams: [team('t1', 'Crew')], workflows: [workflow('w1', 'Flow')], models },
    );
    expect(pick).toEqual({
      teamId: null,
      model: null,
      confidence: { team: 0.9, workflow: 0.5, model: 0.99 },
    });
  });

  it('asks only about what the office has, and nothing when it has nothing', async () => {
    const { decider, seen } = fake(() => ({}));
    await suggestForCard(decider, { title: 'x', body: '' }, { teams: [], workflows: [], models });
    expect(Object.keys(seen[0].questions)).toEqual(['model']);
    expect(
      await suggestForCard(
        decider,
        { title: 'x', body: '' },
        { teams: [], workflows: [], models: [] },
      ),
    ).toBeNull();
  });

  it('never offers yes/no keys (Laya reads those literally) and keeps keys unique', async () => {
    const { decider, seen } = fake(() => ({}));
    await suggestForCard(
      decider,
      { title: 'x', body: '' },
      {
        teams: [team('a', 'Yes'), team('b', 'Solo'), team('c', 'Crew'), team('d', 'Crew')],
        workflows: [],
        models: [],
      },
    );
    const q = seen[0].questions.team;
    const keys = q.type === 'choice' ? Object.keys(q.criteria) : [];
    expect(keys).not.toContain('yes');
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(5);
  });

  it('returns null when the model could not answer', async () => {
    const { decider } = fake(() => null);
    expect(
      await suggestForCard(decider, { title: 'x', body: '' }, { teams: [], workflows: [], models }),
    ).toBeNull();
  });
});
