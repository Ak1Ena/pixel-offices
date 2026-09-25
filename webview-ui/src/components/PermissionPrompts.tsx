import { useEffect, useState } from 'react';

import type {
  AgentClearRequest,
  AgentPermissionAsk,
  DeskSubtask,
  DeskTask,
  GateDecision,
  PermissionDecision,
  ScreenQuestion,
  WorkflowRun,
} from '../../../core/src/messages.js';
import { PERMISSION_PROMPTS_Z_INDEX } from '../constants.js';
import { useTunables } from '../hooks/useTunables.js';
import { tunable } from '../tunableStore.js';
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
  /** Which question each agent has hidden (agentId → question key). */
  hiddenQuestions?: Record<number, string>;
  onHideQuestion?: (agentId: number, key: string, hidden: boolean) => void;
  /** Workflow gates waiting on the user (privileged clients only). */
  gates?: Array<{ run: WorkflowRun; step: number }>;
  onAnswerGate?: (runId: string, step: number, decision: GateDecision) => void;
  /** Agents asking to have their own context cleared (privileged clients only). */
  clearRequests?: AgentClearRequest[];
  onAnswerClear?: (agentId: number, allow: boolean) => void;
  /** Task desk cards whose agent waits at a gate step (privileged clients only). */
  deskGates?: Array<{ task: DeskTask; step: number; sub: DeskSubtask }>;
  onAnswerDeskGate?: (taskId: string, step: number, decision: GateDecision) => void;
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
  hiddenQuestions = {},
  onHideQuestion,
  gates = [],
  onAnswerGate,
  clearRequests = [],
  onAnswerClear,
  deskGates = [],
  onAnswerDeskGate,
}: PermissionPromptsProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (asks.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [asks.length]);

  const maxShown = useTunables().permissionPromptsMaxShown;
  // Fill the stack in this order, each kind taking what the earlier ones left.
  let room = maxShown;
  const take = <T,>(list: T[], offered: boolean): T[] => {
    const out = offered ? list.slice(0, Math.max(0, room)) : [];
    room -= out.length;
    return out;
  };
  const shownDeskGates = take(deskGates, !!onAnswerDeskGate);
  const shownGates = take(gates, !!onAnswerGate);
  const shownQuestions = take(questions, !!onChooseQuestion);
  const shownClears = take(clearRequests, !!onAnswerClear);
  const shownOthers =
    shownDeskGates.length + shownGates.length + shownQuestions.length + shownClears.length;
  if (asks.length === 0 && shownOthers === 0) return null;
  const shown = asks.slice(0, Math.max(0, maxShown - shownOthers));
  const waiting =
    asks.length +
    (onChooseQuestion ? questions.length : 0) +
    (onAnswerGate ? gates.length : 0) +
    (onAnswerClear ? clearRequests.length : 0) +
    (onAnswerDeskGate ? deskGates.length : 0);

  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 top-8 flex flex-col gap-6 max-w-[calc(100%-16px)]"
      style={{ width: tunable('permissionPromptsWidthPx'), zIndex: PERMISSION_PROMPTS_Z_INDEX }}
      aria-live="polite"
      data-testid="permission-prompts"
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {shownDeskGates.map(({ task, step, sub }) => (
        <div
          key={`desk:${task.id}:${step}`}
          role="alertdialog"
          aria-label={`Card #${task.num} needs your go-ahead`}
          className="pixel-panel flex flex-col gap-6 p-8 border-status-permission"
          data-testid="desk-gate"
        >
          <div className="flex items-baseline gap-6 text-sm">
            {task.claimedBy !== undefined ? (
              <button
                onClick={() => onOpenAgent(task.claimedBy!)}
                className="bg-transparent border-0 p-0 text-text underline cursor-pointer text-sm"
              >
                {labelOf(task.claimedBy)}
              </button>
            ) : (
              <span>An agent</span>
            )}
            <span className="text-text-muted">needs your go-ahead</span>
          </div>
          <span className="text-2xs text-status-permission uppercase">
            Card #{task.num} · step {step}
          </span>
          <span className="text-sm">{sub.title}</span>
          {sub.ask && <span className="text-sm text-text-muted">“{sub.ask}”</span>}
          <div className="flex gap-6 justify-end">
            <Button size="sm" onClick={() => onAnswerDeskGate?.(task.id, step, 'stop')}>
              Stop
            </Button>
            <Button
              variant="accent"
              size="sm"
              onClick={() => onAnswerDeskGate?.(task.id, step, 'continue')}
              data-testid="desk-gate-prompt-continue"
            >
              Continue
            </Button>
          </div>
        </div>
      ))}
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
      {shownClears.map((request) => (
        <div
          key={`clear:${request.agentId}`}
          role="alertdialog"
          aria-label={`${labelOf(request.agentId)} asks to clear its context`}
          className="pixel-panel flex flex-col gap-6 p-8 border-status-permission"
          data-testid="clear-request"
        >
          <div className="flex items-baseline gap-6 text-sm">
            <button
              onClick={() => onOpenAgent(request.agentId)}
              className="bg-transparent border-0 p-0 text-text underline cursor-pointer text-sm"
            >
              {labelOf(request.agentId)}
            </button>
            <span className="text-text-muted">asks to clear its context</span>
          </div>
          {request.reason && <span className="text-sm">“{request.reason}”</span>}
          <span className="text-2xs text-text-muted">
            /clear after its turn ends. Nothing is carried over.
          </span>
          <div className="flex gap-6 justify-end">
            <Button size="sm" onClick={() => onAnswerClear?.(request.agentId, false)}>
              Not now
            </Button>
            <Button
              variant="accent"
              size="sm"
              onClick={() => onAnswerClear?.(request.agentId, true)}
              data-testid="clear-request-allow"
            >
              Allow
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
          collapsed={hiddenQuestions[agentId] === question.key}
          onCollapse={(hidden) => onHideQuestion?.(agentId, question.key, hidden)}
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
              <pre className="m-0 px-6 py-4 bg-bg-dark border border-bg-thumb text-code-sm whitespace-pre-wrap break-all max-h-120 overflow-y-auto">
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
      {waiting > shown.length + shownOthers && (
        <div className="pixel-panel px-8 py-2 text-2xs text-text-muted text-center">
          +{waiting - shown.length - shownOthers} more waiting
        </div>
      )}
    </div>
  );
}
