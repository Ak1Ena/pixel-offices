import type { AgentRuntime } from './agentRuntime.js';

/**
 * "Review changes" client messages, shared by both surfaces. Privileged: Apply
 * writes to the user's files, and every answer reaches an agent.
 * Returns true when `msg` was one of them.
 */
export function handleProposalMessage(
  msg: Record<string, unknown>,
  send: (message: Record<string, unknown>) => void,
  runtime: AgentRuntime | undefined,
  privileged: boolean,
): boolean {
  const type = msg.type;
  if (
    type !== 'decideHunk' &&
    type !== 'applyProposal' &&
    type !== 'discardProposal' &&
    type !== 'undoProposal'
  ) {
    return false;
  }
  const notice = (message: string) => send({ type: 'teamNotice', message, error: true });
  if (!runtime || !privileged) {
    notice('Open the office from your private link to review changes.');
    return true;
  }
  const proposals = runtime.proposals;
  switch (type) {
    case 'decideHunk':
      proposals.decide(msg.proposalId, msg.hunkId, msg.decision, msg.reason);
      break;
    case 'applyProposal':
      void proposals.applyAny(msg.proposalId).then((result) => {
        if (!result.ok) notice(result.error);
      });
      break;
    case 'discardProposal':
      proposals.discard(msg.proposalId);
      break;
    case 'undoProposal': {
      const result = proposals.undo(msg.proposalId);
      if (!result.ok) notice(result.error);
      break;
    }
  }
  return true;
}
