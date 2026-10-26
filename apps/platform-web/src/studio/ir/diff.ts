import type { PipelineDefinition, PipelineNode } from '../../types';

export interface ConfigChange { path: string; local: string; server: string }
export interface NodeDiff { nodeId: string; label: string; kind: 'added' | 'removed' | 'changed'; changes: ConfigChange[] }
export interface DefinitionDiff { nodes: NodeDiff[]; edgesAdded: string[]; edgesRemoved: string[] }

function label(node?: PipelineNode): string {
  if (!node) return 'Unknown node';
  const known: Record<string, string> = {
    'builtin.source.http_json': 'HTTP Source', 'builtin.parse.json': 'Parse JSON',
    'builtin.map.fields': 'Map Fields', 'builtin.filter.predicate': 'Filter Records',
    'builtin.validate.schema': 'Validate Schema', 'builtin.sink.dataset': 'Dataset Sink',
  };
  return known[node.type] || node.nodeId;
}

function flatten(value: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
    return out;
  }
  out[prefix || 'value'] = JSON.stringify(value);
  return out;
}

// Conflict details must not become an accidental secret disclosure channel.
// Only audited numeric schema fields are displayed. Unknown, nested, string and
// credential-bearing fields are compared but their values stay hidden.
const PUBLIC_NUMERIC_FIELDS = new Set(['typeVersion', 'timeoutSeconds', 'maxRecords', 'schemaRevision']);

function visibleFieldValue(path: string, serialized: string | undefined): string {
  if (serialized === undefined) return '(absent)';
  if (!PUBLIC_NUMERIC_FIELDS.has(path) || !/^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?$/.test(serialized)) {
    return '[REDACTED]';
  }
  return serialized;
}

function fieldChanges(localNode: PipelineNode, serverNode: PipelineNode): ConfigChange[] {
  const local = flatten({ ...localNode.config, typeVersion: localNode.typeVersion, inputs: localNode.inputs, outputs: localNode.outputs });
  const server = flatten({ ...serverNode.config, typeVersion: serverNode.typeVersion, inputs: serverNode.inputs, outputs: serverNode.outputs });
  return Array.from(new Set([...Object.keys(local), ...Object.keys(server)]))
    .filter((path) => local[path] !== server[path])
    .sort()
    .map((path) => ({ path, local: visibleFieldValue(path, local[path]), server: visibleFieldValue(path, server[path]) }));
}

function edgeId(edge: { fromNode: string; toNode: string; fromPort: string; toPort: string }) {
  return `${edge.fromNode}.${edge.fromPort} → ${edge.toNode}.${edge.toPort}`;
}

/** Field-level Definition diff used only in the conflict UI. */
export function definitionDiff(local: PipelineDefinition, server: PipelineDefinition): DefinitionDiff {
  const localNodes = new Map(local.nodes.map((node) => [node.nodeId, node]));
  const serverNodes = new Map(server.nodes.map((node) => [node.nodeId, node]));
  const nodes: NodeDiff[] = [];
  for (const id of Array.from(serverNodes.keys()).sort()) {
    if (!localNodes.has(id)) nodes.push({ nodeId: id, label: label(serverNodes.get(id)), kind: 'removed', changes: [] });
  }
  for (const id of Array.from(localNodes.keys()).sort()) {
    const mine = localNodes.get(id)!;
    const theirs = serverNodes.get(id);
    if (!theirs) { nodes.push({ nodeId: id, label: label(mine), kind: 'added', changes: [] }); continue; }
    const changes = fieldChanges(mine, theirs);
    if (changes.length) nodes.push({ nodeId: id, label: label(mine), kind: 'changed', changes });
  }
  const localEdges = new Set(local.edges.map(edgeId));
  const serverEdges = new Set(server.edges.map(edgeId));
  return {
    nodes,
    edgesAdded: Array.from(serverEdges).filter((edge) => !localEdges.has(edge)).sort(),
    edgesRemoved: Array.from(localEdges).filter((edge) => !serverEdges.has(edge)).sort(),
  };
}
