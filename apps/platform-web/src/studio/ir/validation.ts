import type { PipelineDefinition, PipelineNode } from '../../types';
import { findPort } from './adapter';
import type { StudioIssue, StudioValidation } from './types';

const SOURCE_TYPE = 'builtin.source.http_json';
const SINK_TYPE = 'builtin.sink.dataset';
const KNOWN_NODE_TYPES = new Set([
  'builtin.source.http_json',
  'builtin.parse.json',
  'builtin.map.fields',
  'builtin.filter.predicate',
  'builtin.validate.schema',
  'builtin.sink.dataset',
]);

export function validatePipeline(definition: PipelineDefinition): StudioValidation {
  const errors: StudioIssue[] = [];
  const warnings: StudioIssue[] = [];
  const ids = new Set<string>();
  for (const node of definition.nodes) {
    if (ids.has(node.nodeId)) errors.push(issue('DUPLICATE_NODE_ID', `Duplicate node id ${node.nodeId}`, node.nodeId));
    if (!KNOWN_NODE_TYPES.has(node.type)) errors.push(issue('UNKNOWN_NODE_TYPE', `Unknown node type ${node.type}`, node.nodeId));
    ids.add(node.nodeId);
  }
  for (const edge of definition.edges) {
    const source = definition.nodes.find((node) => node.nodeId === edge.fromNode);
    const target = definition.nodes.find((node) => node.nodeId === edge.toNode);
    if (!source || !target) { errors.push(issue('EDGE_NODE_MISSING', 'Edge references an unknown node', edge.fromNode)); continue; }
    const from = findPort(source, edge.fromPort, 'output');
    const to = findPort(target, edge.toPort, 'input');
    if (!from) errors.push(issue('PORT_NOT_FOUND', `Output ${edge.fromPort} does not exist on ${source.nodeId}`, source.nodeId, edge.fromPort));
    if (!to) errors.push(issue('PORT_NOT_FOUND', `Input ${edge.toPort} does not exist on ${target.nodeId}`, target.nodeId, edge.toPort));
    if (from && to && from.dataType !== to.dataType) errors.push(issue('PORT_TYPE_MISMATCH', `${source.nodeId}.${from.name} (${from.dataType}) cannot connect to ${target.nodeId}.${to.name} (${to.dataType})`, target.nodeId, to.name));
    if (from && edge.dataType !== from.dataType) errors.push(issue('EDGE_TYPE_INVALID', `Edge dataType ${edge.dataType} does not match source port ${from.dataType}`, source.nodeId, edge.fromPort));
  }
  const sources = definition.nodes.filter((node) => node.type === SOURCE_TYPE);
  const sinks = definition.nodes.filter((node) => node.type === SINK_TYPE);
  if (sources.length !== 1) errors.push(issue('SOURCE_COUNT_UNSUPPORTED', `Exactly one HTTP source is supported; found ${sources.length}`));
  if (sinks.length !== 1) errors.push(issue('SINK_COUNT_UNSUPPORTED', `Exactly one dataset sink is supported; found ${sinks.length}`));
  for (const node of definition.nodes) {
    const incoming = definition.edges.filter((edge) => edge.toNode === node.nodeId).length;
    const outgoing = definition.edges.filter((edge) => edge.fromNode === node.nodeId).length;
    if (node.type === SOURCE_TYPE && (incoming !== 0 || outgoing > 1)) errors.push(issue('SOURCE_TOPOLOGY_UNSUPPORTED', 'Source must have zero inputs and at most one output', node.nodeId));
    else if (node.type === SINK_TYPE && (outgoing !== 0 || incoming > 1)) errors.push(issue('SINK_TOPOLOGY_UNSUPPORTED', 'Sink must have zero outputs and at most one input', node.nodeId));
    else if (incoming > 1 || outgoing > 1) errors.push(issue('BRANCH_JOIN_UNSUPPORTED', 'Branching and joins are not supported by the linear execution engine', node.nodeId));
    else if (incoming === 0 && outgoing === 0 && node.type !== SOURCE_TYPE) errors.push(issue('DISCONNECTED_NODE', 'Node is disconnected from the execution path', node.nodeId));
  }
  if (hasCycle(definition.nodes, definition.edges)) errors.push(issue('CYCLE_DETECTED', 'Pipeline graph contains a cycle'));
  return { valid: errors.length === 0, errors, warnings };
}

export function nodeValidation(definition: PipelineDefinition, node: PipelineNode): StudioIssue[] {
  return validatePipeline(definition).errors.filter((item) => item.nodeId === node.nodeId);
}

function hasCycle(nodes: PipelineNode[], edges: Array<{ fromNode: string; toNode: string }>): boolean {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.nodeId, []);
  for (const edge of edges) adjacency.get(edge.fromNode)?.push(edge.toNode);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of adjacency.get(id) || []) if (visit(next)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return nodes.some((node) => visit(node.nodeId));
}

function issue(code: string, message: string, nodeId?: string, port?: string): StudioIssue {
  return { code, message, nodeId, port };
}
