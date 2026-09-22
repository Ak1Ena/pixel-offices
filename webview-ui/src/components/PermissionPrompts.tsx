import { useEffect, useState } from 'react';

import type {
  AgentPermissionAsk,
  GateDecision,
  PermissionDecision,
  ScreenQuestion,
  WorkflowRun,
} from '../../../core/src/messages.js';
import {
  PERMISSION_PROMPTS_MAX_SHOWN,
  PERMISSION_PROMPTS_WIDTH_PX,
  PERMISSION_PROMPTS_Z_INDEX,
} from '../constants.js';
import { ScreenQuestionCard } from './ScreenQuestionCard.js';
import { Button } from './ui/Button.js';

interface PermissionPromptsProps {
  asks: AgentPermissionAsk[];
  labelOf: (agentId: number) => string;
  onAnswer: (ask: AgentPermissionAsk, decision: PermissionDecision) => void;
  onOpenAgent: (agentId: number) => void;
  /** Questions on office-run agents' screens, shown as dialogs (privileged clients only). */
  questions?: Array<{ agentId: number; question: ScreenQuestion }>;
  onChooseQuestion?: (agentId: number, key: string, option: number, followUp?: string) => void;
  /** Workflow gates waiting on the user (privileged clients only). */
  gates?: Array<{ run: WorkflowRun; step: number }>;
  onAnswerGate?: (runId: string, step: number, decision: GateDecision) => void;
}

function secondsLeft(ask: AgentPermissionAsk, now: number): number | null {
  if (ask.expiresAt === undefined) return null;
  return Math.max(0, Math.round((ask.expiresAt - now) / 1000));
}

/**
 * Permission prompts waiting on the office: an agent's hook holds the prompt
 * (so it is not in the terminal) until Allow / Deny here, "Terminal" hands it
 * back to the agent's own terminal, and when the wait runs out it goes there
 * on its own.
 */
export function PermissionPrompts({
  asks,
  labelOf,
  onAnswer,
  onOpenAgent,
  questions = [],
  onChooseQuestion,
  gates = [],
  onAnswerGate,
}: PermissionPromptsProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (asks.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [asks.length]);

  const shownGates = onAnswerGate ? gates.slice(0, PERMISSION_PROMPTS_MAX_SHOWN) : [];
  const shownQuestions = onChooseQuestion
    ? questions.slice(0, Math.max(0, PERMISSION_PROMPTS_MAX_SHOWN - shownGates.length))
    : [];
  if (asks.length === 0 && shownQuestions.length === 0 && shownGates.length === 0) return null;
  const shown = asks.slice(
    0,
    Math.max(0, PERMISSION_PROMPTS_MAX_SHOWN - shownQuestions.length - shownGates.length),
  );
  const waiting =
    asks.length + (onChooseQuestion ? questions.length : 0) + (onAnswerGate ? gates.length : 0);

  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 top-8 flex flex-col gap-6 max-w-[calc(100%-16px)]"
      style={{ width: PERMISSION_PROMPTS_WIDTH_PX, zIndex: PERMISSION_PROMPTS_Z_INDEX }}
      aria-live="polite"
      data-testid="permission-prompts"
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {shownGates.map(({ run, step }) => (
        <div
          key={`${run.runId}:${step}`}
          role="alertdialog"
          aria-label={`${labelOf(run.agentId)} needs your go-ahead`}
          className="pixel-panel flex flex-col gap-6 p-8 border-status-permission"
          data-testid="workflow-gate"
        >
          <div className="flex items-baseline gap-6 text-sm">
            <button
              onClick={() => onOpenAgent(run.agentId)}
              className="bg-transparent border-0 p-0 text-text underline cursor-pointer text-sm"
            >
              {labelOf(run.agentId)}
            </button>
            <span className="text-text-muted">needs your go-ahead</span>
          </div>
          <span className="text-2xs text-status-permission uppercase">
            {run.title} · step {step} of {run.steps.length}
          </span>
          <span className="text-sm">{run.steps[step - 1]?.text}</span>
          <div className="flex gap-6 justify-end">
            <Button size="sm" onClick={() => onAnswerGate?.(run.runId, step, 'stop')}>
              Stop workflow
            </Button>
            <Button
              variant="accent"
              size="sm"
              onClick={() => onAnswerGate?.(run.runId, step, 'continue')}
              data-testid="workflow-gate-continue"
            >
              Continue
            </Button>
          </div>
        </div>
      ))}
      {shownQuestions.map(({ agentId, question }) => (
        <ScreenQuestionCard
          key={`${agentId}:${question.key}`}
          agentLabel={labelOf(agentId)}
          question={question}
          onChoose={(option, followUp) =>
            onChooseQuestion?.(agentId, question.key, option, followUp)
          }
          onOpenAgent={() => onOpenAgent(agentId)}
        />
      ))}
      {shown.map((ask) => {
        const left = secondsLeft(ask, now);
        return (
          <div
            key={ask.requestId}
            role="alertdialog"
            aria-label={`${labelOf(ask.id)} asks to use ${ask.toolName}`}
            className="pixel-panel flex flex-col gap-4 p-8 border-status-permission"
            data-testid="permission-prompt"
          >
            <div className="flex items-baseline gap-6 text-sm">
              <button
                onClick={() => onOpenAgent(ask.id)}
                className="bg-transparent border-0 p-0 text-text underline cursor-pointer text-sm"
                title="Open this agent's chat"
              >
                {labelOf(ask.id)}
              </button>
              <span className="text-text-muted">wants to use</span>
              <span className="text-text">{ask.toolName}</span>
              {left !== null && (
                <span
                  className="ml-auto text-2xs text-text-muted"
                  title="Then it asks in its terminal"
                >
                  {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
                </span>
              )}
            </div>
            {ask.detail && (
              <pre className="m-0 px-6 py-4 bg-bg-dark border-2 border-bg-thumb text-2xs whitespace-pre-wrap break-all max-h-120 overflow-y-auto">
                {ask.detail}
              </pre>
            )}
            <div className="flex gap-6 justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onAnswer(ask, 'terminal')}
                title="Stop waiting and ask in the agent's own terminal"
              >
                Terminal
              </Button>
              <Button size="sm" onClick={() => onAnswer(ask, 'deny')} data-testid="permission-deny">
                Deny
              </Button>
              <Button
                variant="accent"
                size="sm"
                onClick={() => onAnswer(ask, 'allow')}
                data-testid="permission-allow"
                autoFocus
              >
                Allow
              </Button>
            </div>
          </div>
        );
      })}
      {waiting > shown.length + shownQuestions.length + shownGates.length && (
        <div className="pixel-panel px-8 py-2 text-2xs text-text-muted text-center">
          +{waiting - shown.length - shownQuestions.length - shownGates.length} more waiting
        </div>
      )}
    </div>
  );
}
