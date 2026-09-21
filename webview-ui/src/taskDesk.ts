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
  draft: 'Draft',
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
  /** Cards the human is still writing. No agent sees them. */
  drafts: DeskTask[];
  needsYou: DeskTask[];
  inFlight: DeskTask[];
  done: DeskTask[];
}

const byUrgency = (a: DeskTask, b: DeskTask) =>
  a.priority === b.priority ? a.num - b.num : a.priority === 'p1' ? -1 : 1;

/** The panel's three lists: yours first, then what agents are on, then history (newest first). */
export function deskSections(tasks: DeskTask[]): DeskSections {
  return {
    drafts: tasks.filter((t) => t.state === 'draft').sort(byUrgency),
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

// ── Filtering ────────────────────────────────────────────────

export interface DeskFilter {
  /** Matched against the title, details, `#number`, folder name and the newest brief. */
  text: string;
  kind: DeskTask['kind'] | 'all';
  /** A card folder's root, or 'all'. */
  folder: string;
  priority: DeskTask['priority'] | 'all';
  /** An agent id: cards it is looking at, building, or wrote the newest brief for. */
  agent: number | 'all';
}

export const NO_FILTER: DeskFilter = {
  text: '',
  kind: 'all',
  folder: 'all',
  priority: 'all',
  agent: 'all',
};

export function isFiltering(filter: DeskFilter): boolean {
  return (
    filter.text.trim() !== '' ||
    filter.kind !== 'all' ||
    filter.folder !== 'all' ||
    filter.priority !== 'all' ||
    filter.agent !== 'all'
  );
}

export function filterCards(tasks: DeskTask[], filter: DeskFilter): DeskTask[] {
  const words = filter.text.toLowerCase().split(/\s+/).filter(Boolean);
  return tasks.filter((task) => {
    if (filter.kind !== 'all' && task.kind !== filter.kind) return false;
    if (filter.priority !== 'all' && task.priority !== filter.priority) return false;
    if (filter.folder !== 'all' && !sameRoot(task.folder.root, filter.folder)) return false;
    if (filter.agent !== 'all' && task.claimedBy !== filter.agent) return false;
    if (words.length === 0) return true;
    const brief = task.briefs[task.briefs.length - 1];
    const haystack = [
      `#${task.num}`,
      task.title,
      task.body,
      task.folder.name,
      brief?.understanding ?? '',
      ...(brief?.subtasks.map((s) => s.title) ?? []),
    ]
      .join('\n')
      .toLowerCase();
    // Every word must appear somewhere: "relay p1" narrows, it doesn't widen.
    return words.every((word) => haystack.includes(word));
  });
}

/** The folders cards are in, one entry per root, for the filter's folder list. */
export function cardFolders(tasks: DeskTask[]): Array<{ root: string; name: string }> {
  const seen: Array<{ root: string; name: string }> = [];
  for (const task of tasks) {
    if (!seen.some((f) => sameRoot(f.root, task.folder.root))) {
      seen.push({ root: task.folder.root, name: task.folder.name });
    }
  }
  return seen.sort((a, b) => a.name.localeCompare(b.name));
}

// ── The full board ───────────────────────────────────────────

export interface DeskColumn {
  key: 'draft' | 'inbox' | 'looking' | 'you' | 'ready' | 'working' | 'done';
  title: string;
  hint: string;
  /** The human's column: briefs to judge and results to check. */
  yours: boolean;
  tasks: DeskTask[];
}

/** Every card, by where it stands. One column is the human's; the rest belong to agents. */
export function deskColumns(tasks: DeskTask[]): DeskColumn[] {
  const pick = (states: DeskTaskState[]) =>
    tasks.filter((t) => states.includes(t.state)).sort(byUrgency);
  return [
    {
      key: 'draft',
      title: 'Drafts',
      hint: 'Yours. No agent sees these',
      yours: false,
      tasks: pick(['draft']),
    },
    {
      key: 'inbox',
      title: 'Inbox',
      hint: 'Waiting for a free agent',
      yours: false,
      tasks: pick(['inbox']),
    },
    {
      key: 'looking',
      title: 'Agent looking',
      hint: 'Reading the code',
      yours: false,
      tasks: pick(['looking']),
    },
    {
      key: 'you',
      title: 'Needs you',
      hint: 'Briefs and results to judge',
      yours: true,
      tasks: pick(['brief', 'result']),
    },
    {
      key: 'ready',
      title: 'Ready',
      hint: 'Verified, or queued to start',
      yours: false,
      tasks: pick(['ready']),
    },
    {
      key: 'working',
      title: 'Working',
      hint: 'Building from the brief',
      yours: false,
      tasks: pick(['working']),
    },
    {
      key: 'done',
      title: 'Done',
      hint: 'Accepted by you',
      yours: false,
      tasks: pick(['done']).reverse(),
    },
  ];
}
