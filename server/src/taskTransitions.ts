import type {
  DeskBrief,
  DeskHumanAction,
  DeskLogEntry,
  DeskResult,
  DeskSubtask,
  DeskTask,
  DeskWaitingOn,
} from '../../core/src/messages.js';
import {
  TASK_MAX_BRIEFS,
  TASK_MAX_LOG,
  TASK_MAX_LOOK_ATTEMPTS,
  TASK_MAX_SUBTASKS,
} from './constants.js';

/**
 * Every legal move of a task desk card, and nothing else: no files, no
 * timers, no agents. `TaskDesk` decides WHEN a move happens and performs its
 * side effects; this module decides WHETHER it is allowed and what the card
 * looks like afterwards. Each function returns a new card or an error — the
 * input is never mutated.
 *
 *   draft → inbox → looking → brief → ready → working → result → done
 *                       ↑        │ rejected (round + 1)
 *                       └────────┘
 */

export type Transition = { ok: true; task: DeskTask } | { ok: false; error: string };

export interface HumanCall {
  action: DeskHumanAction;
  note?: string;
  /** Replies to the newest brief's questions, by position. */
  answers?: string[];
  /** Replaces the newest brief's subtask list (titles + skip flags). */
  subtasks?: DeskSubtask[];
}

const YOU = 'You';

function logged(
  task: DeskTask,
  kind: DeskLogEntry['kind'],
  who: string,
  text: string,
  at: string,
): DeskLogEntry[] {
  return [...task.log, { at, who, kind, text }].slice(-TASK_MAX_LOG);
}

const fail = (error: string): Transition => ({ ok: false, error });

/** The newest brief with the human's answers and subtask edits folded in. */
function editedBriefs(task: DeskTask, call: HumanCall): DeskBrief[] {
  const current = task.briefs[task.briefs.length - 1];
  if (!current) return task.briefs;
  const questions = current.questions.map((question, index) => {
    const answer = call.answers?.[index];
    return typeof answer === 'string' ? { ...question, a: answer } : question;
  });
  const subtasks = call.subtasks
    ? call.subtasks.slice(0, TASK_MAX_SUBTASKS).map((sub) => ({ ...sub, done: false }))
    : current.subtasks;
  return [...task.briefs.slice(0, -1), { ...current, questions, subtasks }];
}

/** A call made by the human on a card that is waiting for them. */
export function applyHumanCall(task: DeskTask, call: HumanCall, at: string): Transition {
  const note = call.note?.trim() ?? '';
  const withNote = (text: string) => (note ? `${text} ${note}` : text);
  const waitingOnBrief = task.state === 'brief' || task.state === 'ready';

  switch (call.action) {
    case 'publish':
      if (task.state !== 'draft') return fail('Only a draft can be sent to the desk.');
      return { ok: true, task: { ...task, state: 'inbox' } };
    case 'verified':
      if (task.state !== 'brief') return fail('Only a card with a new brief can be verified.');
      return {
        ok: true,
        task: {
          ...task,
          state: 'ready',
          queued: false,
          briefs: editedBriefs(task, call),
          log: logged(task, 'verified', YOU, withNote('Verified.'), at),
        },
      };
    case 'do':
      if (!waitingOnBrief) return fail('Only a card with a brief can be started.');
      if (task.briefs.length === 0) return fail('This card has no brief to build from.');
      // Always queued: the desk starts it at once when an agent is free.
      return {
        ok: true,
        task: {
          ...task,
          state: 'ready',
          queued: true,
          briefs: editedBriefs(task, call),
          log: logged(task, 'verified', YOU, withNote('Do the task.'), at),
        },
      };
    case 'rejected':
      if (!waitingOnBrief) return fail('Only a card with a brief can be rejected.');
      if (!note) return fail('Say what is missing — the next agent only has your reason to go on.');
      return {
        ok: true,
        task: {
          ...task,
          state: 'inbox',
          round: task.round + 1,
          attempts: 0,
          queued: false,
          claimedBy: undefined,
          briefs: editedBriefs(task, call),
          log: logged(task, 'rejected', YOU, `Rejected: ${note}`, at),
        },
      };
    case 'accept':
      if (task.state !== 'result') return fail('Only a finished card can be accepted.');
      return {
        ok: true,
        task: {
          ...task,
          state: 'done',
          log: logged(task, 'verified', YOU, withNote('Accepted.'), at),
        },
      };
    case 'sendBack':
      if (task.state !== 'result') return fail('Only a finished card can be sent back.');
      if (!note) return fail('Say what is wrong so the agent can fix it.');
      return {
        ok: true,
        task: {
          ...task,
          state: 'ready',
          queued: true,
          log: logged(task, 'rejected', YOU, `Sent back: ${note}`, at),
        },
      };
    default:
      return fail('Unknown action.');
  }
}

/**
 * Autopilot starts the build of a brief nobody has to answer: the human's
 * "Do the task", logged as autopilot's so the card says who decided.
 */
export function autopilotBuild(
  task: DeskTask,
  who: string,
  why: string,
  at: string,
  /** Written into the newest brief's unanswered questions (the agent chooses). */
  unanswered?: string,
): Transition {
  if (task.state !== 'brief') return fail('Only a card with a new brief can be started.');
  if (task.briefs.length === 0) return fail('This card has no brief to build from.');
  const briefs = unanswered
    ? task.briefs.map((b, i) =>
        i === task.briefs.length - 1
          ? { ...b, questions: b.questions.map((q) => (q.a.trim() ? q : { ...q, a: unanswered })) }
          : b,
      )
    : task.briefs;
  return {
    ok: true,
    task: {
      ...task,
      state: 'ready',
      queued: true,
      briefs,
      log: logged(task, 'verified', who, why, at),
    },
  };
}

/**
 * Autopilot sends a finished card back (its tests failed or were never run):
 * the human's "Send back", logged as autopilot's.
 */
export function autopilotSendBack(
  task: DeskTask,
  who: string,
  note: string,
  at: string,
): Transition {
  if (task.state !== 'result') return fail('Only a finished card can be sent back.');
  return {
    ok: true,
    task: {
      ...task,
      state: 'ready',
      queued: true,
      log: logged(task, 'rejected', who, `Sent back: ${note}`, at),
    },
  };
}

/** Autopilot filled in who and how works on a card (team, workflow, model). */
export function autopilotRouted(
  task: DeskTask,
  pick: { teamId?: string; workflowId?: string; model?: string },
  who: string,
  text: string,
  at: string,
): Transition {
  if (task.state !== 'inbox') return fail('The card is not in the inbox.');
  return {
    ok: true,
    task: { ...task, ...pick, autoRouted: true, log: logged(task, 'system', who, text, at) },
  };
}

/** A free agent takes an inbox card to look at it. */
export function claimForLook(task: DeskTask, agentId: number): Transition {
  if (task.state !== 'inbox') return fail('The card is not in the inbox.');
  return { ok: true, task: { ...task, state: 'looking', claimedBy: agentId } };
}

/** The looking agent handed in its brief. */
export function briefIn(task: DeskTask, brief: DeskBrief, at: string): Transition {
  if (task.state !== 'looking') return fail('Nobody is looking at this card right now.');
  const briefs = [...task.briefs, brief].slice(-TASK_MAX_BRIEFS);
  return {
    ok: true,
    task: {
      ...task,
      state: 'brief',
      attempts: 0,
      briefs,
      log: logged(
        task,
        'agent',
        brief.by,
        `Looked at the card and wrote brief v${task.round}.`,
        at,
      ),
    },
  };
}

/**
 * The look ended with no brief (turn over, agent gone). Back to the inbox for
 * another agent — until `TASK_MAX_LOOK_ATTEMPTS`, after which the card goes to
 * the human anyway rather than burning turns forever.
 */
export function lookFailed(task: DeskTask, who: string, at: string): Transition {
  if (task.state !== 'looking') return fail('Nobody is looking at this card right now.');
  const attempts = (task.attempts ?? 0) + 1;
  if (attempts < TASK_MAX_LOOK_ATTEMPTS) {
    return {
      ok: true,
      task: {
        ...task,
        state: 'inbox',
        attempts,
        claimedBy: undefined,
        log: logged(task, 'system', who, 'Stopped without writing a brief. Back in the inbox.', at),
      },
    };
  }
  const empty: DeskBrief = {
    by: who,
    understanding: '',
    subtasks: [],
    files: [],
    questions: [],
    risk: '',
    size: '',
    createdAt: at,
  };
  return {
    ok: true,
    task: {
      ...task,
      state: 'brief',
      attempts: 0,
      claimedBy: undefined,
      briefs: [...task.briefs, empty].slice(-TASK_MAX_BRIEFS),
      log: logged(
        task,
        'system',
        who,
        `${attempts} agents stopped without writing a brief. The card may be too vague — reject it with more detail.`,
        at,
      ),
    },
  };
}

/** A free agent starts building a queued card. */
export function startWork(task: DeskTask, agentId: number): Transition {
  if (task.state !== 'ready' || !task.queued) return fail('The card is not waiting to start.');
  const current = task.briefs[task.briefs.length - 1];
  const briefs = current
    ? [
        ...task.briefs.slice(0, -1),
        { ...current, subtasks: current.subtasks.map((sub) => ({ ...sub, done: false })) },
      ]
    : task.briefs;
  return {
    ok: true,
    task: { ...task, state: 'working', queued: false, claimedBy: agentId, briefs },
  };
}

/** The newest brief with its steps replaced. */
function withSteps(task: DeskTask, subtasks: DeskSubtask[]): DeskBrief[] {
  const current = task.briefs[task.briefs.length - 1];
  return current ? [...task.briefs.slice(0, -1), { ...current, subtasks }] : task.briefs;
}

function stepsOf(task: DeskTask): DeskSubtask[] {
  return task.briefs[task.briefs.length - 1]?.subtasks ?? [];
}

/**
 * How many leading steps are fixed while an agent builds the card: the ones
 * it has finished or passed, and the one it is on. The human may change
 * everything after them. Nothing is locked before the build starts.
 */
export function lockedSteps(task: DeskTask): number {
  if (task.state !== 'working') return 0;
  const steps = stepsOf(task);
  let i = 0;
  while (i < steps.length && (steps[i].done || steps[i].skip)) i++;
  return Math.min(steps.length, i + 1);
}

/** Mark step `index` with `change`; pending steps before it count as skipped (out-of-order reports are fine). */
function reachStep(
  steps: DeskSubtask[],
  index: number,
  change: Partial<DeskSubtask>,
): DeskSubtask[] {
  return steps.map((step, i) =>
    i === index
      ? { ...step, ...change }
      : i < index && !step.done && !step.skip
        ? { ...step, skip: true, waiting: undefined }
        : step,
  );
}

function stepIndex(task: DeskTask, position: number): number | null {
  const index = position - 1;
  return Number.isInteger(index) && stepsOf(task)[index] ? index : null;
}

/**
 * The human replaces the card's steps (reorder, retype, change kinds, add,
 * remove). While the brief waits for them anything goes; during the build the
 * locked steps (lockedSteps) must come first, unchanged. `steps` must already
 * be sanitized and carry ids.
 */
export function editSteps(task: DeskTask, steps: DeskSubtask[], at: string): Transition {
  if (task.state !== 'brief' && task.state !== 'ready' && task.state !== 'working') {
    return fail('Steps can be changed while the brief waits for you or while an agent builds.');
  }
  if (task.briefs.length === 0) return fail('This card has no brief to change.');
  if (steps.length > TASK_MAX_SUBTASKS) return fail(`At most ${TASK_MAX_SUBTASKS} steps.`);
  const old = stepsOf(task);
  const locked = lockedSteps(task);
  for (let i = 0; i < locked; i++) {
    if (steps[i]?.id !== old[i].id) {
      return fail('Steps already done, and the one the agent is on, cannot be moved or removed.');
    }
  }
  const oldIds = new Set(old.map((step) => step.id));
  const next = [
    ...old.slice(0, locked),
    ...steps.slice(locked).map((step) => {
      const clean: DeskSubtask = {
        ...step,
        done: false,
        by: step.id && oldIds.has(step.id) ? step.by : 'you',
      };
      delete clean.waiting;
      delete clean.ask;
      return clean;
    }),
  ];
  return {
    ok: true,
    task: {
      ...task,
      briefs: withSteps(task, next),
      log: logged(task, 'system', YOU, 'Changed the steps.', at),
    },
  };
}

/** The building agent finished step `position` (1-based, counting skipped ones). */
export function subtaskDone(task: DeskTask, position: number): Transition {
  if (task.state !== 'working') return fail('Nobody is building this card right now.');
  const index = stepIndex(task, position);
  if (index === null) return fail(`This card has no step ${position}.`);
  const subtasks = reachStep(stepsOf(task), index, { done: true, waiting: undefined });
  return { ok: true, task: { ...task, briefs: withSteps(task, subtasks) } };
}

/** The building agent reached gate step `position`: it waits for the human. */
export function gateOpened(
  task: DeskTask,
  position: number,
  ask: string,
  who: string,
  at: string,
): Transition {
  if (task.state !== 'working') return fail('Nobody is building this card right now.');
  const index = stepIndex(task, position);
  if (index === null) return fail(`This card has no step ${position}.`);
  const step = stepsOf(task)[index];
  if (step.done) return { ok: true, task };
  const subtasks = reachStep(stepsOf(task), index, { waiting: true, ask: ask || undefined });
  return {
    ok: true,
    task: {
      ...task,
      briefs: withSteps(task, subtasks),
      log: logged(
        task,
        'agent',
        who,
        ask
          ? `Waiting at step ${position} for your go-ahead: ${ask}`
          : `Waiting at step ${position} for your go-ahead.`,
        at,
      ),
    },
  };
}

/** The human answered at a gate step the agent is waiting at. */
export function gateAnswered(
  task: DeskTask,
  position: number,
  decision: 'continue' | 'stop',
  note: string,
  at: string,
  who: string = YOU,
): Transition {
  const index = stepIndex(task, position);
  if (index === null) return fail(`This card has no step ${position}.`);
  if (!stepsOf(task)[index].waiting) return fail('Nobody is waiting at that step.');
  const subtasks = stepsOf(task).map((step, i) =>
    i === index
      ? { ...step, waiting: undefined, ask: undefined, done: decision === 'continue' }
      : step,
  );
  const said =
    decision === 'continue' ? `Go ahead at step ${position}.` : `Stop at step ${position}.`;
  return {
    ok: true,
    task: {
      ...task,
      briefs: withSteps(task, subtasks),
      log: logged(
        task,
        decision === 'continue' ? 'verified' : 'rejected',
        who,
        note ? `${said} ${note}` : said,
        at,
      ),
    },
  };
}

/** The building agent reported its result (or its turn simply ended). */
export function workFinished(task: DeskTask, result: DeskResult, at: string): Transition {
  if (task.state !== 'working') return fail('Nobody is building this card right now.');
  return {
    ok: true,
    task: {
      ...task,
      state: 'result',
      claimedBy: undefined,
      result,
      log: logged(task, 'agent', result.by, 'Finished. Waiting for your check.', at),
    },
  };
}

/**
 * The build turn ended without a report, and the agent's last reply reads as
 * a question for the human or as stuck. The card stays with the agent: the
 * human answers in its chat and the build goes on.
 */
export function workWaiting(task: DeskTask, waitingOn: DeskWaitingOn, who: string): Transition {
  if (task.state !== 'working') return fail('Nobody is building this card right now.');
  const said = waitingOn.kind === 'question' ? 'Asks you something.' : 'Says it is stuck.';
  return {
    ok: true,
    task: { ...task, waitingOn, log: logged(task, 'agent', who, said, waitingOn.at) },
  };
}

/** The agent works on the card again: whatever it waited for is settled. */
export function workResumed(task: DeskTask): Transition {
  if (task.state !== 'working' || !task.waitingOn) return fail('The card is not waiting.');
  const resumed = { ...task };
  delete resumed.waitingOn;
  return { ok: true, task: resumed };
}

/** The building agent vanished mid-build: wait for another one. */
export function workAbandoned(task: DeskTask, who: string, at: string): Transition {
  if (task.state !== 'working') return fail('Nobody is building this card right now.');
  return {
    ok: true,
    task: {
      ...task,
      state: 'ready',
      queued: true,
      claimedBy: undefined,
      log: logged(
        task,
        'system',
        who,
        'Left before finishing. Queued for the next free agent.',
        at,
      ),
    },
  };
}
