import type { PipelineDefinition, PipelineEdge, PipelineNode } from '../../types';
import type { GraphEdge, GraphNode, StudioGraph } from './types';

const X_GAP = 260;
const Y_GAP = 140;

/** Server IR -> canvas graph. Position is editor-only, never persisted. */
export function toGraph(definition: PipelineDefinition): StudioGraph {
  const ordered = topologicalNodes(definition);
  const nodes: GraphNode[] = ordered.map((node, index) => ({
    id: node.nodeId,
    type: 'pipeline',
    // Deterministic row-major placement follows topology, not the JSON array.
    // Position remains editor-only and never enters the persisted Definition.
    position: { x: 30 + (index % 2) * X_GAP, y: 40 + Math.floor(index / 2) * Y_GAP },
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

/**
 * Stable topological order for the linear-v1 Pipeline. Edges are authoritative;
 * node array order must never decide visual sequence. Disconnected nodes (which
 * validation rejects) and cycles (which validation rejects) are still rendered
 * deterministically by node ID rather than dropped.
 */
export function topologicalNodes(definition: PipelineDefinition): PipelineNode[] {
  const byId = new Map(definition.nodes.map((node) => [node.nodeId, node]));
  const indegree = new Map<string, number>();
  const next = new Map<string, string[]>();
  for (const node of definition.nodes) {
    indegree.set(node.nodeId, 0);
  }
  for (const edge of definition.edges) {
    if (!byId.has(edge.fromNode) || !byId.has(edge.toNode)) continue;
    indegree.set(edge.toNode, (indegree.get(edge.toNode) || 0) + 1);
    const list = next.get(edge.fromNode) || [];
    list.push(edge.toNode);
    next.set(edge.fromNode, list);
  }
  for (const list of next.values()) list.sort();
  const queue = definition.nodes
    .filter((node) => (indegree.get(node.nodeId) || 0) === 0)
    .map((node) => node.nodeId)
    .sort();
  const ordered: PipelineNode[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    const node = byId.get(id);
    if (!node) continue;
    ordered.push(node);
    for (const target of next.get(id) || []) {
      const remaining = (indegree.get(target) || 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) queue.push(target);
    }
    queue.sort();
  }
  const remaining = definition.nodes
    .filter((node) => !ordered.some((seen) => seen.nodeId === node.nodeId))
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  return [...ordered, ...remaining];
}
/**
 * Canvas graph -> local editor Definition; discards position/selection/measure
 * fields. A loaded Published digest/status must never describe local changes:
 * the server must canonicalize and validate this DRAFT before persistence.
 */
export function fromGraph(definition: PipelineDefinition, graph: StudioGraph): PipelineDefinition {
  // Preserve server/author array order. The backend digest is not a frontend
  // authority; silently reordering arrays here would change a future digest.
  const nodes = graph.nodes.map((node) => clone(node.data.ir));
  const edges = graph.edges.map((edge) => clone(edge.data.ir));
  return { ...definition, nodes, edges, status: 'DRAFT', digest: '' };
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
