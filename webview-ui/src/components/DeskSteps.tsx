import { useRef, useState } from 'react';

import type { DeskSubtask, WorkflowStepKind } from '../../../core/src/messages.js';
import { TASK_STEP_REF_MAX_CHARS, TASK_SUBTASK_MAX_CHARS } from '../constants.js';
import { moveStepTo, newStepId, nextStepKind } from '../taskDesk.js';
import { Button } from './ui/Button.js';

const KIND_CLASS: Record<WorkflowStepKind, string> = {
  do: 'text-accent-bright border-accent-bright',
  gate: 'text-status-permission border-status-permission',
  show: 'text-status-success border-status-success',
};

const KIND_HELP: Record<WorkflowStepKind, string> = {
  do: 'do — the agent does the work',
  gate: 'gate — the agent stops and waits for your go-ahead',
  show: 'show — the agent shows you a file',
};

interface DeskStepsProps {
  taskNum: number;
  steps: DeskSubtask[];
  /** Leading steps that cannot be moved or changed (done, or the one the agent is on). */
  locked: number;
  /** Absent = read only. */
  onChange?: (steps: DeskSubtask[]) => void;
  /** Answer a gate step the agent is waiting at (1-based). */
  onAnswerGate?: (step: number, decision: 'continue' | 'stop') => void;
}

/**
 * A card's steps: drag the handle (or use ↑ ↓) to move one, click its kind to
 * cycle do → gate → show, edit its text and its ref in place. Steps the agent
 * has finished, and the one it is on, are locked while it builds.
 */
export function DeskSteps({ taskNum, steps, locked, onChange, onAnswerGate }: DeskStepsProps) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newKind, setNewKind] = useState<WorkflowStepKind>('do');
  const [openRef, setOpenRef] = useState<number | null>(null);
  const rowsRef = useRef<HTMLOListElement>(null);
  const editable = !!onChange;

  const update = (index: number, change: Partial<DeskSubtask>) =>
    onChange?.(steps.map((s, i) => (i === index ? { ...s, ...change } : s)));
  const move = (from: number, to: number) => onChange?.(moveStepTo(steps, from, to, locked));
  const add = () => {
    const title = newTitle.trim();
    if (!title) return;
    onChange?.([
      ...steps,
      {
        id: newStepId(),
        ...(newKind !== 'do' ? { kind: newKind } : {}),
        title,
        skip: false,
        done: false,
        by: 'you',
      },
    ]);
    setNewTitle('');
  };

  // Which row the pointer is over, by row midpoints.
  const rowAt = (clientY: number): number => {
    const rows = rowsRef.current ? [...rowsRef.current.children] : [];
    let at = 0;
    rows.forEach((row, i) => {
      const r = row.getBoundingClientRect();
      if (clientY > r.top + r.height / 2) at = i;
    });
    return at;
  };

  return (
    <div className="flex flex-col gap-4" data-testid="desk-steps">
      <span className="text-2xs text-text-muted">
        Steps · #{taskNum}
        {editable && ' · drag ⠿ to move · click the kind to change it'}
      </span>
      {steps.length > 0 && (
        <ol ref={rowsRef} className="m-0 p-0 list-none flex flex-col gap-2">
          {steps.map((step, index) => {
            const isLocked = index < locked;
            const canEdit = editable && !isLocked;
            const kind = step.kind ?? 'do';
            return (
              <li
                key={step.id ?? `new-${index}`}
                className={`flex flex-col gap-2 px-6 py-2 border-2 ${
                  step.waiting
                    ? 'border-status-permission'
                    : step.done
                      ? 'border-status-success'
                      : 'border-border'
                } ${dragFrom === index ? 'opacity-50 border-dashed' : ''} ${
                  isLocked ? 'bg-bg-dark' : ''
                }`}
                data-testid="desk-step"
              >
                <div className="flex gap-6 items-center text-sm">
                  <span
                    className={`select-none text-text-muted w-14 text-center ${
                      canEdit ? 'cursor-grab touch-none' : ''
                    }`}
                    aria-hidden="true"
                    title={
                      canEdit ? 'Drag to move' : isLocked ? 'Locked while the agent works' : ''
                    }
                    onPointerDown={(e) => {
                      if (!canEdit) return;
                      e.currentTarget.setPointerCapture(e.pointerId);
                      setDragFrom(index);
                    }}
                    onPointerMove={(e) => {
                      if (dragFrom !== index) return;
                      const to = rowAt(e.clientY);
                      if (to !== dragFrom && to >= locked) {
                        move(dragFrom, to);
                        setDragFrom(to);
                      }
                    }}
                    onPointerUp={() => setDragFrom(null)}
                  >
                    {isLocked && editable ? '·' : '⠿'}
                  </span>
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() => update(index, { kind: nextStepKind(kind) })}
                    className={`w-50 shrink-0 px-2 text-2xs uppercase border-2 bg-transparent ${KIND_CLASS[kind]} ${
                      canEdit ? 'cursor-pointer' : 'cursor-default'
                    }`}
                    title={KIND_HELP[kind]}
                    aria-label={`Step ${index + 1} kind: ${kind}`}
                    data-testid="desk-step-kind"
                  >
                    {kind}
                  </button>
                  {canEdit ? (
                    <input
                      className="flex-1 min-w-0 bg-transparent text-text text-sm border-0 border-b border-dashed border-transparent focus:border-accent outline-none px-0"
                      value={step.title}
                      maxLength={TASK_SUBTASK_MAX_CHARS}
                      aria-label={`Step ${index + 1}`}
                      onChange={(e) => update(index, { title: e.target.value })}
                    />
                  ) : (
                    <span
                      className={`flex-1 min-w-0 break-words ${step.skip ? 'opacity-50 line-through' : ''}`}
                    >
                      {step.title}
                    </span>
                  )}
                  {step.by === 'you' && <span className="text-2xs text-text-muted">yours</span>}
                  <span className="text-2xs text-text-muted shrink-0">
                    {index + 1}
                    {step.skip
                      ? ' skipped'
                      : step.done
                        ? ' done'
                        : step.waiting
                          ? ' waiting'
                          : isLocked && locked > 0
                            ? ' now'
                            : ''}
                  </span>
                  {canEdit && (
                    <span className="flex gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => move(index, index - 1)}
                        disabled={index <= locked}
                        aria-label={`Move step ${index + 1} up`}
                      >
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => move(index, index + 1)}
                        disabled={index === steps.length - 1}
                        aria-label={`Move step ${index + 1} down`}
                      >
                        ↓
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setOpenRef((v) => (v === index ? null : index))}
                        aria-label={`Ref for step ${index + 1}`}
                        title="The file this step is about"
                      >
                        @
                      </Button>
                      <input
                        type="checkbox"
                        checked={!step.skip}
                        aria-label={`Include step ${index + 1}`}
                        title="Include this step"
                        onChange={() => update(index, { skip: !step.skip })}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onChange?.(steps.filter((_, i) => i !== index))}
                        aria-label={`Remove step ${index + 1}`}
                      >
                        ×
                      </Button>
                    </span>
                  )}
                </div>
                {canEdit && openRef === index ? (
                  <input
                    className="ml-20 bg-bg-dark text-text text-code-sm border-2 border-border focus:border-accent outline-none px-4"
                    value={step.ref ?? ''}
                    maxLength={TASK_STEP_REF_MAX_CHARS}
                    placeholder={
                      kind === 'show' ? 'src/app.ts --lines 10-40' : 'file the step is about'
                    }
                    aria-label={`Ref for step ${index + 1}`}
                    onChange={(e) => update(index, { ref: e.target.value || undefined })}
                  />
                ) : (
                  step.ref && (
                    <span className="ml-20 text-code-sm text-text-muted break-all">
                      ref: {step.ref}
                    </span>
                  )
                )}
                {step.waiting && (
                  <div className="ml-20 flex flex-wrap items-center gap-6 text-sm">
                    <span className="flex-1 min-w-0 text-status-permission">
                      {step.ask ? `Asks: ${step.ask}` : 'Waiting for your go-ahead.'}
                    </span>
                    {onAnswerGate && (
                      <>
                        <Button
                          size="sm"
                          variant="accent"
                          onClick={() => onAnswerGate(index + 1, 'continue')}
                          data-testid="desk-gate-continue"
                        >
                          Continue
                        </Button>
                        <Button size="sm" onClick={() => onAnswerGate(index + 1, 'stop')}>
                          Stop
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {editable && (
        <div className="flex gap-6">
          <button
            type="button"
            onClick={() => setNewKind(nextStepKind(newKind))}
            className={`w-50 shrink-0 px-2 text-2xs uppercase border-2 bg-transparent cursor-pointer ${KIND_CLASS[newKind]}`}
            title={KIND_HELP[newKind]}
            aria-label={`New step kind: ${newKind}`}
          >
            {newKind}
          </button>
          <input
            className="w-full px-8 py-4 bg-bg-dark text-text text-sm border-2 border-border rounded-none outline-none focus:border-accent"
            value={newTitle}
            maxLength={TASK_SUBTASK_MAX_CHARS}
            placeholder="Add a step"
            aria-label="New step"
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button size="sm" onClick={add}>
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
