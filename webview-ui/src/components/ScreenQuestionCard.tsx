import { useEffect, useState } from 'react';

import type { ScreenQuestion } from '../../../core/src/messages.js';
import { SCREEN_QUESTION_RETRY_MS } from '../constants.js';
import { Button } from './ui/Button.js';

interface ScreenQuestionCardProps {
  agentLabel: string;
  question: ScreenQuestion;
  /** Pick an option; `followUp` is typed to the agent once the question is gone. */
  onChoose: (option: number, followUp?: string) => void;
  onOpenAgent: () => void;
}

/** "No, and tell Claude what to do differently": the answer goes on in words. */
const TELL_RE = /tell claude/i;

/**
 * A question an office-run agent shows on its terminal (trust this folder,
 * a permission prompt, a multiple choice), as a dialog: one button per
 * on-screen option, so nobody has to open the Screen view and press keys.
 */
export function ScreenQuestionCard({
  agentLabel,
  question,
  onChoose,
  onOpenAgent,
}: ScreenQuestionCardProps) {
  const [sent, setSent] = useState<number | null>(null);
  const [telling, setTelling] = useState<number | null>(null);
  const [text, setText] = useState('');
  // Hidden to a one-line bar, not dismissed: the agent still waits on it.
  const [collapsed, setCollapsed] = useState(false);

  // A click that didn't take (the screen never moved on) can be tried again.
  useEffect(() => {
    if (sent === null) return;
    const timer = setTimeout(() => setSent(null), SCREEN_QUESTION_RETRY_MS);
    return () => clearTimeout(timer);
  }, [sent]);

  const choose = (option: number, followUp?: string) => {
    setSent(option);
    onChoose(option, followUp);
  };

  const pick = (number: number, label: string) => {
    if (TELL_RE.test(label)) {
      setTelling(number);
      return;
    }
    choose(number);
  };

  const [heading, ...details] = question.prompt;

  if (collapsed) {
    return (
      <div
        role="alert"
        aria-label={`${agentLabel} is asking: ${heading ?? 'a question'}`}
        className="pixel-panel flex items-center gap-6 px-8 py-4 border-status-permission text-sm"
        data-testid="screen-question-collapsed"
      >
        <span className="text-text shrink-0">{agentLabel}</span>
        <span className="text-text-muted truncate">is asking{heading ? `: ${heading}` : ''}</span>
        <Button
          size="sm"
          className="ml-auto shrink-0"
          onClick={() => setCollapsed(false)}
          data-testid="screen-question-show"
        >
          Show
        </Button>
      </div>
    );
  }

  return (
    <div
      role="alertdialog"
      aria-label={`${agentLabel} is asking: ${heading ?? 'a question'}`}
      className="pixel-panel flex flex-col gap-6 p-8 border-status-permission"
      data-testid="screen-question"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && telling === null) {
          e.preventDefault();
          setCollapsed(true);
          return;
        }
        if (telling !== null || e.altKey || e.ctrlKey || e.metaKey) return;
        const option = question.options.find((o) => String(o.number) === e.key);
        if (option) {
          e.preventDefault();
          pick(option.number, option.label);
        }
      }}
    >
      <div className="flex items-baseline gap-6 text-sm">
        <button
          onClick={onOpenAgent}
          className="bg-transparent border-0 p-0 text-text underline cursor-pointer text-sm"
          title="Open this agent's chat"
        >
          {agentLabel}
        </button>
        <span className="text-text-muted">is asking</span>
        <button
          onClick={() => setCollapsed(true)}
          className="ml-auto bg-transparent border-0 p-0 text-text-muted cursor-pointer text-sm"
          title="Hide (the agent still waits for an answer)"
          aria-label="Hide question"
          data-testid="screen-question-hide"
        >
          ×
        </button>
      </div>
      {heading && <div className="text-lg leading-tight">{heading}</div>}
      {details.length > 0 && (
        <pre className="m-0 px-6 py-4 bg-bg-dark border-2 border-bg-thumb text-code-sm whitespace-pre-wrap break-all max-h-120 overflow-y-auto">
          {details.join('\n')}
        </pre>
      )}
      <div className="flex flex-col gap-4">
        {question.options.map((o, i) => (
          <Button
            key={o.number}
            size="sm"
            className="flex items-start gap-8 text-left"
            disabled={sent !== null}
            autoFocus={i === 0}
            onClick={() => pick(o.number, o.label)}
            data-testid="screen-question-option"
          >
            <span className="shrink-0 w-16 text-center border-2 border-border text-xs">
              {o.number}
            </span>
            <span>{sent === o.number ? `${o.label} …` : o.label}</span>
          </Button>
        ))}
      </div>
      {telling !== null && (
        <form
          className="flex gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            choose(telling, text.trim() || undefined);
            setTelling(null);
            setText('');
          }}
        >
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') setTelling(null);
            }}
            placeholder="What should it do instead?"
            className="flex-1 min-w-0 bg-bg-dark border-2 border-accent px-6 py-2 text-sm text-text"
            data-testid="screen-question-text"
          />
          <Button size="sm" variant="accent" type="submit">
            Send
          </Button>
        </form>
      )}
      <div className="flex items-center gap-6 text-2xs text-text-muted">
        <button
          onClick={onOpenAgent}
          className="bg-transparent border-0 p-0 text-text-muted underline cursor-pointer text-2xs"
        >
          Open screen
        </button>
        <span className="ml-auto">
          Keys {question.options[0]?.number}–{question.options[question.options.length - 1]?.number}
        </span>
      </div>
    </div>
  );
}
