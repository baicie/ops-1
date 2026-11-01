import * as React from 'react';
import { cn } from '../../lib/utils';

// shadcn/ui copy-in, adapted to this repo: variants are plain objects instead of cva
// (cva is not an allowed dependency here) and every border is explicit because the
// preflight layer is disabled — see tailwind.config.cjs.
const base = 'inline-flex items-center justify-center gap-[7px] whitespace-nowrap rounded-control border border-solid font-medium leading-[1.2] transition-colors disabled:pointer-events-none disabled:opacity-50';

const variantStyles = {
  default: 'bg-primary text-primary-foreground hover:opacity-90',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-surface-3',
  outline: 'border-border-strong bg-card text-foreground hover:bg-secondary',
  ghost: 'border-transparent text-foreground hover:bg-secondary',
  // The SOLID pair, not the ink. --destructive/--ow-danger is an ink: in dark it is #ff7b7b, a
  // light pink that measured 2.51:1 under this variant's #ffffff. --ow-danger-solid states a fill
  // per theme that the one foreground is legible on (5.49:1 light, 7.01:1 dark).
  destructive: 'border-[var(--ow-danger-solid)] bg-[var(--ow-danger-solid)] text-[var(--ow-danger-solid-text)] hover:opacity-90',
  link: 'border-transparent text-primary underline-offset-4 hover:underline',
} as const;

// token-table R4: two sizes, one family. shadcn ships four sizes (28 / 36 / 44px plus a
// square 36), none of which is one of this product's two control tiers - that is how one
// toolbar came to hold a 36px button beside a 28px tab trigger. `default` is the 40px tier
// (every form control), `sm` the 32px tier (in-row and dense controls); `icon` is square on
// the 40px tier. The 44px size is deleted: 44 is the MOBILE FLOOR every control gets below
// 768px (R3 C2), not a size a call site may ask for, and nothing in the tree asked for it.
const sizeStyles = {
  default: 'h-control-md px-4 text-base',
  sm: 'h-control-sm px-3 text-sm',
  icon: 'h-control-md w-control-md p-0',
  'icon-sm': 'h-control-sm w-control-sm p-0',
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
