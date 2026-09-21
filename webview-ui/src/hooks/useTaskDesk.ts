import { useCallback, useEffect, useState } from 'react';

import type {
  DeskAgent,
  DeskHumanAction,
  DeskSubtask,
  DeskTask,
  DeskTaskKind,
  DeskTaskPriority,
} from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';

export interface NewCard {
  kind: DeskTaskKind;
  title: string;
  body: string;
  priority: DeskTaskPriority;
  folder: string;
}

export interface TaskDeskState {
  tasks: DeskTask[];
  agents: DeskAgent[];
  /** Why the server refused the latest request, until the next one goes out. */
  notice: string | null;
  addCard: (card: NewCard) => void;
  removeCard: (taskId: string) => void;
  call: (
    taskId: string,
    action: DeskHumanAction,
    extra?: { note?: string; answers?: string[]; subtasks?: DeskSubtask[] },
  ) => void;
  setAllow: (taskId: string, allow: number[]) => void;
  setPickup: (agentId: number, enabled: boolean) => void;
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

  useEffect(() => {
    return transport.onMessage((msg) => {
      if (msg.type === 'taskDeskLoaded') {
        setTasks(msg.tasks);
        setAgents(msg.agents);
      } else if (msg.type === 'taskDeskNotice') {
        setNotice(msg.error);
      }
    });
  }, []);

  const addCard = useCallback((card: NewCard) => {
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
  const setPickup = useCallback((agentId: number, enabled: boolean) => {
    transport.send({ type: 'setAgentPickup', id: agentId, enabled });
  }, []);

  return { tasks, agents, notice, addCard, removeCard, call, setAllow, setPickup };
}
