import { useCallback, useEffect, useState } from 'react';

import type {
  AgentKey,
  AgentTokenUsage,
  BoardPin,
  ChatEntry,
  QueuedChatMessage,
  ScreenQuestion,
} from '../../../core/src/messages.js';
import { mergeChatEntries } from '../officeChat.js';
import { transport } from '../transport/index.js';

export interface ChatQueueState {
  queued: QueuedChatMessage[];
  /** Why the latest send was refused, if it was. */
  error?: string;
}

export interface OfficeChatState {
  chats: Record<number, ChatEntry[]>;
  queues: Record<number, ChatQueueState>;
  /** Agents with a reply the user hasn't opened yet. */
  unread: Record<number, boolean>;
  /** Agents the office can type into (server-decided: agentChatSendable). */
  sendable: Record<number, boolean>;
  /** Session token totals + burn rate per agent. */
  usage: Record<number, AgentTokenUsage>;
  /** User-given character names. */
  names: Record<number, string>;
  /** Agents waiting on a permission prompt or an on-screen question (server state, survives bubble clicks). */
  asking: Record<number, boolean>;
  /** Terminal screens of agents the office runs itself (plain text lines). */
  screens: Record<number, string[]>;
  /** The numbered choice each office-run agent is showing on its screen, if any. */
  questions: Record<number, ScreenQuestion>;
  answerQuestion: (agentId: number, key: string, option: number) => void;
  /** True when this office can start agents (+ Agent in the browser). */
  canStartAgents: boolean;
  /** This connection may do privileged things (server-decided, officeCapabilities). */
  privileged: boolean;
  recentFolders: string[];
  /** Whether agents may message each other with @Name (server state). */
  relayEnabled: boolean;
  setRelay: (enabled: boolean) => void;
  sendKeys: (agentId: number, keys: AgentKey[]) => void;
  interruptAgent: (agentId: number) => void;
  renameAgent: (agentId: number, name: string) => void;
  pins: BoardPin[];
  sendMessage: (agentId: number, text: string) => void;
  cancelMessage: (agentId: number, queueId: string) => void;
  markRead: (agentId: number) => void;
  savePin: (pin: BoardPin) => void;
  removePin: (pinId: string) => void;
}

/**
 * Session chat + whiteboard state. Subscribes to the transport on its own so
 * useExtensionMessages stays about the office; call it BEFORE that hook so
 * this listener is registered when `webviewReady` goes out.
 */
export function useOfficeChat(openChatAgentId: number | null): OfficeChatState {
  const [chats, setChats] = useState<Record<number, ChatEntry[]>>({});
  const [queues, setQueues] = useState<Record<number, ChatQueueState>>({});
  const [unread, setUnread] = useState<Record<number, boolean>>({});
  const [sendable, setSendable] = useState<Record<number, boolean>>({});
  const [usage, setUsage] = useState<Record<number, AgentTokenUsage>>({});
  const [names, setNames] = useState<Record<number, string>>({});
  const [screens, setScreens] = useState<Record<number, string[]>>({});
  const [questions, setQuestions] = useState<Record<number, ScreenQuestion>>({});
  const [asking, setAsking] = useState<Record<number, boolean>>({});
  const [canStartAgents, setCanStartAgents] = useState(false);
  const [privileged, setPrivileged] = useState(false);
  const [recentFolders, setRecentFolders] = useState<string[]>([]);
  const [relayEnabled, setRelayEnabled] = useState(false);
  const [pins, setPins] = useState<BoardPin[]>([]);

  useEffect(() => {
    return transport.onMessage((msg) => {
      if (msg.type === 'agentChatEntry') {
        const { id, entry } = msg;
        setChats((prev) => ({ ...prev, [id]: mergeChatEntries(prev[id] ?? [], [entry]) }));
        if (entry.role === 'assistant') setUnread((prev) => ({ ...prev, [id]: true }));
      } else if (msg.type === 'agentChatHistory') {
        setChats((prev) => ({ ...prev, [msg.id]: mergeChatEntries([], msg.entries) }));
      } else if (msg.type === 'agentChatQueue') {
        setQueues((prev) => ({ ...prev, [msg.id]: { queued: msg.queued, error: msg.error } }));
      } else if (msg.type === 'agentTokenUsage') {
        setUsage((prev) => ({ ...prev, [msg.id]: msg }));
      } else if (msg.type === 'agentRenamed') {
        setNames((prev) => ({ ...prev, [msg.id]: msg.name }));
      } else if (msg.type === 'agentToolPermission') {
        setAsking((prev) => ({ ...prev, [msg.id]: true }));
      } else if (msg.type === 'agentToolPermissionClear' || msg.type === 'agentToolsClear') {
        setAsking((prev) => (prev[msg.id] ? { ...prev, [msg.id]: false } : prev));
      } else if (msg.type === 'agentScreen') {
        setScreens((prev) => ({ ...prev, [msg.id]: msg.lines }));
        const question = msg.question;
        setQuestions((prev) => {
          if (question)
            return prev[msg.id]?.key === question.key ? prev : { ...prev, [msg.id]: question };
          if (!(msg.id in prev)) return prev;
          const next = { ...prev };
          delete next[msg.id];
          return next;
        });
      } else if (msg.type === 'agentRelayState') {
        setRelayEnabled(msg.enabled);
      } else if (msg.type === 'officeCapabilities') {
        setCanStartAgents(msg.canStartAgents);
        setPrivileged(msg.privileged === true);
        setRecentFolders(msg.recentFolders);
      } else if (msg.type === 'agentChatSendable') {
        setSendable((prev) => ({ ...prev, [msg.id]: msg.sendable }));
      } else if (msg.type === 'boardLoaded') {
        setPins(msg.pins);
      } else if (msg.type === 'agentClosed') {
        const drop = <T>(prev: Record<number, T>) => {
          if (!(msg.id in prev)) return prev;
          const next = { ...prev };
          delete next[msg.id];
          return next;
        };
        setChats(drop);
        setQueues(drop);
        setUnread(drop);
        setSendable(drop);
        setUsage(drop);
        setNames(drop);
        setScreens(drop);
        setQuestions(drop);
        setAsking(drop);
      }
    });
  }, []);

  // The open chat is being read as it arrives.
  useEffect(() => {
    if (openChatAgentId !== null && unread[openChatAgentId]) {
      setUnread((prev) => ({ ...prev, [openChatAgentId]: false }));
    }
  }, [openChatAgentId, unread]);

  const sendMessage = useCallback((agentId: number, text: string) => {
    setQueues((prev) => ({ ...prev, [agentId]: { queued: prev[agentId]?.queued ?? [] } }));
    transport.send({ type: 'sendChatMessage', id: agentId, text });
  }, []);

  const cancelMessage = useCallback((agentId: number, queueId: string) => {
    transport.send({ type: 'cancelChatMessage', id: agentId, queueId });
  }, []);

  const markRead = useCallback((agentId: number) => {
    setUnread((prev) => (prev[agentId] ? { ...prev, [agentId]: false } : prev));
  }, []);

  const savePin = useCallback((pin: BoardPin) => {
    transport.send({ type: 'saveBoardPin', pin });
  }, []);

  const renameAgent = useCallback((agentId: number, name: string) => {
    // Optimistic: the server echoes agentRenamed with the cleaned-up name.
    setNames((prev) => ({ ...prev, [agentId]: name.trim() }));
    transport.send({ type: 'renameAgent', id: agentId, name });
  }, []);

  const setRelay = useCallback((enabled: boolean) => {
    transport.send({ type: 'setAgentRelay', enabled });
  }, []);

  const sendKeys = useCallback((agentId: number, keys: AgentKey[]) => {
    transport.send({ type: 'sendAgentKeys', id: agentId, keys });
  }, []);

  const interruptAgent = useCallback((agentId: number) => {
    transport.send({ type: 'interruptAgent', id: agentId });
  }, []);

  const answerQuestion = useCallback((agentId: number, key: string, option: number) => {
    transport.send({ type: 'answerScreenQuestion', id: agentId, key, option });
  }, []);

  const removePin = useCallback((pinId: string) => {
    transport.send({ type: 'removeBoardPin', pinId });
  }, []);

  return {
    chats,
    queues,
    unread,
    sendable,
    usage,
    names,
    screens,
    questions,
    answerQuestion,
    asking,
    canStartAgents,
    privileged,
    recentFolders,
    relayEnabled,
    setRelay,
    sendKeys,
    interruptAgent,
    renameAgent,
    pins,
    sendMessage,
    cancelMessage,
    markRead,
    savePin,
    removePin,
  };
}
