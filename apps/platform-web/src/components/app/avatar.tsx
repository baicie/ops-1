import * as React from 'react';
import { cn } from '../../lib/utils';

/** Rendered for a user with no name at all; a glyph, never an invented identity. */
const FALLBACK = '?';

export type AvatarSize = 'sm' | 'md' | 'lg';

const sizeStyles: Record<AvatarSize, string> = {
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-7 w-7 text-[11px]',
  lg: 'h-10 w-10 text-sm',
};

/**
 * Initials for the image-less avatar.
 *
 * Two-word names ("Liu Zhiwei") read as the two initials; a single Latin token is cut to
 * its first two letters; a single CJK token stays one glyph because two full ideographs do
 * not fit the 24-28px circle we render at.
 */
export function initialsFor(name?: string | null, email?: string | null): string {
  const source = (name ?? '').trim() || (email ?? '').split('@')[0].trim();
  if (!source) return FALLBACK;
  const words = source.split(/[\s._\-+]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const single = words[0] ?? source;
  if (/[^\u0000-\u007F]/.test(single)) return Array.from(single)[0].toUpperCase();
  return single.slice(0, 2).toUpperCase();
}

export interface AvatarProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  name?: string | null;
  email?: string | null;
  /** Decorative by default: the caller's visible text is already the accessible name. */
  src?: string | null;
  size?: AvatarSize;
}

export function Avatar({ name, email, src, size = 'md', className, ...props }: AvatarProps) {
  const label = (name ?? '').trim() || (email ?? '').trim();
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full',
        'border border-solid border-border bg-accent font-semibold text-accent',
        sizeStyles[size],
        className,
      )}
      title={label || undefined}
      {...props}
    >
      {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : <span aria-hidden="true">{initialsFor(name, email)}</span>}
    </span>
  );
}
