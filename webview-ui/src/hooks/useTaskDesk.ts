import { useCallback, useEffect, useState } from 'react';

import type {
  DeskAgent,
  DeskColumnDef,
  DeskHumanAction,
  DeskSubtask,
  DeskTask,
  DeskTaskKind,
  DeskTaskPriority,
  GateDecision,
} from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';

export interface NewCard {
  kind: DeskTaskKind;
  title: string;
  body: string;
  priority: DeskTaskPriority;
  folder: string;
  /** Editing: the card to change. Absent for a new card. */
  taskId?: string;
  /** New cards only: keep it off the desk until it is sent. */
  draft?: boolean;
  /** Team preset id, '' = none. */
  teamId?: string;
  /** Workflow id, '' = none. */
  workflowId?: string;
  /** Model picker label for agents started for this card, '' = the usual model. */
  model?: string;
  /** Absolute paths of attached files (the whole list). */
  attachments?: string[];
}

export interface TaskDeskState {
  tasks: DeskTask[];
  agents: DeskAgent[];
  /** Board columns you defined inside the card states (server: deskFlow.ts). */
  flow: DeskColumnDef[];
  saveFlow: (columns: DeskColumnDef[]) => void;
  /** Move a card to another column of its state ('' = the state's first). */
  setColumn: (taskId: string, column: string) => void;
  /** Why the server refused the latest request, until the next one goes out. */
  notice: string | null;
  /** Add a card, or (with `taskId`) edit one. */
  saveCard: (card: NewCard) => void;
  removeCard: (taskId: string) => void;
  call: (
    taskId: string,
    action: DeskHumanAction,
    extra?: { note?: string; answers?: string[]; subtasks?: DeskSubtask[] },
  ) => void;
  setAllow: (taskId: string, allow: number[]) => void;
  /** Replace a card's steps (brief waiting for you, or mid-build after the locked ones). */
  editSteps: (taskId: string, steps: DeskSubtask[]) => void;
  /** Answer an agent waiting at a gate step (1-based). */
  answerGate: (taskId: string, step: number, decision: GateDecision, note?: string) => void;
  setPickup: (agentId: number, enabled: boolean) => void;
  /** Answer the agent building a card that waits on you: typed into its session like any chat message. */
  reply: (agentId: number, text: string) => void;
}

/**
 * Task desk state. Like useOfficeChat it subscribes to the transport on its
 * own; call it BEFORE useExtensionMessages so the listener is registered when
 * `webviewReady` goes out. The server owns every rule — this hook only mirrors
 * `taskDeskLoaded` and sends the human's calls.
 */
export function useTaskDesk(): TaskDeskState {
  const [tasks, setTasks] = useState<DeskTask[]>([]);
  const [agents, setAgents] = useState<DeskAgent[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [flow, setFlow] = useState<DeskColumnDef[]>([]);

  useEffect(() => {
    return transport.onMessage((msg) => {
      if (msg.type === 'taskDeskLoaded') {
        setTasks(msg.tasks);
        setAgents(msg.agents);
      } else if (msg.type === 'deskFlowLoaded') {
        setFlow(msg.columns);
      } else if (msg.type === 'taskDeskNotice') {
        setNotice(msg.error);
      }
    });
  }, []);

  const saveCard = useCallback((card: NewCard) => {
    setNotice(null);
    transport.send({ type: 'saveDeskTask', ...card });
  }, []);
  const removeCard = useCallback((taskId: string) => {
    setNotice(null);
    transport.send({ type: 'removeDeskTask', taskId });
  }, []);
  const call = useCallback<TaskDeskState['call']>((taskId, action, extra) => {
    setNotice(null);
    transport.send({ type: 'deskTaskAction', taskId, action, ...extra });
  }, []);
  const setAllow = useCallback((taskId: string, allow: number[]) => {
    setNotice(null);
    transport.send({ type: 'setDeskTaskAllow', taskId, allow });
  }, []);
  const editSteps = useCallback((taskId: string, steps: DeskSubtask[]) => {
    setNotice(null);
    transport.send({ type: 'editDeskSteps', taskId, steps });
  }, []);
  const answerGate = useCallback(
    (taskId: string, step: number, decision: GateDecision, note?: string) => {
      setNotice(null);
      transport.send({ type: 'answerDeskGate', taskId, step, decision, ...(note ? { note } : {}) });
    },
    [],
  );
  const setPickup = useCallback((agentId: number, enabled: boolean) => {
    transport.send({ type: 'setAgentPickup', id: agentId, enabled });
  }, []);

  const saveFlow = useCallback((columns: DeskColumnDef[]) => {
    setNotice(null);
    setFlow(columns);
    transport.send({ type: 'saveDeskFlow', columns });
  }, []);
  const setColumn = useCallback((taskId: string, column: string) => {
    setNotice(null);
    transport.send({ type: 'setDeskColumn', taskId, column });
  }, []);

  const reply = useCallback((agentId: number, text: string) => {
    setNotice(null);
    transport.send({ type: 'sendChatMessage', id: agentId, text });
  }, []);

  return {
    tasks,
    agents,
    flow,
    saveFlow,
    setColumn,
    notice,
    saveCard,
    removeCard,
    call,
    setAllow,
    editSteps,
    answerGate,
    setPickup,
    reply,
  };
}
