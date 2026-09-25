import type { ReactNode } from 'react';

interface DropdownProps {
  isOpen: boolean;
  children: ReactNode;
  className?: string;
}

export function Dropdown({ isOpen, children, className = '' }: DropdownProps) {
  if (!isOpen) return null;

  return (
    <div className="absolute bottom-full left-0 pb-10 z-10">
      <div className={`bg-bg border border-border rounded-ui shadow-pixel p-4 ${className}`}>
        {children}
      </div>
    </div>
  );
}

interface DropdownItemProps {
  onClick: () => void;
  children: ReactNode;
  className?: string;
  title?: string;
  'data-testid'?: string;
}

export function DropdownItem({
  onClick,
  children,
  className = '',
  title,
  'data-testid': testId,
}: DropdownItemProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      data-testid={testId}
      className={`block w-full text-left py-2 px-12 bg-transparent border-none rounded-ui cursor-pointer whitespace-nowrap hover:bg-btn-bg ${className}`}
    >
      {children}
    </button>
  );
}
