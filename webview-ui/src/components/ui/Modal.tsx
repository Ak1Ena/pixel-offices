import type { ReactNode } from 'react';

import { Button } from './Button.js';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** z-index for backdrop (modal gets +1). Default 49 */
  zIndex?: number;
  className?: string;
  /** A panel docked on the right (the office stays visible and usable), not a centred dialog. */
  side?: boolean;
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  zIndex = 50,
  className = '',
  side = false,
}: ModalProps) {
  if (!isOpen) return null;

  if (side) {
    return (
      <section
        className={`fixed right-16 top-16 bottom-96 w-380 max-w-[calc(100vw-32px)] flex flex-col bg-bg border border-border rounded-panel shadow-pixel overflow-hidden ${className}`}
        style={{ zIndex: zIndex + 1 }}
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <div className="flex items-center justify-between gap-8 pt-12 pb-8 px-14 border-b border-border">
          <span className="font-display text-text text-xl font-medium">{title}</span>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            ×
          </Button>
        </div>
        <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      </section>
    );
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50" style={{ zIndex }} onClick={onClose} />
      <div
        className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-bg border border-border rounded-panel shadow-pixel p-4 min-w-xs ${className}`}
        style={{ zIndex: zIndex + 1 }}
      >
        <div className="flex items-center justify-between py-4 px-10 border-b border-border mb-4">
          <span className="font-display text-text text-xl font-medium">{title}</span>
          <Button variant="ghost" size="icon" onClick={onClose}>
            ×
          </Button>
        </div>
        {children}
      </div>
    </>
  );
}
