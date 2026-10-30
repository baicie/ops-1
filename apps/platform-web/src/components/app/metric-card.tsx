import * as React from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../Icons';
import { formatDate } from '../../format';
import { useT } from '../../i18n';
import { cn } from '../../lib/utils';
import { NoData, UnknownValue } from './status-indicator';

/**
 * One metric, and the reason it exists: it answers a question and takes you somewhere.
 *
 * The value is only ever a number the backend returned. When the source cannot answer, the
 * card renders NO_DATA / UNKNOWN instead of a zero, because "0 stück" and "we did not look"
 * are different facts (docs/09 §9.1). Every card that names a destination is a real link, so a
 * summary strip cannot become the wall of dead KPIs §4.5 A forbids.
 */
export function MetricCard({
  label,
  value,
  /** The other half of a ratio, rendered muted right after the value ("3 / 3"). */
  denominator,
  unit,
  detail,
  sampledAt,
  href,
  state = 'ready',
  showSampled = true,
  className,
}: {
  label: string;
  value?: React.ReactNode;
  /** Rendered as "/ n" so a count with a total and one without share one shape. */
  denominator?: React.ReactNode;
  unit?: string;
  detail?: React.ReactNode;
  /** When the value was observed. Rendered as an absolute time, never invented. */
  sampledAt?: string | null;
  href?: string;
  state?: 'ready' | 'noData' | 'unknown';
  /**
   * Whether this card prints its own observation time. A strip whose members share one source
   * prints that time once for the strip, and four copies of it was the repetition the v3 audit
   * called out - so the card stops repeating it instead of the CSS hiding four nodes.
   */
  showSampled?: boolean;
  className?: string;
}) {
  const t = useT();
  const body = (
    <>
      <span className="ow-metric-label">{label}</span>
      <span className="ow-metric-value" data-metric-state={state}>
        {state === 'ready' ? (
          <>
            {value}
            {denominator !== undefined ? <span className="ow-metric-den">/{denominator}</span> : null}
            {unit ? <span className="ow-metric-unit">{unit}</span> : null}
          </>
        ) : state === 'noData' ? (
          <NoData detail={t('ui.noData.detail')} />
        ) : (
          <UnknownValue detail={t('ui.unknown.detail')} />
        )}
      </span>
      {detail ? <span className="ow-metric-detail">{detail}</span> : null}
      {showSampled ? (
        <span className="ow-metric-sampled">
          {sampledAt ? t('ui.observedAt', { at: formatDate(sampledAt) }) : t('ui.notObserved')}
        </span>
      ) : null}
      {href ? <span className="ow-metric-go" aria-hidden="true"><Icon name="arrowRight" size={14} /></span> : null}
    </>
  );

  if (!href) return <div className={cn('ow-metric', className)}>{body}</div>;
  return (
    <Link to={href} className={cn('ow-metric', 'ow-metric-link', className)} data-metric-card="" data-metric-href={href}>
      {body}
    </Link>
  );
}
