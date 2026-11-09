import type { GraphNode } from './types';

/** The subset of React Flow's change objects this canvas cares about. */
export interface CanvasChange {
  /**
   * Absent on `add` changes, which carry the whole node in `item` instead; those are not a
   * measurement or a move, so they are skipped rather than rendered into the model here.
   */
  id?: string;
  type: string;
  position?: { x: number; y: number };
  dragging?: boolean;
  dimensions?: { width: number; height: number };
}

/**
 * Fold React Flow's `onNodesChange` report into the model, or return null when nothing moved.
 *
 * Pure so it can be tested without a DOM: this is the one place where a controlled canvas can
 * silently diverge from what React Flow believes about its nodes.
 *
 * Why `dimensions` matters at all: React Flow renders a node with `visibility: hidden` until
 * `node.measured` carries both a width and a height (nodeHasDimensions in @xyflow/system), and in
 * controlled mode the only path by which that measurement reaches the node is this change being
 * written back. Dropping it - which is what the canvas used to do, since it only looked at
 * `position` - left the graph blank from the moment the component remounted until something else
 * happened to re-measure. That is the window the draft-conflict spec clicked into: it opened the
 * editor, opened a second tab on the same draft, and clicked a node that resolved in the DOM but was
 * still hidden, so Playwright retried until the 60s budget ran out.
 */
export function applyCanvasChanges(nodes: GraphNode[], changes: CanvasChange[]): GraphNode[] | null {
  const next = [...nodes];
  let changed = false;
  for (const change of changes) {
    const index = next.findIndex((node) => node.id === change.id);
    if (index < 0) continue;
    const current = next[index];
    if (change.type === 'position' && change.position && !change.dragging) {
      if (current.position.x !== change.position.x || current.position.y !== change.position.y) {
        next[index] = { ...current, position: change.position };
        changed = true;
      }
    } else if (change.type === 'dimensions' && change.dimensions) {
      const measured = current.measured;
      if (!measured || measured.width !== change.dimensions.width || measured.height !== change.dimensions.height) {
        next[index] = { ...current, measured: { ...change.dimensions } };
        changed = true;
      }
    }
  }
  return changed ? next : null;
}
