import * as React from 'react';
import { cn } from '../../lib/utils';

// shadcn/ui copy-in, adapted to this repo: variants are plain objects instead of cva
// (cva is not an allowed dependency here) and every border is explicit because the
// preflight layer is disabled — see tailwind.config.cjs.
const base = 'inline-flex items-center justify-center gap-[7px] whitespace-nowrap rounded-md border border-solid font-medium leading-[1.2] transition-colors disabled:pointer-events-none disabled:opacity-50';

const variantStyles = {
  default: 'bg-primary text-primary-foreground hover:opacity-90',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-surface-3',
  outline: 'border-border-strong bg-card text-foreground hover:bg-secondary',
  ghost: 'border-transparent text-foreground hover:bg-secondary',
  destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
  link: 'border-transparent text-primary underline-offset-4 hover:underline',
} as const;

const sizeStyles = {
  default: 'h-9 px-3 text-base',
  sm: 'h-7 px-2 text-sm',
  lg: 'h-11 px-5 text-lg',
  icon: 'h-9 w-9 p-0',
} as const;

export type ButtonVariant = keyof typeof variantStyles;
export type ButtonSize = keyof typeof sizeStyles;

export function buttonVariants({
  variant = 'default',
  size = 'default',
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) {
  return cn(base, variantStyles[variant], sizeStyles[size], className);
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => (
    <button ref={ref} className={buttonVariants({ variant, size, className })} {...props} />
  ),
);
Button.displayName = 'Button';
