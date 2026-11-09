import { describe, expect, it } from 'vitest';
import fixture from './fixtures/pipeline-definition.json';
import { toGraph } from './adapter';
import type { PipelineDefinition } from '@opsweave/platform-client/contracts';
import type { GraphNode } from './types';
import { applyCanvasChanges } from './canvas';

const base = fixture as unknown as PipelineDefinition;
const nodes = (): GraphNode[] => toGraph(base).nodes;

describe('canvas change folding', () => {
  it('writes a reported measurement onto the node so React Flow can un-hide it', () => {
    const before = nodes();
    expect(before.every((node) => node.measured === undefined)).toBe(true);
    const target = before[0];

    const after = applyCanvasChanges(before, [
      { id: target.id, type: 'dimensions', dimensions: { width: 228, height: 96 } },
    ]);

    expect(after).not.toBeNull();
    expect(after![0].measured).toEqual({ width: 228, height: 96 });
    // Everything else is untouched, and the input is not mutated.
    expect(after!.slice(1)).toEqual(before.slice(1));
    expect(before[0].measured).toBeUndefined();
  });

  it('returns null when the same measurement is reported again', () => {
    const measured = applyCanvasChanges(nodes(), [
      { id: nodes()[0].id, type: 'dimensions', dimensions: { width: 228, height: 96 } },
    ])!;

    expect(applyCanvasChanges(measured, [
      { id: measured[0].id, type: 'dimensions', dimensions: { width: 228, height: 96 } },
    ])).toBeNull();
  });

  it('re-reports a measurement that changed size', () => {
    const first = nodes();
    const measured = applyCanvasChanges(first, [
      { id: first[0].id, type: 'dimensions', dimensions: { width: 228, height: 96 } },
    ])!;

    const resized = applyCanvasChanges(measured, [
      { id: measured[0].id, type: 'dimensions', dimensions: { width: 240, height: 96 } },
    ]);

    expect(resized![0].measured).toEqual({ width: 240, height: 96 });
  });

  it('still applies a settled position change', () => {
    const before = nodes();
    const after = applyCanvasChanges(before, [
      { id: before[0].id, type: 'position', position: { x: 40, y: 80 }, dragging: false },
    ]);
    expect(after![0].position).toEqual({ x: 40, y: 80 });
  });

  it('ignores a position change while the node is still being dragged', () => {
    // Reporting every frame of a drag into the model would push a history entry per frame.
    const before = nodes();
    expect(applyCanvasChanges(before, [
      { id: before[0].id, type: 'position', position: { x: 40, y: 80 }, dragging: true },
    ])).toBeNull();
  });

  it('ignores changes for nodes that are not in the model', () => {
    const before = nodes();
    expect(applyCanvasChanges(before, [
      { id: 'not-in-this-graph', type: 'dimensions', dimensions: { width: 10, height: 10 } },
    ])).toBeNull();
  });

  it('applies several changes in one report', () => {
    const before = nodes();
    const after = applyCanvasChanges(before, [
      { id: before[0].id, type: 'dimensions', dimensions: { width: 228, height: 96 } },
      { id: before[1].id, type: 'position', position: { x: 10, y: 20 }, dragging: false },
    ]);
    expect(after![0].measured).toEqual({ width: 228, height: 96 });
    expect(after![1].position).toEqual({ x: 10, y: 20 });
  });
});
