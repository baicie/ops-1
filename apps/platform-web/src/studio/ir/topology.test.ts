import { describe, expect, it } from 'vitest';
import fixture from './fixtures/pipeline-definition.json';
import type { PipelineDefinition } from '../../types';
import { getPipelineExecutionOrder } from './topology';

const base = fixture as unknown as PipelineDefinition;
const clone = (): PipelineDefinition => JSON.parse(JSON.stringify(base)) as PipelineDefinition;

describe('pipeline execution order', () => {
  it('returns the published linear order', () => {
    const result = getPipelineExecutionOrder(clone());
    expect(result.topologyStatus).toBe('VALID');
    expect(result.orderedNodeIds).toEqual(base.nodes.map((node) => node.nodeId));
  });

  it('ignores shuffled node arrays', () => {
    const definition = clone();
    definition.nodes = [...definition.nodes].reverse();
    expect(getPipelineExecutionOrder(definition).orderedNodeIds).toEqual(base.nodes.map((node) => node.nodeId));
  });

  it('ignores shuffled edge arrays', () => {
    const definition = clone();
    definition.edges = [...definition.edges].reverse();
    expect(getPipelineExecutionOrder(definition).orderedNodeIds).toEqual(base.nodes.map((node) => node.nodeId));
  });

  it('tolerates duplicate edges without duplicating nodes', () => {
    const definition = clone();
    definition.edges.push({ ...definition.edges[0] });
    const result = getPipelineExecutionOrder(definition);
    expect(result.topologyStatus).toBe('VALID');
    expect(new Set(result.orderedNodeIds).size).toBe(definition.nodes.length);
    expect(result.diagnostics.some((item) => item.includes('Duplicate'))).toBe(true);
  });

  it('reports a cycle and does not fabricate a linear path', () => {
    const definition = clone();
    definition.edges.push({ fromNode: definition.nodes.at(-1)!.nodeId, fromPort: 'records', toNode: definition.nodes[0].nodeId, toPort: 'records', dataType: 'records' });
    const result = getPipelineExecutionOrder(definition);
    expect(result.topologyStatus).toBe('CYCLE');
    expect(result.orderedNodeIds).toHaveLength(definition.nodes.length);
  });

  it('reports disconnected nodes', () => {
    const definition = clone();
    definition.nodes.push({ ...definition.nodes[0], nodeId: 'orphan', inputs: [], outputs: [] } as any);
    expect(getPipelineExecutionOrder(definition).topologyStatus).toBe('MULTIPLE_SOURCES');
  });

  it('reports multiple sources and sinks', () => {
    const definition = clone();
    definition.edges = [];
    expect(getPipelineExecutionOrder(definition).topologyStatus).toBe('MULTIPLE_SOURCES');
  });
});
