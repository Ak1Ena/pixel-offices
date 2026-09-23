import type { DocEditNotice, FocusRequest, Proposal } from '../../../core/src/messages.js';
import { fileBaseName, spotLabel } from '../docViewer.js';
import { useTunables } from '../hooks/useTunables.js';
import { Button } from './ui/Button.js';

interface FocusNoticesProps {
  /** Waiting requests the user hasn't put off, oldest first. */
  requests: FocusRequest[];
  labelOf: (agentId: number) => string;
  /** Open the file in the viewer; absent when this surface has no viewer. */
  onOpen?: (request: FocusRequest) => void;
  onLater: (request: FocusRequest) => void;
  /** Open suggestions ("Review changes") the user hasn't put off. */
  suggestions?: Proposal[];
  onReview?: (proposal: Proposal) => void;
  onLaterSuggestion?: (proposal: Proposal) => void;
  /** Document edits agents wrote straight away (their edits are auto-accepted), not yet dismissed. */
  docEdits?: DocEditNotice[];
  onUndoDocEdit?: (edit: DocEditNotice) => void;
  onDismissDocEdit?: (edit: DocEditNotice) => void;
}

/**
 * "auth-fix wants you to look": an agent pointed the user at part of a file
 * (`pixel-office show`). Only the path and the spot are shown here; Open loads
 * the file in the document viewer at that spot.
 */
export function FocusNotices({
  requests,
  labelOf,
  onOpen,
  onLater,
  suggestions = [],
  onReview,
  onLaterSuggestion,
  docEdits = [],
  onUndoDocEdit,
  onDismissDocEdit,
}: FocusNoticesProps) {
  const maxShown = useTunables().focusNoticesMaxShown;
  if (requests.length === 0 && suggestions.length === 0 && docEdits.length === 0) return null;
  const shown = requests.slice(-maxShown);
  return (
    <div
      className="absolute right-8 top-8 flex flex-col gap-6 w-320 max-w-[calc(100%-16px)] z-55"
      aria-live="polite"
      data-testid="focus-notices"
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {docEdits.slice(-maxShown).map((edit) => (
        <div
          key={edit.editId}
          role="status"
          className="pixel-panel flex flex-col gap-6 p-8 border-status-success"
          data-testid="doc-edit-notice"
        >
          <div className="text-sm">
            <span className="text-status-success">{edit.who}</span>
            <span className="text-text-muted"> edited </span>
            <span>{fileBaseName(edit.path)}</span>
          </div>
          <ul className="m-0 pl-12 flex flex-col gap-2 font-reading text-read-sm">
            {edit.changes.slice(0, 4).map((line, i) => (
              <li key={i} className="break-words">
                {line}
              </li>
            ))}
            {edit.changes.length > 4 && (
              <li className="text-text-muted">+{edit.changes.length - 4} more</li>
            )}
          </ul>
          <div className="flex gap-6 items-center">
            {onUndoDocEdit && edit.canUndo && (
              <Button size="sm" onClick={() => onUndoDocEdit(edit)} data-testid="doc-edit-undo">
                Undo
              </Button>
            )}
            {onDismissDocEdit && (
              <Button size="sm" variant="ghost" onClick={() => onDismissDocEdit(edit)}>
                OK
              </Button>
            )}
            <span className="ml-auto text-2xs text-text-muted">backup kept</span>
          </div>
        </div>
      ))}
      {suggestions.slice(-maxShown).map((p) => (
        <div
          key={p.proposalId}
          role="alert"
          className="pixel-panel flex flex-col gap-6 p-8 border-pin-note"
          data-testid="proposal-notice"
        >
          <div className="text-sm">
            <span className="text-status-success">
              {p.agentId !== undefined ? labelOf(p.agentId) : 'An agent'}
            </span>
            <span className="text-text-muted"> suggests changes</span>
          </div>
          <div className="self-start max-w-full px-6 py-1 bg-pin-file text-board-ink text-2xs border-2 border-board-ink overflow-hidden text-ellipsis whitespace-nowrap">
            {fileBaseName(p.path)} · {p.hunks.length} change{p.hunks.length === 1 ? '' : 's'}
          </div>
          {p.why && <div className="text-xs leading-snug">“{p.why}”</div>}
          <div className="flex gap-6 items-center">
            {onReview && (
              <Button
                variant="accent"
                size="sm"
                onClick={() => onReview(p)}
                data-testid="proposal-review"
              >
                Review changes
              </Button>
            )}
            {onLaterSuggestion && (
              <Button size="sm" variant="ghost" onClick={() => onLaterSuggestion(p)}>
                Later
              </Button>
            )}
            <span className="ml-auto text-2xs text-status-permission">nothing written yet</span>
          </div>
        </div>
      ))}
      {shown.map((request) => {
        const who = request.agentId !== undefined ? labelOf(request.agentId) : 'An agent';
        const spot = spotLabel(request);
        return (
          <div
            key={request.requestId}
            role="alert"
            className="pixel-panel flex flex-col gap-6 p-8 border-pin-file"
            data-testid="focus-notice"
          >
            <div className="text-sm">
              <span className="text-status-success">{who}</span>
              <span className="text-text-muted"> wants you to look</span>
            </div>
            <div className="self-start max-w-full px-6 py-1 bg-pin-file text-board-ink text-2xs border-2 border-board-ink overflow-hidden text-ellipsis whitespace-nowrap">
              {fileBaseName(request.path)}
              {spot ? ` · ${spot}` : ''}
            </div>
            {request.why && <div className="text-xs leading-snug">“{request.why}”</div>}
            <div className="flex gap-6 items-center">
              {onOpen ? (
                <Button
                  variant="accent"
                  size="sm"
                  onClick={() => onOpen(request)}
                  data-testid="focus-open"
                >
                  Open
                </Button>
              ) : (
                <span className="text-2xs text-text-muted" title={request.path}>
                  {request.path}
                </span>
              )}
              <Button size="sm" variant="ghost" onClick={() => onLater(request)}>
                Later
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
