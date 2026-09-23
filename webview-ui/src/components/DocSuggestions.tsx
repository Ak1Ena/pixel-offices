import type { HunkDecision, Proposal, ProposalHunk } from '../../../core/src/messages.js';
import { decisionCounts, hunkTexts } from '../docSuggestions.js';
import { Button } from './ui/Button.js';

/** What the viewer needs to show an agent's suggestion in the document. */
export interface DocSuggestionProps {
  proposal: Proposal;
  agentLabel: string;
  /** This connection may accept, reject and apply (privileged). */
  canDecide: boolean;
  onDecide: (hunkId: string, decision: HunkDecision) => void;
  onApply: () => void;
  onDiscard: () => void;
}

/** Across the top of the viewer: who suggested what, and Apply / Discard. */
export function SuggestionBar({
  proposal,
  agentLabel,
  canDecide,
  onDecide,
  onApply,
  onDiscard,
}: DocSuggestionProps) {
  const counts = decisionCounts(proposal);
  const all = (decision: HunkDecision) => onDecide('*', decision);
  return (
    <div
      className="flex flex-col gap-4 px-12 py-6 border-b-2 border-status-success bg-bg-dark text-sm"
      data-testid="doc-suggestion-bar"
    >
      <div className="flex items-center gap-8 flex-wrap">
        <span className="flex-1 min-w-0">
          <span className="text-status-success">{agentLabel}</span> suggests {proposal.hunks.length}{' '}
          change{proposal.hunks.length === 1 ? '' : 's'}
          {proposal.why ? <span className="text-text-muted"> — “{proposal.why}”</span> : null}
        </span>
        <span className="text-2xs text-text-muted">
          {counts.accepted} accepted · {counts.rejected} rejected · {counts.pending} to decide
        </span>
      </div>
      {proposal.note && <span className="text-xs text-status-permission">{proposal.note}</span>}
      {canDecide && (
        <div className="flex items-center gap-6 flex-wrap">
          <Button size="sm" onClick={() => all('accepted')}>
            Accept all
          </Button>
          <Button size="sm" onClick={() => all('rejected')}>
            Reject all
          </Button>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={onDiscard}>
            Discard
          </Button>
          <Button
            size="sm"
            variant={counts.accepted > 0 ? 'accent' : 'disabled'}
            disabled={counts.accepted === 0}
            onClick={onApply}
            title="Write the accepted changes to the file (a backup is kept)"
            data-testid="doc-suggestion-apply"
          >
            Apply {counts.accepted > 0 ? counts.accepted : ''}
          </Button>
        </div>
      )}
    </div>
  );
}

/** One suggested change where it lands: what goes, what comes, Accept / Reject. */
export function SuggestionCard({
  hunk,
  canDecide,
  onDecide,
  compact = false,
}: {
  hunk: ProposalHunk;
  canDecide: boolean;
  onDecide: (hunkId: string, decision: HunkDecision) => void;
  /** Only the new text and the buttons (the old text is shown struck through in place). */
  compact?: boolean;
}) {
  const { before, after } = hunkTexts(hunk);
  const decided = hunk.decision !== 'pending';
  return (
    <div
      className={`flex flex-col gap-4 px-8 py-4 border-2 border-dashed font-reading text-read-sm ${
        hunk.decision === 'accepted'
          ? 'border-solid border-status-success bg-diff-add'
          : hunk.decision === 'rejected'
            ? 'border-border opacity-50'
            : 'border-status-success bg-bg'
      }`}
      data-testid="doc-suggestion"
    >
      {!compact && before && (
        <span className="line-through decoration-danger text-danger whitespace-pre-wrap break-words">
          {before}
        </span>
      )}
      {after ? (
        <span className="whitespace-pre-wrap break-words text-status-success">{after}</span>
      ) : (
        <span className="text-2xs text-text-muted">(removed)</span>
      )}
      <div className="flex items-center gap-6 font-pixel">
        <span className="flex-1 text-2xs text-text-muted">
          {hunk.where} · {decided ? hunk.decision : 'suggested'}
          {hunk.reason ? ` — “${hunk.reason}”` : ''}
        </span>
        {canDecide &&
          (decided ? (
            <Button size="sm" onClick={() => onDecide(hunk.hunkId, 'pending')}>
              Undo
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                onClick={() => onDecide(hunk.hunkId, 'rejected')}
                data-testid="doc-suggestion-reject"
              >
                ✗
              </Button>
              <Button
                size="sm"
                variant="accent"
                onClick={() => onDecide(hunk.hunkId, 'accepted')}
                data-testid="doc-suggestion-accept"
              >
                ✓ Accept
              </Button>
            </>
          ))}
      </div>
    </div>
  );
}
