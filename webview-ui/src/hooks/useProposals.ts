import { useCallback, useEffect, useState } from 'react';

import type { HunkDecision, Proposal } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';

export interface ProposalsState {
  proposals: Proposal[];
  decide: (proposalId: string, hunkId: string, decision: HunkDecision, reason?: string) => void;
  apply: (proposalId: string) => void;
  discard: (proposalId: string) => void;
  undo: (proposalId: string) => void;
}

/** Changes agents suggested, waiting for review (server: proposals.ts). */
export function useProposals(): ProposalsState {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  useEffect(() => {
    return transport.onMessage((msg) => {
      if (msg.type === 'proposals') setProposals(msg.proposals);
    });
  }, []);
  const decide = useCallback(
    (proposalId: string, hunkId: string, decision: HunkDecision, reason?: string) => {
      transport.send({
        type: 'decideHunk',
        proposalId,
        hunkId,
        decision,
        ...(reason ? { reason } : {}),
      });
    },
    [],
  );
  const apply = useCallback(
    (proposalId: string) => transport.send({ type: 'applyProposal', proposalId }),
    [],
  );
  const discard = useCallback(
    (proposalId: string) => transport.send({ type: 'discardProposal', proposalId }),
    [],
  );
  const undo = useCallback(
    (proposalId: string) => transport.send({ type: 'undoProposal', proposalId }),
    [],
  );
  return { proposals, decide, apply, discard, undo };
}
