import { useEffect, useState } from 'react';

import type { ModelOption } from '../../../core/src/messages.js';
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
}

const fieldClass =
  'w-full px-8 py-4 bg-bg-dark text-text text-sm border-2 border-border rounded-none outline-none focus:border-accent';

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
}: AddAgentModalProps) {
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [command, setCommand] = useState('claude');
  const [firstMessage, setFirstMessage] = useState('');
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [model, setModel] = useState('');
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
        onClose();
      } else {
        setError(msg.error ?? 'Could not start the agent.');
      }
    });
  }, [pending, onClose]);

  const canStart = cwd.trim().length > 0 && !pending;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Add agent"
      zIndex={54}
      className="w-480 max-w-[94vw]"
    >
      <form
        className="flex flex-col gap-8 px-10 pb-8 max-h-[85vh] overflow-y-auto"
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
          });
        }}
      >
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
          First message (optional)
          <input
            className={fieldClass}
            value={firstMessage}
            onChange={(e) => setFirstMessage(e.target.value)}
            data-testid="agent-first-message"
          />
        </label>
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
