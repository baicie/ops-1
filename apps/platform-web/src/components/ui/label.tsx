import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '../../lib/utils';

// Radix Label owns the htmlFor/id association and the peer-disabled state; the classes only
// mirror the hand-written .field-label typography of the un-migrated pages.
export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      'inline-flex items-center gap-1 text-sm font-semibold text-muted-foreground',
      'peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
      className,
    )}
    {...props}
  />
));
Label.displayName = 'Label';
