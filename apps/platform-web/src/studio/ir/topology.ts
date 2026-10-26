import type { PipelineDefinition, PipelineNode } from '../../types';

export type TopologyStatus = 'VALID' | 'CYCLE' | 'DISCONNECTED' | 'MULTIPLE_SOURCES' | 'MULTIPLE_SINKS';

export interface ExecutionOrder {
  orderedNodeIds: string[];
  orderedNodes: PipelineNode[];
  topologyStatus: TopologyStatus;
  diagnostics: string[];
}

/**
 * Single source of truth for visual execution order. Edges are authoritative;
 * node/edge array order is never trusted. Invalid topology is reported, not
 * converted into a fabricated linear path.
 */
export function getPipelineExecutionOrder(definition: PipelineDefinition): ExecutionOrder {
  const byId = new Map(definition.nodes.map((node) => [node.nodeId, node]));
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, Set<string>>();
  const diagnostic: string[] = [];
  for (const node of definition.nodes) { indegree.set(node.nodeId, 0); outgoing.set(node.nodeId, new Set()); }
  for (const edge of definition.edges) {
    const out = outgoing.get(edge.fromNode);
    if (!out || !byId.has(edge.toNode)) { diagnostic.push(`Edge ${edge.fromNode}→${edge.toNode} references a missing node`); continue; }
    if (out.has(edge.toNode)) { diagnostic.push(`Duplicate edge ${edge.fromNode}→${edge.toNode} ignored`); continue; }
    out.add(edge.toNode);
    indegree.set(edge.toNode, (indegree.get(edge.toNode) || 0) + 1);
  }
  const sources = definition.nodes.filter((node) => (indegree.get(node.nodeId) || 0) === 0).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const queue = sources.map((node) => node.nodeId);
  const ordered: PipelineNode[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    const node = byId.get(id);
    if (!node) continue;
    ordered.push(node);
    for (const target of Array.from(outgoing.get(id) || []).sort()) {
      const remaining = (indegree.get(target) || 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) queue.push(target);
    }
    queue.sort();
  }
  const missing = definition.nodes.filter((node) => !ordered.some((seen) => seen.nodeId === node.nodeId)).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const sinks = definition.nodes.filter((node) => (outgoing.get(node.nodeId)?.size || 0) === 0);
  const targetIds = new Set(definition.edges.map((edge) => edge.toNode));
  const leafSources = sources.filter((node) => !targetIds.has(node.nodeId));
  let status: TopologyStatus = 'VALID';
  if (missing.length > 0) status = 'CYCLE';
  else if (definition.nodes.length > 0 && leafSources.length > 1) status = 'MULTIPLE_SOURCES';
  else if (sinks.length > 1) status = 'MULTIPLE_SINKS';
  else if (ordered.length !== definition.nodes.length) status = 'DISCONNECTED';
  if (status === 'CYCLE') diagnostic.push('Cycle detected; execution order is not linear');
  if (status === 'DISCONNECTED') diagnostic.push('Disconnected nodes detected');
  if (status === 'MULTIPLE_SOURCES') diagnostic.push('Multiple entry nodes detected');
  if (status === 'MULTIPLE_SINKS') diagnostic.push('Multiple sink nodes detected');
  return {
    orderedNodeIds: [...ordered.map((node) => node.nodeId), ...missing.map((node) => node.nodeId)],
    orderedNodes: [...ordered, ...missing],
    topologyStatus: status,
    diagnostics: diagnostic,
  };
}
