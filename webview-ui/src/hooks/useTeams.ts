import { useCallback, useEffect, useState } from 'react';

import type {
  TeamDraft,
  TeamPreset,
  TeamRun,
  Workflow,
  WorkflowDraft,
} from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';

export interface TeamsState {
  teams: TeamPreset[];
  crews: TeamRun[];
  notice: { message: string; error: boolean } | null;
  clearNotice: () => void;
  teamDrafts: Record<string, TeamDraft>;
  workflowDrafts: Record<string, WorkflowDraft>;
  save: (team: TeamPreset) => void;
  remove: (teamId: string) => void;
  start: (teamId: string, folder: string, goal: string) => void;
  stop: (crewId: string) => void;
  importTeam: (team: TeamPreset, workflows: Workflow[]) => void;
  importWorkflow: (markdown: string) => void;
  draftTeam: (req: {
    requestId: string;
    description: string;
    folder?: string;
    readProject?: boolean;
    previous?: TeamPreset;
    change?: string;
  }) => void;
  draftWorkflow: (req: {
    requestId: string;
    description: string;
    folder?: string;
    readProject?: boolean;
    previous?: Workflow;
    change?: string;
  }) => void;
}

/** Team presets, started teams and AI drafts (server: teamStore, teamRuns, aiDraft). */
export function useTeams(): TeamsState {
  const [teams, setTeams] = useState<TeamPreset[]>([]);
  const [crews, setCrews] = useState<TeamRun[]>([]);
  const [notice, setNotice] = useState<TeamsState['notice']>(null);
  const [teamDrafts, setTeamDrafts] = useState<Record<string, TeamDraft>>({});
  const [workflowDrafts, setWorkflowDrafts] = useState<Record<string, WorkflowDraft>>({});

  useEffect(() => {
    return transport.onMessage((msg) => {
      if (msg.type === 'teamsLoaded') setTeams(msg.teams);
      else if (msg.type === 'teamRuns') setCrews(msg.runs);
      else if (msg.type === 'teamNotice')
        setNotice({ message: msg.message, error: msg.error !== false });
      else if (msg.type === 'teamDraft')
        setTeamDrafts((prev) => ({ ...prev, [msg.requestId]: msg }));
      else if (msg.type === 'workflowDraft')
        setWorkflowDrafts((prev) => ({ ...prev, [msg.requestId]: msg }));
    });
  }, []);

  const clearNotice = useCallback(() => setNotice(null), []);
  const save = useCallback((team: TeamPreset) => transport.send({ type: 'saveTeam', team }), []);
  const remove = useCallback(
    (teamId: string) => transport.send({ type: 'deleteTeam', teamId }),
    [],
  );
  const start = useCallback(
    (teamId: string, folder: string, goal: string) =>
      transport.send({ type: 'startTeam', teamId, folder, goal }),
    [],
  );
  const stop = useCallback((crewId: string) => transport.send({ type: 'stopTeam', crewId }), []);
  const importTeam = useCallback(
    (team: TeamPreset, workflows: Workflow[]) =>
      transport.send({ type: 'importTeam', team, workflows }),
    [],
  );
  const importWorkflow = useCallback(
    (markdown: string) => transport.send({ type: 'importWorkflow', markdown }),
    [],
  );
  const draftTeam = useCallback<TeamsState['draftTeam']>(
    (req) => transport.send({ type: 'draftTeam', ...req }),
    [],
  );
  const draftWorkflow = useCallback<TeamsState['draftWorkflow']>(
    (req) => transport.send({ type: 'draftWorkflow', ...req }),
    [],
  );

  return {
    teams,
    crews,
    notice,
    clearNotice,
    teamDrafts,
    workflowDrafts,
    save,
    remove,
    start,
    stop,
    importTeam,
    importWorkflow,
    draftTeam,
    draftWorkflow,
  };
}
