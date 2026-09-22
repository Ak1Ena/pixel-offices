import * as crypto from 'crypto';

import type {
  GateDecision,
  Workflow,
  WorkflowRun,
  WorkflowRunStep,
} from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { SHOW_CLI_COMMAND, WORKFLOW_CLI_COMMAND, WORKFLOW_MAX_RUNS } from './constants.js';

/**
 * Workflow runs: a workflow handed to one agent. Kept in memory — agent ids
 * mean nothing after a restart, so a run can't outlive its office. The agent
 * reports steps through `pixel-office workflow step|gate`; the office only
 * ever records what the agent says (steps may arrive out of order: the gaps
 * are drawn as skipped, never refused — the report is the only evidence).
 */

export type GatePoll = GateDecision | 'pending' | 'gone';
export type RunReply =
  { ok: true; run: WorkflowRun } | { ok: false; status: 400 | 404; error: string };

const NO_SUCH_RUN = 'No such workflow run in this office.';

/** The message typed to the agent when it is given a workflow: the path, never the steps. */
export function attachMessage(run: Pick<WorkflowRun, 'runId'>, filePath: string): string {
  return [
    `Follow the workflow in @${filePath} (run ${run.runId}). Read it first.`,
    `After you finish each step, run: ${WORKFLOW_CLI_COMMAND} step ${run.runId} <step number>`,
    `At a [gate] step, run: ${WORKFLOW_CLI_COMMAND} gate ${run.runId} <step number> and do what it prints.`,
    `At a [show] step, run: ${SHOW_CLI_COMMAND} <file> --why "..." --wait, then mark the step.`,
  ].join('\n');
}

export function newRunId(): string {
  return `w${crypto.randomBytes(3).toString('hex')}`;
}

export class WorkflowRuns {
  private runs: WorkflowRun[] = [];
  private readonly gateWaiters = new Map<string, Set<(poll: GatePoll) => void>>();
  private readonly gateAnswers = new Map<string, GateDecision>();

  constructor(private readonly store: AgentStateStore) {
    store.on('agentRemoved', this.onAgentRemoved);
  }

  snapshot(): { type: 'workflowRuns'; runs: WorkflowRun[] } {
    return { type: 'workflowRuns', runs: structuredClone(this.runs) };
  }

  /**
   * A new run of `workflow` for `agentId`; any run the agent still had is stopped.
   * `runId` is given when the agent was told about the run before it existed.
   */
  start(agentId: number, workflow: Workflow, runId = newRunId()): WorkflowRun {
    for (const old of this.runs.filter((r) => r.agentId === agentId && r.state === 'running')) {
      this.finish(old, 'stopped');
    }
    const run: WorkflowRun = {
      runId,
      workflowId: workflow.id,
      title: workflow.title,
      agentId,
      steps: workflow.steps.map((s): WorkflowRunStep => ({
        kind: s.kind,
        text: s.text,
        ...(s.refs?.length ? { refs: [...s.refs] } : {}),
        state: 'pending',
      })),
      state: 'running',
      startedAt: new Date().toISOString(),
    };
    this.runs.push(run);
    while (this.runs.length > WORKFLOW_MAX_RUNS) this.runs.shift();
    this.broadcast();
    return structuredClone(run);
  }

  /** The agent finished step `n` (1-based). Earlier untouched steps become skipped. */
  markStep(runId: unknown, n: unknown): RunReply {
    const run = this.find(runId);
    if (!run) return { ok: false, status: 404, error: NO_SUCH_RUN };
    const index = this.stepIndex(run, n);
    if (index === null)
      return { ok: false, status: 400, error: `Step must be 1 to ${run.steps.length}.` };
    if (run.state !== 'running')
      return { ok: false, status: 400, error: `This run is ${run.state}.` };
    run.steps[index].state = 'done';
    for (let i = 0; i < index; i++)
      if (run.steps[i].state === 'pending') run.steps[i].state = 'skipped';
    if (run.steps.every((s) => s.state === 'done' || s.state === 'skipped'))
      this.finish(run, 'done');
    else this.broadcast();
    return { ok: true, run: structuredClone(run) };
  }

  /** The agent reached gate step `n`: the office asks the user. */
  openGate(runId: unknown, n: unknown): RunReply {
    const run = this.find(runId);
    if (!run) return { ok: false, status: 404, error: NO_SUCH_RUN };
    const index = this.stepIndex(run, n);
    if (index === null)
      return { ok: false, status: 400, error: `Step must be 1 to ${run.steps.length}.` };
    if (run.state !== 'running')
      return { ok: false, status: 400, error: `This run is ${run.state}.` };
    if (run.steps[index].state !== 'done') {
      run.steps[index].state = 'waiting';
      for (let i = 0; i < index; i++)
        if (run.steps[i].state === 'pending') run.steps[i].state = 'skipped';
    }
    this.broadcast();
    return { ok: true, run: structuredClone(run) };
  }

  /** Long-poll the user's answer at a gate. */
  waitGate(runId: string, n: number, ms: number): Promise<GatePoll> {
    const run = this.find(runId);
    if (!run) return Promise.resolve('gone');
    const key = `${runId}:${n}`;
    const answered = this.gateAnswers.get(key);
    if (answered) return Promise.resolve(answered);
    if (run.state !== 'running') return Promise.resolve('stop');
    return new Promise((resolve) => {
      const waiters = this.gateWaiters.get(key) ?? new Set();
      this.gateWaiters.set(key, waiters);
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        resolve('pending');
      }, ms);
      timer.unref?.();
      const waiter = (poll: GatePoll) => {
        clearTimeout(timer);
        resolve(poll);
      };
      waiters.add(waiter);
    });
  }

  answerGate(runId: unknown, n: unknown, decision: unknown): boolean {
    const run = this.find(runId);
    if (!run || (decision !== 'continue' && decision !== 'stop')) return false;
    const index = this.stepIndex(run, n);
    if (index === null || run.steps[index].state !== 'waiting') return false;
    const key = `${run.runId}:${index + 1}`;
    this.gateAnswers.set(key, decision);
    if (decision === 'continue') {
      run.steps[index].state = 'done';
      this.settle(key, 'continue');
      if (run.steps.every((s) => s.state === 'done' || s.state === 'skipped'))
        this.finish(run, 'done');
      else this.broadcast();
    } else {
      this.settle(key, 'stop');
      this.finish(run, 'stopped');
    }
    return true;
  }

  stop(runId: unknown): boolean {
    const run = this.find(runId);
    if (!run || run.state !== 'running') return false;
    this.finish(run, 'stopped');
    return true;
  }

  /** "Step 3 of 5 · Show me the changelog" — for `workflow show`. */
  describe(runId: unknown): RunReply {
    const run = this.find(runId);
    return run
      ? { ok: true, run: structuredClone(run) }
      : { ok: false, status: 404, error: NO_SUCH_RUN };
  }

  dispose(): void {
    this.store.off('agentRemoved', this.onAgentRemoved);
    for (const key of [...this.gateWaiters.keys()]) this.settle(key, 'gone');
  }

  private readonly onAgentRemoved = (agentId: number): void => {
    const live = this.runs.filter((r) => r.agentId === agentId && r.state === 'running');
    for (const run of live) this.finish(run, 'abandoned');
  };

  private find(runId: unknown): WorkflowRun | undefined {
    return typeof runId === 'string' ? this.runs.find((r) => r.runId === runId) : undefined;
  }

  private stepIndex(run: WorkflowRun, n: unknown): number | null {
    const num = typeof n === 'string' ? Number(n) : n;
    return Number.isInteger(num) && (num as number) >= 1 && (num as number) <= run.steps.length
      ? (num as number) - 1
      : null;
  }

  private finish(run: WorkflowRun, state: WorkflowRun['state']): void {
    run.state = state;
    run.endedAt = new Date().toISOString();
    for (const step of run.steps) if (step.state === 'waiting') step.state = 'pending';
    for (const key of [...this.gateWaiters.keys()]) {
      if (key.startsWith(`${run.runId}:`)) this.settle(key, 'stop');
    }
    this.broadcast();
  }

  private settle(key: string, poll: GatePoll): void {
    const waiters = this.gateWaiters.get(key);
    if (!waiters) return;
    this.gateWaiters.delete(key);
    for (const waiter of waiters) waiter(poll);
  }

  private broadcast(): void {
    this.store.broadcast(this.snapshot());
  }
}
