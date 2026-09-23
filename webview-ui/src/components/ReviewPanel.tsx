import { useEffect, useState } from 'react';

import type { Proposal, ProposalHunk } from '../../../core/src/messages.js';
import { fileBaseName } from '../docViewer.js';
import type { ProposalsState } from '../hooks/useProposals.js';
import { Button } from './ui/Button.js';

interface ReviewPanelProps {
  proposal: Proposal;
  agentLabel: string;
  proposals: ProposalsState;
  /** View-only connections see the changes but can't decide. */
  canDecide: boolean;
  onClose: () => void;
  /** The last refusal from the server (e.g. the file is read-only). */
  notice?: string | null;
  onClearNotice?: () => void;
}

function hunkName(h: ProposalHunk): string {
  const changed = h.lines.find((l) => l.kind !== 'context');
  return (changed?.text ?? '').trim().slice(0, 40) || 'blank line';
}

function Inline({ hunk }: { hunk: ProposalHunk }) {
  let oldN = hunk.oldStart - hunk.lines.findIndex((l) => l.kind !== 'context');
  let newN = hunk.newStart - hunk.lines.findIndex((l) => l.kind !== 'context');
  return (
    <div className="font-mono text-code py-4">
      {hunk.lines.map((l, i) => {
        // A document change has a place (hunk.where), not line numbers.
        const o = hunk.where ? '' : l.kind !== 'add' ? oldN++ : '';
        const n = hunk.where ? '' : l.kind !== 'del' ? newN++ : '';
        return (
          <div
            key={i}
            className={`grid grid-cols-[40px_40px_16px_1fr] pr-8 ${
              l.kind === 'del' ? 'bg-diff-del' : l.kind === 'add' ? 'bg-diff-add' : ''
            }`}
          >
            <span className="text-right pr-6 text-text-muted text-2xs">{o}</span>
            <span className="text-right pr-6 text-text-muted text-2xs">{n}</span>
            <span
              className={
                l.kind === 'del'
                  ? 'text-danger'
                  : l.kind === 'add'
                    ? 'text-status-success'
                    : 'text-text-muted'
              }
            >
              {l.kind === 'del' ? '−' : l.kind === 'add' ? '+' : ' '}
            </span>
            <span
              className={`whitespace-pre-wrap break-words ${l.kind === 'del' ? 'line-through decoration-danger/60' : ''}`}
            >
              {l.text || ' '}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SideBySide({ hunk }: { hunk: ProposalHunk }) {
  const before = hunk.lines.filter((l) => l.kind !== 'add');
  const after = hunk.lines.filter((l) => l.kind !== 'del');
  const col = (lines: ProposalHunk['lines'], title: string) => (
    <div className="flex-1 min-w-0 p-6 font-mono text-code">
      <span className="block text-2xs text-text-muted uppercase mb-2">{title}</span>
      {lines.map((l, i) => (
        <div
          key={i}
          className={`whitespace-pre-wrap break-words px-2 ${l.kind === 'del' ? 'bg-diff-del' : l.kind === 'add' ? 'bg-diff-add' : ''}`}
        >
          {l.text || ' '}
        </div>
      ))}
    </div>
  );
  return (
    <div className="flex border-t-2 border-bg-thumb divide-x-2 divide-bg-thumb">
      {col(before, 'Before')}
      {col(after, 'After')}
    </div>
  );
}

/**
 * Review changes: an agent's suggested edits to a file, change by change.
 * Accept or reject each (or all); Apply writes only the accepted ones to the
 * real file and tells the agent what landed.
 */
export function ReviewPanel({
  proposal,
  agentLabel,
  proposals,
  canDecide,
  onClose,
}: ReviewPanelProps) {
  const [view, setView] = useState<'inline' | 'side'>('inline');
  const [focus, setFocus] = useState(proposal.hunks[0]?.hunkId ?? '');
  const [reason, setReason] = useState('');
  const open = proposal.state === 'open';
  const accepted = proposal.hunks.filter((h) => h.decision === 'accepted').length;
  const rejected = proposal.hunks.filter((h) => h.decision === 'rejected').length;
  const left = proposal.hunks.length - accepted - rejected;
  const focused = proposal.hunks.find((h) => h.hunkId === focus);

  useEffect(() => {
    setReason(focused?.reason ?? '');
    document
      .getElementById(`hunk-${focus}`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the focused change moves
  }, [focus]);

  const decide = (h: ProposalHunk, decision: ProposalHunk['decision']) => {
    proposals.decide(
      proposal.proposalId,
      h.hunkId,
      decision,
      decision === 'rejected' ? reason.trim() || undefined : undefined,
    );
    const next = proposal.hunks.find((x) => x.hunkId !== h.hunkId && x.decision === 'pending');
    if (next && decision !== 'pending') setFocus(next.hunkId);
  };

  return (
    <div
      role="dialog"
      aria-label={`Review changes to ${fileBaseName(proposal.path)}`}
      className="absolute inset-0 z-61 flex bg-bg text-text"
      data-testid="review-panel"
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
      }}
    >
      <aside className="hidden sm:flex flex-col gap-4 w-240 shrink-0 p-8 bg-bg-dark border-r-2 border-border overflow-y-auto">
        <span className="text-2xs text-text-muted uppercase">
          {fileBaseName(proposal.path)} · {proposal.hunks.length} changes
        </span>
        {proposal.hunks.map((h) => (
          <button
            key={h.hunkId}
            onClick={() => setFocus(h.hunkId)}
            className={`grid grid-cols-[12px_1fr] gap-6 items-center text-left px-6 py-4 border-2 rounded-none cursor-pointer text-xs text-text ${
              h.hunkId === focus
                ? 'bg-active-bg border-accent'
                : 'bg-transparent border-transparent hover:bg-bg-thumb'
            }`}
          >
            <span
              className={`w-10 h-10 border-2 ${
                h.decision === 'accepted'
                  ? 'bg-status-success border-status-success'
                  : h.decision === 'rejected'
                    ? 'bg-danger border-danger'
                    : 'border-border'
              }`}
            />
            <span className="min-w-0">
              <span className="block overflow-hidden text-ellipsis whitespace-nowrap">
                {hunkName(h)}
              </span>
              <span className="block text-2xs text-text-muted">
                {h.where ?? `line ${h.oldStart}`} ·{' '}
                {h.decision === 'pending' ? 'to review' : h.decision}
              </span>
            </span>
          </button>
        ))}
        <span className="mt-auto text-2xs text-text-muted">
          Suggested by {agentLabel} ·{' '}
          {new Date(proposal.createdAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="flex items-center gap-8 px-12 py-6 border-b-2 border-border flex-wrap">
          <span className="text-base">{fileBaseName(proposal.path)}</span>
          <span className="flex-1 min-w-0 text-code-sm text-text-muted font-mono overflow-hidden text-ellipsis whitespace-nowrap">
            {proposal.path}
          </span>
          <span className="flex">
            <Button
              size="sm"
              variant={view === 'inline' ? 'active' : 'default'}
              onClick={() => setView('inline')}
            >
              Inline
            </Button>
            <Button
              size="sm"
              variant={view === 'side' ? 'active' : 'default'}
              onClick={() => setView('side')}
            >
              Side by side
            </Button>
          </span>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close">
            ×
          </Button>
        </div>
        <div className="flex items-center gap-10 px-12 py-6 bg-chat-permission border-b-2 border-pin-note text-sm flex-wrap">
          <span className="text-pin-note">
            {open ? 'Review changes' : proposal.state === 'applied' ? 'Applied' : 'Discarded'}
          </span>
          <span className="text-xs">
            {accepted} accepted · {rejected} rejected · {left} left
          </span>
          {proposal.why && (
            <span className="text-read-sm text-text-muted font-reading">“{proposal.why}”</span>
          )}
          <span className="flex-1" />
          {open && canDecide && (
            <>
              <Button
                size="sm"
                onClick={() => proposals.decide(proposal.proposalId, '*', 'rejected')}
              >
                Reject all
              </Button>
              <Button
                size="sm"
                variant="accent"
                onClick={() => proposals.decide(proposal.proposalId, '*', 'accepted')}
                data-testid="review-accept-all"
              >
                Accept all
              </Button>
            </>
          )}
        </div>
        {proposal.note && (
          <div className="px-12 py-4 text-xs border-b-2 border-border bg-bg-dark">
            {proposal.note}
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto p-12 flex flex-col gap-10">
          {proposal.hunks.map((h) => (
            <div
              key={h.hunkId}
              id={`hunk-${h.hunkId}`}
              onClick={() => setFocus(h.hunkId)}
              className={`border-2 bg-bg-dark ${
                h.decision === 'accepted'
                  ? 'border-status-success'
                  : h.decision === 'rejected'
                    ? 'border-danger opacity-70'
                    : h.hunkId === focus
                      ? 'border-accent'
                      : 'border-border'
              }`}
              data-testid="review-hunk"
            >
              <div className="flex items-center gap-8 px-8 py-4 border-b-2 border-bg-thumb text-xs">
                <span>{hunkName(h)}</span>
                <span className="text-2xs text-text-muted">{h.where ?? `line ${h.oldStart}`}</span>
                {h.reason && <span className="text-2xs text-danger">“{h.reason}”</span>}
                <span className="flex-1" />
                {open && canDecide && h.decision === 'pending' && (
                  <>
                    <Button size="sm" onClick={() => decide(h, 'rejected')}>
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      variant="accent"
                      onClick={() => decide(h, 'accepted')}
                      data-testid="review-accept"
                    >
                      Accept
                    </Button>
                  </>
                )}
                {open && canDecide && h.decision !== 'pending' && (
                  <Button size="sm" onClick={() => decide(h, 'pending')}>
                    Undo
                  </Button>
                )}
              </div>
              {view === 'inline' ? <Inline hunk={h} /> : <SideBySide hunk={h} />}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-8 px-12 py-8 border-t-2 border-border flex-wrap">
          {open && canDecide ? (
            <>
              <span className="text-2xs text-text-muted">
                Tell {agentLabel} why (for the change you reject):
              </span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="optional"
                className="flex-1 min-w-120 bg-bg-dark border-2 border-border px-6 py-2 text-read-sm text-text font-reading"
              />
              <Button size="sm" onClick={() => proposals.discard(proposal.proposalId)}>
                Discard
              </Button>
              <Button
                size="sm"
                variant={accepted > 0 ? 'accent' : 'disabled'}
                disabled={accepted === 0}
                onClick={() => proposals.apply(proposal.proposalId)}
                data-testid="review-apply"
              >
                Apply {accepted} change{accepted === 1 ? '' : 's'}
              </Button>
            </>
          ) : (
            <>
              <span className="flex-1 text-xs text-text-muted">
                {open ? 'Open the office from your private link to decide.' : proposal.note}
              </span>
              {proposal.canUndo && canDecide && (
                <Button size="sm" onClick={() => proposals.undo(proposal.proposalId)}>
                  Undo apply
                </Button>
              )}
              <Button size="sm" onClick={onClose}>
                Close
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
