import { useCallback, useEffect, useState } from 'react';

import type { DocEditMode, DocEditNotice } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';

export { lastEditKeyFor } from '../docViewer.js';

export interface DocEditsState {
  /** Recent edits written to documents, newest last (server: docEdits.ts). */
  edits: DocEditNotice[];
  /** What agents' document edits do unless an agent has its own setting. */
  defaultMode: DocEditMode;
  setDefaultMode: (mode: DocEditMode) => void;
  undo: (editId: string) => void;
}

/** Document edits and the office-wide edit mode. Own transport listener. */
export function useDocEdits(): DocEditsState {
  const [edits, setEdits] = useState<DocEditNotice[]>([]);
  const [defaultMode, setMode] = useState<DocEditMode>('ask');

  useEffect(() => {
    return transport.onMessage((msg) => {
      if (msg.type === 'docEdits') setEdits(msg.edits);
      else if (msg.type === 'docEditDefault') setMode(msg.mode);
    });
  }, []);

  const setDefaultMode = useCallback((mode: DocEditMode) => {
    setMode(mode);
    transport.send({ type: 'setDocEditDefault', mode });
  }, []);
  const undo = useCallback((editId: string) => {
    transport.send({ type: 'undoDocEdit', editId });
  }, []);

  return { edits, defaultMode, setDefaultMode, undo };
}
