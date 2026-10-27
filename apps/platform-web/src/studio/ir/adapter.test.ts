import { describe, expect, it } from 'vitest';
import fixture from './fixtures/pipeline-definition.json';
import type { PipelineDefinition } from '../../types';
import { fromGraph, toGraph, edgeId } from './adapter';
import { validatePipeline } from './validation';

const base = fixture as unknown as PipelineDefinition;

function clone(): PipelineDefinition {
  return JSON.parse(JSON.stringify(base)) as PipelineDefinition;
}

describe('Pipeline IR adapter', () => {
  it('round-trips the real contract fixture without editor fields', () => {
    const graph = toGraph(base);
    const restored = fromGraph(base, graph);
    expect(restored.nodes.map((node) => node.nodeId)).toEqual(base.nodes.map((node) => node.nodeId));
    expect(restored.edges.map((edge) => edgeId(edge))).toEqual(base.edges.map((edge) => edgeId(edge)));
    expect(restored.status).toBe('DRAFT');
    expect(restored.digest).toBe('');
    expect(restored).not.toHaveProperty('position');
    expect(JSON.stringify(restored)).not.toContain('"selected"');
  });

  it('keeps stable node and edge ids when array order changes', () => {
    const graph = toGraph(base);
    const shuffled = { nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() };
    const restored = fromGraph(base, shuffled);
    expect(new Set(restored.nodes.map((node) => node.nodeId))).toEqual(new Set(base.nodes.map((node) => node.nodeId)));
    expect(new Set(restored.edges.map((edge) => edgeId(edge)))).toEqual(new Set(base.edges.map((edge) => edgeId(edge))));
  });

  it('rejects an unknown node type', () => {
    const definition = clone();
    definition.nodes[0].type = 'builtin.unknown.node';
    expect(validatePipeline(definition).errors.some((item) => item.code === 'UNKNOWN_NODE_TYPE')).toBe(true);
  });

  it('detects a port type mismatch', () => {
    const definition = clone();
    definition.edges[0].dataType = 'integer';
    expect(validatePipeline(definition).errors.some((item) => item.code === 'PORT_TYPE_MISMATCH' || item.code === 'EDGE_TYPE_INVALID')).toBe(true);
  });

  it('detects multiple sources and sinks', () => {
    const definition = clone();
    const source = definition.nodes.find((node) => node.type === 'builtin.source.http_json')!;
    const sink = definition.nodes.find((node) => node.type === 'builtin.sink.dataset')!;
    definition.nodes.push({ ...source, nodeId: 'source-two', inputs: [], outputs: source.outputs });
    definition.nodes.push({ ...sink, nodeId: 'sink-two' });
    const result = validatePipeline(definition);
    expect(result.errors.some((item) => item.code === 'SOURCE_COUNT_UNSUPPORTED')).toBe(true);
    expect(result.errors.some((item) => item.code === 'SINK_COUNT_UNSUPPORTED')).toBe(true);
  });

  it('detects duplicate ids, cycles and disconnected nodes', () => {
    const definition = clone();
    definition.nodes.push({ ...definition.nodes[1], nodeId: definition.nodes[1].nodeId });
    expect(validatePipeline(definition).errors.some((item) => item.code === 'DUPLICATE_NODE_ID')).toBe(true);

    const cyclic = clone();
    cyclic.edges.push({ fromNode: cyclic.nodes[2].nodeId, fromPort: cyclic.nodes[2].outputs[0].name, toNode: cyclic.nodes[1].nodeId, toPort: cyclic.nodes[1].inputs[0].name, dataType: 'json' });
    expect(validatePipeline(cyclic).errors.some((item) => item.code === 'CYCLE_DETECTED')).toBe(true);

    const disconnected = clone();
    disconnected.nodes.push({ ...disconnected.nodes[1], nodeId: 'disconnected-node' });
    expect(validatePipeline(disconnected).errors.some((item) => item.code === 'DISCONNECTED_NODE')).toBe(true);
  });

  it('rejects invalid ports and branching', () => {
    const invalid = clone();
    invalid.edges[0].fromPort = 'missing-output';
    expect(validatePipeline(invalid).errors.some((item) => item.code === 'PORT_NOT_FOUND')).toBe(true);

    const branching = clone();
    const source = branching.nodes.find((node) => node.type === 'builtin.source.http_json')!;
    const parse = branching.nodes.find((node) => node.type === 'builtin.parse.json')!;
    const map = branching.nodes.find((node) => node.type === 'builtin.map.fields')!;
    branching.edges.push({ fromNode: source.nodeId, fromPort: source.outputs[0].name, toNode: map.nodeId, toPort: map.inputs[0].name, dataType: 'json' });
    expect(validatePipeline(branching).errors.some((item) => item.code === 'BRANCH_JOIN_UNSUPPORTED')).toBe(true);
    expect(parse.nodeId).toBeTruthy();
  });
});

describe('topological layout', () => {
  it('orders nodes by edges even when the node array is shuffled', () => {
    const definition = structuredClone(base);
    definition.nodes = [definition.nodes[2], definition.nodes[0], definition.nodes[4], definition.nodes[1], definition.nodes[5], definition.nodes[3]];
    const ordered = toGraph(definition).nodes.map((node) => node.id);
    expect(ordered).toEqual(base.nodes.map((node) => node.nodeId));
  });

  it('orders nodes by edges even when the edge array is shuffled', () => {
    const definition = structuredClone(base);
    definition.edges = [...definition.edges].reverse();
    expect(toGraph(definition).nodes.map((node) => node.id)).toEqual(base.nodes.map((node) => node.nodeId));
  });

  it('renders a cycle deterministically instead of dropping nodes', () => {
    const definition = structuredClone(base);
    definition.edges.push({ fromNode: definition.nodes[5].nodeId, toNode: definition.nodes[0].nodeId, fromPort: 'records', toPort: 'records', dataType: 'records' } as any);
    const ids = toGraph(definition).nodes.map((node) => node.id);
    expect(ids.sort()).toEqual(base.nodes.map((node) => node.nodeId).sort());
    expect(new Set(ids).size).toBe(ids.length);
  });
});
