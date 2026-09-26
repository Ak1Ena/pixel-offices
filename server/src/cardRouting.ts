import type { ModelOption, TeamPreset, Workflow } from '../../core/src/messages.js';
import { CARD_ROUTING_MAX_OPTIONS, CARD_ROUTING_OPTION_MAX_CHARS } from './constants.js';
import { type Decider, type DecisionQuestion, tailOf, thresholdFor } from './decisions.js';

/**
 * "Suggest with Laya" on a desk card: which team preset, which workflow and
 * which model fit the card. Three `choice` questions over what this office
 * actually has, each with a way out (no team / no workflow / keep the
 * default), because Laya always picks SOME option.
 *
 * A suggestion only fills the card editor; the human saves it. An answer
 * below the checkpoint's `card` threshold (DECISION_THRESHOLDS) is dropped.
 */

export interface CardRoutingInput {
  title: string;
  body: string;
  kind?: string;
}

export interface CardRoutingOptions {
  teams: TeamPreset[];
  workflows: Workflow[];
  /** The provider's model picker as last read (ModelCatalog); empty = no model question. */
  models: ModelOption[];
}

export interface CardRoutingPick {
  /** Present when the question was asked: an id, or null for "no team / no workflow / default model". */
  teamId?: string | null;
  workflowId?: string | null;
  /** The picker label, as `startAgent {model}` takes it. */
  model?: string | null;
  /** Calibrated confidence per answered question. */
  confidence: { team?: number; workflow?: number; model?: number };
}

const NONE_TEAM = 'solo';
const NONE_WORKFLOW = 'freeform';
const NONE_MODEL = 'default';

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= CARD_ROUTING_OPTION_MAX_CHARS
    ? flat
    : `${flat.slice(0, CARD_ROUTING_OPTION_MAX_CHARS - 1)}…`;
}

/**
 * Option keys Laya can read: a slug of the name, made unique, never one of
 * the words Laya takes literally (yes/no/true/false) or our "none" keys.
 */
function keysFor<T>(items: T[], name: (item: T) => string, reserved: string): Map<string, T> {
  const out = new Map<string, T>();
  const taken = new Set([reserved, 'yes', 'no', 'true', 'false']);
  items.slice(0, CARD_ROUTING_MAX_OPTIONS).forEach((item, i) => {
    let key =
      name(item)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || `option-${i + 1}`;
    if (taken.has(key)) key = `${key}-${i + 1}`;
    taken.add(key);
    out.set(key, item);
  });
  return out;
}

function teamText(team: TeamPreset): string {
  const roles = team.members.map((m) => `${m.name} (${m.role})`).join(', ');
  return clip(
    `${team.title}${team.description ? ` — ${team.description}` : ''}. Members: ${roles}`,
  );
}

function workflowText(workflow: Workflow): string {
  const steps = workflow.steps.map((s, i) => `${i + 1}. ${s.text}`).join(' ');
  return clip(`${workflow.title}: ${steps}`);
}

function modelText(option: ModelOption): string {
  return clip(option.detail ? `${option.label} — ${option.detail}` : option.label);
}

/** Ask Laya which team, workflow and model fit the card. Null = no model to ask, or it could not answer. */
export async function suggestForCard(
  decider: Decider,
  card: CardRoutingInput,
  options: CardRoutingOptions,
): Promise<CardRoutingPick | null> {
  const teams = keysFor(options.teams, (t) => t.title, NONE_TEAM);
  const workflows = keysFor(options.workflows, (w) => w.title, NONE_WORKFLOW);
  const models = keysFor(options.models, (m) => m.label, NONE_MODEL);

  const questions: Record<string, DecisionQuestion> = {};
  if (teams.size > 0) {
    questions.team = {
      type: 'choice',
      instructions: 'Which team of coding agents should take this card?',
      criteria: {
        [NONE_TEAM]: 'one agent alone is enough; the card is small or focused',
        ...Object.fromEntries([...teams].map(([k, t]) => [k, teamText(t)])),
      },
    };
  }
  if (workflows.size > 0) {
    questions.workflow = {
      type: 'choice',
      instructions: 'Which saved workflow should the agent follow for this card?',
      criteria: {
        [NONE_WORKFLOW]: 'none of these workflows fits the card',
        ...Object.fromEntries([...workflows].map(([k, w]) => [k, workflowText(w)])),
      },
    };
  }
  if (models.size > 0) {
    questions.model = {
      type: 'choice',
      instructions:
        'Which AI model fits this card? Hard, broad or risky work needs the most capable model; small routine edits a fast one.',
      criteria: {
        [NONE_MODEL]: 'no preference; keep the usual model',
        ...Object.fromEntries([...models].map(([k, m]) => [k, modelText(m)])),
      },
    };
  }
  if (Object.keys(questions).length === 0) return null;

  const answers = await decider.ask(
    {
      card: clip(`${card.kind ? `[${card.kind}] ` : ''}${card.title}`),
      details: tailOf(card.body),
    },
    questions,
  );
  if (!answers) return null;

  const pick: CardRoutingPick = { confidence: {} };
  const read = <T>(
    question: 'team' | 'workflow' | 'model',
    map: Map<string, T>,
    none: string,
    value: (item: T) => string,
  ): string | null | undefined => {
    const a = answers[question];
    if (!questions[question] || !a || typeof a.choice !== 'string') return undefined;
    const confidence = a.confidence ?? 0;
    pick.confidence[question] = confidence;
    if (confidence < thresholdFor(a, 'card')) return undefined;
    if (a.choice === none) return null;
    const item = map.get(a.choice);
    return item === undefined ? undefined : value(item);
  };
  const team = read('team', teams, NONE_TEAM, (t) => t.id);
  const workflow = read('workflow', workflows, NONE_WORKFLOW, (w) => w.id);
  const model = read('model', models, NONE_MODEL, (m) => m.label);
  if (team !== undefined) pick.teamId = team;
  if (workflow !== undefined) pick.workflowId = workflow;
  if (model !== undefined) pick.model = model;
  return pick;
}
