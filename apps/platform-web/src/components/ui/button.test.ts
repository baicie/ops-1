import { describe, expect, it } from 'vitest';
import { buttonVariants } from './button';

/**
 * preflight is off. A `border` utility that names no colour paints the UA `buttontext` (black in
 * light, #d5d5d5 in dark), and `ghost` without `bg-transparent` paints the UA ButtonFace. These
 * assertions keep the paint explicit at the source level; the visual matrix checks the computed
 * colours in the browser.
 */
describe('buttonVariants paint', () => {
  it('names an explicit border colour on every variant', () => {
    // twMerge keeps the winning border colour; what matters is that one is present and tokenised.
    expect(buttonVariants({ variant: 'default' })).toContain('border-primary');
    expect(buttonVariants({ variant: 'secondary' })).toContain('border-border-strong');
    expect(buttonVariants({ variant: 'outline' })).toContain('border-border-strong');
    expect(buttonVariants({ variant: 'ghost' })).toContain('border-transparent');
    expect(buttonVariants({ variant: 'destructive' })).toContain('border-[var(--ow-danger-solid)]');
    expect(buttonVariants({ variant: 'link' })).toContain('border-transparent');
  });

  it('keeps the transparent variants transparent and the Link box identical to the Button box', () => {
    expect(buttonVariants({ variant: 'ghost' })).toContain('bg-transparent');
    expect(buttonVariants({ variant: 'link' })).toContain('bg-transparent');
    expect(buttonVariants()).toContain('py-0');
    expect(buttonVariants()).toContain('no-underline');
  });
});
