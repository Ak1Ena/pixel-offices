import { useCallback, useEffect, useState } from 'react';

import type { FocusRequest } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';

export interface FocusRequestsState {
  /** Open and recently answered "show me" requests, oldest first. */
  requests: FocusRequest[];
  /** "Got it" (no reply), or a reply that goes back to the agent. */
  answer: (requestId: string, reply?: string) => void;
}

/**
 * Agents pointing the user at part of a file (`pixel-office show`; server:
 * focusRequests.ts). Own transport listener, like usePermissionAsks; call it
 * before useExtensionMessages so the handshake's snapshot is caught.
 */
export function useFocusRequests(): FocusRequestsState {
  const [requests, setRequests] = useState<FocusRequest[]>([]);

  useEffect(() => {
    return transport.onMessage((msg) => {
      if (msg.type === 'focusRequests') setRequests(msg.requests);
    });
  }, []);

  const answer = useCallback((requestId: string, reply?: string) => {
    // Optimistic: the server confirms with a fresh focusRequests list.
    setRequests((prev) =>
      prev.map((r) =>
        r.requestId === requestId ? { ...r, state: 'seen', ...(reply ? { reply } : {}) } : r,
      ),
    );
    transport.send({ type: 'answerFocus', requestId, ...(reply ? { reply } : {}) });
  }, []);

  return { requests, answer };
}
