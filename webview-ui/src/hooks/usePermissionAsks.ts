import { useCallback, useEffect, useState } from 'react';

import type { AgentPermissionAsk, PermissionDecision } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';

export interface PermissionAsksState {
  /** Open asks, oldest first. */
  asks: AgentPermissionAsk[];
  answer: (ask: AgentPermissionAsk, decision: PermissionDecision) => void;
}

/**
 * Permission prompts an agent's hook is holding open until the office answers
 * (server: permissionBroker.ts). Own transport listener, like useOfficeChat;
 * call it before useExtensionMessages so the handshake's asks are caught.
 */
export function usePermissionAsks(): PermissionAsksState {
  const [asks, setAsks] = useState<AgentPermissionAsk[]>([]);

  useEffect(() => {
    return transport.onMessage((msg) => {
      if (msg.type === 'agentPermissionAsk') {
        setAsks((prev) =>
          prev.some((a) => a.requestId === msg.requestId) ? prev : [...prev, msg],
        );
      } else if (msg.type === 'agentPermissionAnswered') {
        setAsks((prev) => prev.filter((a) => a.requestId !== msg.requestId));
      } else if (msg.type === 'agentClosed') {
        setAsks((prev) => prev.filter((a) => a.id !== msg.id));
      }
    });
  }, []);

  const answer = useCallback((ask: AgentPermissionAsk, decision: PermissionDecision) => {
    // Optimistic: the server confirms with agentPermissionAnswered.
    setAsks((prev) => prev.filter((a) => a.requestId !== ask.requestId));
    transport.send({
      type: 'answerPermission',
      id: ask.id,
      requestId: ask.requestId,
      decision,
    });
  }, []);

  return { asks, answer };
}
