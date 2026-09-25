import type { ComponentType, ReactNode } from 'react';
import { createElement, useEffect, useState } from 'react';

import type { LookStudioProps } from './LookStudio.js';

let loaded: ComponentType<LookStudioProps> | null = null;

/**
 * The character studio, loaded on first use (it pulls in Three.js).
 *
 * Not React.lazy on purpose: a lazy boundary shows its content again through
 * React's retry lane, and the 3D office's overlays update every frame — those
 * updates can starve the retry forever, leaving "Loading…" on screen. A plain
 * state update after the import lands is never starved.
 */
export function useLookStudio(): ComponentType<LookStudioProps> | null {
  const [Comp, setComp] = useState<ComponentType<LookStudioProps> | null>(() => loaded);
  useEffect(() => {
    if (loaded) return;
    let alive = true;
    void import('./LookStudio.js').then((m) => {
      loaded = m.default;
      if (alive) setComp(() => m.default);
    });
    return () => {
      alive = false;
    };
  }, []);
  return Comp;
}

/** The studio once loaded, `fallback` until then. */
export function LookStudioLazy(props: LookStudioProps & { fallback?: ReactNode }): ReactNode {
  const { fallback = null, ...rest } = props;
  const Comp = useLookStudio();
  return Comp ? createElement(Comp, rest) : fallback;
}
