import * as React from 'react';
import { cn } from '../../lib/utils';

// shadcn/ui copy-in, adapted to this repo: there is no variant axis and every border is explicit because preflight is off — the global
// reset in src/styles.css does not normalise form controls or tables.
const base =
  'flex h-9 w-full rounded-md border border-solid border-border-strong bg-card px-3 py-1 text-base text-foreground transition-colors ' +
  'placeholder:text-muted-foreground ' +
  'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input ref={ref} type={type} className={cn(base, className)} {...props} />
  ),
);
Input.displayName = 'Input';
