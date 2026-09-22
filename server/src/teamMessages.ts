import type { TeamPreset, Workflow } from '../../core/src/messages.js';
import type { AgentRuntime } from './agentRuntime.js';
import { draftTeam, draftWorkflow } from './aiDraft.js';

/** Drafts running right now (each one is a paid `claude -p` call). */
let draftsInFlight = 0;
const MAX_DRAFTS_IN_FLIGHT = 2;

/**
 * Team-preset and AI-draft client messages, shared by both surfaces. All
 * privileged: they start agents, spend tokens, or write ~/.pixel-agents.
 * Returns true when `msg` was one of them.
 */
export function handleTeamMessage(
  msg: Record<string, unknown>,
  send: (message: Record<string, unknown>) => void,
  runtime: AgentRuntime | undefined,
  privileged: boolean,
): boolean {
  const type = msg.type;
  if (
    type !== 'saveTeam' &&
    type !== 'deleteTeam' &&
    type !== 'startTeam' &&
    type !== 'stopTeam' &&
    type !== 'importTeam' &&
    type !== 'draftTeam' &&
    type !== 'draftWorkflow'
  ) {
    return false;
  }
  const notice = (message: string, error = true) => send({ type: 'teamNotice', message, error });
  const requestId = typeof msg.requestId === 'string' ? msg.requestId.slice(0, 64) : '';
  const draftError = (error: string) =>
    send({ type: type === 'draftTeam' ? 'teamDraft' : 'workflowDraft', requestId, error });
  if (!runtime || !privileged) {
    const why = !runtime
      ? 'Teams are not available here.'
      : 'Open the office from your private link to use teams.';
    if (type === 'draftTeam' || type === 'draftWorkflow') draftError(why);
    else notice(why);
    return true;
  }

  switch (type) {
    case 'saveTeam': {
      const result = runtime.teams.save(msg.team);
      if (!result.ok) notice(result.error);
      break;
    }
    case 'deleteTeam':
      if (!runtime.teams.remove(msg.teamId)) notice('No such team.');
      break;
    case 'startTeam': {
      const team = runtime.teams.get(msg.teamId);
      if (!team) {
        notice('No such team.');
        break;
      }
      const folder = typeof msg.folder === 'string' ? msg.folder : '';
      const result = runtime.crews.start(
        team,
        folder,
        typeof msg.goal === 'string' ? msg.goal : '',
      );
      if (!result.ok) notice(result.error);
      else {
        const failed = result.run.members.filter((m) => m.error);
        notice(
          failed.length === 0
            ? `Starting ${team.title}: ${result.run.members.length} agents.`
            : `Started ${team.title}, but ${failed.map((m) => `${m.name} (${m.error})`).join(', ')} did not start.`,
          failed.length > 0,
        );
      }
      break;
    }
    case 'stopTeam':
      runtime.crews.stop(msg.crewId);
      break;
    case 'importTeam': {
      // Workflows first, each saved under a fresh id (keep both on a clash);
      // the team's members are pointed at the new ids.
      const renamed = new Map<string, string>();
      for (const raw of Array.isArray(msg.workflows)
        ? (msg.workflows as Workflow[]).slice(0, 10)
        : []) {
        const oldId = typeof raw?.id === 'string' ? raw.id : '';
        const saved = runtime.workflows.save({ ...raw, id: '' });
        if (saved.ok && oldId) renamed.set(oldId, saved.workflow.id);
      }
      const team = msg.team as TeamPreset | undefined;
      const members = Array.isArray(team?.members)
        ? team.members.map((m) => {
            const next = { ...m };
            if (next.workflowId) {
              const id = renamed.get(next.workflowId);
              if (id) next.workflowId = id;
              else delete next.workflowId;
            }
            return next;
          })
        : [];
      const result = runtime.teams.save({ ...team, id: '', members });
      if (!result.ok) notice(result.error);
      else notice(`Imported ${result.team.title}. It won't start until you press Start.`, false);
      break;
    }
    case 'draftTeam':
    case 'draftWorkflow': {
      if (!requestId) break;
      if (draftsInFlight >= MAX_DRAFTS_IN_FLIGHT) {
        draftError('Two drafts are already running. Try again when one is done.');
        break;
      }
      draftsInFlight++;
      const work =
        type === 'draftTeam'
          ? draftTeam(msg).then((d) => send({ type: 'teamDraft', requestId, ...d }))
          : draftWorkflow(msg).then((d) => send({ type: 'workflowDraft', requestId, ...d }));
      void work
        .catch((e: unknown) => draftError(e instanceof Error ? e.message : String(e)))
        .finally(() => draftsInFlight--);
      break;
    }
  }
  return true;
}
