import { lazy, Suspense, useEffect, useState } from 'react';

import type { AgentLook } from '../../../core/src/agentLook.js';
import { randomLook } from '../lookOptions.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

const LookStudio = lazy(() => import('../office3d/LookStudio.js'));

interface LookModalProps {
  /** Whose look is being changed; null = closed. */
  agentName: string | null;
  current: AgentLook | undefined;
  onSave: (look: AgentLook | undefined) => void;
  onClose: () => void;
}

/** The character studio for an agent already in the office. */
export function LookModal({ agentName, current, onSave, onClose }: LookModalProps) {
  const [look, setLook] = useState<AgentLook>(() => current ?? randomLook());
  useEffect(() => {
    if (agentName !== null) setLook(current ?? randomLook());
    // Only when it opens: edits in progress are not reset by a new echo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentName]);

  return (
    <Modal
      isOpen={agentName !== null}
      onClose={onClose}
      title={`${agentName ?? ''}'s look`}
      zIndex={54}
      className="w-420 max-w-[94vw]"
    >
      <div className="flex flex-col gap-8 px-10 pb-8 max-h-[85vh] overflow-y-auto">
        <Suspense fallback={<span className="text-2xs text-text-muted">Loading…</span>}>
          <LookStudio look={look} onChange={setLook} />
        </Suspense>
        <div className="flex gap-8 justify-end">
          {current && (
            <Button type="button" size="md" onClick={() => onSave(undefined)}>
              Use default
            </Button>
          )}
          <Button type="button" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="md"
            variant="accent"
            onClick={() => onSave(look)}
            data-testid="look-save"
          >
            Save look
          </Button>
        </div>
      </div>
    </Modal>
  );
}
