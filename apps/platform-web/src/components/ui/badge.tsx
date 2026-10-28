import * as React from 'react';
import { cn } from '../../lib/utils';

const base = 'inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-solid px-2 py-0.5 text-sm font-semibold';

const variantStyles = {
  default: 'border-transparent bg-primary text-primary-foreground',
  secondary: 'border-border bg-secondary text-secondary-foreground',
  outline: 'border-border text-foreground',
  success: 'border-transparent bg-success-soft text-success',
  warning: 'border-transparent bg-warning-soft text-warning',
  info: 'border-transparent bg-info-soft text-info',
  destructive: 'border-transparent bg-destructive-soft text-destructive',
} as const;

export type BadgeVariant = keyof typeof variantStyles;

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return <span className={cn(base, variantStyles[variant], className)} {...props} />;
}
