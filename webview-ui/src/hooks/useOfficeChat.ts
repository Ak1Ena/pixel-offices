import { useCallback, useEffect, useState } from 'react';

import type { BoardPin, ChatEntry, QueuedChatMessage } from '../../../core/src/messages.js';
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

  const removePin = useCallback((pinId: string) => {
    transport.send({ type: 'removeBoardPin', pinId });
  }, []);

  return { chats, queues, unread, pins, sendMessage, cancelMessage, markRead, savePin, removePin };
}
