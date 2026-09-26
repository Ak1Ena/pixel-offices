import type {
  DeskAgent,
  DeskHumanAction,
  DeskSubtask,
  DeskTask,
  DeskTaskState,
  WorkflowStep,
  WorkflowStepKind,
} from '../../core/src/messages.js';

/**
 * Pure helpers for the task desk panel (no DOM, no transport) — what the
 * panel shows is decided here so it can be tested in the Node runner. The
 * RULES of the desk live on the server; nothing here decides what is allowed.
 */

/** Cards waiting on the human: a brief to judge, a result to check, or a builder's question. */
export function needsYou(task: DeskTask): boolean {
  return task.state === 'brief' || task.state === 'result' || isWaitingOnYou(task);
}

/** The agent building the card ended its turn asking you something, or stuck. */
export function isWaitingOnYou(task: DeskTask): boolean {
  return task.state === 'working' && task.waitingOn !== undefined;
}

/** The chip a card shows: its state, or what its builder waits for. */
export function stateLabel(task: DeskTask): string {
  if (task.state === 'ready' && task.queued) return 'Queued';
  if (isWaitingOnYou(task)) return task.waitingOn!.kind === 'question' ? 'Asks you' : 'Stuck';
  return STATE_LABEL[task.state];
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
      .filter((t) => FLIGHT_ORDER.includes(t.state) && !isWaitingOnYou(t))
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
    return task.allow.length > 0
      ? 'Only read-only sessions may take it: the office cannot type into them.'
      : 'The office cannot type into the agents in this folder.';
  }
  return 'Agents in this folder have pick-up switched off.';
}

/**
 * How a stuck card can be moved on from the panel: let anyone in the folder
 * take it (only read-only agents were picked, and a reachable one is here), or
 * start an agent (nobody here the office can type into).
 */
export function stuckFixes(
  task: DeskTask,
  agents: DeskAgent[],
): { allowAnyone: boolean; startAgent: boolean } {
  const none = { allowAnyone: false, startAgent: false };
  if (!stuckReason(task, agents)) return none;
  const here = agentsInFolder(task, agents);
  const reachable = here.filter((a) => a.canReach);
  const allowedReachable = reachable.filter(
    (a) => task.allow.length === 0 || task.allow.includes(a.id),
  );
  return {
    allowAnyone: task.allow.length > 0 && allowedReachable.length === 0 && reachable.length > 0,
    startAgent: reachable.length === 0,
  };
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

// ── Drag and drop on the full board ──

/** What dropping a card on a column does: a human call, a call that needs a note first, or nothing. */
export type DeskDrop = { action: DeskHumanAction } | { needsNote: 'rejected' | 'sendBack' } | null;

/**
 * The move a drop onto `column` stands for. Only the human's own calls can be
 * made this way (the same ones the card's buttons make); columns that agents
 * fill (looking, working) accept a card only as "do the task".
 */
export function dropAction(task: DeskTask, column: DeskColumn['key']): DeskDrop {
  switch (task.state) {
    case 'draft':
      return column === 'inbox' ? { action: 'publish' } : null;
    case 'brief':
      if (column === 'ready') return { action: 'verified' };
      if (column === 'working') return { action: 'do' };
      if (column === 'inbox') return { needsNote: 'rejected' };
      return null;
    case 'ready':
      return column === 'working' && !task.queued ? { action: 'do' } : null;
    case 'result':
      if (column === 'done') return { action: 'accept' };
      if (column === 'working') return { needsNote: 'sendBack' };
      return null;
    default:
      return null;
  }
}

// ── Card steps ──

/** How many leading steps are fixed while an agent builds (mirrors the server's lockedSteps). */
export function lockedStepCount(task: DeskTask): number {
  if (task.state !== 'working') return 0;
  const steps = task.briefs[task.briefs.length - 1]?.subtasks ?? [];
  let i = 0;
  while (i < steps.length && (steps[i].done || steps[i].skip)) i++;
  return Math.min(steps.length, i + 1);
}

/** Move one item from `from` to `to`, keeping the first `locked` items where they are. */
export function moveStepTo<T>(list: T[], from: number, to: number, locked = 0): T[] {
  if (from < locked || from >= list.length) return list;
  const target = Math.max(locked, Math.min(list.length - 1, to));
  if (target === from) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

const STEP_KINDS: StepKind[] = ['do', 'gate', 'show'];

/** A step id in the server's format, so a new step keeps its identity while it is moved. */
export function newStepId(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return `s${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
export type StepKind = WorkflowStepKind;

/** do → gate → show → do. */
export function nextStepKind(kind: StepKind | undefined): StepKind {
  return STEP_KINDS[(STEP_KINDS.indexOf(kind ?? 'do') + 1) % STEP_KINDS.length];
}

/** A card's steps as workflow steps (Save as workflow). */
export function stepsToWorkflow(steps: DeskSubtask[]): WorkflowStep[] {
  return steps
    .filter((s) => !s.skip)
    .map((s) => {
      const kind = s.kind ?? 'do';
      const ref = s.ref?.trim();
      return {
        kind,
        text: s.title,
        ...(ref ? (kind === 'show' ? { show: ref } : { refs: [ref] }) : {}),
      };
    });
}

/** A workflow's steps as new card steps (Load workflow). The server gives them ids. */
export function workflowToSteps(steps: WorkflowStep[]): DeskSubtask[] {
  return steps.map((s) => {
    const ref = (s.kind === 'show' ? s.show : s.refs?.[0])?.trim();
    return {
      ...(s.kind !== 'do' ? { kind: s.kind } : {}),
      title: s.text,
      ...(ref ? { ref } : {}),
      skip: false,
      done: false,
      by: 'you' as const,
    };
  });
}

/** Gate steps agents are waiting at, for the prompt stack. `step` is 1-based. */
export function deskGates(
  tasks: DeskTask[],
): Array<{ task: DeskTask; step: number; sub: DeskSubtask }> {
  const out: Array<{ task: DeskTask; step: number; sub: DeskSubtask }> = [];
  for (const task of tasks) {
    if (task.state !== 'working') continue;
    const steps = task.briefs[task.briefs.length - 1]?.subtasks ?? [];
    steps.forEach((sub, i) => {
      if (sub.waiting) out.push({ task, step: i + 1, sub });
    });
  }
  return out;
}

/** Whether two step lists say the same thing (for "unsaved changes"). */
export function sameSteps(a: DeskSubtask[], b: DeskSubtask[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (s, i) =>
      s.id === b[i].id &&
      s.title === b[i].title &&
      (s.kind ?? 'do') === (b[i].kind ?? 'do') &&
      (s.ref ?? '') === (b[i].ref ?? '') &&
      s.skip === b[i].skip,
  );
}
