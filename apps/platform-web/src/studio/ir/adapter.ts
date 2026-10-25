import type { PipelineDefinition, PipelineEdge, PipelineNode } from '../../types';
import type { GraphEdge, GraphNode, StudioGraph } from './types';

const X_GAP = 280;
const Y_GAP = 150;

/** Server IR -> canvas graph. Position is editor-only, never persisted. */
export function toGraph(definition: PipelineDefinition): StudioGraph {
  const nodes: GraphNode[] = definition.nodes.map((node, index) => ({
    id: node.nodeId,
    type: 'pipeline',
    position: { x: 80 + (index % 2) * X_GAP, y: 70 + Math.floor(index / 2) * Y_GAP },
    data: { ir: clone(node) },
  }));
  const edges: GraphEdge[] = definition.edges.map((edge) => ({
    id: edgeId(edge),
    source: edge.fromNode,
    target: edge.toNode,
    sourceHandle: edge.fromPort,
    targetHandle: edge.toPort,
    label: edge.dataType,
    data: { ir: clone(edge) },
  }));
  return { nodes, edges };
}

/** Canvas graph -> PipelineDefinition; discards position/selection/measure fields. */
export function fromGraph(definition: PipelineDefinition, graph: StudioGraph): PipelineDefinition {
  // Preserve server/author array order. The backend digest is not a frontend
  // authority; silently reordering arrays here would change a future digest.
  const nodes = graph.nodes.map((node) => clone(node.data.ir));
  const edges = graph.edges.map((edge) => clone(edge.data.ir));
  return { ...definition, nodes, edges };
}

export function edgeId(edge: PipelineEdge): string {
  return `${edge.fromNode}:${edge.fromPort}->${edge.toNode}:${edge.toPort}`;
}

export function edgeKey(edge: PipelineEdge): string {
  return `${edge.fromNode}:${edge.fromPort}->${edge.toNode}:${edge.toPort}:${edge.dataType}`;
}

export function findNode(definition: PipelineDefinition, nodeId: string): PipelineNode | undefined {
  return definition.nodes.find((node) => node.nodeId === nodeId);
}

export function findPort(node: PipelineNode, port: string, direction: 'input' | 'output') {
  return (direction === 'input' ? node.inputs : node.outputs).find((candidate) => candidate.name === port);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
