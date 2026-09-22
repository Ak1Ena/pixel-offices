import * as crypto from 'crypto';

import type { TeamPreset, TeamRun } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { TEAM_ADOPT_WAIT_MS, TEAM_MAX_RUNS } from './constants.js';
import { firstMessage, leadOf } from './teamFile.js';

/** Starts and stops agents for the office (OfficeSessions in the standalone office). */
export interface AgentStarter {
  start(req: {
    cwd: string;
    name?: string;
    command?: string;
    firstMessage?: string;
  }): { ok: true; sessionId: string } | { ok: false; error: string };
  agentIdFor(sessionId: string): number | undefined;
  stopSession(sessionId: string): boolean;
}

export interface TeamRunHooks {
  /** Give a member its workflow once its agent exists. */
  attachWorkflow(agentId: number, workflowId: string): void;
  setRelay(enabled: boolean): void;
}

/**
 * Teams started from presets. Every member is an agent the office runs (a
 * pty it owns), started with its role in its first message. The team is an
 * OFFICE-level grouping — the webview seats it in a team room and gives it a
 * group-chat channel — and never touches Claude's own team machinery.
 */
export class TeamRuns {
  private runs: TeamRun[] = [];
  /** crewId → member index → session id. */
  private readonly sessions = new Map<string, string[]>();
  private readonly workflowFor = new Map<string, Array<string | undefined>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: AgentStateStore,
    private readonly starter: () => AgentStarter | undefined,
    private readonly hooks: TeamRunHooks,
  ) {
    store.on('agentRemoved', this.onAgentRemoved);
  }

  snapshot(): { type: 'teamRuns'; runs: TeamRun[] } {
    return { type: 'teamRuns', runs: structuredClone(this.runs) };
  }

  start(
    team: TeamPreset,
    folder: string,
    goal: string,
  ): { ok: true; run: TeamRun } | { ok: false; error: string } {
    const starter = this.starter();
    if (!starter) {
      return {
        ok: false,
        error: 'Only the standalone office (npx pixel-agents) can start agents for a team.',
      };
    }
    const text = goal.trim();
    if (!text) return { ok: false, error: 'Say what the team should do.' };
    const lead = leadOf(team);
    // The lead starts first so its session exists when the others mention it.
    const order = [lead, ...team.members.filter((m) => m !== lead)];
    const crewId = `c${crypto.randomBytes(3).toString('hex')}`;
    const run: TeamRun = {
      crewId,
      teamId: team.id,
      title: team.title,
      goal: text,
      folder,
      members: [],
      startedAt: new Date().toISOString(),
      state: 'running',
    };
    const sessionIds: string[] = [];
    const workflows: Array<string | undefined> = [];
    let started = 0;
    for (const member of order) {
      const result = starter.start({
        cwd: folder,
        name: member.name,
        command: member.command || undefined,
        firstMessage: firstMessage(team, member, text),
      });
      run.members.push({
        name: member.name,
        role: member.role,
        ...(member === lead ? { lead: true } : {}),
        ...(member.palette !== undefined ? { palette: member.palette } : {}),
        ...(result.ok ? {} : { error: result.error }),
      });
      sessionIds.push(result.ok ? result.sessionId : '');
      workflows.push(member.workflowId);
      if (result.ok) started++;
      else if (member === lead) break; // no lead, no team
    }
    if (started === 0) {
      return {
        ok: false,
        error: run.members.find((m) => m.error)?.error ?? 'No member could start.',
      };
    }
    if (team.relay) this.hooks.setRelay(true);
    this.runs.push(run);
    while (this.runs.length > TEAM_MAX_RUNS) this.runs.shift();
    this.sessions.set(crewId, sessionIds);
    this.workflowFor.set(crewId, workflows);
    this.ensureTimer();
    this.broadcast();
    return { ok: true, run: structuredClone(run) };
  }

  stop(crewId: unknown): boolean {
    const run = this.runs.find((r) => r.crewId === crewId && r.state === 'running');
    if (!run) return false;
    const starter = this.starter();
    for (const sessionId of this.sessions.get(run.crewId) ?? []) {
      if (sessionId) starter?.stopSession(sessionId);
    }
    run.state = 'stopped';
    this.broadcast();
    return true;
  }

  dispose(): void {
    this.store.off('agentRemoved', this.onAgentRemoved);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Watch for members' agents to be adopted; hand each its workflow once. */
  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.link(), 1_000);
    this.timer.unref?.();
  }

  private link(): void {
    const starter = this.starter();
    let changed = false;
    let waiting = false;
    for (const run of this.runs) {
      if (run.state !== 'running') continue;
      const sessionIds = this.sessions.get(run.crewId) ?? [];
      const workflows = this.workflowFor.get(run.crewId) ?? [];
      run.members.forEach((member, i) => {
        if (member.agentId !== undefined || member.error || !sessionIds[i]) return;
        const agentId = starter?.agentIdFor(sessionIds[i]);
        if (agentId === undefined) {
          if (Date.now() - Date.parse(run.startedAt) > TEAM_ADOPT_WAIT_MS) {
            member.error = 'Never showed up in the office.';
            changed = true;
          } else {
            waiting = true;
          }
          return;
        }
        member.agentId = agentId;
        changed = true;
        const workflowId = workflows[i];
        if (workflowId) this.hooks.attachWorkflow(agentId, workflowId);
      });
    }
    if (changed) this.broadcast();
    if (!waiting && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private readonly onAgentRemoved = (agentId: number): void => {
    for (const run of this.runs) {
      if (run.state !== 'running') continue;
      const member = run.members.find((m) => m.agentId === agentId);
      if (!member) continue;
      delete member.agentId;
      member.error = 'Stopped.';
      if (run.members.every((m) => m.agentId === undefined)) run.state = 'stopped';
      this.broadcast();
    }
  };

  private broadcast(): void {
    this.store.broadcast(this.snapshot());
  }
}
