import { useEffect, useRef, useState } from 'react';

import type { ChatEntry } from '../../../core/src/messages.js';
import type { AskAgent } from '../askAgent.js';
import {
  askMessage,
  fileFolder,
  followUpMessage,
  loadDocChatAgent,
  newAgentId,
  rankAgents,
  recentEntries,
  saveDocChatAgent,
} from '../askAgent.js';
import type { DocRef } from '../docViewer.js';
import { fileBaseName, refLabel } from '../docViewer.js';
import { parseMarkdown } from '../messenger.js';
import { transport } from '../transport/index.js';
import { MessageText } from './FileAttachments.js';
import { Markdown } from './MessengerPanel.js';
import { Button } from './ui/Button.js';

interface DocChatPanelProps {
  /** The open file's path. */
  filePath: string;
  /** Places picked in the document (tray + the current pick), sent with the next message. */
  refs: DocRef[];
  /** Agents the office can type into. */
  agents: AskAgent[];
  /** Who to talk to when this file has no agent yet (the open chat, the agent that asked…). */
  preferred?: number | null;
  /** The office can start an agent (standalone with node-pty, private link). */
  canStartAgent: boolean;
  /** An agent's chat (the same thread its chat card shows). */
  entriesFor: (agentId: number) => ChatEntry[];
  onSend: (agentId: number, text: string) => void;
  /** A message went out: the picked places are used up. */
  onSent: () => void;
  onOpenChat: (agentId: number) => void;
  onClose: () => void;
}

const NEW_AGENT = -1;

/** One chat row, compact for a side panel. */
function Row({ entry }: { entry: ChatEntry }) {
  if (entry.role === 'tool') {
    return (
      <div className="flex gap-6 text-2xs text-text-muted px-2">
        <span>{entry.toolDone ? '✓' : '…'}</span>
        <span className="min-w-0 truncate" title={entry.text}>
          {entry.text}
        </span>
      </div>
    );
  }
  if (entry.role === 'user') {
    return (
      <div className="self-end max-w-[90%] px-8 py-4 bg-active-bg border border-accent font-reading text-read-sm whitespace-pre-wrap break-words">
        <MessageText text={entry.text} />
      </div>
    );
  }
  return (
    <div className="max-w-full px-8 py-4 bg-bg border border-border font-reading text-read-sm break-words">
      <Markdown blocks={parseMarkdown(entry.text)} />
    </div>
  );
}

/**
 * Talk to an agent about the open document, beside it. Pick the agent once
 * (remembered for this file) or start a new one in the file's folder; the
 * conversation is that agent's own chat, shown here. The first message names
 * the file; every message carries the places picked since the last one —
 * references only, never the text. The agent can read places with
 * `pixel-office doc read` and change them with `pixel-office doc edit`; its
 * edits show up in the viewer (or wait in Review changes, as you set).
 */
export function DocChatPanel({
  filePath,
  refs,
  agents,
  preferred,
  canStartAgent,
  entriesFor,
  onSend,
  onSent,
  onOpenChat,
  onClose,
}: DocChatPanelProps) {
  const ranked = rankAgents(agents);
  const ids = agents.map((a) => a.id);
  const [target, setTarget] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [starting, setStarting] = useState<{ before: number[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Agents already told which file this is (in this session of the panel). */
  const introduced = useRef(new Set<number>());
  const threadRef = useRef<HTMLDivElement>(null);

  // Who to talk to: the agent remembered for this file, else the preferred one,
  // else the best-ranked, else (when possible) a new one.
  useEffect(() => {
    setTarget((current) => {
      if (current !== null && (current === NEW_AGENT || ids.includes(current))) return current;
      const remembered = loadDocChatAgent(filePath);
      if (remembered !== undefined && ids.includes(remembered)) return remembered;
      if (preferred != null && ids.includes(preferred)) return preferred;
      return ranked[0]?.id ?? (canStartAgent ? NEW_AGENT : null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-pick only when who is here changes
  }, [ids.join(','), filePath, preferred, canStartAgent]);

  // A new agent was asked for: it is the one that appears next.
  useEffect(() => {
    if (!starting) return;
    const fresh = newAgentId(starting.before, ids);
    if (fresh === undefined) return;
    setStarting(null);
    setTarget(fresh);
    saveDocChatAgent(filePath, fresh);
    introduced.current.add(fresh); // its first message named the file
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs as agents arrive
  }, [ids.join(','), starting]);

  useEffect(() => {
    if (!starting) return;
    return transport.onMessage((msg) => {
      if (msg.type === 'startAgentResult' && !msg.ok) {
        setStarting(null);
        setError(msg.error ?? 'Could not start the agent.');
      }
    });
  }, [starting]);

  const entries = target !== null && target !== NEW_AGENT ? entriesFor(target) : [];
  const { shown, hidden } = recentEntries(entries, showAll);
  const last = entries[entries.length - 1];
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [target, entries.length, last?.entryId, last?.toolDone]);

  const agent = agents.find((a) => a.id === target);
  const folder = fileFolder(filePath);

  const send = () => {
    if (target === null || starting) return;
    const text = draft.trim();
    if (!text && refs.length === 0) return;
    setError(null);
    if (target === NEW_AGENT) {
      setStarting({ before: ids });
      transport.send({
        type: 'startAgent',
        cwd: folder,
        firstMessage: askMessage(text, refs, filePath),
      });
    } else {
      const first = !introduced.current.has(target);
      onSend(target, first ? askMessage(text, refs, filePath) : followUpMessage(text, refs));
      introduced.current.add(target);
      saveDocChatAgent(filePath, target);
    }
    setDraft('');
    onSent();
  };

  return (
    <aside
      aria-label="Document chat"
      className="w-340 max-w-[55%] shrink-0 flex flex-col bg-bg-dark border-l-2 border-border min-h-0"
      data-testid="doc-chat"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-6 px-10 py-6 border-b-2 border-border">
        <label className="sr-only" htmlFor="doc-chat-agent">
          Agent
        </label>
        <select
          id="doc-chat-agent"
          value={target ?? ''}
          onChange={(e) => {
            const id = Number(e.target.value);
            setTarget(id);
            if (id !== NEW_AGENT) saveDocChatAgent(filePath, id);
          }}
          className="flex-1 min-w-0 bg-bg text-text text-sm border border-border rounded-ui px-4 py-2"
          data-testid="doc-chat-agent"
        >
          {target === null && <option value="">No agent</option>}
          {ranked.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
              {a.inFolder ? ' · this folder' : ''}
              {a.busy ? ' · busy' : ''}
            </option>
          ))}
          {canStartAgent && folder && (
            <option value={NEW_AGENT}>+ New agent in {fileBaseName(folder)}</option>
          )}
        </select>
        {agent && (
          <Button
            size="sm"
            onClick={() => onOpenChat(agent.id)}
            title="Open this agent's full chat"
            aria-label="Open full chat"
          >
            ⤢
          </Button>
        )}
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close" title="Close">
          ×
        </Button>
      </div>

      <div ref={threadRef} className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-6 p-8">
        {hidden > 0 && (
          <Button size="sm" className="self-center" onClick={() => setShowAll(true)}>
            Show {hidden} earlier
          </Button>
        )}
        {target === NEW_AGENT && !starting && (
          <span className="m-auto text-center text-xs text-text-muted px-8">
            Your first message starts a new agent in {folder} and tells it about{' '}
            {fileBaseName(filePath)}.
          </span>
        )}
        {starting && (
          <span className="m-auto text-center text-xs text-text-muted px-8">
            Starting the agent… Its answer appears here.
          </span>
        )}
        {target !== NEW_AGENT && target !== null && entries.length === 0 && (
          <span className="m-auto text-center text-xs text-text-muted px-8">
            Talk to {agent?.label ?? 'the agent'} about {fileBaseName(filePath)}. Pick paragraphs,
            cells, slides or lines to point at them.
          </span>
        )}
        {target === null && (
          <span className="m-auto text-center text-xs text-text-muted px-8">
            No agent the office can type into. Start one with + Agent or `pixel-office claude`.
          </span>
        )}
        {shown.map((entry) => (
          <Row key={entry.entryId} entry={entry} />
        ))}
        {agent?.busy && entries.length > 0 && (
          <span className="text-2xs text-status-active px-2">{agent.label} is working…</span>
        )}
      </div>

      <div className="flex flex-col gap-4 p-8 border-t-2 border-border">
        {refs.length > 0 && (
          <div className="flex flex-wrap gap-4">
            {refs.map((ref, i) => (
              <span
                key={`${refLabel(ref)}-${i}`}
                className="px-6 py-1 bg-active-bg border border-accent text-code-sm font-mono"
              >
                {refLabel(ref)}
              </span>
            ))}
          </div>
        )}
        <textarea
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            refs.length > 0
              ? 'Ask about the picked places, or ask for a change…'
              : `Message about ${fileBaseName(filePath)} — Enter sends`
          }
          aria-label="Message"
          className="w-full resize-none p-6 bg-bg text-text font-reading text-read border border-border focus:border-accent rounded-ui outline-none"
          data-testid="doc-chat-input"
        />
        <div className="flex items-center gap-6">
          <span className="flex-1 text-2xs text-text-muted">
            {error ?? 'Only places are sent, never the text.'}
          </span>
          <Button
            variant={target !== null && !starting ? 'accent' : 'disabled'}
            size="sm"
            disabled={target === null || !!starting}
            onClick={send}
            data-testid="doc-chat-send"
          >
            {target === NEW_AGENT ? 'Start & send' : agent?.busy ? 'Queue' : 'Send'}
          </Button>
        </div>
      </div>
    </aside>
  );
}
