import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';

type Edge = 'none' | 'start' | 'end' | 'both';

/**
 * A horizontally scrolling filter strip that tells the truth about being cut off.
 *
 * The 390px defect was two bugs wearing one coat:
 *   1. the scroller carried a permanent right-hand mask, so the last chip ("Avail") looked
 *      faded away even when the strip scrolled all the way to the end and nothing was hidden;
 *   2. the selected chip could sit outside the visible window, so the filter in force was
 *      invisible - the one chip that has to be readable was the one that got clipped.
 *
 * So: the fade is a real element that only exists on an edge that actually hides content, and
 * the selected chip is scrolled into view whenever the selection changes.
 */
export function FilterScroller({
  children,
  className,
  activeKey,
  testId,
}: {
  children: React.ReactNode;
  className?: string;
  activeKey?: string;
  testId?: string;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [edge, setEdge] = useState<Edge>('none');

  const measure = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    const max = node.scrollWidth - node.clientWidth;
    // Sub-pixel slack: a 0.5px difference is rounding, not hidden content.
    if (max <= 1) { setEdge('none'); return; }
    const atStart = node.scrollLeft <= 1;
    const atEnd = node.scrollLeft >= max - 1;
    setEdge(atStart ? 'end' : atEnd ? 'start' : 'both');
  }, []);

  useLayoutEffect(() => {
    measure();
    const node = scroller.current;
    if (!node) return;
    node.addEventListener('scroll', measure, { passive: true });
    // The strip's width changes with the viewport and with the font it is laid out in.
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(node);
      if (node.firstElementChild) observer.observe(node.firstElementChild);
    }
    return () => {
      node.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [measure, children]);

  // A selection the operator cannot see is not a selection they made on purpose.
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const active = node.querySelector<HTMLElement>('[data-state="active"]');
    if (!active) return;
    const start = active.offsetLeft;
    const end = start + active.offsetWidth;
    if (start < node.scrollLeft || end > node.scrollLeft + node.clientWidth) {
      node.scrollLeft = Math.max(0, end - node.clientWidth);
    }
    measure();
  }, [activeKey, measure]);

  return (
    <div className={cn('ow-filter-shell', className)} data-overflow={edge} data-testid={testId}>
      <div className="ow-filter-scroll" ref={scroller} data-testid={testId ? testId + '-scroll' : undefined}>
        {children}
      </div>
      {edge === 'start' || edge === 'both' ? <span className="ow-filter-fade is-start" aria-hidden="true" data-testid={testId ? testId + '-fade-start' : undefined} /> : null}
      {edge === 'end' || edge === 'both' ? <span className="ow-filter-fade is-end" aria-hidden="true" data-testid={testId ? testId + '-fade-end' : undefined} /> : null}
    </div>
  );
}
