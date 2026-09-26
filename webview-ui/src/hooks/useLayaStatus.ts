import { useEffect, useState } from 'react';

import type { LayaStatus } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';

/**
 * The office's own Laya (Settings → Decision model). The status arrives in
 * the handshake, before most panels mount, so the latest one is kept here
 * from the moment this module loads.
 */
let latest: LayaStatus | null = null;
const listeners = new Set<(status: LayaStatus) => void>();
transport.onMessage((msg) => {
  if (msg.type !== 'layaStatus') return;
  latest = msg;
  for (const listener of listeners) listener(msg);
});

export function useLayaStatus(): LayaStatus | null {
  const [status, setStatus] = useState<LayaStatus | null>(latest);
  useEffect(() => {
    listeners.add(setStatus);
    return () => {
      listeners.delete(setStatus);
    };
  }, []);
  return status;
}

/** A decision model answers: the office's own Laya is running, or a hand-set endpoint is configured. */
export function decisionModelReady(status: LayaStatus | null): boolean {
  return !!status && (status.state === 'running' || !!status.external);
}
