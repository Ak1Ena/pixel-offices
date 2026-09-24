import { useState } from 'react';

import type { WorkflowRun } from '../../../core/src/messages.js';
import { WORKFLOW_STEPS_HIDDEN_KEY } from '../constants.js';
import { Button } from './ui/Button.js';

function loadHidden(): boolean {
  try {
    return localStorage.getItem(WORKFLOW_STEPS_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

function saveHidden(hidden: boolean): void {
  try {
    localStorage.setItem(WORKFLOW_STEPS_HIDDEN_KEY, hidden ? '1' : '0');
  } catch {
    /* remembered only when storage is available */
  }
}

/**
 * The workflow an agent is working through: title, progress and its steps.
 * The step list folds away (▸ / ▾); the choice is remembered per viewer and
 * shared by the chat card and Messages.
 */
export function WorkflowRunSteps({
  run,
  onStop,
  className = '',
}: {
  run: WorkflowRun;
  onStop?: () => void;
  className?: string;
}) {
  const [hidden, setHidden] = useState(loadHidden);
  const done = run.steps.filter((st) => st.state === 'done' || st.state === 'skipped').length;
  const waiting = run.steps.findIndex((st) => st.state === 'waiting');
  const toggle = () => {
    setHidden((h) => {
      saveHidden(!h);
      return !h;
    });
  };
  return (
    <div className={`flex flex-col gap-2 ${className}`} data-testid="chat-run">
      <div className="flex items-center gap-6 text-xs">
        <button
          className="flex flex-1 min-w-0 items-center gap-6 bg-transparent border-0 p-0 text-text text-left cursor-pointer"
          onClick={toggle}
          aria-expanded={!hidden}
          title={hidden ? 'Show the workflow steps' : 'Hide the workflow steps'}
          data-testid="chat-run-toggle"
        >
          <span className="w-12">{hidden ? '▸' : '▾'}</span>
          <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
            Workflow: {run.title}
          </span>
        </button>
        {hidden && waiting >= 0 && (
          <span className="text-2xs text-status-permission">step {waiting + 1} needs you</span>
        )}
        <span className="text-2xs text-text-muted">
          {done}/{run.steps.length}
        </span>
        {onStop && (
          <Button size="sm" variant="ghost" onClick={onStop}>
            Stop
          </Button>
        )}
      </div>
      {!hidden &&
        run.steps.map((st, i) => (
          <div
            key={i}
            className={`flex gap-6 text-2xs ${
              st.state === 'waiting'
                ? 'text-status-permission'
                : st.state === 'done'
                  ? 'text-text-muted'
                  : st.state === 'skipped'
                    ? 'text-text-muted line-through'
                    : 'text-text'
            }`}
            data-testid="chat-run-step"
          >
            <span className="w-12">
              {st.state === 'done' ? '✓' : st.state === 'waiting' ? '?' : i + 1}
            </span>
            <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
              {st.text}
            </span>
            <span className="opacity-70">{st.kind}</span>
          </div>
        ))}
    </div>
  );
}
