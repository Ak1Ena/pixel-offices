import * as fs from 'fs';

import type {
  DeskAgent,
  DeskBrief,
  DeskSubtask,
  DeskTask,
  TaskDeskLoaded,
  TeamPreset,
  Workflow,
} from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { ChatSender } from './chatSender.js';
import {
  SHOW_CLI_COMMAND,
  TASK_CLI_COMMAND,
  TASK_DESK_TICK_MS,
  TASK_NO_SUCH_CARD_ERROR,
  TASK_NOTE_MAX_CHARS,
} from './constants.js';
import { confidentChoice, type Decider, tailOf } from './decisions.js';
import type { AutopilotDesk, DeskAutopilot } from './deskAutopilot.js';
import { type FolderRoot, resolveFolderRoot, sameRoot } from './gitRoot.js';
import {
  briefFromInput,
  cleanText,
  sanitizeAttachments,
  sanitizeResult,
  sanitizeSubtask,
  TaskStore,
  withStepIds,
} from './taskStore.js';
import {
  applyHumanCall,
  briefIn,
  claimForLook,
  editSteps,
  gateAnswered,
  gateOpened,
  type HumanCall,
  lookFailed,
  startWork,
  subtaskDone,
  type Transition,
  workAbandoned,
  workFinished,
  workResumed,
  workWaiting,
} from './taskTransitions.js';
import type { AgentState } from './types.js';

/**
 * The task desk: hands cards to free agents and turns what they report back
 * into card moves. taskTransitions.ts holds the rules, TaskStore the cards;
 * this class holds the timing — who is free, which folder they are in, when a
 * turn ended — and the side effects (typing the prompt into a terminal).
 *
 * An agent only ever gets a card for the folder it is working in (matched on
 * the git top-level folder), only when the office can type into its terminal,
 * and only when its pick-up switch is on. Agents the office started itself
 * have the switch on by default; a session somebody started in their own
 * terminal has it off, so the desk never types into work in progress.
 *
 * Two office processes can share tasks.json (VS Code and standalone). Agent
 * ids mean nothing across them, so every claim carries its `owner` process and
 * each process leaves the other's claims alone unless that process is gone.
 */

export type DeskReply<T = DeskTask> = { ok: true; value: T } | { ok: false; error: string };

/** What an agent waiting at a gate step hears back. */
export type DeskGatePoll =
  { decision: 'continue' | 'stop'; note?: string } | { decision: 'pending' } | { decision: 'gone' };

export interface TaskDeskOptions {
  store: AgentStateStore;
  chatSender: Pick<ChatSender, 'canSend' | 'isIdle' | 'send'>;
  /** Pick-up default for an agent whose switch was never touched. */
  defaultPickup?: (agentId: number) => boolean;
  taskStore?: TaskStore;
  resolveRoot?: (folder: string) => Promise<FolderRoot | null>;
  /** This process, as recorded on claims. */
  owner?: string;
  isOwnerAlive?: (owner: string) => boolean;
  /** Saved workflows a card can follow. Absent = cards carry no workflow. */
  workflows?: (id: string) => Workflow | undefined;
  /** Team presets a card can be for, and starting them. Absent = no team cards. */
  teams?: DeskTeams;
  /** Reads a build turn that ended without a report (decisions.ts). Absent or null = today's rule. */
  decider?: () => Decider | null;
  /** Settings → Autopilot (deskAutopilot.ts). Absent = the human drives every card. */
  autopilot?: DeskAutopilot;
}

/** What the desk needs to give a card to a team (TeamStore + TeamRuns in the runtime). */
export interface DeskTeams {
  get(teamId: string): TeamPreset | undefined;
  /** Start the team in `folder`; its lead's first message is `goal`. */
  start(
    team: TeamPreset,
    folder: string,
    goal: string,
  ): { ok: true; crewId: string } | { ok: false; error: string };
  /** The crew's lead: its agent id, undefined while it is starting, null when the crew is gone. */
  leadOf(crewId: string): number | undefined | null;
}

interface Claim {
  taskId: string;
  /** The agent's turn for this card has visibly started. A turn can only END after that. */
  sawBusy: boolean;
}

const NO_CARD = TASK_NO_SUCH_CARD_ERROR;

function pidAlive(owner: string): boolean {
  try {
    process.kill(Number(owner), 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class TaskDesk {
  private readonly agents: AgentStateStore;
  private readonly chat: TaskDeskOptions['chatSender'];
  private readonly cards: TaskStore;
  private readonly defaultPickup: (agentId: number) => boolean;
  private readonly resolveRoot: (folder: string) => Promise<FolderRoot | null>;
  private readonly owner: string;
  private readonly isOwnerAlive: (owner: string) => boolean;
  private readonly workflowOf: (id: string) => Workflow | undefined;
  private readonly teams: DeskTeams | undefined;
  private readonly decider: () => Decider | null;
  readonly autopilot: DeskAutopilot | undefined;
  /** Team cards whose team could not start: not retried until the card is edited. */
  private readonly teamFailed = new Set<string>();
  /** agent id → the card it is looking at or building. */
  private readonly claims = new Map<number, Claim>();
  /** agent id → where it works, as last resolved. */
  private readonly roots = new Map<number, { cwd: string; root: FolderRoot | null }>();
  /** Cards whose steps the human changed mid-build; the agent hears on its next report. */
  private readonly planChanged = new Set<string>();
  /** `${taskId}:${stepId}` → agents long-polling that gate. */
  private readonly gateWaiters = new Map<string, Set<(poll: DeskGatePoll) => void>>();
  /** Answers given while nobody was polling (the CLI polls in rounds). */
  private readonly gateAnswers = new Map<string, DeskGatePoll>();
  private lastSnapshot = '';
  private inflight: Promise<void> | null = null;
  private rerun = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(opts: TaskDeskOptions) {
    this.agents = opts.store;
    this.chat = opts.chatSender;
    this.defaultPickup = opts.defaultPickup ?? (() => false);
    this.resolveRoot = opts.resolveRoot ?? resolveFolderRoot;
    this.owner = opts.owner ?? String(process.pid);
    this.isOwnerAlive = opts.isOwnerAlive ?? pidAlive;
    this.workflowOf = opts.workflows ?? (() => undefined);
    this.teams = opts.teams;
    this.decider = opts.decider ?? (() => null);
    this.autopilot = opts.autopilot;
    this.cards = opts.taskStore ?? new TaskStore(() => this.publish());
    this.agents.on('broadcast', this.onBroadcast);
    this.agents.on('agentRemoved', this.onAgentRemoved);
    this.timer = setInterval(() => void this.tick(), TASK_DESK_TICK_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.agents.off('broadcast', this.onBroadcast);
    this.agents.off('agentRemoved', this.onAgentRemoved);
    for (const key of [...this.gateWaiters.keys()]) this.settleGate(key, { decision: 'gone' });
    this.cards.dispose();
  }

  // ── What clients see ──

  snapshot(): TaskDeskLoaded {
    const agents: DeskAgent[] = [];
    for (const [id, agent] of this.agents) {
      if (!this.isCandidate(agent)) continue;
      const root = this.roots.get(id)?.root;
      agents.push({
        id,
        ...(root ? { root: root.root } : {}),
        ...(root?.branch ? { branch: root.branch } : {}),
        pickup: this.pickupOf(agent),
        canReach: this.chat.canSend(id),
      });
    }
    return { type: 'taskDeskLoaded', tasks: this.cards.getTasks(), agents };
  }

  /** Broadcast the desk when anything a client shows has changed. */
  private publish(): void {
    const message = this.snapshot();
    const text = JSON.stringify(message);
    if (text === this.lastSnapshot) return;
    this.lastSnapshot = text;
    this.agents.broadcast({ ...message });
  }

  // ── Calls from the human (clientMessageHandler gates these on ctx.privileged) ──

  async saveTask(input: {
    taskId?: unknown;
    kind: unknown;
    title: unknown;
    body: unknown;
    priority: unknown;
    folder: unknown;
    draft?: unknown;
    teamId?: unknown;
    workflowId?: unknown;
    model?: unknown;
    attachments?: unknown;
  }): Promise<DeskReply> {
    const existing = input.taskId === undefined ? undefined : this.cards.find(input.taskId);
    if (input.taskId !== undefined && !existing) return { ok: false, error: NO_CARD };
    if (
      existing &&
      (existing.state === 'working' || existing.state === 'result' || existing.state === 'done')
    ) {
      return { ok: false, error: 'This card is already being built; it can no longer be edited.' };
    }

    let folder = existing?.folder;
    if (!existing || existing.state === 'inbox' || existing.state === 'draft') {
      const resolved =
        typeof input.folder === 'string' ? await this.resolveRoot(input.folder) : null;
      if (!resolved) return { ok: false, error: 'That folder does not exist on this computer.' };
      folder = resolved;
    }

    // Team and workflow shape how the card is looked at: fixed once an agent has looked.
    const beforeLook = !existing || existing.state === 'inbox' || existing.state === 'draft';
    let teamId = existing?.teamId;
    let workflowId = existing?.workflowId;
    let model = existing?.model;
    if (beforeLook) {
      if (typeof input.model === 'string') model = input.model.trim() || undefined;
      const team = this.pickId(input.teamId, existing?.teamId);
      if (team && !this.teams?.get(team)) {
        return {
          ok: false,
          error: this.teams
            ? 'That team no longer exists.'
            : 'Only the standalone office (npx pixel-agents) can give a card to a team.',
        };
      }
      const workflow = this.pickId(input.workflowId, existing?.workflowId);
      if (workflow && !this.workflowOf(workflow)) {
        return { ok: false, error: 'That workflow no longer exists.' };
      }
      teamId = team;
      workflowId = workflow;
    }
    let attachments = existing?.attachments;
    if (input.attachments !== undefined) {
      const picked = sanitizeAttachments(input.attachments);
      const missing = picked.filter((a) => !isFile(a.path));
      if (missing.length > 0) {
        return {
          ok: false,
          error: `Not a file on this computer: ${missing.map((a) => a.path).join(', ')}`,
        };
      }
      attachments = picked;
    }
    if (existing) this.teamFailed.delete(existing.id);

    if (!existing) {
      const created = this.cards.create({
        ...input,
        folder: folder!,
        draft: input.draft === true,
        teamId,
        workflowId,
        model,
        attachments,
      });
      if (!created)
        return {
          ok: false,
          error: 'The card was rejected (a title is required), or the desk is full.',
        };
      void this.tick();
      return { ok: true, value: created };
    }
    const next = {
      ...existing,
      kind: input.kind,
      title: input.title,
      body: input.body,
      priority: input.priority,
      folder: folder!,
      teamId,
      workflowId,
      model,
      attachments,
      // A different team is a different crew.
      crewId: teamId === existing.teamId ? existing.crewId : undefined,
    };
    if (!this.cards.replace(next as DeskTask))
      return { ok: false, error: 'The card was rejected (a title is required).' };
    return { ok: true, value: this.cards.find(existing.id)! };
  }

  removeTask(taskId: unknown): boolean {
    const task = this.cards.find(taskId);
    if (!task) return false;
    this.teamFailed.delete(task.id);
    this.dropClaimOn(task.id);
    this.releaseGates({ ...task, state: 'done' });
    return this.cards.remove(task.id);
  }

  humanCall(taskId: unknown, call: HumanCall): DeskReply {
    const task = this.cards.find(taskId);
    if (!task) return { ok: false, error: NO_CARD };
    const clean: HumanCall = {
      action: call.action,
      note: cleanText(call.note, TASK_NOTE_MAX_CHARS) ?? undefined,
      answers: Array.isArray(call.answers)
        ? call.answers.map((a) => cleanText(a, TASK_NOTE_MAX_CHARS) ?? '')
        : undefined,
      subtasks: Array.isArray(call.subtasks) ? cleanSteps(call.subtasks) : undefined,
    };
    const reply = this.commit(applyHumanCall(task, clean, this.now()));
    if (reply.ok) void this.tick();
    return reply;
  }

  /** The human reorders, retypes, adds or removes a card's steps. */
  editSteps(taskId: unknown, steps: unknown): DeskReply {
    const task = this.cards.find(taskId);
    if (!task) return { ok: false, error: NO_CARD };
    if (!Array.isArray(steps)) return { ok: false, error: 'steps must be a list.' };
    const reply = this.commit(editSteps(task, cleanSteps(steps), this.now()));
    if (reply.ok && task.state === 'working') this.planChanged.add(task.id);
    return reply;
  }

  /** The human answers an agent waiting at a gate step. */
  answerGate(
    taskId: unknown,
    position: unknown,
    decision: unknown,
    note: unknown,
    who?: string,
  ): DeskReply {
    const task = this.cards.find(taskId);
    if (!task) return { ok: false, error: NO_CARD };
    if (decision !== 'continue' && decision !== 'stop')
      return { ok: false, error: 'Unknown answer.' };
    const step = stepAt(task, position);
    const text = cleanText(note, TASK_NOTE_MAX_CHARS) ?? '';
    const reply = this.commit(
      gateAnswered(task, Number(position), decision, text, this.now(), who),
    );
    if (reply.ok && step?.id) {
      this.settleGate(`${task.id}:${step.id}`, { decision, ...(text ? { note: text } : {}) });
    }
    return reply;
  }

  setAllow(taskId: unknown, allow: unknown): DeskReply {
    const task = this.cards.find(taskId);
    if (!task) return { ok: false, error: NO_CARD };
    if (!Array.isArray(allow)) return { ok: false, error: 'allow must be a list of agent ids.' };
    const ids = allow.filter((id): id is number => Number.isInteger(id));
    // A card only read-only sessions may take would wait forever: say so instead.
    if (ids.length > 0 && !ids.some((id) => this.chat.canSend(id))) {
      const names = ids.map((id) => this.labelOf(id)).join(', ');
      return {
        ok: false,
        error: `${names} ${ids.length === 1 ? 'is a read-only session' : 'are read-only sessions'}: the office cannot type into ${ids.length === 1 ? 'it' : 'them'}, so the card would never be picked up. Pick an agent the office started (or one run with \`pixel-office claude\`), or let anyone in the folder take it.`,
      };
    }
    const reply = this.commit({ ok: true, task: { ...task, allow: ids } });
    if (reply.ok) void this.tick();
    return reply;
  }

  setPickup(agentId: unknown, enabled: unknown): void {
    if (typeof agentId !== 'number' || typeof enabled !== 'boolean') return;
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.pickup = enabled;
    this.agents.persist();
    this.publish();
    void this.tick();
  }

  /** A card as plain text for `task show`, with its workflow's steps and its team. */
  describe(task: DeskTask): string {
    return describeTask(task, {
      workflow: task.workflowId ? this.workflowOf(task.workflowId) : undefined,
      team: task.teamId ? this.teams?.get(task.teamId) : undefined,
    });
  }

  // ── Calls from agents (`pixel-office task …`, Bearer HTTP) ──

  show(ref: unknown): DeskReply {
    const task = this.cards.find(ref);
    return task ? { ok: true, value: task } : { ok: false, error: NO_CARD };
  }

  submitBrief(ref: unknown, raw: unknown): DeskReply {
    const task = this.cards.find(ref);
    if (!task) return { ok: false, error: NO_CARD };
    if (!this.isOurs(task))
      return { ok: false, error: 'Nobody here is looking at this card right now.' };
    const parsed = briefFromInput(raw, this.labelOf(task.claimedBy));
    if (!parsed.ok) return parsed;
    const reply = this.commit(briefIn(task, parsed.brief, this.now()));
    // The author stays on the card (it is preferred for the build) but is free again.
    if (reply.ok && task.claimedBy !== undefined) this.claims.delete(task.claimedBy);
    return reply;
  }

  markSubtask(ref: unknown, position: unknown): DeskReply {
    const task = this.cards.find(ref);
    if (!task) return { ok: false, error: NO_CARD };
    return this.commit(subtaskDone(task, Number(position)));
  }

  /** The building agent reached a gate step: the human is asked (prompt stack + card). */
  openGate(ref: unknown, position: unknown, ask: unknown): DeskReply {
    const task = this.cards.find(ref);
    if (!task) return { ok: false, error: NO_CARD };
    if (!this.isOurs(task))
      return { ok: false, error: 'Nobody here is building this card right now.' };
    const text = cleanText(ask, TASK_NOTE_MAX_CHARS) ?? '';
    return this.commit(
      gateOpened(task, Number(position), text, this.labelOf(task.claimedBy), this.now()),
    );
  }

  /** Long-poll the human's answer at a gate step (`pixel-office task gate` polls in rounds). */
  waitGate(ref: unknown, position: unknown, ms: number): Promise<DeskGatePoll> {
    const task = this.cards.find(ref);
    const step = task ? stepAt(task, position) : undefined;
    if (!task || !step?.id) return Promise.resolve({ decision: 'gone' });
    const key = `${task.id}:${step.id}`;
    const answered = this.gateAnswers.get(key);
    if (answered) {
      this.gateAnswers.delete(key);
      return Promise.resolve(answered);
    }
    if (task.state !== 'working' || !step.waiting) {
      return Promise.resolve(step.done ? { decision: 'continue' } : { decision: 'gone' });
    }
    return new Promise((resolve) => {
      const waiters = this.gateWaiters.get(key) ?? new Set();
      this.gateWaiters.set(key, waiters);
      const waiter = (poll: DeskGatePoll) => {
        clearTimeout(timer);
        resolve(poll);
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        resolve({ decision: 'pending' });
      }, ms);
      timer.unref?.();
      waiters.add(waiter);
    });
  }

  /** True once per mid-build step change: the agent's next report says the plan changed. */
  takePlanChange(ref: unknown): boolean {
    const task = this.cards.find(ref);
    return !!task && this.planChanged.delete(task.id);
  }

  submitResult(ref: unknown, raw: unknown): DeskReply {
    const task = this.cards.find(ref);
    if (!task) return { ok: false, error: NO_CARD };
    if (!this.isOurs(task))
      return { ok: false, error: 'Nobody here is building this card right now.' };
    const result = sanitizeResult(raw, this.labelOf(task.claimedBy));
    if (!result) return { ok: false, error: '"summary" must say what was done.' };
    const reply = this.commit(workFinished(task, result, this.now()));
    if (reply.ok && task.claimedBy !== undefined) this.claims.delete(task.claimedBy);
    return reply;
  }

  // ── The loop ──

  /**
   * Re-resolve folders, release dead claims, hand out cards. Safe to call any
   * time: a call that lands while a pass is running joins it, and the pass
   * goes round once more so that call's change is never missed.
   */
  tick(): Promise<void> {
    if (this.inflight) {
      this.rerun = true;
      return this.inflight;
    }
    this.inflight = (async () => {
      try {
        do {
          this.rerun = false;
          await this.refreshRoots();
          this.releaseLostClaims();
          this.autopilot?.plan(this.autopilotView);
          this.startTeams();
          this.assign();
          this.autopilot?.staff(this.autopilotView);
          this.publish();
        } while (this.rerun);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private async refreshRoots(): Promise<void> {
    for (const [id, agent] of this.agents) {
      if (!agent.cwd) continue;
      const known = this.roots.get(id);
      // resolveFolderRoot caches, so this is cheap; re-asking is how a branch switch shows up.
      const root = await this.resolveRoot(agent.cwd);
      if (
        !known ||
        known.cwd !== agent.cwd ||
        JSON.stringify(known.root) !== JSON.stringify(root)
      ) {
        this.roots.set(id, { cwd: agent.cwd, root });
      }
    }
  }

  /** Claims whose agent (or whose whole office process) is gone. */
  private releaseLostClaims(): void {
    for (const task of this.cards.getTasks()) {
      if (task.state !== 'looking' && task.state !== 'working') continue;
      const ours = task.owner === this.owner;
      const lost = ours
        ? task.claimedBy === undefined ||
          !this.agents.get(task.claimedBy) ||
          !this.claims.has(task.claimedBy)
        : !task.owner || !this.isOwnerAlive(task.owner);
      if (!lost) continue;
      if (ours && task.claimedBy !== undefined) this.claims.delete(task.claimedBy);
      const who = ours ? this.labelOf(task.claimedBy) : 'An agent in another window';
      this.commit(
        task.state === 'looking'
          ? lookFailed(task, who, this.now())
          : workAbandoned(task, who, this.now()),
      );
    }
  }

  /**
   * A team card waiting for an agent (in the inbox, or queued to build) needs
   * its team running: start it once, with the card as the lead's first read.
   * The card then goes to the lead through the usual hand-out.
   */
  private startTeams(): void {
    if (!this.teams) return;
    for (const task of this.cards.getTasks()) {
      if (!task.teamId || this.autopilot?.holds(task.id)) continue;
      if (task.state !== 'inbox' && !(task.state === 'ready' && task.queued)) continue;
      if (task.crewId && this.teams.leadOf(task.crewId) !== null) continue;
      if (this.teamFailed.has(task.id)) continue;
      const team = this.teams.get(task.teamId);
      const started = team
        ? this.teams.start(team, task.folder.root, teamGoal(task))
        : ({ ok: false, error: 'The team no longer exists.' } as const);
      const entry = {
        at: this.now(),
        who: 'Office',
        kind: 'system' as const,
        text: started.ok
          ? `Started the team "${team!.title}" for this card.`
          : `Could not start the team: ${started.error}`,
      };
      if (!started.ok) this.teamFailed.add(task.id);
      this.commit({
        ok: true,
        task: {
          ...task,
          ...(started.ok ? { crewId: started.crewId } : {}),
          log: [...task.log, entry],
        },
      });
    }
  }

  private assign(): void {
    const byUrgency = (a: DeskTask, b: DeskTask) =>
      a.priority === b.priority ? a.num - b.num : a.priority === 'p1' ? -1 : 1;
    const open = this.cards.getTasks().filter((t) => !this.autopilot?.holds(t.id));
    // Builds the human already asked for go before new looks.
    const builds = open.filter((t) => t.state === 'ready' && t.queued).sort(byUrgency);
    const looks = open.filter((t) => t.state === 'inbox').sort(byUrgency);

    for (const task of builds) {
      const free = this.freeAgentsFor(task);
      // The agent that wrote the brief already has the context.
      const agent = free.find((a) => a.id === task.claimedBy) ?? free[0];
      if (!agent) continue;
      const reply = this.commit(startWork(task, agent.id), { owner: this.owner });
      if (!reply.ok) continue;
      this.claims.set(agent.id, { taskId: task.id, sawBusy: false });
      const note = this.autopilot?.buildNote(reply.value);
      this.chat.send(
        agent.id,
        note ? `${buildPrompt(reply.value)}\n${note}` : buildPrompt(reply.value),
      );
    }
    for (const task of looks) {
      const agent = this.freeAgentsFor(task)[0];
      if (!agent) continue;
      const reply = this.commit(claimForLook(task, agent.id), { owner: this.owner });
      if (!reply.ok) continue;
      this.claims.set(agent.id, { taskId: task.id, sawBusy: false });
      this.chat.send(agent.id, lookPrompt(reply.value));
    }
  }

  /** The desk as autopilot sees it. */
  private readonly autopilotView: AutopilotDesk = {
    cards: () => this.cards.getTasks(),
    commit: (transition) => this.commit(transition),
    hasFreeAgent: (task) => this.freeAgentsFor(task).length > 0,
    answerGate: (taskId, position, note, who) =>
      this.answerGate(taskId, position, 'continue', note, who),
    holding: (agentId) => this.claims.has(agentId),
    tick: () => void this.tick(),
  };

  private freeAgentsFor(task: DeskTask): AgentState[] {
    const free: AgentState[] = [];
    for (const [id, agent] of this.agents) {
      if (!this.isCandidate(agent) || !this.pickupOf(agent)) continue;
      if (this.claims.has(id)) continue;
      if (!agent.isWaiting || agent.permissionSent) continue;
      if (!this.chat.canSend(id) || !this.chat.isIdle(id)) continue;
      if (task.teamId) {
        // A team card goes to its team's lead, and only once the team runs.
        if (!task.crewId || this.teams?.leadOf(task.crewId) !== id) continue;
      } else if (task.allow.length > 0 && !task.allow.includes(id)) continue;
      if (!sameRoot(this.roots.get(id)?.root?.root, task.folder.root)) continue;
      free.push(agent);
    }
    return free;
  }

  /** Top-level sessions only: a teammate or a background spawn answers to its lead, not the desk. */
  private isCandidate(agent: AgentState): boolean {
    return agent.leadAgentId === undefined && !agent.spawnToolUseId && !agent.hooksOnly;
  }

  private pickupOf(agent: AgentState): boolean {
    return agent.pickup ?? this.defaultPickup(agent.id);
  }

  // ── Turn ends ──

  private readonly onBroadcast = (message: Record<string, unknown>): void => {
    const id = message.id;
    if (typeof id !== 'number') return;
    const claim = this.claims.get(id);
    if (!claim) {
      // An agent just went idle: there may be a card waiting for it.
      if (message.type === 'agentStatus' && message.status === 'waiting') void this.tick();
      return;
    }
    if (
      message.type === 'agentToolStart' ||
      (message.type === 'agentStatus' && message.status === 'active')
    ) {
      claim.sawBusy = true;
      this.resumeIfWaiting(claim);
      return;
    }
    if (message.type === 'agentStatus' && message.status === 'waiting' && claim.sawBusy) {
      this.turnEnded(id, claim);
    }
  };

  /** The agent works on its card again: it is no longer waiting on the human. */
  private resumeIfWaiting(claim: Claim): void {
    const task = this.cards.find(claim.taskId);
    if (task?.waitingOn && task.owner === this.owner) this.commit(workResumed(task));
  }

  /**
   * The agent's turn for its card is over and it never reported back. With a
   * decision model, a build turn is read first: a question for the human or
   * "I'm stuck" keeps the card with the agent, waiting on the human (the
   * claim stays, so its next turn end is read again). Anything else, a failed
   * or unsure read, or no model: the rule below.
   */
  private turnEnded(agentId: number, claim: Claim): void {
    const task = this.cards.find(claim.taskId);
    const decider = this.decider();
    const said = this.fullLastReply(agentId);
    if (
      !decider ||
      !said ||
      task?.state !== 'working' ||
      task.claimedBy !== agentId ||
      task.owner !== this.owner
    ) {
      this.finishTurn(agentId, claim);
      return;
    }
    // Only a NEW turn may end it again; this one is being read.
    claim.sawBusy = false;
    void this.readEnding(decider, task.title, said).then((kind) => {
      // The agent went back to work (or lost the card) while the model read.
      if (this.claims.get(agentId) !== claim || claim.sawBusy) return;
      const current = this.cards.find(claim.taskId);
      if (kind && current) {
        const waitingOn = { kind, text: tailOf(said, TASK_NOTE_MAX_CHARS), at: this.now() };
        if (this.commit(workWaiting(current, waitingOn, this.labelOf(agentId))).ok) return;
      }
      this.finishTurn(agentId, claim);
    });
  }

  private async readEnding(
    decider: Decider,
    title: string,
    reply: string,
  ): Promise<'question' | 'blocked' | null> {
    const answers = await decider.ask(
      { card: title, reply: tailOf(reply) },
      {
        ending: {
          type: 'choice',
          instructions: 'How did the coding agent end its turn on this card?',
          criteria: {
            finished: 'says the work is done or reports what it changed',
            question: 'asks the user a question, or asks them to choose or confirm before going on',
            blocked: 'cannot go on because of an error, a failing command or missing access',
          },
        },
      },
    );
    const ending = confidentChoice(answers?.ending, 'ending');
    return ending === 'question' || ending === 'blocked' ? ending : null;
  }

  private finishTurn(agentId: number, claim: Claim): void {
    this.claims.delete(agentId);
    const task = this.cards.find(claim.taskId);
    if (!task || task.claimedBy !== agentId || task.owner !== this.owner) return;
    const who = this.labelOf(agentId);
    if (task.state === 'looking') {
      this.commit(lookFailed(task, who, this.now()));
    } else if (task.state === 'working') {
      const said = this.lastReply(agentId);
      this.commit(
        workFinished(
          task,
          {
            by: who,
            summary: said
              ? `The turn ended without a report. Last thing it said:\n${said}`
              : 'The turn ended without a report. Check the terminal.',
          },
          this.now(),
        ),
      );
    }
    void this.tick();
  }

  private readonly onAgentRemoved = (id: number): void => {
    this.roots.delete(id);
    if (this.claims.has(id))
      void this.tick(); // releaseLostClaims sees the agent is gone
    else this.publish();
  };

  // ── Helpers ──

  private commit(transition: Transition, extra: Partial<DeskTask> = {}): DeskReply {
    if (!transition.ok) return transition;
    const task = { ...transition.task, ...extra };
    if (task.claimedBy === undefined) delete task.owner;
    if (!this.cards.replace(task)) return { ok: false, error: 'The card could not be saved.' };
    this.releaseGates(task);
    return { ok: true, value: this.cards.find(task.id)! };
  }

  private settleGate(key: string, poll: DeskGatePoll): void {
    const waiters = this.gateWaiters.get(key);
    this.gateWaiters.delete(key);
    if (!waiters || waiters.size === 0) {
      // Nobody is polling right now: keep a real answer for the next round.
      if (poll.decision === 'continue' || poll.decision === 'stop') this.gateAnswers.set(key, poll);
      return;
    }
    for (const waiter of waiters) waiter(poll);
  }

  /** A card that stopped being built: anyone waiting at its gates gets `gone`. */
  private releaseGates(task: DeskTask): void {
    if (task.state === 'working') return;
    this.planChanged.delete(task.id);
    for (const key of [...this.gateWaiters.keys()]) {
      if (key.startsWith(`${task.id}:`)) this.settleGate(key, { decision: 'gone' });
    }
    for (const key of [...this.gateAnswers.keys()]) {
      if (key.startsWith(`${task.id}:`)) this.gateAnswers.delete(key);
    }
  }

  private dropClaimOn(taskId: string): void {
    for (const [agentId, claim] of this.claims) {
      if (claim.taskId === taskId) this.claims.delete(agentId);
    }
  }

  private isOurs(task: DeskTask): boolean {
    return (
      task.owner === this.owner && task.claimedBy !== undefined && this.claims.has(task.claimedBy)
    );
  }

  private labelOf(agentId: number | undefined): string {
    const agent = agentId === undefined ? undefined : this.agents.get(agentId);
    if (!agent) return agentId === undefined ? 'An agent' : `Agent #${agentId}`;
    return agent.displayName ?? agent.agentName ?? `${agent.folderName ?? 'Agent'} #${agent.id}`;
  }

  private lastReply(agentId: number): string {
    return this.fullLastReply(agentId).slice(0, TASK_NOTE_MAX_CHARS);
  }

  private fullLastReply(agentId: number): string {
    const log = this.agents.get(agentId)?.chatLog ?? [];
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i];
      if (entry.role === 'assistant' && entry.text) return entry.text;
    }
    return '';
  }

  private now(): string {
    return new Date().toISOString();
  }

  /** A client-sent preset id: '' clears it, undefined keeps `current`. */
  private pickId(raw: unknown, current: string | undefined): string | undefined {
    if (raw === undefined) return current;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
  }
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** The team lead's first message: read the card now, the desk hands it over when it is free. */
export function teamGoal(task: DeskTask): string {
  return [
    `Task desk card #${task.num}: ${task.title}`,
    `Read it now: ${TASK_CLI_COMMAND} show ${task.num}`,
    'Change no file yet. Think about which teammates the card needs; the office will hand you the card to look at as soon as you are free, and then tell you what to do.',
  ].join('\n');
}

/** What a looking agent is told. The card's text travels through the CLI, not the keyboard. */
export function lookPrompt(task: DeskTask): string {
  const again =
    task.round > 1
      ? ` This is round ${task.round}: the last brief was rejected, and the card says why.`
      : '';
  return [
    `Task desk card #${task.num} (${task.kind}${task.priority === 'p1' ? ', P1' : ''}): look only. Do not change any file.${again}`,
    `Read it: ${TASK_CLI_COMMAND} show ${task.num}`,
    `Then hand in what you understood: ${TASK_CLI_COMMAND} brief ${task.num} --file <brief.json>`,
    'brief.json: {"understanding": "...", "subtasks": ["...", "[gate] ...", "[show] ..."], "files": ["..."], "questions": ["..."], "risk": "low|medium|high", "size": "..."}',
    'Subtasks are steps: plain = work, "[gate] …" = stop for the human\'s go-ahead, "[show] …" = show the human a file.',
    task.workflowId
      ? 'The card follows a workflow (its steps are in `show`): use those steps as your subtasks, in order, keeping their [gate]/[show] kinds; add or adjust only what the card needs.'
      : '',
    task.attachments?.length
      ? `The human attached ${task.attachments.length} file${task.attachments.length === 1 ? '' : 's'} (paths in \`show\`): read the ones that matter.`
      : '',
    'Write brief.json outside the project (a temp folder). Ask questions in the brief, not here.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** What a building agent is told. */
export function buildPrompt(task: DeskTask): string {
  const brief: DeskBrief | undefined = task.briefs[task.briefs.length - 1];
  const live = brief?.subtasks.filter((s) => !s.skip) ?? [];
  const has = (kind: 'gate' | 'show') => live.some((s) => s.kind === kind);
  return [
    `Task desk card #${task.num}: the brief is approved. Do the task.`,
    `Read the approved brief, my notes and answers: ${TASK_CLI_COMMAND} show ${task.num}`,
    task.teamId
      ? 'You lead a team on this card: call teammates in (a paragraph starting with @their-name) for parts of the work. You report the steps and `task done` yourself.'
      : '',
    live.length > 0
      ? `Work through its ${live.length} steps in order; after each one run: ${TASK_CLI_COMMAND} step ${task.num} <step number>`
      : '',
    has('gate')
      ? `At a [gate] step, run ${TASK_CLI_COMMAND} gate ${task.num} <step number> [--ask "question"] and do what it prints.`
      : '',
    has('show')
      ? `At a [show] step, show the human with ${SHOW_CLI_COMMAND} <file> [--lines A-B] --why "..." (the step's ref names the file), then mark it done.`
      : '',
    `When finished: ${TASK_CLI_COMMAND} done ${task.num} --summary "what you did" [--branch B] [--tests "result"]`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** A card as plain text, for `task show`. */
export function describeTask(
  task: DeskTask,
  extra: { workflow?: Workflow; team?: TeamPreset } = {},
): string {
  const lines = [
    `# #${task.num} ${task.title}`,
    `kind: ${task.kind}  priority: ${task.priority}  state: ${task.state}  round: ${task.round}`,
    `folder: ${task.folder.root}${task.folder.branch ? ` (branch ${task.folder.branch})` : ''}`,
  ];
  if (task.folder.subPath) lines.push(`the human pointed at: ${task.folder.subPath}`);
  if (task.body) lines.push('', '## What the human wrote', task.body);
  if (task.attachments?.length) {
    lines.push('', '## Files the human attached');
    for (const a of task.attachments) lines.push(`- ${a.path}`);
  }
  if (extra.team) {
    lines.push(
      '',
      `## Team: ${extra.team.title}`,
      ...extra.team.members.map((m) => `- @${m.name}: ${m.role}${m.lead ? ' (lead)' : ''}`),
    );
  }
  if (task.workflowId) {
    const wf = extra.workflow;
    lines.push('', `## Workflow: ${wf?.title ?? task.workflowId}${wf ? '' : ' (no longer saved)'}`);
    if (wf?.path) lines.push(`file: ${wf.path}`);
    wf?.steps.forEach((step, i) =>
      lines.push(
        `${i + 1}. ${step.kind !== 'do' ? `[${step.kind}] ` : ''}${step.text}${step.refs?.length ? ` — ref: ${step.refs.join(', ')}` : ''}${step.show ? ` — show: ${step.show}` : ''}`,
      ),
    );
  }
  const brief = task.briefs[task.briefs.length - 1];
  if (brief) {
    lines.push(
      '',
      `## Brief by ${brief.by}${task.state === 'inbox' ? ' (REJECTED — see history)' : ''}`,
    );
    if (brief.understanding) lines.push(brief.understanding);
    if (brief.subtasks.length) {
      lines.push('', 'Steps:');
      brief.subtasks.forEach((s, i) =>
        lines.push(
          `${i + 1}. [${s.skip ? 'skip' : s.done ? 'done' : s.waiting ? 'waiting' : ' '}]${s.kind && s.kind !== 'do' ? ` [${s.kind}]` : ''} ${s.title}${s.ref ? ` — ref: ${s.ref}` : ''}${s.by === 'you' ? ' (added by the human)' : ''}`,
        ),
      );
    }
    if (brief.files.length) lines.push('', `Files: ${brief.files.join(', ')}`);
    for (const q of brief.questions) lines.push('', `Q: ${q.q}`, `A: ${q.a || '(not answered)'}`);
  }
  if (task.log.length) {
    lines.push('', '## History');
    for (const entry of task.log) lines.push(`- ${entry.who}: ${entry.text}`);
  }
  return lines.join('\n');
}

/** Human-sent steps, sanitized, with ids. */
function cleanSteps(raw: unknown[]): DeskSubtask[] {
  return withStepIds(raw.map(sanitizeSubtask).filter((step) => step !== null));
}

/** The newest brief's step at 1-based `position`. */
function stepAt(task: DeskTask, position: unknown): DeskSubtask | undefined {
  const index = Number(position) - 1;
  return Number.isInteger(index) ? task.briefs[task.briefs.length - 1]?.subtasks[index] : undefined;
}
