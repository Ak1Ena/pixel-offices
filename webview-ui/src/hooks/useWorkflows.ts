import { useCallback, useEffect, useState } from 'react';

import type { GateDecision, Workflow, WorkflowRun } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';

export interface WorkflowsState {
  workflows: Workflow[];
  runs: WorkflowRun[];
  /** The last refusal from the server (not privileged, agent can't be typed to, …). */
  notice: string | null;
  clearNotice: () => void;
  save: (workflow: Workflow) => void;
  remove: (workflowId: string) => void;
  attach: (agentId: number, workflowId: string) => void;
  answerGate: (runId: string, step: number, decision: GateDecision) => void;
  stopRun: (runId: string) => void;
}

/** Saved workflows and runs (server: workflowStore.ts, workflowRuns.ts). Own transport listener. */
export function useWorkflows(): WorkflowsState {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    return transport.onMessage((msg) => {
      if (msg.type === 'workflowsLoaded') setWorkflows(msg.workflows);
      else if (msg.type === 'workflowRuns') setRuns(msg.runs);
      else if (msg.type === 'workflowNotice') setNotice(msg.error);
    });
  }, []);

  const clearNotice = useCallback(() => setNotice(null), []);
  const save = useCallback((workflow: Workflow) => {
    transport.send({ type: 'saveWorkflow', workflow });
  }, []);
  const remove = useCallback((workflowId: string) => {
    transport.send({ type: 'deleteWorkflow', workflowId });
  }, []);
  const attach = useCallback((agentId: number, workflowId: string) => {
    transport.send({ type: 'attachWorkflow', id: agentId, workflowId });
  }, []);
  const answerGate = useCallback((runId: string, step: number, decision: GateDecision) => {
    transport.send({ type: 'answerGate', runId, step, decision });
  }, []);
  const stopRun = useCallback((runId: string) => {
    transport.send({ type: 'stopWorkflowRun', runId });
  }, []);

  return { workflows, runs, notice, clearNotice, save, remove, attach, answerGate, stopRun };
}
