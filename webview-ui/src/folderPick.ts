import { useCallback, useEffect, useRef, useState } from 'react';

import { MOBILE_BREAKPOINT_PX } from './constants.js';
import { isBrowserRuntime } from './runtime.js';
import { transport } from './transport/index.js';

/**
 * The native "Open folder…" dialog: send `pickFolder`, wait for the
 * point-to-point `folderPicked` reply. One pick in flight — a second call
 * before the first resolves is ignored by the server, so callers just don't
 * fire while `picking` is true.
 */
export function useNativeFolderPick(): {
  available: boolean;
  picking: boolean;
  error: string | null;
  pick: (onPicked: (path: string) => void) => void;
} {
  const [capable, setCapable] = useState(!isBrowserRuntime);
  const [wide, setWide] = useState(
    typeof window === 'undefined' || window.innerWidth >= MOBILE_BREAKPOINT_PX,
  );
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onPickedRef = useRef<((path: string) => void) | null>(null);

  useEffect(() => {
    if (!isBrowserRuntime) return;
    return transport.onMessage((msg) => {
      if (msg.type === 'officeCapabilities') setCapable(msg.canPickFolder === true);
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setWide(window.innerWidth >= MOBILE_BREAKPOINT_PX);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    return transport.onMessage((msg) => {
      if (msg.type !== 'folderPicked') return;
      setPicking(false);
      if (msg.path) onPickedRef.current?.(msg.path);
      setError(msg.error ?? null);
      onPickedRef.current = null;
    });
  }, []);

  const pick = useCallback((onPicked: (path: string) => void) => {
    onPickedRef.current = onPicked;
    setError(null);
    setPicking(true);
    transport.send({ type: 'pickFolder' });
  }, []);

  return { available: capable && wide, picking, error, pick };
}
