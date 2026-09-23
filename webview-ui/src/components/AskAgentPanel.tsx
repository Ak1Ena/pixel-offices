import { useEffect, useState } from 'react';

import type { AskAgent } from '../askAgent.js';
import { askMessage, fileFolder, rankAgents } from '../askAgent.js';
import type { DocRef } from '../docViewer.js';
import { fileBaseName, refLabel } from '../docViewer.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

interface AskAgentPanelProps {
  /** The open file's path. */
  filePath: string;
  /** Places picked so far (tray + the current pick); empty = the whole file. */
  refs: DocRef[];
  /** Agents the office can type into. */
  agents: AskAgent[];
  /** Who to select first (the open chat, the agent that asked "show me"…). */
  preferred?: number | null;
  /** The office can start an agent (standalone with node-pty, private link). */
  canStartAgent: boolean;
  onSend: (agentId: number, text: string) => void;
  /** Called after the question went out; the viewer clears its picks. */
  onSent: () => void;
  onOpenChat: (agentId: number) => void;
  onClose: () => void;
}

const NEW_AGENT = -1;

/**
 * "Ask an agent" beside an open document: the question, who gets it (an agent
 * already in the office, ranked by folder, or a new one started in the file's
 * folder), and what is attached — references to the picked places, never the
 * text. The viewer stays open; the reply arrives in the agent's chat.
 */
export function AskAgentPanel({
  filePath,
  refs,
  agents,
  preferred,
  canStartAgent,
  onSend,
  onSent,
  onOpenChat,
  onClose,
}: AskAgentPanelProps) {
  const ranked = rankAgents(agents);
  const [question, setQuestion] = useState('');
  const [target, setTarget] = useState<number | null>(null);
  const [status, setStatus] = useState<
    | { kind: 'sent'; agentId: number; label: string }
    | { kind: 'starting' }
    | { kind: 'error'; message: string }
    | null
  >(null);

  // First choice: the preferred agent, else the best-ranked, else a new agent.
  useEffect(() => {
    setTarget((current) => {
      if (current !== null && (current === NEW_AGENT || agents.some((a) => a.id === current)))
        return current;
      if (preferred != null && agents.some((a) => a.id === preferred)) return preferred;
      return ranked[0]?.id ?? (canStartAgent ? NEW_AGENT : null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-pick only when who is here changes
  }, [agents.map((a) => a.id).join(','), preferred, canStartAgent]);

  // A new agent: wait for the office to say it started.
  useEffect(() => {
    if (status?.kind !== 'starting') return;
    return transport.onMessage((msg) => {
      if (msg.type !== 'startAgentResult') return;
      if (msg.ok) {
        setStatus({ kind: 'sent', agentId: -1, label: 'the new agent' });
        setQuestion('');
        onSent();
      } else {
        setStatus({ kind: 'error', message: msg.error ?? 'Could not start the agent.' });
      }
    });
  }, [status?.kind, onSent]);

  const folder = fileFolder(filePath);
  const send = () => {
    const text = askMessage(question, refs, filePath);
    if (target === NEW_AGENT) {
      setStatus({ kind: 'starting' });
      transport.send({ type: 'startAgent', cwd: folder, firstMessage: text });
      return;
    }
    if (target === null) return;
    onSend(target, text);
    const label = agents.find((a) => a.id === target)?.label ?? 'the agent';
    setStatus({ kind: 'sent', agentId: target, label });
    setQuestion('');
    onSent();
  };

  return (
    <aside
      aria-label="Ask an agent"
      className="w-300 max-w-[50%] shrink-0 flex flex-col gap-8 p-10 bg-bg-dark border-l-2 border-border overflow-y-auto"
      data-testid="ask-agent"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-6">
        <span className="flex-1 text-base">Ask an agent</span>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close" title="Close">
          ×
        </Button>
      </div>

      <label className="flex flex-col gap-4 text-xs" htmlFor="ask-agent-question">
        Your question
        <textarea
          id="ask-agent-question"
          autoFocus
          rows={4}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="What does this say about churn? Can you fix the totals?"
          className="w-full resize-none p-6 bg-bg text-text font-reading text-read border-2 border-border focus:border-accent rounded-none outline-none"
          data-testid="ask-agent-question"
        />
      </label>

      <div className="flex flex-col gap-4 text-xs">
        <span>About</span>
        <div className="flex flex-wrap gap-4">
          {(refs.length > 0 ? refs : [{ path: filePath }]).map((ref, i) => (
            <span
              key={`${refLabel(ref)}-${i}`}
              className="px-6 py-1 bg-active-bg border-2 border-accent text-code-sm font-mono"
            >
              {refs.length > 0 ? refLabel(ref) : `${fileBaseName(filePath)} (whole file)`}
            </span>
          ))}
        </div>
        <span className="text-2xs text-text-muted">
          Pick paragraphs, cells, slides or lines in the document to narrow it down. Only the place
          is sent, never the text.
        </span>
      </div>

      <fieldset className="flex flex-col gap-2 text-sm border-0 p-0 m-0">
        <legend className="text-xs mb-4">Who</legend>
        {ranked.length === 0 && !canStartAgent && (
          <span className="text-2xs text-text-muted">
            No agent the office can type into. Start one with + Agent or `pixel-office claude`.
          </span>
        )}
        {ranked.map((agent) => (
          <label
            key={agent.id}
            className={`flex items-center gap-6 px-6 py-2 border-2 cursor-pointer ${
              target === agent.id ? 'border-accent bg-active-bg' : 'border-transparent'
            }`}
          >
            <input
              type="radio"
              name="ask-agent-target"
              checked={target === agent.id}
              onChange={() => setTarget(agent.id)}
            />
            <span className="flex-1 min-w-0 truncate">{agent.label}</span>
            {agent.inFolder && <span className="text-2xs text-status-success">this folder</span>}
            {agent.busy && <span className="text-2xs text-text-muted">busy</span>}
          </label>
        ))}
        {canStartAgent && folder && (
          <label
            className={`flex items-center gap-6 px-6 py-2 border-2 cursor-pointer ${
              target === NEW_AGENT ? 'border-accent bg-active-bg' : 'border-transparent'
            }`}
          >
            <input
              type="radio"
              name="ask-agent-target"
              checked={target === NEW_AGENT}
              onChange={() => setTarget(NEW_AGENT)}
            />
            <span className="flex-1 min-w-0 truncate" title={folder}>
              + New agent in {fileBaseName(folder)}
            </span>
          </label>
        )}
      </fieldset>

      <Button
        variant={target !== null && status?.kind !== 'starting' ? 'accent' : 'disabled'}
        size="md"
        disabled={target === null || status?.kind === 'starting'}
        onClick={send}
        data-testid="ask-agent-send"
      >
        {status?.kind === 'starting'
          ? 'Starting agent…'
          : target !== null && agents.find((a) => a.id === target)?.busy
            ? 'Queue question'
            : 'Ask'}
      </Button>
      <span className="text-2xs text-text-muted">Ctrl/⌘+Enter sends.</span>

      {status?.kind === 'sent' && (
        <div className="flex flex-col gap-4 p-6 border-2 border-status-success text-xs">
          <span>
            Sent to {status.label}. The answer appears in its chat
            {status.agentId === -1 ? ' once it has started' : ''}.
          </span>
          {status.agentId !== -1 && (
            <Button size="sm" onClick={() => onOpenChat(status.agentId)}>
              Open chat
            </Button>
          )}
        </div>
      )}
      {status?.kind === 'error' && <span className="text-xs text-danger">{status.message}</span>}
    </aside>
  );
}
