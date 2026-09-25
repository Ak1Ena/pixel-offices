import { useEffect, useState } from 'react';

import type { AgentLook } from '../../../core/src/agentLook.js';
import type { ModelOption, PastSession } from '../../../core/src/messages.js';
import { randomLook } from '../lookOptions.js';
import { LookStudioLazy } from '../office3d/lookStudioLazy.js';
import { transport } from '../transport/index.js';
import { FolderPicker } from './FolderPicker.js';
import { ModelSelect } from './ModelSelect.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

interface AddAgentModalProps {
  isOpen: boolean;
  onClose: () => void;
  recentFolders: string[];
  /** Claude's model picker options, as last read (see ModelSelect). */
  modelOptions: ModelOption[];
  /** The 3D office is on: design the new agent's look here too. */
  show3D?: boolean;
}

const fieldClass =
  'w-full px-8 py-4 bg-bg-dark text-text text-sm border border-border rounded-ui outline-none focus:border-accent';

/**
 * + Agent in the standalone office: starts Claude on this computer as an agent
 * the office runs itself. It has no terminal window — its chat card (with a
 * screen view for on-screen questions) is how you talk to it.
 */
export function AddAgentModal({
  isOpen,
  onClose,
  recentFolders,
  modelOptions,
  show3D,
}: AddAgentModalProps) {
  const [look, setLook] = useState<AgentLook>(randomLook);
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [command, setCommand] = useState('claude');
  const [firstMessage, setFirstMessage] = useState('');
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [model, setModel] = useState('');
  /** Start fresh, or continue one of the folder's earlier sessions. */
  const [mode, setMode] = useState<'new' | 'resume'>('new');
  const [resumeId, setResumeId] = useState('');
  const [past, setPast] = useState<{ cwd: string; sessions: PastSession[]; error?: string } | null>(
    null,
  );

  // The folder's earlier sessions, asked for whenever Resume is on and the folder changes.
  useEffect(() => {
    if (!isOpen || mode !== 'resume' || !cwd.trim()) return;
    const folder = cwd.trim();
    setPast(null);
    setResumeId('');
    const off = transport.onMessage((msg) => {
      if (msg.type !== 'pastSessions' || msg.cwd !== folder) return;
      setPast({ cwd: folder, sessions: msg.sessions, error: msg.error });
    });
    transport.send({ type: 'listPastSessions', cwd: folder });
    return off;
  }, [isOpen, mode, cwd]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill the folder with the most recent one each time the dialog opens.
  useEffect(() => {
    if (isOpen) {
      setCwd((current) => current || recentFolders[0] || '');
      setError(null);
      setPending(false);
    }
  }, [isOpen, recentFolders]);

  useEffect(() => {
    if (!pending) return;
    return transport.onMessage((msg) => {
      if (msg.type !== 'startAgentResult') return;
      setPending(false);
      if (msg.ok) {
        setName('');
        setFirstMessage('');
        setLook(randomLook());
        onClose();
      } else {
        setError(msg.error ?? 'Could not start the agent.');
      }
    });
  }, [pending, onClose]);

  const canStart = cwd.trim().length > 0 && !pending && (mode === 'new' || resumeId !== '');

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={show3D ? 'New agent' : 'Add agent'}
      zIndex={54}
      className={show3D ? '' : 'w-480 max-w-[94vw]'}
      side={show3D}
    >
      <form
        className={`flex flex-col gap-8 overflow-y-auto ${
          show3D ? 'flex-1 min-h-0 px-14 py-12' : 'px-10 pb-8 max-h-[85vh]'
        }`}
        onKeyDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!canStart) return;
          setError(null);
          setPending(true);
          transport.send({
            type: 'startAgent',
            cwd: cwd.trim(),
            name: name.trim() || undefined,
            command: command.trim() || undefined,
            firstMessage: firstMessage.trim() || undefined,
            skipPermissions: skipPermissions || undefined,
            model: model || undefined,
            resume: mode === 'resume' ? resumeId : undefined,
            look: show3D ? look : undefined,
          });
        }}
      >
        {show3D && (
          <LookStudioLazy
            look={look}
            onChange={setLook}
            part="preview"
            fallback={<div className="h-200 rounded-ui border border-border" />}
          />
        )}
        <label className="flex flex-col gap-2 text-sm">
          Name
          <input
            className={fieldClass}
            value={name}
            maxLength={32}
            placeholder="Backend Bob"
            onChange={(e) => setName(e.target.value)}
            data-testid="agent-name"
          />
        </label>
        <div className="flex flex-col gap-2 text-sm">
          Project folder
          <FolderPicker value={cwd} onChange={setCwd} recentFolders={recentFolders} />
        </div>
        <div className="flex flex-col gap-4 text-sm">
          <div className="flex gap-4">
            <Button
              type="button"
              size="sm"
              variant={mode === 'new' ? 'active' : 'default'}
              onClick={() => setMode('new')}
            >
              New session
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === 'resume' ? 'active' : 'default'}
              onClick={() => setMode('resume')}
              data-testid="agent-mode-resume"
            >
              Resume a session
            </Button>
          </div>
          {mode === 'resume' && (
            <PastSessionList
              past={past}
              folderChosen={cwd.trim().length > 0}
              value={resumeId}
              onChange={setResumeId}
            />
          )}
        </div>
        <label className="flex flex-col gap-2 text-sm">
          Start with
          <input
            className={fieldClass}
            value={command}
            placeholder="claude"
            onChange={(e) => setCommand(e.target.value)}
            data-testid="agent-command"
          />
          <span className="text-2xs text-text-muted">
            claude, claude with flags, or one of your shell aliases that runs it
          </span>
        </label>
        <div className="flex flex-col gap-2 text-sm">
          Model
          <ModelSelect
            options={modelOptions}
            value={model}
            onChange={setModel}
            className={fieldClass}
          />
        </div>
        <label className="flex flex-col gap-2 text-sm">
          {mode === 'resume' ? 'Message after resuming (optional)' : 'First message (optional)'}
          <input
            className={fieldClass}
            value={firstMessage}
            onChange={(e) => setFirstMessage(e.target.value)}
            data-testid="agent-first-message"
          />
        </label>
        {show3D && (
          <div className="flex flex-col gap-4 text-sm">
            Look
            <LookStudioLazy
              look={look}
              onChange={setLook}
              part="options"
              fallback={<span className="text-2xs text-text-muted">Loading…</span>}
            />
          </div>
        )}
        <label className="flex items-center gap-6 text-sm">
          <input
            type="checkbox"
            checked={skipPermissions}
            onChange={(e) => setSkipPermissions(e.target.checked)}
          />
          Skip permission prompts
          <span className="text-2xs text-warning">the agent can run anything without asking</span>
        </label>
        <p className="m-0 text-2xs text-text-muted">
          Starts on this computer, in that folder. There is no terminal window: its chat card is how
          you talk to it, and closing the office stops it.
        </p>
        {error && (
          <p className="m-0 text-sm text-danger" data-testid="agent-error">
            {error}
          </p>
        )}
        <div className="flex gap-8 justify-end">
          <Button type="button" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="md"
            variant={canStart ? 'accent' : 'disabled'}
            disabled={!canStart}
            data-testid="agent-start"
          >
            {pending ? 'Starting…' : 'Start agent'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** The folder's earlier sessions, newest first; one is picked to resume. */
function PastSessionList({
  past,
  folderChosen,
  value,
  onChange,
}: {
  past: { sessions: PastSession[]; error?: string } | null;
  folderChosen: boolean;
  value: string;
  onChange: (sessionId: string) => void;
}) {
  if (!folderChosen) return <span className="text-2xs text-text-muted">Pick a folder first.</span>;
  if (!past) return <span className="text-2xs text-text-muted">Looking for sessions…</span>;
  if (past.error) return <span className="text-2xs text-danger">{past.error}</span>;
  if (past.sessions.length === 0) {
    return <span className="text-2xs text-text-muted">No earlier sessions in this folder.</span>;
  }
  return (
    <div
      className="flex flex-col max-h-240 overflow-y-auto border border-border"
      role="listbox"
      aria-label="Earlier sessions"
      data-testid="agent-past-sessions"
    >
      {past.sessions.map((s) => (
        <button
          key={s.sessionId}
          type="button"
          role="option"
          aria-selected={value === s.sessionId}
          disabled={s.open}
          onClick={() => onChange(s.sessionId)}
          title={s.firstPrompt ?? s.title}
          className={`flex flex-col gap-1 text-left px-8 py-4 border-0 border-b border-border ${
            s.open
              ? 'bg-transparent text-text-muted cursor-default'
              : value === s.sessionId
                ? 'bg-active-bg text-text cursor-pointer'
                : 'bg-transparent text-text cursor-pointer'
          }`}
        >
          <span className="text-sm truncate">{s.title}</span>
          <span className="text-2xs text-text-muted">
            {ago(s.updatedAt)}
            {s.open ? ' · open in the office' : ''}
          </span>
        </button>
      ))}
    </div>
  );
}
