import { useSyncExternalStore } from 'react';

import type { TunableValues } from '../tunables.js';
import { allTunables, subscribeTunables } from '../tunableStore.js';

/** Every Settings → Advanced value; the component re-renders when one changes. */
export function useTunables(): TunableValues {
  return useSyncExternalStore(subscribeTunables, allTunables);
}
