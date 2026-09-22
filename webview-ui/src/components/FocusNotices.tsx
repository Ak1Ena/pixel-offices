import type { FocusRequest } from '../../../core/src/messages.js';
import { FOCUS_NOTICES_MAX_SHOWN } from '../constants.js';
import { fileBaseName, spotLabel } from '../docViewer.js';
import { Button } from './ui/Button.js';

interface FocusNoticesProps {
  /** Waiting requests the user hasn't put off, oldest first. */
  requests: FocusRequest[];
  labelOf: (agentId: number) => string;
  /** Open the file in the viewer; absent when this surface has no viewer. */
  onOpen?: (request: FocusRequest) => void;
  onLater: (request: FocusRequest) => void;
}

/**
 * "auth-fix wants you to look": an agent pointed the user at part of a file
 * (`pixel-office show`). Only the path and the spot are shown here; Open loads
 * the file in the document viewer at that spot.
 */
export function FocusNotices({ requests, labelOf, onOpen, onLater }: FocusNoticesProps) {
  if (requests.length === 0) return null;
  const shown = requests.slice(-FOCUS_NOTICES_MAX_SHOWN);
  return (
    <div
      className="absolute right-8 top-8 flex flex-col gap-6 w-320 max-w-[calc(100%-16px)] z-55"
      aria-live="polite"
      data-testid="focus-notices"
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
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
