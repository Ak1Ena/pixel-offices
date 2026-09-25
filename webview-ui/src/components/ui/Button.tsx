import type { ButtonHTMLAttributes } from 'react';

const base = 'border rounded-ui cursor-pointer font-semibold transition-colors';

const sizes = {
  sm: 'py-4 px-10 text-sm',
  md: 'py-6 px-14',
  lg: 'py-8 px-16 text-lg',
  xl: 'py-10 px-24 text-xl',
  icon: 'p-0 w-24 h-24 flex items-center justify-center',
  icon_lg: 'p-0 w-40 h-40 flex items-center justify-center',
} as const;

const variants = {
  default: `${base} bg-btn-bg border-border hover:bg-btn-hover`,
  active: `${base} bg-active-bg border-accent`,
  disabled: `${base} bg-btn-bg border-transparent cursor-default opacity-[var(--btn-disabled-opacity)]`,
  accent: `${base} bg-accent! hover:bg-accent-bright! text-accent-ink border-accent hover:border-accent-bright`,
  ghost: `${base} bg-transparent text-text-muted border-transparent hover:text-text`,
} as const;

type ButtonVariant = keyof typeof variants;
type ButtonSize = keyof typeof sizes;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = 'default',
  size = 'lg',
  className = '',
  ...props
}: ButtonProps) {
  return <button className={`${variants[variant]} ${sizes[size]} ${className}`} {...props} />;
}
