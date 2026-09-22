import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamPreset } from '../../core/src/messages.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { draftTeam, draftWorkflow, extractJson } from '../src/aiDraft.js';
import { fillGoal, firstMessage, leadOf, sanitizeTeam } from '../src/teamFile.js';
import type { AgentStarter } from '../src/teamRuns.js';
import { TeamRuns } from '../src/teamRuns.js';

const TEAM: TeamPreset = {
  id: 'feature-squad',
  title: 'Feature squad',
  goalTemplate: 'Build this feature: {goal}. Tell me when it is ready.',
  relay: true,
  members: [
    { name: 'backend', role: 'Backend', instructions: 'API routes.', command: '' },
    {
      name: 'lead',
      role: 'Lead',
      lead: true,
      instructions: 'Plan and split.',
      command: 'claude --model claude-opus-5',
      workflowId: 'new-endpoint',
    },
  ],
};

describe('team presets', () => {
  it('cleans names, keeps one lead and drops bad workflow ids', () => {
    const t = sanitizeTeam({
      title: ' T ',
      members: [
        { name: 'a b', role: 'x', lead: true, instructions: '' },
        { name: 'A-B', role: 'y', lead: true, instructions: '', workflowId: 'Bad Id' },
      ],
    });
    expect(t?.members.map((m) => m.name)).toEqual(['a-b', 'A-B-2']);
    expect(t?.members.filter((m) => m.lead)).toHaveLength(1);
    expect(t?.members[1].workflowId).toBeUndefined();
    expect(sanitizeTeam({ title: 'T', members: [] })).toBeNull();
  });

  it('fills the goal into the lead’s message; members wait for the lead', () => {
    expect(fillGoal('Do {goal} now', 'X')).toBe('Do X now');
    expect(fillGoal('', 'X')).toBe('X');
    const lead = leadOf(TEAM);
    expect(lead.name).toBe('lead');
    const toLead = firstMessage(TEAM, lead, 'PDF export');
    expect(toLead).toContain('Build this feature: PDF export.');
    expect(toLead).toContain('@backend (Backend)');
    const toBackend = firstMessage(TEAM, TEAM.members[0], 'PDF export');
    expect(toBackend).toContain('led by @lead');
    expect(toBackend).not.toContain('PDF export');
    expect(toLead).toContain('not running yet');
    const called = firstMessage(TEAM, TEAM.members[0], 'PDF export', '@backend add GET /pdf');
    expect(called).toContain('@lead called you in: @backend add GET /pdf');
    expect(called).not.toContain('Wait for instructions');
  });
});

describe('starting a team', () => {
  let store: AgentStateStore;
  let started: Array<{ name?: string; firstMessage?: string }>;
  let agentIds: Map<string, number>;
  let attached: Array<[number, string, string]>;
  let relay: boolean[];
  let crews: TeamRuns;
  const starter: AgentStarter = {
    start: (req) => {
      started.push(req);
      return { ok: true, sessionId: `s-${req.name}` };
    },
    agentIdFor: (sessionId) => agentIds.get(sessionId),
    stopSession: () => true,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    store = new AgentStateStore();
    started = [];
    agentIds = new Map();
    attached = [];
    relay = [];
    crews = new TeamRuns(store, () => starter, {
      workflowIntro: (w) => ({ runId: 'w1', text: `Follow ${w} (run w1)` }),
      attachWorkflow: (id, w, runId) => attached.push([id, w, runId]),
      setRelay: (on) => relay.push(on),
    });
  });
  afterEach(() => {
    crews.dispose();
    vi.useRealTimers();
  });

  it('starts only the lead, with its workflow in the first prompt', () => {
    const result = crews.start(TEAM, '/repo', 'PDF export');
    expect(result.ok).toBe(true);
    expect(started.map((s) => s.name)).toEqual(['lead']);
    expect(relay).toEqual([true]);
    // The workflow is in the first prompt, not typed after the first turn.
    expect(started[0].firstMessage).toContain('Follow new-endpoint (run w1)');
    agentIds.set('s-lead', 7);
    vi.advanceTimersByTime(1_100);
    expect(attached).toEqual([[7, 'new-endpoint', 'w1']]);
    const members = crews.snapshot().runs[0].members;
    expect(members[0]).toMatchObject({ name: 'lead', agentId: 7, lead: true });
    expect(members[1]).toMatchObject({ name: 'backend', benched: true });
  });

  it('starts a benched teammate when the lead calls it by @name, once', () => {
    crews.start(TEAM, '/repo', 'PDF export');
    agentIds.set('s-lead', 7);
    vi.advanceTimersByTime(1_100);
    crews.onReply(7, 'I will do the UI myself; @backend can wait.');
    crews.onReply(8, '@backend from a stranger');
    expect(started.map((s) => s.name)).toEqual(['lead']);
    crews.onReply(7, '@backend add GET /api/pdf returning the file.\n\nUser: all good?');
    expect(started.map((s) => s.name)).toEqual(['lead', 'backend']);
    expect(started[1].firstMessage).toContain('@lead called you in: @backend add GET /api/pdf');
    crews.onReply(7, '@backend also add tests');
    expect(started).toHaveLength(2);
    agentIds.set('s-backend', 8);
    vi.advanceTimersByTime(1_100);
    expect(crews.snapshot().runs[0].members[1]).toMatchObject({ agentId: 8 });
    expect(crews.snapshot().runs[0].members[1].benched).toBeUndefined();
  });

  it('refuses without a goal or without a way to start agents', () => {
    expect(crews.start(TEAM, '/repo', '  ').ok).toBe(false);
    const none = new TeamRuns(store, () => undefined, {
      workflowIntro: () => undefined,
      attachWorkflow: () => {},
      setRelay: () => {},
    });
    expect(none.start(TEAM, '/repo', 'x').ok).toBe(false);
    none.dispose();
  });
});

describe('AI drafts', () => {
  it('finds the JSON in a reply, fenced or bare', () => {
    expect(extractJson('Here:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('sure {"a":2} done')).toEqual({ a: 2 });
    expect(() => extractJson('no json here')).toThrow();
  });

  it('turns a drafted team into a clean preset, keeping only workflows it brought', async () => {
    const fake = async () =>
      JSON.stringify({
        team: {
          title: 'Screenshot to page',
          members: [
            {
              name: 'lead',
              role: 'Lead',
              lead: true,
              instructions: 'Split it',
              workflowId: 'draft-1',
            },
            { name: 'builder', role: 'Builder', instructions: 'Build', workflowId: 'draft-9' },
          ],
        },
        workflows: [
          { id: 'draft-1', title: 'Flow', steps: [{ kind: 'gate', text: 'OK to merge?' }] },
        ],
        note: 'Made a team',
      });
    const d = await draftTeam({ description: 'x' }, fake);
    expect(d.team.id).toBe('');
    expect(d.team.members[0].workflowId).toBe('draft-1');
    expect(d.team.members[1].workflowId).toBeUndefined();
    expect(d.workflows.map((w) => w.id)).toEqual(['draft-1']);
    expect(d.note).toBe('Made a team');
  });

  it('marks the steps a drafted workflow guessed', async () => {
    const fake = async () =>
      '{"workflow":{"title":"Hotfix","steps":[{"kind":"do","text":"a"},{"kind":"do","text":"b"}]},"unsure":[2,9]}';
    const d = await draftWorkflow({ description: 'x' }, fake);
    expect(d.workflow.title).toBe('Hotfix');
    expect(d.unsure).toEqual([2]);
  });
});
