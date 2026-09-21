import type { DeskAgent, DeskTask, DeskTaskState } from '../../core/src/messages.js';

/**
 * Pure helpers for the task desk panel (no DOM, no transport) — what the
 * panel shows is decided here so it can be tested in the Node runner. The
 * RULES of the desk live on the server; nothing here decides what is allowed.
 */

/** Cards waiting on the human: a brief to judge or a result to check. */
export function needsYou(task: DeskTask): boolean {
  return task.state === 'brief' || task.state === 'result';
}

export const STATE_LABEL: Record<DeskTaskState, string> = {
  inbox: 'Inbox',
  looking: 'Agent looking',
  brief: 'Brief ready',
  ready: 'Ready',
  working: 'Working',
  result: 'Result to check',
  done: 'Done',
};

const FLIGHT_ORDER: DeskTaskState[] = ['working', 'looking', 'ready', 'inbox'];

export interface DeskSections {
  needsYou: DeskTask[];
  inFlight: DeskTask[];
  done: DeskTask[];
}

const byUrgency = (a: DeskTask, b: DeskTask) =>
  a.priority === b.priority ? a.num - b.num : a.priority === 'p1' ? -1 : 1;

/** The panel's three lists: yours first, then what agents are on, then history (newest first). */
export function deskSections(tasks: DeskTask[]): DeskSections {
  return {
    needsYou: tasks.filter(needsYou).sort(byUrgency),
    inFlight: tasks
      .filter((t) => FLIGHT_ORDER.includes(t.state))
      .sort(
        (a, b) => FLIGHT_ORDER.indexOf(a.state) - FLIGHT_ORDER.indexOf(b.state) || byUrgency(a, b),
      ),
    done: tasks.filter((t) => t.state === 'done').sort((a, b) => b.num - a.num),
  };
}

/** Same folder, the way the server compares roots (trailing separators, case on macOS/Windows paths). */
export function sameRoot(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/[\\/]+$/, '');
  return norm(a) === norm(b) || norm(a).toLowerCase() === norm(b).toLowerCase();
}

export function agentsInFolder(task: DeskTask, agents: DeskAgent[]): DeskAgent[] {
  return agents.filter((a) => sameRoot(a.root, task.folder.root));
}

/** Whether `agent` could be handed `task` (ignoring whether it is busy right now). */
export function mayTake(task: DeskTask, agent: DeskAgent): boolean {
  return (
    sameRoot(agent.root, task.folder.root) &&
    agent.pickup &&
    agent.canReach &&
    (task.allow.length === 0 || task.allow.includes(agent.id))
  );
}

/**
 * Why a waiting card is not moving, in the human's words; null when an agent
 * can take it (or it isn't waiting for one).
 */
export function stuckReason(task: DeskTask, agents: DeskAgent[]): string | null {
  const waiting = task.state === 'inbox' || (task.state === 'ready' && task.queued === true);
  if (!waiting) return null;
  const here = agentsInFolder(task, agents);
  if (here.length === 0) return `No agent is working in ${task.folder.name}.`;
  if (here.some((a) => mayTake(task, a))) return null;
  const allowed = here.filter((a) => task.allow.length === 0 || task.allow.includes(a.id));
  if (allowed.length === 0) return 'Nobody is allowed to take it.';
  if (allowed.every((a) => !a.canReach)) {
    return 'The office cannot type into the agents in this folder.';
  }
  return 'Agents in this folder have pick-up switched off.';
}

/** "3/5" for the newest brief's subtasks, skipped ones left out; null when there are none. */
export function subtaskProgress(task: DeskTask): string | null {
  const live = task.briefs[task.briefs.length - 1]?.subtasks.filter((s) => !s.skip) ?? [];
  return live.length === 0 ? null : `${live.filter((s) => s.done).length}/${live.length}`;
}

/** A branch the agent is on that differs from the one the card was made on. */
export function branchMismatch(task: DeskTask, agent: DeskAgent): boolean {
  return !!task.folder.branch && !!agent.branch && task.folder.branch !== agent.branch;
}
