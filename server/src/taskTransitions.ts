import type {
  DeskBrief,
  DeskHumanAction,
  DeskLogEntry,
  DeskResult,
  DeskSubtask,
  DeskTask,
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
 *   inbox → looking → brief → ready → working → result → done
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

/** The building agent ticked one of its subtasks (1-based, counting skipped ones). */
export function subtaskDone(task: DeskTask, position: number): Transition {
  if (task.state !== 'working') return fail('Nobody is building this card right now.');
  const current = task.briefs[task.briefs.length - 1];
  const index = position - 1;
  if (!current || !Number.isInteger(index) || !current.subtasks[index]) {
    return fail(`This card has no subtask ${position}.`);
  }
  const subtasks = current.subtasks.map((sub, i) => (i === index ? { ...sub, done: true } : sub));
  return {
    ok: true,
    task: { ...task, briefs: [...task.briefs.slice(0, -1), { ...current, subtasks }] },
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
