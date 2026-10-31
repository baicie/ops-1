import { translate, type Locale } from '../i18n';

/**
 * How long ago - one ladder for the whole shell.
 *
 * Two surfaces printed the same fact in two dialects: the audit table's `TimeAgo` said
 * "24m ago" while the run span beside it said "3 hours ago", because one read the message
 * catalog and the other asked `Intl.RelativeTimeFormat` for a long form. A reader comparing a
 * row's age with the span of the run in the same row had to translate between them first.
 *
 * The catalog form is the one that survived: it is the compact one, it is already the format of
 * every Occurred/Created column, and "3h ago" is one token to scan instead of three.
 *
 * The ladder is the one this product has always used; nothing about the rounding changed, so an
 * age that read "23h ago" yesterday still reads "23h ago" today.
 */
export function ageMessage(locale: Locale, at?: string | null): string {
  if (!at) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 10) return translate(locale, 'time.justNow');
  if (seconds < 60) return translate(locale, 'time.secondsAgo', { count: seconds });
  if (seconds < 3600) return translate(locale, 'time.minutesAgo', { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return translate(locale, 'time.hoursAgo', { count: Math.floor(seconds / 3600) });
  return translate(locale, 'time.daysAgo', { count: Math.floor(seconds / 86400) });
}

/**
 * The wall clock a row happened at, to the second, in the reader's locale.
 *
 * An age is deliberate about its own coarseness: "23h ago" is a whole day of events collapsing
 * into one string. Twenty-five rows of a poller therefore read as ten identical cards. The clock
 * is the same fact at the precision that separates them, and it is the only one of the two that
 * does not change while the reader looks at it.
 */
export function clockMessage(locale: Locale, at?: string | null): string {
  if (!at) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}
