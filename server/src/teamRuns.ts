import * as crypto from 'crypto';

import type { TeamPreset, TeamRun } from '../../core/src/messages.js';
import { addressedParts } from './addressedParts.js';
import type { AgentStateStore } from './agentStateStore.js';
import { TEAM_ADOPT_WAIT_MS, TEAM_CALL_MAX_CHARS, TEAM_MAX_RUNS } from './constants.js';
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
  /** The message that hands out a workflow, for a member's first prompt; undefined = no such workflow. */
  workflowIntro(workflowId: string): { runId: string; text: string } | undefined;
  /** Start the run the member was told about, once its agent exists. */
  attachWorkflow(agentId: number, workflowId: string, runId: string): void;
  setRelay(enabled: boolean): void;
}

/**
 * Teams started from presets. Every member is an agent the office runs (a
 * pty it owns), started with its role in its first message. Only the lead
 * starts with the team; the others are benched until the lead calls them in
 * (a paragraph of its reply opening with `@name`; they get that part), so a team spends tokens only on who the task needs.
 * The team is an
 * OFFICE-level grouping — the webview seats it in a team room and gives it a
 * group-chat channel — and never touches Claude's own team machinery.
 */
export class TeamRuns {
  private runs: TeamRun[] = [];
  /** crewId → member index → session id. */
  private readonly sessions = new Map<string, string[]>();
  /** crewId → the preset, members in run order (lead first), for starting benched members. */
  private readonly presets = new Map<string, TeamPreset>();
  private readonly workflowFor = new Map<
    string,
    Array<{ workflowId: string; runId: string } | undefined>
  >();
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
    // Lead first: run.members[i] lines up with the preset's members in this order.
    const order = [lead, ...team.members.filter((m) => m !== lead)];
    for (const member of order) {
      run.members.push({
        name: member.name,
        role: member.role,
        ...(member === lead ? { lead: true } : { benched: true }),
        ...(member.palette !== undefined ? { palette: member.palette } : {}),
      });
    }
    this.presets.set(crewId, { ...team, members: order });
    this.sessions.set(
      crewId,
      order.map(() => ''),
    );
    this.workflowFor.set(
      crewId,
      order.map(() => undefined),
    );
    const started = this.startMember(run, 0, starter, firstMessage(team, lead, text));
    if (!started.ok) {
      this.forget(crewId);
      return { ok: false, error: started.error };
    }
    if (team.relay) this.hooks.setRelay(true);
    this.runs.push(run);
    while (this.runs.length > TEAM_MAX_RUNS) this.forget(this.runs.shift()!.crewId);
    this.ensureTimer();
    this.broadcast();
    return { ok: true, run: structuredClone(run) };
  }

  /**
   * A NEW reply from an agent. When it is a team's lead and a paragraph opens
   * with a benched teammate's `@name`, that teammate starts now with its part as the task.
   */
  onReply(agentId: number, reply: string): void {
    const starter = this.starter();
    if (!starter) return;
    let changed = false;
    for (const run of this.runs) {
      if (run.state !== 'running') continue;
      // The lead may reply before the 1 s link loop has matched its session.
      const leadSession = this.sessions.get(run.crewId)?.[0];
      const leadId =
        run.members[0]?.agentId ?? (leadSession ? starter.agentIdFor(leadSession) : undefined);
      if (leadId !== agentId) continue;
      const team = this.presets.get(run.crewId);
      if (!team) continue;
      const benched = run.members.flatMap((m, i) =>
        m.benched ? [{ key: i, aliases: [m.name] }] : [],
      );
      for (const [i, part] of addressedParts(reply, benched)) {
        delete run.members[i].benched;
        changed = true;
        const task =
          part.length > TEAM_CALL_MAX_CHARS ? `${part.slice(0, TEAM_CALL_MAX_CHARS)}…` : part;
        this.startMember(run, i, starter, firstMessage(team, team.members[i], run.goal, task));
      }
    }
    if (changed) {
      this.ensureTimer();
      this.broadcast();
    }
  }

  /**
   * Start member `i` of `run`. Its workflow rides the first prompt: typed
   * later, it would queue behind the whole first turn.
   */
  private startMember(
    run: TeamRun,
    i: number,
    starter: AgentStarter,
    first: string,
  ): { ok: true } | { ok: false; error: string } {
    const member = this.presets.get(run.crewId)?.members[i];
    if (!member) return { ok: false, error: 'No such member.' };
    const intro = member.workflowId ? this.hooks.workflowIntro(member.workflowId) : undefined;
    const result = starter.start({
      cwd: run.folder,
      name: member.name,
      command: member.command || undefined,
      firstMessage: intro ? `${first}\n\n${intro.text}` : first,
    });
    if (!result.ok) {
      run.members[i].error = result.error;
      return result;
    }
    run.members[i].startedAt = new Date().toISOString();
    this.sessions.get(run.crewId)![i] = result.sessionId;
    if (intro && member.workflowId) {
      this.workflowFor.get(run.crewId)![i] = { workflowId: member.workflowId, runId: intro.runId };
    }
    return { ok: true };
  }

  private forget(crewId: string): void {
    this.presets.delete(crewId);
    this.sessions.delete(crewId);
    this.workflowFor.delete(crewId);
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
          if (Date.now() - Date.parse(member.startedAt ?? run.startedAt) > TEAM_ADOPT_WAIT_MS) {
            member.error = 'Never showed up in the office.';
            changed = true;
          } else {
            waiting = true;
          }
          return;
        }
        member.agentId = agentId;
        changed = true;
        const workflow = workflows[i];
        if (workflow) this.hooks.attachWorkflow(agentId, workflow.workflowId, workflow.runId);
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
