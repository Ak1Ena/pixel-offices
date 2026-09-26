import type { DeskTask } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { type CardRoutingOptions, suggestForCard } from './cardRouting.js';
import { type AutopilotSettings, getAutopilot, setAutopilot } from './configPersistence.js';
import {
  AUTOPILOT_AGENT_CHOOSES,
  AUTOPILOT_FIRST_MESSAGE,
  AUTOPILOT_LOG_NAME,
  AUTOPILOT_MAX_SEND_BACKS,
  AUTOPILOT_SPAWN_TIMEOUT_MS,
  TASK_CLI_COMMAND,
} from './constants.js';
import { confidentChoice, type Decider, type DecisionAnswer, tailOf } from './decisions.js';
import type { DeskReply } from './taskDesk.js';
import {
  autopilotBuild,
  autopilotRouted,
  autopilotSendBack,
  type Transition,
} from './taskTransitions.js';

/**
 * The desk on autopilot (Settings → Autopilot): cards go from the inbox to a
 * build without the human, who still gets every question, every risky plan
 * and the final say on each result.
 *
 * 1. Route — a new inbox card the human left without a team, workflow or
 *    model gets them from the decision model (cardRouting.ts). Unsure or no
 *    model: one agent, the usual model. Once per card, logged on it.
 * 2. Approve — a brief not marked high risk is built at once, unless the
 *    decision model says the plan needs the human. Open questions: with
 *    `agentAnswers`, each one the model reads as safe to leave to the agent
 *    is answered "choose sensibly and say what you chose"; any other keeps
 *    the brief with the human.
 * 3. Gates — with `passGates`, a gate step the model reads as routine is
 *    passed; any other waits for the human.
 * 4. Check — the build prompt asks for its own branch and a test run; a
 *    result with failing or missing tests is sent back (at most
 *    AUTOPILOT_MAX_SEND_BACKS times) before the human sees it.
 * 5. Staff — a card with no free agent in its folder gets one started there
 *    (OfficeSessions; standalone only), up to `maxAgents` of autopilot's own.
 * 6. Tidy — an agent autopilot started that sits idle with no card for
 *    `idleMinutes` is closed. Agents somebody else started are never touched.
 *
 * Never used for permissions or accepting a result: those stay with the human.
 */

/** What autopilot starts agents with (OfficeSessions). */
export interface AutopilotStarter {
  start(req: {
    cwd: string;
    command?: string;
    firstMessage?: string;
    model?: string;
  }): { ok: true; sessionId: string } | { ok: false; error: string };
  agentIdFor(sessionId: string): number | undefined;
  stopSession(sessionId: string): boolean;
}

/** The desk as autopilot sees it (TaskDesk passes itself through this). */
export interface AutopilotDesk {
  cards(): DeskTask[];
  commit(transition: Transition): DeskReply;
  /** An agent in the card's folder could take it right now. */
  hasFreeAgent(task: DeskTask): boolean;
  /** The agent is looking at or building a card. */
  holding(agentId: number): boolean;
  /** Let an agent waiting at a gate step go on. */
  answerGate(taskId: string, position: number, note: string, who: string): DeskReply;
  tick(): void;
}

export interface DeskAutopilotOptions {
  store: AgentStateStore;
  decider: () => Decider | null;
  starter: () => AutopilotStarter | undefined;
  /** Teams, workflows and models a card can be routed to. */
  routing: () => CardRoutingOptions;
  /** Test seams. */
  readSettings?: () => AutopilotSettings;
  writeSettings?: (change: unknown) => AutopilotSettings;
  nowMs?: () => number;
}

interface Spawned {
  folder: string;
  startedAt: number;
  agentId?: number;
  /** Since when it has been idle with no card. */
  idleSince?: number;
}

const PLAN_QUESTION = {
  type: 'choice' as const,
  instructions:
    'A coding agent wrote this plan for a card. Can it be carried out without asking the user first?',
  criteria: {
    go: 'a routine plan with a clear goal: the agent can simply carry it out',
    ask: 'deletes data, touches production, payments, secrets or security, rewrites a lot, or leaves a decision open for the user',
  },
};

const QUESTION_QUESTION = {
  type: 'choice' as const,
  instructions:
    'A coding agent asked the user this before starting. Nobody answered. Can the agent safely choose the answer itself?',
  criteria: {
    agent:
      'a detail with a sensible default the user can change later: naming, wording, style, where to put a file, which branch',
    user: 'only the user can decide: deletes or replaces something, changes behaviour users rely on, costs money, touches production, security or secrets',
  },
};

const GATE_QUESTION = {
  type: 'choice' as const,
  instructions:
    'A coding agent stopped at this step of its plan and waits for a go-ahead. Is it a routine step it can simply continue with?',
  criteria: {
    go: 'routine: writing or changing code or docs, running tests, a review of its own work',
    ask: 'deletes data, deploys or publishes, migrates a database, touches production, payments, secrets or security, or asks the user to decide something',
  },
};

/** A test report that says something failed ("3 failed", "tests failing"), and not "0 failed". */
export function testsFailed(tests: string): boolean {
  if (/\b[1-9]\d*\s+(failed|failing|failures?|errors?)\b/i.test(tests)) return true;
  return (
    /\b(failed|failing|broken)\b/i.test(tests) &&
    !/\b(0|no|zero)\s+(tests?\s+)?(failed|failing|failures?)\b/i.test(tests)
  );
}

export class DeskAutopilot {
  private settingsCache: AutopilotSettings;
  /** Cards being read by the decision model: the desk hands them to nobody meanwhile. */
  private readonly held = new Set<string>();
  /** `${taskId}:${brief count}` already judged, so a plan left for the human is not asked again. */
  private readonly judged = new Set<string>();
  /** Cards autopilot could not start an agent for (until the setting changes). */
  private readonly startFailed = new Set<string>();
  /** sessionId → an agent autopilot started. */
  private readonly spawned = new Map<string, Spawned>();
  private lastBroadcast = '';
  private readonly nowMs: () => number;

  constructor(private readonly opts: DeskAutopilotOptions) {
    this.settingsCache = (opts.readSettings ?? getAutopilot)();
    this.nowMs = opts.nowMs ?? Date.now;
  }

  get settings(): AutopilotSettings {
    return this.settingsCache;
  }

  /** Apply a Settings change (privileged). */
  configure(change: unknown): void {
    this.settingsCache = (this.opts.writeSettings ?? setAutopilot)(change);
    this.startFailed.clear();
    this.broadcast(true);
  }

  snapshot(): Record<string, unknown> {
    return {
      type: 'autopilotState',
      ...this.settingsCache,
      canStartAgents: this.opts.starter() !== undefined,
      running: this.spawned.size,
    };
  }

  private broadcast(force = false): void {
    const msg = this.snapshot();
    const key = JSON.stringify(msg);
    if (!force && key === this.lastBroadcast) return;
    this.lastBroadcast = key;
    this.opts.store.broadcast(msg);
  }

  /** The desk must not hand this card out yet. */
  holds(taskId: string): boolean {
    return this.held.has(taskId);
  }

  /** Before the hand-out: route new cards and start briefs that need nobody. */
  plan(desk: AutopilotDesk): void {
    if (!this.settingsCache.enabled) return;
    for (const task of desk.cards()) {
      if (this.held.has(task.id)) continue;
      if (task.state === 'inbox' && !task.autoRouted) this.route(desk, task);
      // Past the inbox, only cards autopilot took on: one you were driving stays yours.
      else if (!task.autoRouted) continue;
      else if (task.state === 'brief') this.judge(desk, task);
      else if (task.state === 'working' && this.settingsCache.passGates) this.gates(desk, task);
      else if (task.state === 'result') this.check(desk, task);
    }
  }

  private route(desk: AutopilotDesk, task: DeskTask): void {
    const decider = this.opts.decider();
    const missing = {
      team: !task.teamId,
      workflow: !task.workflowId,
      model: !task.model,
    };
    const log = (pick: { teamId?: string; workflowId?: string; model?: string }, text: string) =>
      desk.commit(
        autopilotRouted(task, pick, AUTOPILOT_LOG_NAME, text, new Date(this.nowMs()).toISOString()),
      );
    if (!decider || (!missing.team && !missing.workflow && !missing.model)) {
      log({}, decider ? 'Kept your team, workflow and model.' : 'One agent, the usual model.');
      return;
    }
    this.held.add(task.id);
    const all = this.opts.routing();
    void suggestForCard(decider, task, {
      teams: missing.team ? all.teams : [],
      workflows: missing.workflow ? all.workflows : [],
      models: missing.model ? all.models : [],
    })
      .then((pick) => {
        const current = desk.cards().find((t) => t.id === task.id);
        if (!current || current.state !== 'inbox') return;
        const fill: { teamId?: string; workflowId?: string; model?: string } = {};
        const said: string[] = [];
        const pct = (c: number | undefined) => (c === undefined ? '' : ` (${c.toFixed(2)})`);
        if (pick?.teamId && !current.teamId) {
          fill.teamId = pick.teamId;
          const title = all.teams.find((t) => t.id === pick.teamId)?.title ?? pick.teamId;
          said.push(`team "${title}"${pct(pick.confidence.team)}`);
        }
        if (pick?.workflowId && !current.workflowId) {
          fill.workflowId = pick.workflowId;
          const title = all.workflows.find((w) => w.id === pick.workflowId)?.title;
          said.push(`workflow "${title ?? pick.workflowId}"${pct(pick.confidence.workflow)}`);
        }
        if (pick?.model && !current.model) {
          fill.model = pick.model;
          said.push(`model ${pick.model}${pct(pick.confidence.model)}`);
        }
        desk.commit(
          autopilotRouted(
            current,
            fill,
            AUTOPILOT_LOG_NAME,
            said.length > 0
              ? `Laya chose ${said.join(', ')}. Change them on the card if they are wrong.`
              : 'Laya was not sure: one agent, the usual model.',
            new Date(this.nowMs()).toISOString(),
          ),
        );
      })
      .finally(() => {
        this.held.delete(task.id);
        desk.tick();
      });
  }

  private judge(desk: AutopilotDesk, task: DeskTask): void {
    const key = `${task.id}:${task.briefs.length}`;
    if (this.judged.has(key)) return;
    const brief = task.briefs[task.briefs.length - 1];
    if (!brief) return;
    this.judged.add(key);
    // A high-risk plan is the human's, whatever a model says.
    if (/high/i.test(brief.risk)) return;
    const open = brief.questions.filter((q) => !q.a.trim());
    const decider = this.opts.decider();
    // Questions need a model to read them (and the setting); without one they wait.
    if (open.length > 0 && (!decider || !this.settingsCache.agentAnswers)) return;
    const build = (why: string) => {
      const current = desk.cards().find((t) => t.id === task.id);
      if (!current || current.state !== 'brief' || current.briefs.length !== task.briefs.length)
        return;
      desk.commit(
        autopilotBuild(
          current,
          AUTOPILOT_LOG_NAME,
          why,
          new Date(this.nowMs()).toISOString(),
          open.length > 0 ? AUTOPILOT_AGENT_CHOOSES : undefined,
        ),
      );
    };
    if (!decider) {
      build('Not high risk: started the build.');
      return;
    }
    this.held.add(task.id);
    const plan = [
      brief.understanding,
      ...brief.subtasks.filter((s) => !s.skip).map((s, i) => `${i + 1}. ${s.title}`),
      brief.risk ? `Risk: ${brief.risk}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    void Promise.all([
      decider.ask({ card: task.title, plan: tailOf(plan) }, { plan: PLAN_QUESTION }),
      ...open.map((q) =>
        decider.ask({ card: task.title, question: tailOf(q.q) }, { q: QUESTION_QUESTION }),
      ),
    ])
      .then(([planAnswers, ...questionAnswers]) => {
        if (confidentChoice(planAnswers?.plan, 'plan') === 'ask') {
          this.note(desk, task, 'Left the plan for you: it reads as risky.');
          return;
        }
        const blocking = open.filter(
          (_, i) =>
            confidentChoice(questionAnswers[i]?.q as DecisionAnswer | undefined, 'plan') !==
            'agent',
        );
        if (blocking.length > 0) {
          this.note(
            desk,
            task,
            `Waiting for you: ${blocking.length === 1 ? 'a question only you can answer' : `${blocking.length} questions only you can answer`} ("${blocking[0].q.slice(0, 120)}").`,
          );
          return;
        }
        build(
          open.length > 0
            ? `${open.length} question${open.length === 1 ? '' : 's'}, none only yours: the agent chooses and says what it chose. Started the build.`
            : 'The plan needs no answers from you: started the build.',
        );
      })
      .finally(() => {
        this.held.delete(task.id);
        desk.tick();
      });
  }

  /** A gate step the agent waits at: pass it when the model reads it as routine. */
  private gates(desk: AutopilotDesk, task: DeskTask): void {
    const brief = task.briefs[task.briefs.length - 1];
    const decider = this.opts.decider();
    if (!brief || !decider) return;
    brief.subtasks.forEach((step, index) => {
      if (!step.waiting) return;
      const key = `${task.id}:gate:${step.id ?? index}:${task.log.length}`;
      if (this.judged.has(key)) return;
      this.judged.add(key);
      void decider
        .ask(
          { card: task.title, step: tailOf(`${step.title}${step.ask ? `\n${step.ask}` : ''}`) },
          { gate: GATE_QUESTION },
        )
        .then((answers) => {
          if (confidentChoice(answers?.gate, 'plan') !== 'go') return;
          desk.answerGate(task.id, index + 1, 'Autopilot: a routine step.', AUTOPILOT_LOG_NAME);
        });
    });
  }

  /** A finished card: tests failed or never ran → back to the agent, a few times at most. */
  private check(desk: AutopilotDesk, task: DeskTask): void {
    const key = `${task.id}:result:${task.log.length}`;
    if (this.judged.has(key) || !task.result) return;
    this.judged.add(key);
    const sentBack = task.log.filter(
      (l) => l.who === AUTOPILOT_LOG_NAME && l.text.startsWith('Sent back'),
    ).length;
    const tests = task.result.tests?.trim() ?? '';
    const branch = task.result.branch?.trim() ?? '';
    if (!branch || /^(main|master)$/i.test(branch)) {
      this.note(desk, task, 'Check the branch: this work is not on a branch of its own.');
    }
    if (sentBack >= AUTOPILOT_MAX_SEND_BACKS) return;
    const why = !tests
      ? `no test result was reported. Run the project's tests (or say why none apply) and report with ${TASK_CLI_COMMAND} done ${task.num} --tests "…".`
      : testsFailed(tests)
        ? `the tests failed ("${tests.slice(0, 120)}"). Fix them, run them again and report the result.`
        : '';
    if (!why) return;
    const current = desk.cards().find((t) => t.id === task.id) ?? task;
    desk.commit(
      autopilotSendBack(current, AUTOPILOT_LOG_NAME, why, new Date(this.nowMs()).toISOString()),
    );
  }

  /** A line on the card's log from autopilot. */
  private note(desk: AutopilotDesk, task: DeskTask, text: string): void {
    const current = desk.cards().find((t) => t.id === task.id) ?? task;
    desk.commit({
      ok: true,
      task: {
        ...current,
        log: [
          ...current.log,
          {
            at: new Date(this.nowMs()).toISOString(),
            who: AUTOPILOT_LOG_NAME,
            kind: 'system',
            text,
          },
        ],
      },
    });
  }

  /** Added to the build prompt while autopilot runs the desk. */
  buildNote(task: DeskTask): string {
    if (!this.settingsCache.enabled) return '';
    return [
      `Autopilot runs this card: work on a new branch of your own (for example autopilot/card-${task.num}), never on main or master, and do not push.`,
      `Before ${TASK_CLI_COMMAND} done, run the project's tests and pass the result with --tests and your branch with --branch.`,
      'Questions nobody answered: choose sensibly and list them under "Choices I made" in your summary.',
    ].join('\n');
  }

  /** After the hand-out: start agents for cards nobody could take, close idle ones. */
  staff(desk: AutopilotDesk): void {
    const starter = this.opts.starter();
    this.refresh(starter);
    if (!this.settingsCache.enabled || !starter) {
      this.broadcast();
      return;
    }
    this.tidy(desk, starter);

    const waiting = new Map<string, DeskTask[]>();
    for (const task of desk.cards()) {
      if (task.teamId || this.held.has(task.id) || this.startFailed.has(task.id)) continue;
      const wants =
        (task.state === 'inbox' && task.autoRouted) || (task.state === 'ready' && task.queued);
      if (!wants || desk.hasFreeAgent(task)) continue;
      const list = waiting.get(task.folder.root) ?? [];
      list.push(task);
      waiting.set(task.folder.root, list);
    }
    for (const [folder, cards] of waiting) {
      let onTheWay = [...this.spawned.values()].filter(
        (s) => s.folder === folder && (s.agentId === undefined || !desk.holding(s.agentId)),
      ).length;
      for (const card of cards.slice(onTheWay)) {
        if (this.spawned.size >= this.settingsCache.maxAgents) break;
        const started = starter.start({
          cwd: folder,
          command: this.settingsCache.command,
          firstMessage: AUTOPILOT_FIRST_MESSAGE,
          ...(card.model ? { model: card.model } : {}),
        });
        if (!started.ok) {
          this.startFailed.add(card.id);
          desk.commit({
            ok: true,
            task: {
              ...card,
              log: [
                ...card.log,
                {
                  at: new Date(this.nowMs()).toISOString(),
                  who: AUTOPILOT_LOG_NAME,
                  kind: 'system',
                  text: `Could not start an agent: ${started.error}`,
                },
              ],
            },
          });
          continue;
        }
        this.spawned.set(started.sessionId, { folder, startedAt: this.nowMs() });
        onTheWay++;
      }
    }
    this.broadcast();
  }

  /** Learn agent ids; forget agents that are gone or never showed up. */
  private refresh(starter: AutopilotStarter | undefined): void {
    for (const [sessionId, s] of this.spawned) {
      s.agentId ??= starter?.agentIdFor(sessionId);
      const gone =
        s.agentId !== undefined
          ? !this.opts.store.get(s.agentId)
          : this.nowMs() - s.startedAt > AUTOPILOT_SPAWN_TIMEOUT_MS;
      if (gone || !starter) this.spawned.delete(sessionId);
    }
  }

  private tidy(desk: AutopilotDesk, starter: AutopilotStarter): void {
    const limit = this.settingsCache.idleMinutes * 60_000;
    for (const [sessionId, s] of this.spawned) {
      if (s.agentId === undefined) continue;
      const agent = this.opts.store.get(s.agentId);
      const idle = !!agent && agent.isWaiting && !agent.permissionSent && !desk.holding(s.agentId);
      if (!idle) {
        s.idleSince = undefined;
        continue;
      }
      s.idleSince ??= this.nowMs();
      if (this.nowMs() - s.idleSince < limit) continue;
      console.log(`[Pixel Agents] Autopilot: closing idle agent ${s.agentId}`);
      starter.stopSession(sessionId);
      this.spawned.delete(sessionId);
    }
  }

  /** Agents autopilot started (for the UI). */
  owns(agentId: number): boolean {
    for (const s of this.spawned.values()) if (s.agentId === agentId) return true;
    return false;
  }
}
