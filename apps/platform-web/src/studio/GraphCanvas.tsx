import React, { useCallback, useEffect, useState } from 'react';
import {
  Background, Controls, Handle, Position, ReactFlow,
  type Connection, type Edge, type Node, type NodeProps, type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { PipelineNode } from '../types';
import type { GraphEdge, GraphNode } from './ir/types';
import { Icon } from '../components/Icons';

interface PipelineNodeData extends Record<string, unknown> {
  ir: PipelineNode;
}

const NODE_META: Record<string, { label: string; category: string; icon: string; summary: (config: Record<string, unknown>) => string }> = {
  'builtin.source.http_json': { label: 'HTTP Source', category: 'source', icon: 'activity', summary: (config) => config.endpoint ? String(config.endpoint) : 'Endpoint not set' },
  'builtin.parse.json': { label: 'Parse JSON', category: 'transform', icon: 'ops', summary: () => 'Bounded JSON parse' },
  'builtin.map.fields': { label: 'Map Fields', category: 'transform', icon: 'ops', summary: (config) => config.mappings ? `${Object.keys(config.mappings as object).length} mapped fields` : 'Default id / name mapping' },
  'builtin.filter.predicate': { label: 'Filter Records', category: 'transform', icon: 'filter', summary: (config) => config.field ? `${String(config.field)} ${String(config.op || 'eq')}` : 'No filter predicate' },
  'builtin.validate.schema': { label: 'Validate Schema', category: 'validate', icon: 'check', summary: () => 'Dataset schema pin' },
  'builtin.sink.dataset': { label: 'Dataset Sink', category: 'sink', icon: 'inbox', summary: (config) => config.datasetId ? 'Dataset configured' : 'Dataset not set' },
};

function PipelineNodeView({ data, selected }: NodeProps<Node<PipelineNodeData>>) {
  const node = data.ir;
  const meta = NODE_META[node.type] || { label: node.type.split('.').slice(-1)[0], category: 'transform', icon: 'box', summary: () => 'Custom node' };
  return (
    <div className={`studio-rf-node node-${meta.category} ${selected ? 'selected' : ''}`}>
      <div className="studio-rf-node-head">
        <span className="node-type-icon"><Icon name={meta.icon} size={14} /></span>
        <div className="node-title"><strong>{meta.label}</strong><small>{node.nodeId}</small></div>
      </div>
      <p className="node-summary">{meta.summary(node.config)}</p>
      <div className="studio-rf-ports">
        {node.inputs.map((port) => <span key={port.name} className="studio-rf-port input"><Handle type="target" position={Position.Left} id={port.name} /><span className="port-label">{port.name}</span><span className="port-type">{port.dataType}</span></span>)}
        {node.outputs.map((port) => <span key={port.name} className="studio-rf-port output"><span className="port-label">{port.name}</span><span className="port-type">{port.dataType}</span><Handle type="source" position={Position.Right} id={port.name} /></span>)}
      </div>
    </div>
  );
}

const nodeTypes = { pipeline: PipelineNodeView };

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedId?: string | null;
  onNodesChange: (nodes: GraphNode[]) => void;
  onEdgesChange: (edges: GraphEdge[]) => void;
  onConnectAttempt: (connection: Connection) => { ok: boolean; error?: string };
  onSelect: (nodeId: string | null) => void;
  layoutNonce?: number;
}

export function GraphCanvas({ nodes, edges, selectedId, onNodesChange, onEdgesChange, onConnectAttempt, onSelect, layoutNonce = 0 }: GraphCanvasProps) {
  const [flow, setFlow] = useState<ReactFlowInstance<Node<PipelineNodeData>, Edge> | null>(null);
  useEffect(() => { if (layoutNonce > 0) void flow?.fitView({ padding: 0.2 }); }, [layoutNonce, flow]);
  const flowNodes: Array<Node<PipelineNodeData>> = nodes.map((node) => ({
    id: node.id, type: 'pipeline', position: node.position,
    data: { ir: node.data.ir }, selected: node.id === selectedId,
  }));
  const flowEdges: Edge[] = edges.map((edge) => ({
    id: edge.id, source: edge.source, target: edge.target,
    sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle,
    label: edge.label, animated: false,
  }));
  const handleNodesChange = useCallback((changes: any[]) => {
    const next = [...nodes];
    let changed = false;
    for (const change of changes) {
      if (change.type === 'position' && change.position && !change.dragging) {
        const index = next.findIndex((node) => node.id === change.id);
        if (index >= 0) {
          const current = next[index];
          if (current.position.x !== change.position.x || current.position.y !== change.position.y) {
            next[index] = { ...current, position: change.position };
            changed = true;
          }
        }
      }
    }
    if (changed) onNodesChange(next);
  }, [nodes, onNodesChange]);
  const connect = useCallback((connection: Connection) => {
    const result = onConnectAttempt(connection);
    if (!result.ok) return;
    const source = nodes.find((node) => node.id === connection.source);
    const target = nodes.find((node) => node.id === connection.target);
    if (!source || !target) return;
    const fromPort = source.data.ir.outputs.find((port) => port.name === connection.sourceHandle);
    const toPort = target.data.ir.inputs.find((port) => port.name === connection.targetHandle);
    if (!fromPort || !toPort) return;
    const id = `${source.id}:${fromPort.name}->${target.id}:${toPort.name}`;
    if (edges.some((edge) => edge.id === id)) return;
    onEdgesChange([...edges, {
      id, source: source.id, target: target.id, sourceHandle: fromPort.name, targetHandle: toPort.name,
      label: fromPort.dataType, data: { ir: { fromNode: source.id, fromPort: fromPort.name, toNode: target.id, toPort: toPort.name, dataType: fromPort.dataType } },
    }]);
  }, [edges, nodes, onConnectAttempt, onEdgesChange]);
  return (
    <div className="studio-rf-wrap">
      <ReactFlow
        style={{ width: '100%', height: '100%' }}
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes as any}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.15 }}
        defaultEdgeOptions={{ type: 'smoothstep' }}
        elevateEdgesOnSelect
        minZoom={0.25}
        maxZoom={1.75}
        onInit={(instance) => {
          setFlow(instance);
          // A second tab can mount React Flow before its container has a measured
          // viewport; fit again after layout/paint so nodes are never off-screen.
          window.setTimeout(() => void instance.fitView({ padding: 0.2 }), 100);
        }}
        onNodeClick={(_, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
        onNodesChange={handleNodesChange}
        onConnect={connect}
        onNodesDelete={(deleted) => {
          if (!window.confirm(`Delete ${deleted.length} selected node${deleted.length === 1 ? '' : 's'} and their connections?`)) return;
          const removed = new Set(deleted.map((item) => item.id));
          onNodesChange(nodes.filter((node) => !removed.has(node.id)));
          onEdgesChange(edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)));
        }}
        onEdgesDelete={(deleted) => onEdgesChange(edges.filter((edge) => !deleted.some((item) => item.id === edge.id)))}
        deleteKeyCode={['Backspace', 'Delete']}
      >
        <Background gap={18} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
