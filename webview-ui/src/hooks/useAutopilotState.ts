import { useEffect, useState } from 'react';

import type { AutopilotState } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';

/** Settings → Autopilot. Kept from module load: the state arrives in the handshake. */
let latest: AutopilotState | null = null;
const listeners = new Set<(state: AutopilotState) => void>();
transport.onMessage((msg) => {
  if (msg.type !== 'autopilotState') return;
  latest = msg;
  for (const listener of listeners) listener(msg);
});

export function useAutopilotState(): AutopilotState | null {
  const [state, setState] = useState<AutopilotState | null>(latest);
  useEffect(() => {
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}
