import React, { useCallback } from 'react';
import {
  Background, Controls, Handle, MiniMap, Position, ReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { PipelineNode } from '../types';
import type { GraphEdge, GraphNode } from './ir/types';

interface PipelineNodeData extends Record<string, unknown> {
  ir: PipelineNode;
}

function PipelineNodeView({ data, selected }: NodeProps<Node<PipelineNodeData>>) {
  const node = data.ir;
  return (
    <div className={`studio-rf-node ${selected ? 'selected' : ''}`}>
      <div className="studio-rf-node-head"><strong>{node.nodeId}</strong><span>{node.type.split('.').slice(-1)[0]}</span></div>
      <small>{node.type}</small>
      <div className="studio-rf-ports">
        {node.inputs.map((port) => <span key={port.name} className="studio-rf-port input"><Handle type="target" position={Position.Left} id={port.name} />{port.name} · {port.dataType}</span>)}
        {node.outputs.map((port) => <span key={port.name} className="studio-rf-port output"><Handle type="source" position={Position.Right} id={port.name} />{port.name} · {port.dataType}</span>)}
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
}

export function GraphCanvas({ nodes, edges, selectedId, onNodesChange, onEdgesChange, onConnectAttempt, onSelect }: GraphCanvasProps) {
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
    for (const change of changes) {
      if (change.type === 'position' && change.position && !change.dragging) {
        const index = next.findIndex((node) => node.id === change.id);
        if (index >= 0) next[index] = { ...next[index], position: change.position };
      }
    }
    onNodesChange(next);
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
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes as any}
        fitView
        minZoom={0.25}
        maxZoom={1.75}
        onNodeClick={(_, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
        onNodesChange={handleNodesChange}
        onConnect={connect}
        onNodesDelete={(deleted) => onNodesChange(nodes.filter((node) => !deleted.some((item) => item.id === node.id)))}
        onEdgesDelete={(deleted) => onEdgesChange(edges.filter((edge) => !deleted.some((item) => item.id === edge.id)))}
        deleteKeyCode={['Backspace', 'Delete']}
      >
        <Background gap={18} size={1} />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
