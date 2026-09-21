import type {
  DeskAgent,
  DeskBrief,
  DeskSubtask,
  DeskTask,
  TaskDeskLoaded,
} from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { ChatSender } from './chatSender.js';
import {
  TASK_CLI_COMMAND,
  TASK_DESK_TICK_MS,
  TASK_NO_SUCH_CARD_ERROR,
  TASK_NOTE_MAX_CHARS,
} from './constants.js';
import { type FolderRoot, resolveFolderRoot, sameRoot } from './gitRoot.js';
import { briefFromInput, cleanText, sanitizeResult, TaskStore } from './taskStore.js';
import {
  applyHumanCall,
  briefIn,
  claimForLook,
  type HumanCall,
  lookFailed,
  startWork,
  subtaskDone,
  type Transition,
  workAbandoned,
  workFinished,
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
  /** agent id → the card it is looking at or building. */
  private readonly claims = new Map<number, Claim>();
  /** agent id → where it works, as last resolved. */
  private readonly roots = new Map<number, { cwd: string; root: FolderRoot | null }>();
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

    if (!existing) {
      const created = this.cards.create({ ...input, folder: folder!, draft: input.draft === true });
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
    };
    if (!this.cards.replace(next as DeskTask))
      return { ok: false, error: 'The card was rejected (a title is required).' };
    return { ok: true, value: this.cards.find(existing.id)! };
  }

  removeTask(taskId: unknown): boolean {
    const task = this.cards.find(taskId);
    if (!task) return false;
    this.dropClaimOn(task.id);
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
      subtasks: Array.isArray(call.subtasks) ? (call.subtasks as DeskSubtask[]) : undefined,
    };
    const reply = this.commit(applyHumanCall(task, clean, this.now()));
    if (reply.ok) void this.tick();
    return reply;
  }

  setAllow(taskId: unknown, allow: unknown): DeskReply {
    const task = this.cards.find(taskId);
    if (!task) return { ok: false, error: NO_CARD };
    if (!Array.isArray(allow)) return { ok: false, error: 'allow must be a list of agent ids.' };
    const reply = this.commit({ ok: true, task: { ...task, allow: allow as number[] } });
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
          this.assign();
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

  private assign(): void {
    const byUrgency = (a: DeskTask, b: DeskTask) =>
      a.priority === b.priority ? a.num - b.num : a.priority === 'p1' ? -1 : 1;
    const open = this.cards.getTasks();
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
      this.chat.send(agent.id, buildPrompt(reply.value));
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

  private freeAgentsFor(task: DeskTask): AgentState[] {
    const free: AgentState[] = [];
    for (const [id, agent] of this.agents) {
      if (!this.isCandidate(agent) || !this.pickupOf(agent)) continue;
      if (this.claims.has(id)) continue;
      if (!agent.isWaiting || agent.permissionSent) continue;
      if (!this.chat.canSend(id) || !this.chat.isIdle(id)) continue;
      if (task.allow.length > 0 && !task.allow.includes(id)) continue;
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
    if (message.type === 'agentToolStart') claim.sawBusy = true;
    if (message.type !== 'agentStatus') return;
    if (message.status === 'active') claim.sawBusy = true;
    else if (message.status === 'waiting' && claim.sawBusy) this.turnEnded(id, claim);
  };

  /** The agent's turn for its card is over and it never reported back. */
  private turnEnded(agentId: number, claim: Claim): void {
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
    return { ok: true, value: this.cards.find(task.id)! };
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
    const log = this.agents.get(agentId)?.chatLog ?? [];
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i];
      if (entry.role === 'assistant' && entry.text) return entry.text.slice(0, TASK_NOTE_MAX_CHARS);
    }
    return '';
  }

  private now(): string {
    return new Date().toISOString();
  }
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
    'brief.json: {"understanding": "...", "subtasks": ["...", "..."], "files": ["..."], "questions": ["..."], "risk": "low|medium|high", "size": "..."}',
    'Write brief.json outside the project (a temp folder). Ask questions in the brief, not here.',
  ].join('\n');
}

/** What a building agent is told. */
export function buildPrompt(task: DeskTask): string {
  const brief: DeskBrief | undefined = task.briefs[task.briefs.length - 1];
  const steps = brief?.subtasks.filter((s) => !s.skip).length ?? 0;
  return [
    `Task desk card #${task.num}: the brief is approved. Do the task.`,
    `Read the approved brief, my notes and answers: ${TASK_CLI_COMMAND} show ${task.num}`,
    steps > 0
      ? `Work through its ${steps} subtasks; after each one run: ${TASK_CLI_COMMAND} step ${task.num} <subtask number>`
      : '',
    `When finished: ${TASK_CLI_COMMAND} done ${task.num} --summary "what you did" [--branch B] [--tests "result"]`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** A card as plain text, for `task show`. */
export function describeTask(task: DeskTask): string {
  const lines = [
    `# #${task.num} ${task.title}`,
    `kind: ${task.kind}  priority: ${task.priority}  state: ${task.state}  round: ${task.round}`,
    `folder: ${task.folder.root}${task.folder.branch ? ` (branch ${task.folder.branch})` : ''}`,
  ];
  if (task.folder.subPath) lines.push(`the human pointed at: ${task.folder.subPath}`);
  if (task.body) lines.push('', '## What the human wrote', task.body);
  const brief = task.briefs[task.briefs.length - 1];
  if (brief) {
    lines.push(
      '',
      `## Brief by ${brief.by}${task.state === 'inbox' ? ' (REJECTED — see history)' : ''}`,
    );
    if (brief.understanding) lines.push(brief.understanding);
    if (brief.subtasks.length) {
      lines.push('', 'Subtasks:');
      brief.subtasks.forEach((s, i) =>
        lines.push(
          `${i + 1}. [${s.skip ? 'skip' : s.done ? 'done' : ' '}] ${s.title}${s.by === 'you' ? ' (added by the human)' : ''}`,
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
